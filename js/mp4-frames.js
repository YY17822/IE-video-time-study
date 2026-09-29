// 讀取 MP4 / MOV 影片的「每一幀時間表」
// 只讀檔案的索引區（moov），不會把整個影片讀進記憶體。
// iPhone 影片常是可變幀率（VFR），所以不能用「幀數 ÷ 30」推算時間，
// 而是直接讀出每一幀真實的顯示時間。

const MAX_MOOV_BYTES = 300 * 1024 * 1024;

function fourcc(view, pos) {
  return String.fromCharCode(
    view.getUint8(pos), view.getUint8(pos + 1),
    view.getUint8(pos + 2), view.getUint8(pos + 3)
  );
}

// 逐一列出某個範圍內的 box（MP4 的資料區塊）
function* boxes(view, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = view.getUint32(p);
    const type = fourcc(view, p + 4);
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(p + 8));
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) break;
    yield { type, start: p + header, end: p + size };
    p += size;
  }
}

function child(view, box, type) {
  if (!box) return null;
  for (const b of boxes(view, box.start, box.end)) {
    if (b.type === type) return b;
  }
  return null;
}

function path(view, box, types) {
  let cur = box;
  for (const t of types) {
    cur = child(view, cur, t);
    if (!cur) return null;
  }
  return cur;
}

// 在檔案中找出 moov 區塊（只讀每個區塊的標頭，跳過影像資料）
async function readMoov(file) {
  let offset = 0;
  while (offset + 8 <= file.size) {
    const buf = await file.slice(offset, offset + 16).arrayBuffer();
    const v = new DataView(buf);
    let size = v.getUint32(0);
    const type = fourcc(v, 4);
    if (size === 1) size = Number(v.getBigUint64(8));
    else if (size === 0) size = file.size - offset;
    if (size < 8) return null;
    if (type === 'moov') {
      if (size > MAX_MOOV_BYTES) return null;
      return file.slice(offset, offset + size).arrayBuffer();
    }
    offset += size;
  }
  return null;
}

function parseTrak(view, trak, movieTimescale) {
  const mdia = child(view, trak, 'mdia');
  const hdlr = child(view, mdia, 'hdlr');
  const mdhd = child(view, mdia, 'mdhd');
  const stbl = path(view, mdia, ['minf', 'stbl']);
  if (!hdlr || !mdhd || !stbl) return null;

  const handler = fourcc(view, hdlr.start + 8);
  const mdhdVer = view.getUint8(mdhd.start);
  const timescale = view.getUint32(mdhd.start + (mdhdVer === 1 ? 20 : 12));

  // 編碼格式（avc1 = H.264、hvc1/hev1 = HEVC/H.265）
  let codec = '';
  const stsd = child(view, stbl, 'stsd');
  if (stsd && view.getUint32(stsd.start + 4) > 0) {
    codec = fourcc(view, stsd.start + 12);
  }

  // 編輯清單（elst）：決定影片從哪個時間點開始顯示
  let emptyDelay = 0; // 以秒計
  let mediaStart = 0; // 以軌道時間單位計
  const elst = path(view, trak, ['edts', 'elst']);
  if (elst) {
    const ver = view.getUint8(elst.start);
    const count = view.getUint32(elst.start + 4);
    let p = elst.start + 8;
    for (let i = 0; i < count; i++) {
      let segDur, mediaTime;
      if (ver === 1) {
        segDur = Number(view.getBigUint64(p));
        mediaTime = Number(view.getBigInt64(p + 8));
        p += 20;
      } else {
        segDur = view.getUint32(p);
        mediaTime = view.getInt32(p + 4);
        p += 12;
      }
      if (mediaTime === -1) {
        emptyDelay += segDur / movieTimescale;
      } else {
        mediaStart = mediaTime;
        break;
      }
    }
  }

  return { handler, timescale, codec, stbl, emptyDelay, mediaStart };
}

function buildFrameTimes(view, track) {
  const stts = child(view, track.stbl, 'stts');
  if (!stts) return null;

  // stts：每一幀的解碼間隔
  const sttsCount = view.getUint32(stts.start + 4);
  let total = 0;
  for (let i = 0; i < sttsCount; i++) {
    total += view.getUint32(stts.start + 8 + i * 8);
  }
  if (total === 0) return null;

  const pts = new Float64Array(total);
  let dts = 0;
  let k = 0;
  for (let i = 0; i < sttsCount; i++) {
    const count = view.getUint32(stts.start + 8 + i * 8);
    const delta = view.getUint32(stts.start + 12 + i * 8);
    for (let c = 0; c < count && k < total; c++) {
      pts[k++] = dts;
      dts += delta;
    }
  }

  // ctts：解碼順序和顯示順序的差距（B 幀）
  const ctts = child(view, track.stbl, 'ctts');
  if (ctts) {
    const count = view.getUint32(ctts.start + 4);
    k = 0;
    for (let i = 0; i < count; i++) {
      const n = view.getUint32(ctts.start + 8 + i * 8);
      const off = view.getInt32(ctts.start + 12 + i * 8);
      for (let c = 0; c < n && k < total; c++) pts[k++] += off;
    }
  }

  const times = new Float64Array(total);
  for (let i = 0; i < total; i++) {
    times[i] = (pts[i] - track.mediaStart) / track.timescale + track.emptyDelay;
  }
  times.sort();

  // 去掉被編輯清單裁掉（時間為負）的幀
  let first = 0;
  while (first < times.length && times[first] < -1e-6) first++;
  return first > 0 ? times.slice(first) : times;
}

/**
 * 讀取影片每一幀的顯示時間（秒）。
 * 回傳 { frames: Float64Array, codec: string, hasAudio: boolean }
 * 讀不到時丟出錯誤。
 */
export async function readFrameTimes(file) {
  const buf = await readMoov(file);
  if (!buf) throw new Error('找不到影片索引（moov）');
  const view = new DataView(buf);

  // buf 本身就是 moov 區塊，跳過它自己的標頭
  let hdr = 8;
  if (view.getUint32(0) === 1) hdr = 16;
  const moov = { start: hdr, end: buf.byteLength };

  let movieTimescale = 1000;
  const mvhd = child(view, moov, 'mvhd');
  if (mvhd) {
    const ver = view.getUint8(mvhd.start);
    movieTimescale = view.getUint32(mvhd.start + (ver === 1 ? 20 : 12)) || 1000;
  }

  let videoTrack = null;
  let hasAudio = false;
  for (const b of boxes(view, moov.start, moov.end)) {
    if (b.type !== 'trak') continue;
    const t = parseTrak(view, b, movieTimescale);
    if (!t) continue;
    if (t.handler === 'vide' && !videoTrack) videoTrack = t;
    if (t.handler === 'soun') hasAudio = true;
  }
  if (!videoTrack) throw new Error('找不到影像軌');

  const frames = buildFrameTimes(view, videoTrack);
  if (!frames || frames.length < 2) throw new Error('影像軌沒有幀資料');

  return { frames, codec: videoTrack.codec, hasAudio };
}
