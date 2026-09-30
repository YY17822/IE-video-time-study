// 軟體內的對話框（取代瀏覽器的 alert / confirm）
// 用法：const choice = await ask({ title, message, buttons: [{ label, value, kind }] });

let openCount = 0;

export function isDialogOpen() {
  return openCount > 0;
}

export function ask({ title = '', message = '', content = null, buttons = [], cancelValue = null }) {
  return new Promise((resolve) => {
    openCount++;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal';
    box.setAttribute('role', 'dialog');

    if (title) {
      const h = document.createElement('h3');
      h.textContent = title;
      box.appendChild(h);
    }
    if (message) {
      const p = document.createElement('p');
      p.className = 'modal-msg';
      p.textContent = message;
      box.appendChild(p);
    }
    if (content) box.appendChild(content);

    const row = document.createElement('div');
    row.className = 'modal-buttons';
    box.appendChild(row);

    const close = (value) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      openCount--;
      resolve(value);
    };

    buttons.forEach((b) => {
      const btn = document.createElement('button');
      btn.className = 'btn' + (b.kind ? ` ${b.kind}` : '');
      btn.textContent = b.label;
      btn.addEventListener('click', () => close(b.value));
      row.appendChild(btn);
    });

    // 讓外部內容（例如清單）也能關閉對話框
    box.closeWith = close;

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(cancelValue);
      }
    };
    document.addEventListener('keydown', onKey, true);

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const primary = row.querySelector('.primary, .accent') || row.lastElementChild;
    primary?.focus();
  });
}
