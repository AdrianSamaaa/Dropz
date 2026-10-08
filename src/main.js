const {
  app, BrowserWindow, Tray, Menu, ipcMain, screen, dialog, globalShortcut, nativeImage, nativeTheme, shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { Store, COLORS, uid } = require('./store');
const apps = require('./apps');

if (process.env.DROPS_DATA_DIR) app.setPath('userData', path.resolve(process.env.DROPS_DATA_DIR));

const WIN_W = 272; // drop window width, including the transparent shadow margin
const COLOR_NAMES = ['Violet', 'Sky', 'Mint', 'Amber', 'Coral', 'Pink', 'Lavender', 'Slate'];
const SHOW_ALL_KEY = 'CommandOrControl+Alt+D';
const ICON = path.join(__dirname, '..', 'assets', 'icon.ico');
const PRELOAD = path.join(__dirname, 'preload.js');

let store;
let tray = null;
let picker = null;
let pickerDropId = null;
let quitting = false;
const dropWins = new Map(); // drop id -> BrowserWindow
const moveTimers = new Map(); // window id -> interval

// ------------------------------------------------------------------ helpers

function payload(drop) {
  return { ...drop, items: drop.items.map(i => ({ ...i, missing: !fs.existsSync(i.path) })) };
}

function push(drop) {
  const win = dropWins.get(drop.id);
  if (win && !win.isDestroyed()) win.webContents.send('drop:update', payload(drop));
  if (picker && !picker.isDestroyed() && pickerDropId === drop.id) picker.webContents.send('picker:target', pickerTarget());
  updateTray();
}

function dropOf(e) {
  for (const [id, win] of dropWins) if (!win.isDestroyed() && win.webContents === e.sender) return store.drop(id);
  return null;
}

function availableBelow(win) {
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  return wa.y + wa.height - b.y;
}

function colorDot(hex) {
  const size = 16;
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
      const a = Math.max(0, Math.min(1, 6.5 - d));
      const i = (y * size + x) * 4;
      // BGRA, premultiplied
      buf[i] = b * a; buf[i + 1] = g * a; buf[i + 2] = r * a; buf[i + 3] = 255 * a;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function freeSpot() {
  const wa = screen.getPrimaryDisplay().workArea;
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 6; col++) {
      const x = wa.x + wa.width - (WIN_W + 4) * (col + 1) - 20;
      const y = wa.y + 24 + row * 84;
      const taken = store.drops.some(d => Math.abs(d.x - x) < WIN_W - 40 && Math.abs(d.y - y) < 70);
      if (!taken) return { x, y };
    }
  }
  return { x: wa.x + 120, y: wa.y + 120 };
}

function ensureOnScreen(drop) {
  const visible = screen.getAllDisplays().some(({ workArea: wa }) =>
    drop.x > wa.x - WIN_W + 60 && drop.x < wa.x + wa.width - 60 &&
    drop.y >= wa.y - 8 && drop.y < wa.y + wa.height - 60);
  if (!visible) Object.assign(drop, freeSpot());
}

// ------------------------------------------------------------------ drop windows

function createDropWindow(drop, { rename = false } = {}) {
  ensureOnScreen(drop);
  const win = new BrowserWindow({
    x: drop.x, y: drop.y, width: WIN_W, height: 90,
    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    skipTaskbar: true, type: 'toolbar', show: false,
    alwaysOnTop: store.settings.alwaysOnTop,
    title: drop.name, icon: ICON,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, spellcheck: false },
  });
  dropWins.set(drop.id, win);
  win.loadFile(path.join(__dirname, 'ui', 'drop.html'), { query: rename ? { rename: '1' } : {} });
  win.once('ready-to-show', () => {
    if (rename) { win.show(); win.focus(); } else win.showInactive();
  });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Alt+F4 shouldn't make a Drop vanish; only quitting or deleting closes it.
  win.on('close', e => { if (!quitting && store.drop(drop.id)) e.preventDefault(); });
  win.on('query-session-end', () => { quitting = true; store.saveNow(); });
  win.on('closed', () => {
    stopMove(win);
    if (dropWins.get(drop.id) === win) dropWins.delete(drop.id);
  });
  return win;
}

function newDrop() {
  const drop = store.createDrop({ name: 'New Drop', ...freeSpot() });
  createDropWindow(drop, { rename: true });
  updateTray();
  return drop;
}

function showAll() {
  for (const win of dropWins.values()) {
    if (win.isDestroyed()) continue;
    if (win.isMinimized()) win.restore();
    win.showInactive();
    win.moveTop();
  }
}

function stopMove(win) {
  clearInterval(moveTimers.get(win.id));
  moveTimers.delete(win.id);
}

async function deleteDrop(drop) {
  const win = dropWins.get(drop.id);
  const tidied = drop.items.filter(isTidied).length;
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
    title: 'Delete Drop',
    message: `Delete "${drop.name}"?`,
    detail: 'Only the Drop is removed. Your apps stay installed.' +
      (tidied ? ` Its ${tidied} app${tidied === 1 ? '' : 's'} will go back on your desktop.` : ''),
  });
  if (response !== 0) return;
  for (const item of drop.items) {
    if (isTidied(item) && fs.existsSync(item.path)) {
      try { await apps.restore(item); } catch { /* stays in the Tidied folder / hidden */ }
    }
  }
  store.removeDrop(drop.id);
  if (win && !win.isDestroyed()) win.destroy();
  updateTray();
}

// ------------------------------------------------------------------ items

const isTidied = item => !!(item.originalPath || item.hidden);
const tidying = new Set(); // item ids with a tidy in progress

// Takes items off the desktop (see apps.js for how). Returns how many couldn't be.
async function tidyItems(items) {
  items = items.filter(i => !tidying.has(i.id) && !isTidied(i) && fs.existsSync(i.path));
  items.forEach(i => tidying.add(i.id));
  try {
    return await tidyNow(items);
  } finally {
    items.forEach(i => tidying.delete(i.id));
  }
}

async function tidyNow(items) {
  let failed = 0;
  const shared = [];
  const changes = [];
  for (const item of items) {
    const mode = apps.tidyMode(item.path);
    if (mode === 'move') {
      try {
        const from = item.path;
        item.path = await apps.stash(from);
        item.originalPath = from;
        changes.push({ event: 'delete', path: from });
      } catch {
        failed++;
      }
    } else if (mode === 'hide') {
      if (await apps.setHidden(item.path, true)) {
        item.hidden = true;
        changes.push({ event: 'update', path: item.path });
      } else {
        failed++;
      }
    } else if (mode === 'shared') {
      shared.push(item);
    }
  }
  if (shared.length) {
    const moved = await apps.stashShared(shared.map(i => i.path));
    for (const item of shared) {
      const dst = moved.get(item.path);
      if (!dst) { failed++; continue; }
      changes.push({ event: 'delete', path: item.path });
      item.originalPath = item.path;
      item.path = dst;
    }
  }
  store.save();
  if (changes.length) await apps.refreshDesktop(changes);
  return failed;
}

async function tidyEverything() {
  await tidyItems(store.drops.flatMap(d => d.items));
  store.drops.forEach(push);
}

async function addPaths(drop, paths, index, tidy = store.settings.tidyDesktop) {
  const have = new Set(drop.items.flatMap(i => [i.path, i.originalPath]).filter(Boolean).map(apps.norm));
  const added = [];
  for (const raw of paths) {
    if (!raw) continue;
    const p = path.resolve(raw);
    if (have.has(apps.norm(p))) continue;
    const info = await apps.describe(p);
    if (!info) continue;
    have.add(apps.norm(p));
    added.push({ id: uid(), name: info.name, kind: info.kind, path: p, icon: await apps.iconFor(p) });
  }
  const at = index == null ? drop.items.length : Math.max(0, Math.min(index, drop.items.length));
  drop.items.splice(at, 0, ...added);
  store.save();
  push(drop);
  // Show the apps in the Drop right away; taking them off the desktop may wait on a UAC prompt.
  const tidyFailed = tidy && added.length ? await tidyItems(added) : 0;
  if (tidy && added.length) push(drop);
  return { added: added.length, tidyFailed };
}

async function removeItem(drop, itemId) {
  const item = drop.items.find(i => i.id === itemId);
  if (!item) return;
  if (isTidied(item) && fs.existsSync(item.path)) {
    try {
      await apps.restore(item);
    } catch (err) {
      dialog.showMessageBox(dropWins.get(drop.id), {
        type: 'warning', title: 'Drops',
        message: `Couldn't put "${item.name}" back on the desktop.`,
        detail: `${err.message}\n\nIt's at ${item.path}`,
      });
      return;
    }
  }
  drop.items = drop.items.filter(i => i.id !== itemId);
  store.save();
  push(drop);
}

function moveItem(fromDrop, toDrop, itemId, index) {
  const at = fromDrop.items.findIndex(i => i.id === itemId);
  if (at < 0) return;
  const [item] = fromDrop.items.splice(at, 1);
  const to = index == null ? toDrop.items.length : Math.max(0, Math.min(index, toDrop.items.length));
  toDrop.items.splice(to, 0, item);
  store.save();
  push(fromDrop);
  if (toDrop !== fromDrop) push(toDrop);
}

async function restoreAll() {
  let restored = 0, failed = 0;
  for (const drop of store.drops) {
    for (const item of drop.items) {
      if (!isTidied(item) || !fs.existsSync(item.path)) continue;
      try {
        item.path = await apps.restore(item);
        delete item.originalPath;
        delete item.hidden;
        restored++;
      } catch {
        failed++;
      }
    }
    push(drop);
  }
  store.save();
  return { restored, failed };
}

async function restoreAllTidied() {
  setSetting('tidyDesktop', false);
  const { restored, failed } = await restoreAll();
  dialog.showMessageBox({
    type: 'info', title: 'Drops',
    message: restored ? `Put ${restored} app${restored === 1 ? '' : 's'} back on your desktop.` : 'Nothing to put back.',
    detail: (failed ? `${failed} couldn't be put back. ` : '') +
      'They stay in your Drops too. "Remove apps from desktop when added" is now off.',
  });
}

// ------------------------------------------------------------------ menus

function popup(win, template) {
  return new Promise(resolve => {
    Menu.buildFromTemplate(template).popup({ window: win, callback: () => resolve() });
  });
}

function dropMenu(drop, win) {
  return popup(win, [
    { label: 'Rename', accelerator: 'F2', click: () => win.webContents.send('drop:beginRename') },
    { label: 'Add apps…', click: () => openPicker(drop.id) },
    { label: drop.pinned ? 'Unpin (close after use)' : 'Pin open', click: () => togglePin(drop) },
    {
      label: 'Color',
      submenu: COLORS.map((c, i) => ({
        label: COLOR_NAMES[i], type: 'radio', checked: drop.color === c, icon: colorDot(c),
        click: () => { drop.color = c; store.save(); push(drop); },
      })),
    },
    { type: 'separator' },
    { label: 'New Drop', click: newDrop },
    { label: 'Delete Drop…', click: () => deleteDrop(drop) },
  ]);
}

function itemMenu(drop, win, item) {
  const others = store.drops.filter(d => d.id !== drop.id);
  return popup(win, [
    { label: 'Open', click: () => launch(drop, item) },
    { label: 'Run as administrator', visible: item.kind === 'app', click: () => apps.runAsAdmin(item.path) },
    { label: 'Open file location', click: () => apps.revealTarget(item.path) },
    { type: 'separator' },
    { label: 'Rename', click: () => win.webContents.send('item:beginRename', item.id) },
    {
      label: 'Move to',
      submenu: [
        ...others.map(d => ({ label: d.name, icon: colorDot(d.color), click: () => moveItem(drop, d, item.id) })),
        ...(others.length ? [{ type: 'separator' }] : []),
        { label: 'New Drop', click: () => moveItem(drop, newDrop(), item.id) },
      ],
    },
    { type: 'separator' },
    {
      label: isTidied(item) ? 'Remove (put back on desktop)' : 'Remove from Drop',
      click: () => removeItem(drop, item.id),
    },
  ]);
}

function togglePin(drop) {
  drop.pinned = !drop.pinned;
  store.save();
  push(drop);
}

async function launch(drop, item) {
  const err = await shell.openPath(item.path);
  if (err) {
    const win = dropWins.get(drop.id);
    const msg = fs.existsSync(item.path) ? `Couldn't open ${item.name}` : `Can't find ${item.name}`;
    if (win && !win.isDestroyed()) win.webContents.send('drop:toast', msg);
  }
  return err || null;
}

// ------------------------------------------------------------------ tray & settings

function applyLoginItem() {
  app.setLoginItemSettings({
    openAtLogin: store.settings.openAtLogin,
    path: process.execPath,
    args: app.isPackaged ? [] : [app.getAppPath()],
  });
}

function setSetting(key, value) {
  const was = store.settings[key];
  store.settings[key] = value;
  store.save();
  if (key === 'tidyDesktop' && value && !was) tidyEverything();
  if (key === 'alwaysOnTop') for (const w of dropWins.values()) if (!w.isDestroyed()) w.setAlwaysOnTop(value);
  if (key === 'openAtLogin') applyLoginItem();
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const s = store.settings;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Drops', enabled: false },
    { type: 'separator' },
    { label: 'New Drop', click: newDrop },
    { label: 'Show all Drops', accelerator: SHOW_ALL_KEY, click: showAll },
    {
      label: 'Add apps to',
      enabled: store.drops.length > 0,
      submenu: store.drops.map(d => ({ label: d.name, icon: colorDot(d.color), click: () => openPicker(d.id) })),
    },
    { type: 'separator' },
    { label: 'Keep Drops on top of windows', type: 'checkbox', checked: s.alwaysOnTop, click: m => setSetting('alwaysOnTop', m.checked) },
    { label: 'Remove apps from desktop when added', type: 'checkbox', checked: s.tidyDesktop, click: m => setSetting('tidyDesktop', m.checked) },
    { label: 'Start with Windows', type: 'checkbox', checked: s.openAtLogin, click: m => setSetting('openAtLogin', m.checked) },
    { type: 'separator' },
    { label: 'Put all apps back on the desktop', click: restoreAllTidied },
    { type: 'separator' },
    { label: 'Quit Drops', click: () => app.quit() },
  ]));
}

// ------------------------------------------------------------------ picker window

function pickerTarget() {
  const drop = store.drop(pickerDropId);
  if (!drop) return null;
  return {
    id: drop.id, name: drop.name, color: drop.color,
    have: drop.items.flatMap(i => [i.path, i.originalPath]).filter(Boolean).map(apps.norm),
    tidy: store.settings.tidyDesktop,
  };
}

function openPicker(dropId) {
  pickerDropId = dropId;
  if (picker && !picker.isDestroyed()) {
    picker.webContents.send('picker:target', pickerTarget());
    picker.show();
    picker.focus();
    return;
  }
  picker = new BrowserWindow({
    width: 640, height: 700, minWidth: 460, minHeight: 440,
    title: 'Add apps', icon: ICON, show: false,
    backgroundColor: '#14161b',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#14161b', symbolColor: '#c9ced8', height: 44 },
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, spellcheck: false },
  });
  picker.loadFile(path.join(__dirname, 'ui', 'picker.html'));
  picker.once('ready-to-show', () => picker.show());
  picker.webContents.on('will-navigate', e => e.preventDefault());
  picker.on('closed', () => { picker = null; });
}

// ------------------------------------------------------------------ IPC

function registerIpc() {
  // --- drop windows
  ipcMain.handle('drop:init', e => {
    const drop = dropOf(e);
    const win = BrowserWindow.fromWebContents(e.sender);
    return drop && { drop: payload(drop), available: availableBelow(win) };
  });

  ipcMain.handle('drop:setHeight', (e, h) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const available = availableBelow(win);
    const height = Math.max(40, Math.min(Math.round(h), available));
    const b = win.getBounds();
    if (height > b.height) win.moveTop();
    win.setBounds({ x: b.x, y: b.y, width: WIN_W, height });
    return { height, available };
  });

  ipcMain.on('drop:moveStart', (e, { ox, oy }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    stopMove(win);
    const { width, height } = win.getBounds();
    moveTimers.set(win.id, setInterval(() => {
      if (win.isDestroyed()) return stopMove(win);
      const p = screen.getCursorScreenPoint();
      win.setBounds({ x: Math.round(p.x - ox), y: Math.round(p.y - oy), width, height });
    }, 8));
  });

  ipcMain.on('drop:moveEnd', e => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const drop = dropOf(e);
    if (!win || !drop) return;
    stopMove(win);
    // keep the header reachable
    const b = win.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    const x = Math.min(Math.max(b.x, wa.x - 10), wa.x + wa.width - WIN_W + 10);
    const y = Math.min(Math.max(b.y, wa.y - 8), wa.y + wa.height - 80);
    if (x !== b.x || y !== b.y) win.setBounds({ x, y, width: b.width, height: b.height });
    drop.x = x;
    drop.y = y;
    store.save();
    win.webContents.send('drop:space', availableBelow(win));
  });

  ipcMain.handle('drop:rename', (e, name) => {
    const drop = dropOf(e);
    const clean = String(name || '').trim().slice(0, 40);
    if (!drop || !clean) return;
    drop.name = clean;
    store.save();
    push(drop);
  });

  ipcMain.handle('drop:addPaths', (e, { paths, index }) => {
    const drop = dropOf(e);
    return drop ? addPaths(drop, paths, index) : { added: 0 };
  });

  ipcMain.handle('drop:launch', (e, itemId) => {
    const drop = dropOf(e);
    const item = drop?.items.find(i => i.id === itemId);
    return item ? launch(drop, item) : null;
  });

  ipcMain.handle('drop:reorder', (e, ids) => {
    const drop = dropOf(e);
    if (!drop) return;
    const byId = new Map(drop.items.map(i => [i.id, i]));
    const next = ids.map(id => byId.get(id)).filter(Boolean);
    if (next.length !== drop.items.length) return push(drop);
    drop.items = next;
    store.save();
    push(drop);
  });

  ipcMain.handle('drop:moveItem', (e, { fromDropId, itemId, index }) => {
    const to = dropOf(e);
    const from = store.drop(fromDropId);
    if (to && from) moveItem(from, to, itemId, index);
  });

  ipcMain.handle('drop:renameItem', (e, { itemId, name }) => {
    const drop = dropOf(e);
    const item = drop?.items.find(i => i.id === itemId);
    const clean = String(name || '').trim().slice(0, 80);
    if (!item || !clean) return;
    item.name = clean;
    store.save();
    push(drop);
  });

  ipcMain.handle('drop:menu', e => {
    const drop = dropOf(e);
    return drop && dropMenu(drop, BrowserWindow.fromWebContents(e.sender));
  });

  ipcMain.handle('drop:itemMenu', (e, itemId) => {
    const drop = dropOf(e);
    const item = drop?.items.find(i => i.id === itemId);
    return item && itemMenu(drop, BrowserWindow.fromWebContents(e.sender), item);
  });

  ipcMain.handle('drop:togglePin', e => {
    const drop = dropOf(e);
    if (drop) togglePin(drop);
  });

  ipcMain.handle('drop:openPicker', e => {
    const drop = dropOf(e);
    if (drop) openPicker(drop.id);
  });

  // --- picker
  ipcMain.handle('picker:init', () => pickerTarget());
  ipcMain.handle('picker:scan', () => apps.scanCandidates());
  ipcMain.handle('picker:icon', (e, p) => apps.iconFor(p));

  ipcMain.handle('picker:add', async (e, { paths, tidy }) => {
    const drop = store.drop(pickerDropId);
    if (!drop) return { added: 0 };
    if (tidy !== store.settings.tidyDesktop) setSetting('tidyDesktop', tidy);
    const result = await addPaths(drop, paths, null, tidy);
    const win = dropWins.get(drop.id);
    if (win && !win.isDestroyed() && result.added) {
      win.show();
      win.focus();
      win.webContents.send('drop:setExpanded', true);
    }
    return result;
  });

  ipcMain.handle('picker:browse', async () => {
    const drop = store.drop(pickerDropId);
    if (!drop) return { added: 0 };
    const { canceled, filePaths } = await dialog.showOpenDialog(picker, {
      title: `Add to ${drop.name}`,
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Apps and shortcuts', extensions: ['exe', 'lnk', 'url', 'appref-ms', 'bat', 'cmd'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (canceled) return { added: 0 };
    return addPaths(drop, filePaths, null, false);
  });

  ipcMain.on('picker:close', () => picker?.close());
}

// ------------------------------------------------------------------ app lifecycle

if (process.argv.includes('--restore-desktop')) {
  // Run by the uninstaller (after it has closed Drops): put everything Drops took off
  // the desktop back, so uninstalling never loses anyone's apps.
  app.whenReady().then(async () => {
    apps.init(app.getPath('userData'));
    store = new Store(path.join(app.getPath('userData'), 'drops.json'));
    await restoreAll();
    store.saveNow();
    apps.dispose();
    app.exit(0);
  });
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('app.drops.organizer');
  app.on('second-instance', showAll);
  app.on('window-all-closed', () => { /* keep running in the tray */ });

  app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark';
    apps.init(app.getPath('userData'));
    store = new Store(path.join(app.getPath('userData'), 'drops.json'));
    registerIpc();

    if (!store.data.initialized) {
      store.data.initialized = true;
      store.createDrop({ name: 'My Apps', ...freeSpot() });
    }
    for (const drop of store.drops) createDropWindow(drop);

    // v2: apps added to a Drop leave the desktop by default, including ones added earlier.
    if (store.data.version < 2) {
      store.data.version = 2;
      store.settings.tidyDesktop = true;
      store.save();
      tidyEverything();
    }

    tray = new Tray(ICON);
    tray.setToolTip('Drops');
    tray.on('click', showAll);
    updateTray();

    globalShortcut.register(SHOW_ALL_KEY, showAll);
    screen.on('display-removed', () => {
      for (const drop of store.drops) {
        const before = `${drop.x},${drop.y}`;
        ensureOnScreen(drop);
        const win = dropWins.get(drop.id);
        if (win && `${drop.x},${drop.y}` !== before) win.setPosition(drop.x, drop.y);
      }
      store.save();
    });

    if (process.env.DROPS_SNAPSHOT) {
      require('./dev-snapshot')({ dropWins, openPicker, store, createDropWindow, addPaths, removeItem, getPicker: () => picker });
    }
  });

  app.on('before-quit', () => {
    quitting = true;
    if (store) store.saveNow();
    apps.dispose();
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
}
