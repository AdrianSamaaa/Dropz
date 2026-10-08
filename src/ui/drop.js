// A single Drop on the desktop: a header tile that opens downward into its apps.
const api = window.drops;
const $ = id => document.getElementById(id);
const card = $('card'), head = $('head'), glyph = $('glyph'), nameEl = $('name'), nameInput = $('nameInput');
const meta = $('meta'), pinBtn = $('pinBtn'), body = $('body'), inner = $('inner'), list = $('list');
const empty = $('empty'), addBtn = $('addBtn');

const ITEM_MIME = 'application/x-drops-item';
const PAD_TOP = 8, PAD_BOTTOM = 20, BORDER = 2; // must match drop.css
const MIN_LIST = 3 * 40;

const FALLBACK = {
  folder: '<svg viewBox="0 0 24 24"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2h8.4A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" fill="#f5c451"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>',
  app: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 8.5h18"/></svg>',
};
const EMPTY_GLYPH = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="4" y="3.5" width="16" height="5" rx="2"/><path d="M6.5 13h11M7.5 17h9M8.5 21h7" opacity=".65"/></svg>';

let drop = null;
let expanded = false;
let available = 600;  // px from the window's top to the bottom of the work area
let busy = false;     // a native menu is open; ignore focus changes
let renaming = false;
let renamingItem = null;
let toastText = '';
let toastTimer = 0, leaveTimer = 0, dragCloseTimer = 0;
let dragDepth = 0, dragOpened = false;

// ------------------------------------------------------------------ sizing

const collapsedHeight = () => PAD_TOP + BORDER + head.offsetHeight + PAD_BOTTOM;

function fitList() {
  const chrome = collapsedHeight() + (inner.offsetHeight - list.offsetHeight);
  list.style.maxHeight = Math.max(MIN_LIST, available - chrome) + 'px';
}

async function setExpanded(next) {
  if (next === expanded) return;
  expanded = next;
  card.classList.toggle('expanded', next);
  clearTimeout(leaveTimer);
  if (next) {
    fitList();
    const h = inner.offsetHeight;
    await api.setHeight(collapsedHeight() + h);
    if (expanded) body.style.height = h + 'px';
  } else {
    body.style.height = '0px';
    setTimeout(() => { if (!expanded) api.setHeight(collapsedHeight()); }, 210);
  }
}

async function syncHeight() {
  if (!expanded) return api.setHeight(collapsedHeight());
  fitList();
  const h = inner.offsetHeight;
  if (h >= body.offsetHeight) {
    await api.setHeight(collapsedHeight() + h);
    if (expanded) body.style.height = h + 'px';
  } else {
    body.style.height = h + 'px';
    setTimeout(() => { if (expanded) api.setHeight(collapsedHeight() + inner.offsetHeight); }, 210);
  }
}

// ------------------------------------------------------------------ rendering

function iconEl(item) {
  if (item.icon) {
    const img = new Image();
    img.src = item.icon;
    img.alt = '';
    img.draggable = false;
    return img;
  }
  const span = document.createElement('span');
  span.className = 'fallback';
  span.innerHTML = FALLBACK[item.kind] || FALLBACK.file;
  return span;
}

function rowFor(item) {
  const li = document.createElement('li');
  li.className = 'row' + (item.missing ? ' missing' : '');
  li.dataset.id = item.id;
  li.draggable = true;
  li.title = item.missing ? `${item.name} can't be found` : item.name;
  const ico = document.createElement('span');
  ico.className = 'ico';
  ico.append(iconEl(item));
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = item.name;
  li.append(ico, label);
  return li;
}

function renderMeta() {
  meta.classList.toggle('error', !!toastText);
  meta.title = toastText;
  if (toastText) { meta.textContent = toastText; return; }
  const n = drop.items.length;
  const noun = drop.items.every(i => i.kind === 'app') ? 'app' : 'item';
  meta.textContent = n ? `${n} ${noun}${n === 1 ? '' : 's'}` : 'Drop apps here';
}

function renderGlyph() {
  const icons = drop.items.slice(0, 4);
  glyph.className = 'glyph' + (icons.length === 0 ? ' is-empty' : icons.length === 1 ? ' is-single' : '');
  if (!icons.length) glyph.innerHTML = EMPTY_GLYPH;
  else glyph.replaceChildren(...icons.map(iconEl));
}

function render() {
  if (renamingItem) return; // re-rendered when the rename finishes
  document.documentElement.style.setProperty('--accent', drop.color);
  document.title = drop.name;
  if (!renaming) nameEl.textContent = drop.name;
  renderMeta();
  renderGlyph();
  pinBtn.classList.toggle('on', !!drop.pinned);
  pinBtn.title = drop.pinned ? 'Pinned open (click to unpin)' : 'Pin open';

  const scroll = list.scrollTop;
  list.replaceChildren(...drop.items.map(rowFor));
  list.scrollTop = scroll;
  list.hidden = drop.items.length === 0;
  empty.hidden = drop.items.length > 0;
  syncHeight();
}

function toast(text) {
  toastText = text;
  renderMeta();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastText = ''; renderMeta(); }, 4500);
}

// ------------------------------------------------------------------ header: click to open, drag to move

head.addEventListener('pointerdown', e => {
  if (e.button !== 0 || e.target.closest('button, input')) return;
  const sx = e.screenX, sy = e.screenY, ox = e.clientX, oy = e.clientY;
  let moving = false;
  head.setPointerCapture(e.pointerId);

  const onMove = ev => {
    if (!moving && Math.hypot(ev.screenX - sx, ev.screenY - sy) > 4) {
      moving = true;
      card.classList.add('moving');
      api.moveStart(ox, oy);
    }
  };
  const onEnd = ev => {
    head.removeEventListener('pointermove', onMove);
    head.removeEventListener('pointerup', onEnd);
    head.removeEventListener('lostpointercapture', onEnd);
    if (moving) {
      card.classList.remove('moving');
      api.moveEnd();
    } else if (ev.type === 'pointerup') {
      setExpanded(!expanded);
    }
  };
  head.addEventListener('pointermove', onMove);
  head.addEventListener('pointerup', onEnd);
  head.addEventListener('lostpointercapture', onEnd);
});

async function withMenu(open) {
  busy = true;
  try { await open(); } finally { busy = false; }
  if (!document.hasFocus() && !drop.pinned && !renaming && !renamingItem) setExpanded(false);
}

head.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (!e.target.closest('input')) withMenu(api.menu);
});

pinBtn.addEventListener('click', () => api.togglePin());
addBtn.addEventListener('click', () => api.openPicker());

// ------------------------------------------------------------------ renaming

function beginRename() {
  if (renaming) return;
  renaming = true;
  nameInput.value = drop.name;
  nameEl.hidden = true;
  nameInput.hidden = false;
  nameInput.focus();
  nameInput.select();
}

function finishRename(save) {
  if (!renaming) return;
  renaming = false;
  const value = nameInput.value.trim();
  nameInput.hidden = true;
  nameEl.hidden = false;
  if (save && value && value !== drop.name) {
    drop.name = value;
    nameEl.textContent = value;
    api.rename(value);
  }
}

nameInput.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter') finishRename(true);
  else if (e.key === 'Escape') finishRename(false);
});
nameInput.addEventListener('blur', () => finishRename(true));

function beginItemRename(id) {
  const item = drop.items.find(i => i.id === id);
  const row = [...list.children].find(r => r.dataset.id === id);
  if (!item || !row) return;
  if (!expanded) setExpanded(true);
  renamingItem = id;
  row.draggable = false;
  const input = document.createElement('input');
  input.className = 'row-input';
  input.value = item.name;
  input.maxLength = 80;
  input.spellcheck = false;
  row.querySelector('.label').replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = save => {
    if (done) return;
    done = true;
    renamingItem = null;
    const value = input.value.trim();
    if (save && value && value !== item.name) {
      item.name = value;
      api.renameItem(id, value);
    }
    render();
  };
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

// ------------------------------------------------------------------ items: launch, menu, reorder

list.addEventListener('click', async e => {
  const row = e.target.closest('.row');
  if (!row || e.target.closest('input')) return;
  row.classList.remove('launching');
  void row.offsetWidth;
  row.classList.add('launching');
  await api.launch(row.dataset.id);
});

list.addEventListener('contextmenu', e => {
  const row = e.target.closest('.row');
  if (!row) return;
  e.preventDefault();
  e.stopPropagation();
  withMenu(() => api.itemMenu(row.dataset.id));
});

list.addEventListener('dragstart', e => {
  const row = e.target.closest('.row');
  if (!row) return;
  e.dataTransfer.setData(ITEM_MIME, JSON.stringify({ dropId: drop.id, itemId: row.dataset.id }));
  e.dataTransfer.effectAllowed = 'move';
  row.classList.add('dragging');
});

list.addEventListener('dragend', e => {
  e.target.closest('.row')?.classList.remove('dragging');
  dragDepth = 0;
  endDragVisual();
});

// ------------------------------------------------------------------ drag & drop onto the Drop

const isOurs = e => e.dataTransfer.types.includes(ITEM_MIME);
const isFiles = e => e.dataTransfer.types.includes('Files');

function indexAt(e) {
  const h = head.getBoundingClientRect();
  if (e.clientY < h.bottom) return drop.items.length; // dropped on the header: append
  const rows = [...list.children];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) return i;
  }
  return rows.length;
}

function clearMarker() {
  for (const r of list.querySelectorAll('.insert-before, .insert-after')) r.classList.remove('insert-before', 'insert-after');
}

function showMarker(e) {
  clearMarker();
  const rows = list.children;
  if (!rows.length || e.clientY < head.getBoundingClientRect().bottom) return;
  const i = indexAt(e);
  if (i < rows.length) rows[i].classList.add('insert-before');
  else rows[rows.length - 1].classList.add('insert-after');
}

function endDragVisual() {
  card.classList.remove('drag-over');
  clearMarker();
}

window.addEventListener('dragenter', e => {
  if (!isOurs(e) && !isFiles(e)) return;
  e.preventDefault();
  clearTimeout(dragCloseTimer);
  if (++dragDepth === 1) {
    card.classList.add('drag-over');
    if (!expanded) {
      dragOpened = true;
      setExpanded(true);
    }
  }
});

window.addEventListener('dragleave', () => {
  if (dragDepth === 0 || --dragDepth > 0) return;
  endDragVisual();
  if (dragOpened && !drop.pinned) {
    dragCloseTimer = setTimeout(() => { dragOpened = false; setExpanded(false); }, 350);
  }
});

window.addEventListener('dragover', e => {
  e.preventDefault();
  if (isOurs(e)) {
    e.dataTransfer.dropEffect = 'move';
  } else if (!isFiles(e)) {
    e.dataTransfer.dropEffect = 'none';
    return;
  } else {
    // Never report "move" to Explorer, or it would delete the original.
    e.dataTransfer.dropEffect = /link|all|uninitialized/i.test(e.dataTransfer.effectAllowed) ? 'link' : 'copy';
  }
  showMarker(e);
});

window.addEventListener('drop', async e => {
  e.preventDefault();
  const index = indexAt(e);
  dragDepth = 0;
  dragOpened = false;
  clearTimeout(dragCloseTimer);
  endDragVisual();

  const raw = e.dataTransfer.getData(ITEM_MIME);
  if (raw) {
    const { dropId, itemId } = JSON.parse(raw);
    if (dropId !== drop.id) return api.moveItem(dropId, itemId, index);
    const ids = drop.items.map(i => i.id);
    const from = ids.indexOf(itemId);
    if (from < 0) return;
    ids.splice(from, 1);
    ids.splice(index > from ? index - 1 : index, 0, itemId);
    return api.reorder(ids);
  }

  const files = [...e.dataTransfer.files];
  if (!files.length) return;
  const { added } = await api.addFiles(files, index);
  if (!added) toast(files.length === 1 ? 'Already in this Drop' : 'Those are already in this Drop');
});

// ------------------------------------------------------------------ closing on its own

window.addEventListener('blur', () => {
  if (!busy && !drop?.pinned && !dragDepth && !renaming && !renamingItem) setExpanded(false);
});

// Opened by a drag without ever being focused: close once the mouse leaves.
document.addEventListener('mouseout', e => {
  if (e.relatedTarget || !expanded || drop.pinned || busy || dragDepth || document.hasFocus()) return;
  clearTimeout(leaveTimer);
  leaveTimer = setTimeout(() => setExpanded(false), 700);
});
document.addEventListener('mouseover', () => clearTimeout(leaveTimer));

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !drop.pinned) setExpanded(false);
  else if (e.key === 'F2') beginRename();
});

// ------------------------------------------------------------------ wiring

api.onUpdate(d => {
  const wasPinned = drop?.pinned;
  drop = d;
  render();
  if (d.pinned && !wasPinned) setExpanded(true);
});
api.onSpace(a => { available = a; syncHeight(); });
api.onBeginRename(beginRename);
api.onItemRename(beginItemRename);
api.onSetExpanded(v => setExpanded(v));
api.onToast(toast);

(async () => {
  const res = await api.init();
  if (!res) return;
  drop = res.drop;
  available = res.available;
  render();
  if (drop.pinned) setExpanded(true);
  if (new URLSearchParams(location.search).has('rename')) beginRename();
})();
