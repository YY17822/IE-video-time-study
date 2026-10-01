// IE 工時影片分析 — 主程式
// 目前功能：播放、逐幀、分割、片段表、專案檔開啟與儲存
import { readFrameTimes } from './js/mp4-frames.js';
import { SegmentStore } from './js/segments.js';
import { ask, isDialogOpen } from './js/dialog.js';
import { pickFiles, saveProjectFile, saveExcelFile, isProjectFile } from './js/files.js';
import { buildXlsx, STYLE } from './js/xlsx.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
const EPS = 0.0005;
const FALLBACK_FPS = 30;
const DURATION_TOLERANCE = 0.1; // 秒：判斷「同一支影片」時允許的長度誤差
const APP_ID = 'ie-time-study';
const FILE_VERSION = 1;
const CODEC_NAMES = { avc1: 'H.264', avc3: 'H.264', hvc1: 'HEVC (H.265)', hev1: 'HEVC (H.265)' };
const HAS_RVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

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
  resumeTime: null,    // 載入後要跳回的位置（接續上次）
  loadToken: 0,
  createdAt: 0,        // 這份分析第一次建立的時間
  videoHandle: null,   // 影片檔（Chrome 用來讓存檔視窗預設開在影片所在的資料夾）
  projectHandle: null, // 目前的專案檔（存過一次後，⌘S 直接覆蓋它）
  projectName: '',     // 目前專案檔的檔名
  dirty: false,        // 有沒有尚未儲存的變更
  savedAt: 0,
  loading: false,      // 正在載入，這段期間的資料變動不算「未儲存」
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

// 片段時長：只顯示「分:秒」（四捨五入到整秒）
function fmtDuration(sec) {
  const total = Math.round(Math.max(0, sec));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
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

// ================= 開啟檔案 =================

function dialogOk(title, message) {
  return ask({ title, message, buttons: [{ label: '知道了', value: true, kind: 'primary' }], cancelValue: true });
}

// 有未儲存的變更時，先問要不要存。回傳 true = 可以繼續
async function confirmDiscard() {
  if (!state.ready || !state.dirty) return true;
  const choice = await ask({
    title: '目前的分析還沒儲存',
    message: '要先儲存嗎？不儲存的話，這次的變更會消失。',
    buttons: [
      { label: '取消', value: 'cancel' },
      { label: '不儲存', value: 'discard', kind: 'danger' },
      { label: '儲存', value: 'save', kind: 'primary' },
    ],
    cancelValue: 'cancel',
  });
  if (choice === 'discard') return true;
  if (choice === 'save') return save(false);
  return false;
}

// 讀取並檢查專案檔內容
async function readProject(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    await dialogOk('無法開啟', `「${file.name}」不是有效的專案檔。`);
    return null;
  }
  const valid = data && data.app === APP_ID && data.video && typeof data.video.name === 'string' &&
    isFinite(data.video.duration) && Array.isArray(data.segments);
  if (!valid) {
    await dialogOk('無法開啟', `「${file.name}」不是本軟體的專案檔。`);
    return null;
  }
  return data;
}

// 處理「開啟」選到的檔案：一支影片、一個專案檔，或兩個一起
async function openEntries(entries) {
  if (!entries || !entries.length) return;
  const projects = entries.filter((e) => isProjectFile(e.file));
  const videos = entries.filter((e) => !isProjectFile(e.file));
  if (projects.length > 1 || videos.length > 1) {
    await dialogOk('一次只能開一組', '請選一支影片；要繼續舊的分析時，再加上它的專案檔（最多兩個檔案）。');
    return;
  }
  if (!(await confirmDiscard())) return;

  let project = null;
  const projectEntry = projects[0] || null;
  if (projectEntry) {
    project = await readProject(projectEntry.file);
    if (!project) return;
  }

  let videoEntry = videos[0] || null;
  if (!videoEntry) {
    const go = await ask({
      title: '請選擇對應的影片',
      message: `這個專案檔記錄的影片是：\n「${project.video.name}」（長度 ${fmtTime(project.video.duration)}，${project.segments.length} 段）`,
      buttons: [
        { label: '取消', value: false },
        { label: '選擇影片', value: true, kind: 'primary' },
      ],
      cancelValue: false,
    });
    if (!go) return;
    const picked = await pickFiles({ videoOnly: true, startIn: projectEntry.handle });
    videoEntry = picked?.[0];
    if (!videoEntry) return;
  }

  loadFile(videoEntry, project ? { data: project, handle: projectEntry.handle, name: projectEntry.file.name } : null);
}

async function openDialog() {
  try {
    openEntries(await pickFiles({ startIn: state.projectHandle || state.videoHandle }));
  } catch (err) {
    console.error(err);
    toast('無法開啟檔案');
  }
}

$('btnOpen').addEventListener('click', openDialog);

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
document.addEventListener('drop', async (e) => {
  const items = [...(e.dataTransfer?.items || [])].filter((it) => it.kind === 'file');
  // Chrome 可以從拖曳的檔案取得 handle，之後存檔就能直接覆蓋
  const entries = await Promise.all(items.map(async (it) => {
    const file = it.getAsFile();
    let handle = null;
    if (it.getAsFileSystemHandle) {
      try { handle = await it.getAsFileSystemHandle(); } catch { /* 沒關係 */ }
    }
    return { file, handle };
  }));
  openEntries(entries.filter((en) => en.file));
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

function resetToStart() {
  state.ready = false;
  state.dirty = false;
  state.projectHandle = null;
  state.projectName = '';
  video.removeAttribute('src');
  video.load();
  $('fileName').textContent = '尚未開啟影片';
  $('frameInfo').textContent = '';
  $('dropHint').hidden = false;
  setControlsEnabled(false);
  store.segs = [];
  onSegmentsChanged();
  updateSaveStatus();
}

/**
 * 載入影片。
 * videoEntry：{ file, handle }
 * project：要套用的專案檔 { data, handle, name }，沒有則開始新的分析
 */
async function loadFile(videoEntry, project) {
  const { file } = videoEntry;
  const token = ++state.loadToken;
  hideAlert();
  video.pause();
  state.ready = false;
  state.dirty = false;
  setControlsEnabled(false);

  if (state.url) URL.revokeObjectURL(state.url);
  state.file = file;
  state.url = URL.createObjectURL(file);
  $('fileName').textContent = file.name;
  $('frameInfo').textContent = '讀取中…';
  $('saveStatus').textContent = '';
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

  const duration = video.duration;

  // 雙層防錯：比對專案檔記錄的檔名與影片長度
  if (project) {
    const rec = project.data.video;
    const problems = [];
    if (rec.name !== file.name) {
      problems.push(`・檔名不同：專案檔記錄的是「${rec.name}」，你選的是「${file.name}」`);
    }
    if (Math.abs(rec.duration - duration) > DURATION_TOLERANCE) {
      problems.push(`・影片長度不同：專案檔記錄的是 ${fmtTime(rec.duration)}，你選的是 ${fmtTime(duration)}`);
    }
    if (problems.length) {
      const choice = await ask({
        title: '影片可能選錯了',
        message: problems.join('\n') +
          '\n\n如果確定是同一支影片（例如只是改過檔名），可以強制載入。',
        buttons: [
          { label: '取消', value: 'cancel' },
          { label: '重新選擇影片', value: 'repick' },
          { label: '忽略提示，強制載入', value: 'force', kind: 'danger' },
        ],
        cancelValue: 'cancel',
      });
      if (token !== state.loadToken) return;
      if (choice === 'repick') {
        resetToStart();
        const picked = await pickFiles({ videoOnly: true, startIn: project.handle || videoEntry.handle })
          .catch(() => null);
        if (picked?.[0]) loadFile(picked[0], project);
        return;
      }
      if (choice !== 'force') { resetToStart(); return; }
    }
  }

  // ---- 準備幀時間表 ----
  state.duration = duration;
  state.codec = info?.codec || '';
  if (info) {
    state.frames = info.frames;
    state.estimated = false;
  } else {
    const n = Math.max(1, Math.floor(duration * FALLBACK_FPS));
    state.frames = Float64Array.from({ length: n }, (_, i) => i / FALLBACK_FPS);
    state.estimated = true;
  }

  state.videoHandle = videoEntry.handle || null;
  state.projectHandle = project?.handle || null;
  state.projectName = project?.name || '';
  state.createdAt = project?.data.createdAt || Date.now();
  state.savedAt = 0;
  state.resumeTime = project ? (Number(project.data.lastTime) || 0) : null;

  state.cur = 0;
  video.playbackRate = Number($('speedSel').value);
  state.ready = true;
  state.loading = true;
  if (project) store.load(fitSegments(project.data.segments, duration));
  else store.reset(duration);
  state.loading = false;
  state.dirty = false;
  setControlsEnabled(true);
  updateFrameInfo();
  updateSaveStatus();
  if (project) toast(`已載入專案檔（${store.length} 段）`);

  // 對齊：確認瀏覽器顯示的第一幀時間與幀時間表一致
  state.calibrating = HAS_RVFC && !state.estimated;
  video.currentTime = 0;
  if (state.calibrating) {
    // 若瀏覽器沒有回報新畫面（例如本來就停在開頭），就不校正，直接繼續
    setTimeout(() => {
      if (token === state.loadToken && state.calibrating) {
        state.calibrating = false;
        applyResume();
      }
    }, 600);
  } else {
    applyResume();
  }
  updatePosition();
}

// 把存下來的片段套到這支影片上（強制載入長度不同的影片時，裁掉超出的部分）
function fitSegments(segs, duration) {
  const out = [];
  for (const s of segs || []) {
    const start = Number(s.start), end = Number(s.end);
    if (!isFinite(start) || !isFinite(end) || start >= duration - EPS) continue;
    out.push({ start: Math.max(0, start), end: Math.min(end, duration), note: String(s.note || '') });
  }
  if (!out.length) return [{ start: 0, end: duration, note: '' }];
  out[0].start = 0;
  out[out.length - 1].end = duration;
  return out;
}

function applyResume() {
  if (state.resumeTime == null) return;
  const t = state.resumeTime;
  state.resumeTime = null;
  if (t > 0) gotoFrame(frameAt(t));
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
  ['btnBack1s', 'btnPrev', 'btnPlay', 'btnNext', 'btnFwd1s', 'btnSplit', 'btnMerge', 'speedSel', 'btnSave', 'btnSaveAs', 'btnExcel']
    .forEach((id) => { $(id).disabled = !on; });
  updateUndoButtons();
}

// ================= 儲存專案檔 =================

function safeFileBase(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_');
}

function buildProjectData() {
  return {
    app: APP_ID,
    version: FILE_VERSION,
    video: { name: state.file.name, duration: state.duration, frameCount: state.frames.length },
    segments: store.segs.map((s) => ({ start: s.start, end: s.end, note: s.note })),
    lastTime: curTime(),
    createdAt: state.createdAt,
    updatedAt: Date.now(),
  };
}

// saveAs = true：一定跳出「另存新檔」視窗。回傳 true = 已儲存
async function save(saveAs) {
  if (!state.ready) return false;
  // 正在輸入的備註也要一起存
  const el = document.activeElement;
  if (el && el.tagName === 'INPUT') el.blur();

  try {
    const res = await saveProjectFile(JSON.stringify(buildProjectData(), null, 2), {
      handle: saveAs ? null : state.projectHandle,
      suggestedName: `${safeFileBase(state.file.name)}_工時分析.json`,
      startIn: state.projectHandle || state.videoHandle,
    });
    if (!res) return false; // 使用者取消
    state.projectHandle = res.handle;
    state.projectName = res.name;
    state.dirty = false;
    state.savedAt = Date.now();
    updateSaveStatus();
    toast(res.downloaded ? `已下載到「下載」資料夾：${res.name}` : `已儲存：${res.name}`);
    return true;
  } catch (err) {
    console.error(err);
    await dialogOk('儲存失敗', `無法儲存專案檔。\n（${err.message}）`);
    return false;
  }
}

function updateSaveStatus() {
  const el = $('saveStatus');
  el.classList.toggle('dirty', state.ready && state.dirty);
  if (!state.ready) { el.textContent = ''; return; }
  if (state.dirty) {
    el.textContent = '● 尚未儲存';
  } else if (state.savedAt) {
    const d = new Date(state.savedAt);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    el.textContent = `已儲存 ${hm}${state.projectName ? ' · ' + state.projectName : ''}`;
  } else {
    el.textContent = state.projectName ? `專案檔：${state.projectName}` : '尚未存檔';
  }
  document.title = (state.dirty ? '● ' : '') + 'IE 工時影片分析';
}

// ================= 匯出 Excel =================

async function exportExcel() {
  if (!state.ready) return;
  const el = document.activeElement;
  if (el && el.tagName === 'INPUT') el.blur();

  const rows = [[
    { v: '#', s: STYLE.header },
    { v: '開始時間', s: STYLE.header },
    { v: '結束時間', s: STYLE.header },
    { v: '時長(秒)', s: STYLE.header },
    { v: '動作備註', s: STYLE.header },
  ]];
  let total = 0;
  // 時長只取整數秒（四捨五入），與畫面上「分:秒」的算法一致
  store.segs.forEach((s, i) => {
    const dur = Math.round(s.end - s.start);
    total += dur;
    rows.push([i + 1, fmtTime(s.start), fmtTime(s.end), dur, s.note]);
  });
  const last = store.segs.length + 1;
  rows.push([
    '', '',
    { v: '合計', s: STYLE.bold },
    { v: total, f: `SUM(D2:D${last})`, s: STYLE.bold },
    '',
  ]);

  const blob = buildXlsx({
    sheetName: '工時分析',
    rows,
    widths: [6, 12, 12, 11, 48],
  });

  try {
    const res = await saveExcelFile(blob, {
      suggestedName: `${safeFileBase(state.file.name)}_工時分析.xlsx`,
      startIn: state.projectHandle || state.videoHandle,
    });
    if (res) toast(res.downloaded ? `已下載到「下載」資料夾：${res.name}` : `已匯出：${res.name}`);
  } catch (err) {
    console.error(err);
    await dialogOk('匯出失敗', `無法匯出 Excel 檔。\n（${err.message}）`);
  }
}

$('btnExcel').addEventListener('click', exportExcel);
$('btnSave').addEventListener('click', () => save(false));
$('btnSaveAs').addEventListener('click', () => save(true));

// 關閉分頁、重新整理前，有未儲存的變更就提醒
window.addEventListener('beforeunload', (e) => {
  if (state.ready && state.dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

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

function jumpSeconds(sec) {
  if (!state.ready) return;
  gotoFrame(frameAt(clamp(curTime() + sec, 0, state.duration)));
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
video.addEventListener('pause', () => {
  $('btnPlay').textContent = '▶︎';
  updatePosition();
});
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
      state.cur = frameAt(meta.mediaTime);
      applyResume();
    } else {
      state.cur = frameAt(meta.mediaTime);
    }
    updatePosition();
  }
  video.requestVideoFrameCallback(onVideoFrame);
}
if (HAS_RVFC) video.requestVideoFrameCallback(onVideoFrame);

// 播放中持續更新播放指針
function tick() {
  if (state.ready && !video.paused) {
    if (!HAS_RVFC) state.cur = frameAt(video.currentTime);
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

// 合併：把目前選取的片段（播放位置所在的那一段）併入上一段
function mergeCurrent() {
  if (!state.ready) return;
  const i = store.indexAt(curTime());
  if (i === 0) { toast('第 1 段沒有上一段可以合併'); return; }
  const startOfPrev = store.segs[i - 1].start;
  store.mergeWithPrevious(i);
  // 停在合併後那一段的開頭，方便確認結果
  gotoFrame(frameAt(startOfPrev));
  toast(`已將第 ${i + 1} 段併入第 ${i} 段（可按 ⌘Z 復原）`);
}

function undo() {
  if (!state.ready) return;
  if (store.undo()) toast('已復原'); else toast('沒有可以復原的動作');
}
function redo() {
  if (!state.ready) return;
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
  if (state.ready && !state.loading) {
    state.dirty = true;
    updateSaveStatus();
  }
}

function renderTable() {
  const body = $('segBody');
  body.textContent = '';
  const frag = document.createDocumentFragment();
  let total = 0;

  if (state.ready) {
    store.segs.forEach((s, i) => {
      const tr = document.createElement('tr');
      tr.dataset.i = i;
      const dur = s.end - s.start;
      total += dur;
      const cells = [
        ['c-no', String(i + 1)],
        ['c-time', fmtTime(s.start)],
        ['c-time', fmtTime(s.end)],
        ['c-num', fmtDuration(dur)],
        ['c-num', String(Math.round(dur))], // 整數秒，與 Excel 匯出一致
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
  }

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
  $('tlPlayhead').hidden = !state.ready;
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
  if (!state.ready) {
    $('timeNow').textContent = fmtTime(0);
    $('timeTotal').textContent = fmtTime(0);
    $('frameNow').textContent = '';
    return;
  }
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
$('btnBack1s').addEventListener('click', () => jumpSeconds(-1));
$('btnPrev').addEventListener('click', () => step(-1));
$('btnNext').addEventListener('click', () => step(1));
$('btnFwd1s').addEventListener('click', () => jumpSeconds(1));
$('btnSplit').addEventListener('click', split);
$('btnMerge').addEventListener('click', mergeCurrent);
$('btnUndo').addEventListener('click', undo);
$('btnRedo').addEventListener('click', redo);
$('alertClose').addEventListener('click', hideAlert);
$('speedSel').addEventListener('change', (e) => {
  video.playbackRate = Number(e.target.value);
  e.target.blur();
});

// ================= 鍵盤快捷鍵 =================

document.addEventListener('keydown', (e) => {
  if (isDialogOpen()) return;

  // ⌘S 儲存、⇧⌘S 另存新檔、⌘O 開啟（輸入備註時也能用）
  if ((e.metaKey || e.ctrlKey) && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 's') {
      e.preventDefault();
      if (state.ready) { save(e.shiftKey); flashKey('save'); }
      return;
    }
    if (k === 'o') {
      e.preventDefault();
      openDialog();
      return;
    }
  }

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
      e.preventDefault();
      if (e.shiftKey) { step(1); flashKey('frame'); } else { jumpSeconds(1); flashKey('sec'); }
      break;
    case 'ArrowLeft':
      e.preventDefault();
      if (e.shiftKey) { step(-1); flashKey('frame'); } else { jumpSeconds(-1); flashKey('sec'); }
      break;
    case 'ArrowUp':
      e.preventDefault(); changeSpeed(1); flashKey('speed'); break;
    case 'ArrowDown':
      e.preventDefault(); changeSpeed(-1); flashKey('speed'); break;
    case 'KeyM':
      e.preventDefault(); mergeCurrent(); flashKey('merge'); break;
    case 'Delete':
    case 'Backspace':
      e.preventDefault(); removeCurrent(); flashKey('delete'); break;
    case 'Enter':
    case 'NumpadEnter':
      e.preventDefault(); focusNote(); flashKey('note'); break;
  }
});

// ================= 啟動 =================

// 舊版曾把紀錄存在瀏覽器裡，現在改用專案檔，清掉舊資料
try { indexedDB.deleteDatabase('ie-time-study'); } catch { /* 沒關係 */ }
renderTable();
renderTimeline();
updateSaveStatus();
