// IE 工時影片分析 — 主程式（第一階段：播放、逐幀、分割、片段表）
import { readFrameTimes } from './js/mp4-frames.js';
import { SegmentStore } from './js/segments.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
const EPS = 0.0005;
const FALLBACK_FPS = 30;
const CODEC_NAMES = { avc1: 'H.264', avc3: 'H.264', hvc1: 'HEVC (H.265)', hev1: 'HEVC (H.265)' };

const state = {
  ready: false,
  file: null,
  url: null,
  frames: null,        // 每一幀的顯示時間（秒）
  estimated: false,    // true = 讀不到幀資訊，以固定 fps 估算
  codec: '',
  duration: 0,
  cur: 0,              // 目前畫面是第幾幀（從 0 開始）
  calibrating: false,
  loadToken: 0,
};

const store = new SegmentStore(onSegmentsChanged);

// ================= 工具 =================

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const cs = Math.round(sec * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  const pad = (n) => String(n).padStart(2, '0');
  return (h ? `${h}:${pad(m)}` : pad(m)) + `:${pad(s)}.${pad(c)}`;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 時間 t 對應的幀：最後一個「顯示時間 ≤ t」的幀
function frameAt(t) {
  const f = state.frames;
  let lo = 0, hi = f.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (f[mid] <= t + EPS) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

// 片段邊界對應的幀編號（影片結尾 = 總幀數）
function boundaryFrame(t) {
  return t >= state.duration - EPS ? state.frames.length : frameAt(t);
}

// 跳到某一幀時，實際要設定的播放時間：取這一幀和下一幀的中間，避免誤差跳到隔壁幀
function seekTargetOf(i) {
  const f = state.frames;
  if (i + 1 < f.length) return (f[i] + f[i + 1]) / 2;
  const d = f.length > 1 ? f[i] - f[i - 1] : 1 / FALLBACK_FPS;
  return Math.min(f[i] + d / 2, state.duration - 0.001);
}

function curTime() {
  return state.frames ? state.frames[state.cur] : 0;
}

let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 1400);
}

function showAlert(msg) {
  $('alertText').textContent = msg;
  $('alertBox').hidden = false;
}
function hideAlert() {
  $('alertBox').hidden = true;
}

// 快捷鍵提示燈
function flashKey(name) {
  const el = document.querySelector(`.key[data-key="${name}"]`);
  if (!el) return;
  el.classList.add('lit');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('lit'), 220);
}

// ================= 開啟影片 =================

$('btnOpen').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) loadFile(file);
  e.target.value = '';
});

const wrap = $('videoWrap');
['dragenter', 'dragover'].forEach((type) =>
  document.addEventListener(type, (e) => {
    e.preventDefault();
    wrap.classList.add('dragover');
  })
);
['dragleave', 'drop'].forEach((type) =>
  document.addEventListener(type, (e) => {
    e.preventDefault();
    if (type === 'drop' || e.target === document.documentElement) wrap.classList.remove('dragover');
  })
);
document.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});

function waitForMetadata() {
  return new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error('media error')); };
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', ok);
      video.removeEventListener('error', bad);
    };
    video.addEventListener('loadedmetadata', ok);
    video.addEventListener('error', bad);
  });
}

function unsupportedMessage(codec) {
  const name = CODEC_NAMES[codec] || codec || '未知';
  if (codec === 'avc1' || codec === 'avc3') {
    return `這個瀏覽器無法播放這支影片（編碼格式：${name}）。\n\n` +
      `請改用最新版的 Chrome、Edge 或 Safari 開啟本軟體。`;
  }
  return `這台電腦的瀏覽器無法顯示這支影片的畫面（編碼格式：${name}）。\n\n` +
    `請先把影片轉成 H.264 格式的 MP4 再開啟。\n` +
    `之後拍攝時，可在 iPhone「設定 → 相機 → 格式」選擇「最相容」，` +
    `並在「錄影」中關閉「HDR 影片」，就不會再遇到這個問題。`;
}

async function loadFile(file) {
  const token = ++state.loadToken;
  hideAlert();
  video.pause();
  state.ready = false;
  setControlsEnabled(false);

  if (state.url) URL.revokeObjectURL(state.url);
  state.file = file;
  state.url = URL.createObjectURL(file);
  $('fileName').textContent = file.name;
  $('frameInfo').textContent = '讀取中…';
  $('dropHint').hidden = true;

  // 同時進行：讀幀時間表、讓瀏覽器載入影片
  const parsing = readFrameTimes(file).catch((err) => {
    console.warn('讀取幀資訊失敗：', err);
    return null;
  });
  video.src = state.url;

  let info = null;
  try {
    await waitForMetadata();
    info = await parsing;
  } catch {
    info = await parsing;
    if (token !== state.loadToken) return;
    $('frameInfo').textContent = '';
    showAlert(unsupportedMessage(info?.codec));
    return;
  }
  if (token !== state.loadToken) return;

  // 有聲音但沒有畫面 = 常見的「黑畫面」情況
  if (video.videoWidth === 0) {
    $('frameInfo').textContent = '';
    showAlert(unsupportedMessage(info?.codec));
    return;
  }

  state.duration = video.duration;
  state.codec = info?.codec || '';
  if (info) {
    state.frames = info.frames;
    state.estimated = false;
  } else {
    const n = Math.max(1, Math.floor(state.duration * FALLBACK_FPS));
    state.frames = Float64Array.from({ length: n }, (_, i) => i / FALLBACK_FPS);
    state.estimated = true;
  }

  state.cur = 0;
  video.playbackRate = Number($('speedSel').value);
  store.reset(state.duration);
  state.ready = true;
  setControlsEnabled(true);
  updateFrameInfo();

  // 對齊：確認瀏覽器顯示的第一幀時間與幀時間表一致
  state.calibrating = 'requestVideoFrameCallback' in HTMLVideoElement.prototype && !state.estimated;
  video.currentTime = 0;
  updatePosition();
}

function updateFrameInfo() {
  const n = state.frames.length;
  const fps = n / state.duration;
  const codec = CODEC_NAMES[state.codec] || state.codec;
  const parts = [`${n.toLocaleString()} 幀`, `平均 ${fps.toFixed(fps < 10 ? 2 : 1)} fps`];
  if (codec) parts.push(codec);
  if (state.estimated) parts.push('（讀不到幀資訊，以 30fps 估算）');
  $('frameInfo').textContent = parts.join(' · ');
  $('timeTotal').textContent = fmtTime(state.duration);
}

function setControlsEnabled(on) {
  ['btnPrev', 'btnPlay', 'btnNext', 'btnSplit', 'speedSel'].forEach((id) => { $(id).disabled = !on; });
  updateUndoButtons();
}

// ================= 播放與逐幀 =================

function togglePlay() {
  if (!state.ready) return;
  if (video.paused) {
    if (video.ended || state.cur >= state.frames.length - 1) gotoFrame(0);
    video.play();
  } else {
    video.pause();
  }
}

function gotoFrame(i) {
  if (!state.ready) return;
  i = clamp(i, 0, state.frames.length - 1);
  if (!video.paused) video.pause();
  state.cur = i;
  video.currentTime = seekTargetOf(i);
  updatePosition();
}

function step(n) {
  gotoFrame(state.cur + n);
}

function changeSpeed(dir) {
  const sel = $('speedSel');
  const idx = SPEEDS.indexOf(Number(sel.value));
  const next = SPEEDS[clamp(idx + dir, 0, SPEEDS.length - 1)];
  sel.value = String(next);
  video.playbackRate = next;
  toast(`倍速 ${next}x`);
}

video.addEventListener('play', () => { $('btnPlay').textContent = '❚❚'; });
video.addEventListener('pause', () => { $('btnPlay').textContent = '▶︎'; updatePosition(); });
video.addEventListener('ended', () => {
  if (!state.ready) return;
  state.cur = state.frames.length - 1;
  updatePosition();
});

// 每當瀏覽器真的顯示出一幀，就用那一幀的精確時間更新目前幀
function onVideoFrame(_now, meta) {
  if (state.ready) {
    if (state.calibrating) {
      state.calibrating = false;
      const offset = meta.mediaTime - state.frames[0];
      if (Math.abs(offset) > 1e-4 && Math.abs(offset) < 1) {
        state.frames = state.frames.map((t) => t + offset);
        console.info(`幀時間已校正 ${offset.toFixed(4)} 秒`);
      }
    }
    state.cur = frameAt(meta.mediaTime);
    updatePosition();
  }
  video.requestVideoFrameCallback(onVideoFrame);
}
if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
  video.requestVideoFrameCallback(onVideoFrame);
}

// 播放中持續更新播放指針（較不支援 requestVideoFrameCallback 的瀏覽器也靠這裡更新幀）
function tick() {
  if (state.ready && !video.paused) {
    if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) {
      state.cur = frameAt(video.currentTime);
    }
    updatePosition();
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ================= 分割、刪除、復原 =================

function split() {
  if (!state.ready) return;
  const t = curTime();
  if (store.split(t)) {
    toast(`已在 ${fmtTime(t)} 分割`);
  } else {
    toast(t < EPS ? '影片開頭無法分割' : '這裡已經是分割點');
  }
}

function removeCurrent() {
  if (!state.ready) return;
  if (store.length <= 1) { toast('只剩一段，無法刪除'); return; }
  const i = store.indexAt(curTime());
  store.remove(i);
  toast(`已刪除第 ${i + 1} 段（可按 ⌘Z 復原）`);
}

function undo() {
  if (store.undo()) toast('已復原'); else toast('沒有可以復原的動作');
}
function redo() {
  if (store.redo()) toast('已重做'); else toast('沒有可以重做的動作');
}

function updateUndoButtons() {
  $('btnUndo').disabled = !state.ready || store.undoStack.length === 0;
  $('btnRedo').disabled = !state.ready || store.redoStack.length === 0;
}

function focusNote() {
  if (!state.ready) return;
  if (!video.paused) video.pause();
  const i = store.indexAt(curTime());
  const input = $('segBody').querySelector(`tr[data-i="${i}"] input`);
  if (input) {
    input.scrollIntoView({ block: 'nearest' });
    input.focus();
    input.select();
  }
}

// ================= 畫面更新 =================

let lastCurrentSeg = -1;

function onSegmentsChanged() {
  renderTable();
  renderTimeline();
  lastCurrentSeg = -1;
  updatePosition();
  updateUndoButtons();
}

function renderTable() {
  const body = $('segBody');
  body.textContent = '';
  const frag = document.createDocumentFragment();
  let total = 0;

  store.segs.forEach((s, i) => {
    const tr = document.createElement('tr');
    tr.dataset.i = i;
    const dur = s.end - s.start;
    total += dur;
    const frames = boundaryFrame(s.end) - boundaryFrame(s.start);
    const cells = [
      ['c-no', String(i + 1)],
      ['c-time', fmtTime(s.start)],
      ['c-time', fmtTime(s.end)],
      ['c-num', dur.toFixed(2)],
      ['c-num', String(frames)],
    ];
    for (const [cls, text] of cells) {
      const td = document.createElement('td');
      td.className = cls;
      td.textContent = text;
      tr.appendChild(td);
    }
    const td = document.createElement('td');
    td.className = 'note';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = s.note;
    input.placeholder = '輸入動作描述…';
    input.addEventListener('change', () => store.setNote(i, input.value.trim()));
    td.appendChild(input);
    tr.appendChild(td);
    frag.appendChild(tr);
  });

  body.appendChild(frag);
  $('emptyHint').hidden = state.ready;
  $('segSummary').textContent = state.ready
    ? `共 ${store.length} 段 · 合計 ${total.toFixed(2)} 秒`
    : '';
}

// 點表格的一列：跳到那一段的開頭
$('segBody').addEventListener('click', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const tr = e.target.closest('tr');
  if (!tr) return;
  const s = store.segs[Number(tr.dataset.i)];
  if (s) gotoFrame(frameAt(s.start));
});

function renderTimeline() {
  const box = $('tlSegments');
  box.textContent = '';
  if (!state.ready) return;
  const frag = document.createDocumentFragment();
  store.segs.forEach((s, i) => {
    const d = document.createElement('div');
    d.className = 'tl-seg';
    d.style.left = `${(s.start / state.duration) * 100}%`;
    d.style.width = `${((s.end - s.start) / state.duration) * 100}%`;
    d.textContent = String(i + 1);
    d.title = `#${i + 1}  ${fmtTime(s.start)} – ${fmtTime(s.end)}${s.note ? '\n' + s.note : ''}`;
    frag.appendChild(d);
  });
  box.appendChild(frag);
}

function updatePosition() {
  if (!state.ready) return;
  const playing = !video.paused;
  const t = playing ? video.currentTime : curTime();
  $('timeNow').textContent = fmtTime(t);
  $('frameNow').textContent = `第 ${(state.cur + 1).toLocaleString()} 幀`;
  $('tlPlayhead').style.left = `${(t / state.duration) * 100}%`;

  const segIdx = store.indexAt(curTime());
  if (segIdx !== lastCurrentSeg) {
    lastCurrentSeg = segIdx;
    document.querySelectorAll('#segBody tr.current, .tl-seg.current')
      .forEach((el) => el.classList.remove('current'));
    const row = $('segBody').querySelector(`tr[data-i="${segIdx}"]`);
    if (row) {
      row.classList.add('current');
      row.scrollIntoView({ block: 'nearest' });
    }
    $('tlSegments').children[segIdx]?.classList.add('current');
  }
}

// ================= 時間軸拖曳 =================

const timeline = $('timeline');
function seekFromPointer(e) {
  if (!state.ready) return;
  const rect = timeline.getBoundingClientRect();
  const ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1);
  gotoFrame(frameAt(ratio * state.duration));
}
timeline.addEventListener('pointerdown', (e) => {
  if (!state.ready) return;
  timeline.setPointerCapture(e.pointerId);
  seekFromPointer(e);
});
timeline.addEventListener('pointermove', (e) => {
  if (timeline.hasPointerCapture(e.pointerId)) seekFromPointer(e);
});

// ================= 按鈕 =================

// 按鈕不搶走鍵盤焦點，避免按 Space 時重複觸發按鈕
document.querySelectorAll('button').forEach((b) =>
  b.addEventListener('mousedown', (e) => e.preventDefault())
);

$('btnPlay').addEventListener('click', togglePlay);
$('btnPrev').addEventListener('click', () => step(-1));
$('btnNext').addEventListener('click', () => step(1));
$('btnSplit').addEventListener('click', split);
$('btnUndo').addEventListener('click', undo);
$('btnRedo').addEventListener('click', redo);
$('alertClose').addEventListener('click', hideAlert);
$('speedSel').addEventListener('change', (e) => {
  video.playbackRate = Number(e.target.value);
  e.target.blur();
});

// ================= 鍵盤快捷鍵 =================

document.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    // 在備註欄按 Enter 或 Esc：結束輸入，回到快捷鍵模式
    if (tag === 'INPUT' && (e.key === 'Enter' || e.key === 'Escape') && !e.isComposing) {
      e.preventDefault();
      e.target.blur();
    }
    return;
  }

  const mod = e.metaKey || e.ctrlKey;
  if (mod) {
    const k = e.key.toLowerCase();
    if (k === 'z') {
      e.preventDefault();
      if (e.shiftKey) { redo(); flashKey('redo'); } else { undo(); flashKey('undo'); }
    } else if (k === 'y') {
      e.preventDefault();
      redo(); flashKey('redo');
    }
    return;
  }
  if (!state.ready) return;

  switch (e.code) {
    case 'Space':
      e.preventDefault(); togglePlay(); flashKey('play'); break;
    case 'KeyS':
      e.preventDefault(); split(); flashKey('split'); break;
    case 'ArrowRight':
      e.preventDefault(); step(e.shiftKey ? 10 : 1); flashKey(e.shiftKey ? 'jump' : 'next'); break;
    case 'ArrowLeft':
      e.preventDefault(); step(e.shiftKey ? -10 : -1); flashKey(e.shiftKey ? 'jump' : 'prev'); break;
    case 'ArrowUp':
      e.preventDefault(); changeSpeed(1); flashKey('speed'); break;
    case 'ArrowDown':
      e.preventDefault(); changeSpeed(-1); flashKey('speed'); break;
    case 'Delete':
    case 'Backspace':
      e.preventDefault(); removeCurrent(); flashKey('delete'); break;
    case 'Enter':
    case 'NumpadEnter':
      e.preventDefault(); focusNote(); flashKey('note'); break;
  }
});

renderTable();
