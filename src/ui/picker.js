// "Add apps" window: pick apps from the desktop and Start menu for one Drop.
const api = window.drops.picker;
const $ = id => document.getElementById(id);
const q = $('q'), seg = $('seg'), scroll = $('scroll'), statusEl = $('status');
const tidyEl = $('tidy'), addBtn = $('add'), browseBtn = $('browse'), toastEl = $('toast');
const sections = { desktop: $('secDesktop'), start: $('secStart'), desktopFiles: $('secDesktopFiles') };
const TAB_OF = { desktop: 'desktop', desktopFiles: 'desktop', start: 'start' };

const CHECK = '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M3.5 8.5 6.5 11.5 12.5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const FALLBACK = {
  folder: '<svg viewBox="0 0 24 24"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2h8.4A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" fill="#f5c451"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>',
  app: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 8.5h18"/></svg>',
};

let target = null;
let filter = 'all';
let toastTimer = 0;
const selected = new Set();
const tiles = new Map(); // path -> tile

// ------------------------------------------------------------------ icons, loaded as tiles scroll into view

const queue = [];
let running = 0;

function pump() {
  while (running < 4 && queue.length) {
    const tile = queue.shift();
    running++;
    api.icon(tile.dataset.path).then(url => {
      const box = tile.querySelector('.tico');
      if (url) {
        const img = new Image();
        img.src = url;
        img.alt = '';
        box.replaceChildren(img);
      } else {
        box.innerHTML = `<span class="fallback">${FALLBACK[tile.dataset.kind] || FALLBACK.file}</span>`;
      }
    }).finally(() => { running--; pump(); });
  }
}

const observer = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    observer.unobserve(entry.target);
    queue.push(entry.target);
  }
  pump();
}, { root: scroll, rootMargin: '300px' });

// ------------------------------------------------------------------ tiles

function tileFor(c) {
  const tile = document.createElement('button');
  tile.className = 'tile';
  tile.title = c.path;
  tile.dataset.path = c.path;
  tile.dataset.kind = c.kind;
  tile.dataset.name = c.name.toLowerCase();
  tile.innerHTML = `<span class="tico"><span class="ph"></span></span><span class="tname"></span><span class="check">${CHECK}</span>`;
  tile.querySelector('.tname').textContent = c.name;
  tile.addEventListener('click', () => {
    if (selected.has(c.path)) selected.delete(c.path);
    else selected.add(c.path);
    tile.classList.toggle('on', selected.has(c.path));
    updateAdd();
  });
  tiles.set(c.path, tile);
  observer.observe(tile);
  return tile;
}

function updateAdd() {
  const n = selected.size;
  addBtn.disabled = n === 0;
  addBtn.textContent = n ? `Add ${n} app${n === 1 ? '' : 's'}` : 'Add';
}

function applyTarget(t) {
  if (!t) return api.close();
  target = t;
  document.documentElement.style.setProperty('--accent', t.color);
  $('dropName').textContent = t.name;
  document.title = `Add apps to ${t.name}`;
  tidyEl.checked = t.tidy;
  const have = new Set(t.have);
  for (const [p, tile] of tiles) {
    const added = have.has(p.toLowerCase());
    if (added) selected.delete(p);
    tile.classList.toggle('added', added);
    tile.classList.toggle('on', selected.has(p));
    tile.disabled = added;
  }
  updateAdd();
}

function applyFilter() {
  const term = q.value.trim().toLowerCase();
  let shown = 0;
  for (const [key, section] of Object.entries(sections)) {
    let n = 0;
    for (const tile of section.querySelector('.grid').children) {
      const match = !term || tile.dataset.name.includes(term);
      tile.hidden = !match;
      if (match) n++;
    }
    section.querySelector('.count').textContent = n;
    section.hidden = n === 0 || (filter !== 'all' && filter !== TAB_OF[key]);
    if (!section.hidden) shown += n;
  }
  statusEl.hidden = shown > 0;
  statusEl.textContent = term ? `No apps match "${q.value.trim()}"` : 'No apps found here';
}

function toast(text, ms = 2600) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
}

// ------------------------------------------------------------------ actions

async function addSelected() {
  if (!selected.size) return;
  addBtn.disabled = true;
  const { tidyFailed } = await api.add([...selected], tidyEl.checked);
  selected.clear();
  if (tidyFailed) {
    toast(`Added. ${tidyFailed} couldn't be removed from the desktop (admin permission was declined or Windows refused).`, 3200);
    setTimeout(() => api.close(), 3200);
  } else {
    api.close();
  }
}

addBtn.addEventListener('click', addSelected);

browseBtn.addEventListener('click', async () => {
  const { added } = await api.browse();
  if (added) toast(`Added ${added} to ${target.name}`);
});

seg.addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  filter = btn.dataset.f;
  for (const b of seg.children) b.classList.toggle('on', b === btn);
  applyFilter();
});

q.addEventListener('input', applyFilter);
q.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.ctrlKey) return;
  const visible = [...tiles.values()].filter(t => !t.hidden && !t.closest('section').hidden && !t.disabled);
  if (visible.length === 1) visible[0].click();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') api.close();
  else if (e.key === 'Enter' && e.ctrlKey) addSelected();
});

api.onTarget(applyTarget);

(async () => {
  applyTarget(await api.init());
  const candidates = await api.scan();
  for (const c of candidates) sections[c.source].querySelector('.grid').append(tileFor(c));
  applyTarget(target);
  applyFilter();
  q.focus();
})();
