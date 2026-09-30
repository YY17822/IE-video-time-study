// 開啟檔案、儲存專案檔
// Chrome / Edge：使用系統的「開啟」「另存新檔」視窗，可以自選位置，也能直接覆蓋同一個檔案。
// 其他瀏覽器：用一般的選檔視窗開啟，存檔則下載到「下載」資料夾。

export const HAS_FS_ACCESS = 'showOpenFilePicker' in window && 'showSaveFilePicker' in window;

const OPEN_TYPES = [{
  description: '影片或工時分析專案檔',
  accept: {
    'video/*': ['.mov', '.mp4', '.m4v'],
    'application/json': ['.json'],
  },
}];
const VIDEO_TYPES = [{
  description: '影片',
  accept: { 'video/*': ['.mov', '.mp4', '.m4v'] },
}];
const JSON_TYPES = [{
  description: '工時分析專案檔',
  accept: { 'application/json': ['.json'] },
}];

export function isProjectFile(file) {
  return /\.json$/i.test(file.name);
}

// 用隱藏的 <input type="file"> 選檔（給不支援新方法的瀏覽器）
function pickWithInput(accept, multiple) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener('change', () => {
      resolve([...input.files].map((file) => ({ file, handle: null })));
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/**
 * 開啟檔案。回傳 [{ file, handle }]，使用者取消則回傳 null。
 * videoOnly：只能選一支影片；startIn：視窗一開始顯示哪個資料夾（傳入某個檔案的 handle = 那個檔案所在的資料夾）
 */
export async function pickFiles({ videoOnly = false, startIn = null } = {}) {
  if (!HAS_FS_ACCESS) {
    return pickWithInput(videoOnly ? 'video/*,.mov,.mp4,.m4v' : 'video/*,.mov,.mp4,.m4v,.json', !videoOnly);
  }
  try {
    const options = {
      id: 'ie-open',
      multiple: !videoOnly,
      types: videoOnly ? VIDEO_TYPES : OPEN_TYPES,
    };
    if (startIn) options.startIn = startIn;
    const handles = await window.showOpenFilePicker(options);
    return Promise.all(handles.map(async (handle) => ({ file: await handle.getFile(), handle })));
  } catch (err) {
    if (err.name === 'AbortError') return null;
    throw err;
  }
}

async function canWrite(handle) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

const XLSX_TYPES = [{
  description: 'Excel 活頁簿',
  accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] },
}];

/**
 * 儲存專案檔。
 * handle：已經存過的檔案（有的話直接覆蓋，不再跳視窗）
 * 回傳 { handle, name }；使用者取消則回傳 null。
 */
export function saveProjectFile(text, { handle = null, suggestedName, startIn = null }) {
  const blob = new Blob([text], { type: 'application/json' });
  return saveBlob(blob, { handle, suggestedName, startIn, types: JSON_TYPES, id: 'ie-save' });
}

// 匯出 Excel：每次都跳出「另存新檔」視窗
export function saveExcelFile(blob, { suggestedName, startIn = null }) {
  return saveBlob(blob, { suggestedName, startIn, types: XLSX_TYPES, id: 'ie-excel' });
}

async function saveBlob(blob, { handle = null, suggestedName, startIn = null, types, id }) {
  if (!HAS_FS_ACCESS) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = suggestedName;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(a.href);
    }, 2000);
    return { handle: null, name: suggestedName, downloaded: true };
  }

  // 已有檔案：直接覆蓋
  if (handle) {
    try {
      if (await canWrite(handle)) {
        await writeTo(handle, blob);
        return { handle, name: handle.name };
      }
    } catch (err) {
      console.warn('無法覆蓋原本的檔案，改為另存新檔：', err);
    }
  }

  // 另存新檔
  try {
    const options = { id, suggestedName, types };
    if (startIn) options.startIn = startIn;
    const newHandle = await window.showSaveFilePicker(options);
    await writeTo(newHandle, blob);
    return { handle: newHandle, name: newHandle.name };
  } catch (err) {
    if (err.name === 'AbortError') return null;
    throw err;
  }
}

async function writeTo(handle, blob) {
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}
