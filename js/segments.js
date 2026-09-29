// 分割片段的資料與「復原 / 重做」歷程
// 片段永遠是連續的：[0 → 第一個分割點]、[分割點 → 下一個分割點] ... [最後分割點 → 影片結尾]

const EPS = 0.0005; // 秒；小於任何一幀的間隔
const HISTORY_LIMIT = 300;

export class SegmentStore {
  constructor(onChange) {
    this.segs = [];
    this.undoStack = [];
    this.redoStack = [];
    this.onChange = onChange;
  }

  reset(duration) {
    this.segs = [{ start: 0, end: duration, note: '' }];
    this.undoStack = [];
    this.redoStack = [];
    this.onChange();
  }

  get length() {
    return this.segs.length;
  }

  // 找出時間 t 所在的片段編號
  indexAt(t) {
    for (let i = 0; i < this.segs.length; i++) {
      if (t < this.segs[i].end - EPS) return i;
    }
    return this.segs.length - 1;
  }

  // 所有會改變資料的動作都經過這裡，才能復原
  commit(change) {
    const before = JSON.stringify(this.segs);
    if (change() === false) return false;
    this.undoStack.push(before);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.onChange();
    return true;
  }

  // 在時間 t 分割；若 t 已經是分割點或在片段邊緣，回傳 false
  split(t) {
    return this.commit(() => {
      const i = this.indexAt(t);
      const s = this.segs[i];
      if (t - s.start < EPS || s.end - t < EPS) return false;
      this.segs.splice(i, 1,
        { start: s.start, end: t, note: s.note },
        { start: t, end: s.end, note: '' }
      );
    });
  }

  // 刪除片段：併入前一段（第一段則併入下一段），保留被併入那段的備註
  remove(i) {
    return this.commit(() => {
      if (this.segs.length <= 1 || i < 0 || i >= this.segs.length) return false;
      if (i > 0) {
        this.segs[i - 1].end = this.segs[i].end;
      } else {
        this.segs[1].start = this.segs[0].start;
      }
      this.segs.splice(i, 1);
    });
  }

  setNote(i, text) {
    if (!this.segs[i] || this.segs[i].note === text) return false;
    return this.commit(() => {
      this.segs[i].note = text;
    });
  }

  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(JSON.stringify(this.segs));
    this.segs = JSON.parse(this.undoStack.pop());
    this.onChange();
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(JSON.stringify(this.segs));
    this.segs = JSON.parse(this.redoStack.pop());
    this.onChange();
    return true;
  }
}
