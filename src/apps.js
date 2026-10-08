// Everything that touches the file system or the Windows shell:
// icons, describing dropped paths, scanning for apps, and taking apps off the desktop.
const { app, shell } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn, execFile } = require('child_process');
const readline = require('readline');

const SHORTCUT_EXTS = new Set(['.lnk', '.url', '.appref-ms']);
const APP_EXTS = new Set([...SHORTCUT_EXTS, '.exe', '.bat', '.cmd']);
const ICON_SIZE = 64;

let dataDir = null;
const iconCache = new Map();

// ---------------------------------------------------------------- icons

// One PowerShell process stays alive and answers shell requests (icons, desktop
// refreshes) over stdio, so each costs ~10ms instead of a process start.
class ShellWorker {
  constructor() {
    this.proc = null;
    this.ready = null;
    this.pending = new Map();
    this.nextId = 1;
    this.failures = 0;
  }

  start() {
    const script = path.join(dataDir, 'iconworker.ps1');
    // The bundled script may live inside an asar archive, which PowerShell can't read.
    fs.writeFileSync(script, fs.readFileSync(path.join(__dirname, 'iconworker.ps1')));
    const proc = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.proc = proc;
    proc.stdin.on('error', () => { /* worker went away; pending requests resolve on exit */ });
    this.ready = new Promise(resolve => {
      const rl = readline.createInterface({ input: proc.stdout });
      rl.on('line', line => {
        if (line === 'READY') return resolve(true);
        const tab = line.indexOf('\t');
        const cb = this.pending.get(line.slice(0, tab));
        if (cb) cb(line.slice(tab + 1).trim());
      });
      proc.on('error', () => resolve(false));
      proc.on('exit', () => {
        resolve(false);
        if (this.proc === proc) this.proc = null;
        this.failures++;
        for (const cb of [...this.pending.values()]) cb('');
      });
    });
  }

  // op: an icon size, or a shell change event (see iconworker.ps1). Resolves '' on failure.
  async request(p, op) {
    if (this.failures >= 3) return '';
    if (!this.proc) this.start();
    if (!(await this.ready) || !this.proc) return '';
    const id = String(this.nextId++);
    return new Promise(resolve => {
      let timer = 0;
      const done = result => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(result);
      };
      timer = setTimeout(() => done(''), 10000);
      this.pending.set(id, done);
      try {
        this.proc.stdin.write(`${id}\t${Buffer.from(p, 'utf8').toString('base64')}\t${op}\n`);
      } catch {
        done('');
      }
    });
  }

  async icon(p) {
    const png = await this.request(p, ICON_SIZE);
    return png ? `data:image/png;base64,${png}` : null;
  }

  stop() {
    if (this.proc) this.proc.kill();
    this.proc = null;
  }
}

const worker = new ShellWorker();

const expandEnv = s => s.replace(/%([^%]+)%/g, (m, k) => process.env[k] ?? m);

// Electron's own icon lookup only knows exe/dll/ico files; resolve shortcuts first.
async function fallbackIcon(p) {
  const candidates = [];
  if (path.extname(p).toLowerCase() === '.lnk') {
    try {
      const link = shell.readShortcutLink(p);
      if (link.icon) candidates.push(expandEnv(link.icon));
      if (link.target) candidates.push(link.target);
    } catch { /* not a readable shortcut */ }
  }
  candidates.push(p);
  for (const c of candidates) {
    try {
      const img = await app.getFileIcon(c, { size: 'large' });
      if (!img.isEmpty()) return img.toDataURL();
    } catch { /* try next */ }
  }
  return null;
}

async function iconFor(p) {
  const key = p.toLowerCase();
  if (iconCache.has(key)) return iconCache.get(key);
  const url = (await worker.icon(p)) || (await fallbackIcon(p));
  iconCache.set(key, url);
  return url;
}

// ---------------------------------------------------------------- paths

function displayName(p, isDir) {
  if (isDir) return path.basename(p) || p;
  const ext = path.extname(p);
  return APP_EXTS.has(ext.toLowerCase()) ? path.basename(p, ext) : path.basename(p);
}

function kindOf(p, isDir) {
  if (isDir) return 'folder';
  return APP_EXTS.has(path.extname(p).toLowerCase()) ? 'app' : 'file';
}

async function describe(p) {
  try {
    const st = await fsp.stat(p);
    return { name: displayName(p, st.isDirectory()), kind: kindOf(p, st.isDirectory()) };
  } catch {
    return null;
  }
}

const norm = p => path.resolve(p).toLowerCase();

const publicDesktop = () => path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop');

function desktopDirs() {
  return [app.getPath('desktop'), publicDesktop()];
}

function startMenuDirs() {
  return [
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ];
}

const JUNK = /\b(uninstall|uninst|readme|read me|help|manual|documentation|license|licence|release notes|changelog|website|web site|faq)\b/i;

// Everything the "Add apps" picker can offer: desktop entries first, then Start menu apps.
async function scanCandidates() {
  const seen = new Set();
  const desktop = [];
  for (const dir of desktopDirs()) {
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (/^desktop\.ini$/i.test(e.name) || e.name.startsWith('~$') || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      const isDir = e.isDirectory();
      const name = displayName(full, isDir);
      const kind = kindOf(full, isDir);
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      desktop.push({ path: full, name, kind, source: kind === 'app' ? 'desktop' : 'desktopFiles' });
    }
  }

  const start = [];
  async function walk(dir, depth) {
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 4) await walk(full, depth + 1);
        continue;
      }
      const ext = path.extname(e.name).toLowerCase();
      if (ext !== '.lnk' && ext !== '.url') continue;
      const name = displayName(full, false);
      if (JUNK.test(name) || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      start.push({ path: full, name, kind: 'app', source: 'start' });
    }
  }
  for (const dir of startMenuDirs()) await walk(dir, 0);

  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  return [...desktop.sort(byName), ...start.sort(byName)];
}

// ---------------------------------------------------------------- tidy: taking apps off the desktop
//
//  - shortcuts on your desktop are moved into the Drops data folder;
//  - shortcuts on the shared (Public) desktop are moved too, which needs one admin
//    prompt when Windows won't let us delete them;
//  - programs, files and folders on your desktop are only hidden, so nothing that
//    depends on where they live breaks.

const sameDir = (p, dir) => norm(path.dirname(p)) === norm(dir);

function tidyMode(p) {
  const shortcut = SHORTCUT_EXTS.has(path.extname(p).toLowerCase());
  if (sameDir(p, app.getPath('desktop'))) return shortcut ? 'move' : 'hide';
  if (sameDir(p, publicDesktop()) && shortcut) return 'shared';
  return null;
}

const tidyDir = () => path.join(dataDir, 'Tidied');

function uniquePath(p) {
  const ext = path.extname(p);
  const base = p.slice(0, p.length - ext.length);
  let candidate = p;
  for (let i = 2; fs.existsSync(candidate); i++) candidate = `${base} (${i})${ext}`;
  return candidate;
}

async function moveFile(src, dst) {
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  try {
    await fsp.rename(src, dst);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.copyFile(src, dst);
    await fsp.unlink(src);
  }
}

async function stash(p) {
  const dst = uniquePath(path.join(tidyDir(), path.basename(p)));
  await moveFile(p, dst);
  return dst;
}

const psQuote = s => `'${s.replace(/'/g, "''")}'`;

// Writes a PowerShell script (with a BOM, so Windows PowerShell reads non-ASCII paths right).
function writeScript(lines) {
  const file = path.join(dataDir, `elevated-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`);
  fs.writeFileSync(file, '\ufeff' + lines.join('\r\n') + '\r\n', 'utf8');
  return file;
}

// Runs the lines as administrator: Windows shows one UAC prompt. Resolves false if declined.
function runElevated(lines) {
  const script = writeScript(lines);
  const args = `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}"`;
  const command = `try { Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList ${psQuote(args)} } catch { exit 1 }`;
  return new Promise(resolve => {
    const ps = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: 'ignore' });
    const done = ok => { fs.rm(script, { force: true }, () => {}); resolve(ok); };
    ps.on('exit', code => done(code === 0));
    ps.on('error', () => done(false));
  });
}

// Shared-desktop shortcuts: move them if Windows allows it, otherwise copy them and
// delete the originals in one elevated step. Returns Map(original -> new path).
async function stashShared(paths) {
  const moved = new Map();
  const copies = new Map();
  for (const p of paths) {
    try {
      moved.set(p, await stash(p));
      continue;
    } catch (e) {
      if (e.code !== 'EPERM' && e.code !== 'EACCES') continue;
    }
    try {
      const dst = uniquePath(path.join(tidyDir(), path.basename(p)));
      await fsp.copyFile(p, dst);
      copies.set(p, dst);
    } catch { /* unreadable; leave it */ }
  }
  if (copies.size) {
    await runElevated([...copies.keys()].map(p => `Remove-Item -LiteralPath ${psQuote(p)} -Force`));
    for (const [src, dst] of copies) {
      if (fs.existsSync(src)) await fsp.rm(dst, { force: true });
      else moved.set(src, dst);
    }
  }
  return moved;
}

function attrib(args) {
  return new Promise(resolve => {
    execFile('attrib.exe', args, { windowsHide: true }, (err, out) => resolve(err ? null : String(out)));
  });
}

// Hides or unhides a file/folder in place. Returns true if it ended up as asked.
async function setHidden(p, hidden) {
  await attrib([hidden ? '+h' : '-h', p]);
  const out = await attrib([p]);
  if (out == null) return false;
  const flags = out.slice(0, Math.max(0, out.indexOf(':\\') - 1));
  return flags.includes('H') === hidden;
}

// Explorer doesn't always notice when another program changes the desktop (OneDrive
// desktops especially), so tell it directly. changes: [{ event: create|delete|update, path }]
async function refreshDesktop(changes) {
  for (const { event, path: p } of changes) await worker.request(p, event);
  for (const dir of desktopDirs()) await worker.request(dir, 'updatedir');
}

// Undoes whatever tidy did. Returns the item's path afterwards.
async function restore(item) {
  if (item.hidden) {
    if (!(await setHidden(item.path, false))) throw new Error('Windows would not unhide it.');
    await refreshDesktop([{ event: 'update', path: item.path }]);
    return item.path;
  }
  if (item.originalPath) {
    // Shared-desktop shortcuts come back to your own desktop, which needs no admin rights.
    const home = sameDir(item.originalPath, publicDesktop())
      ? path.join(app.getPath('desktop'), path.basename(item.originalPath))
      : item.originalPath;
    const dst = uniquePath(home);
    await moveFile(item.path, dst);
    await refreshDesktop([{ event: 'create', path: dst }]);
    return dst;
  }
  return item.path;
}

// ---------------------------------------------------------------- launching

function runAsAdmin(p) {
  const quoted = p.replace(/'/g, "''");
  spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Start-Process -FilePath '${quoted}' -Verb RunAs`],
    { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
}

function revealTarget(p) {
  if (path.extname(p).toLowerCase() === '.lnk') {
    try {
      const { target } = shell.readShortcutLink(p);
      if (target && fs.existsSync(target)) return shell.showItemInFolder(target);
    } catch { /* fall through */ }
  }
  shell.showItemInFolder(p);
}

module.exports = {
  init(dir) { dataDir = dir; fs.mkdirSync(dir, { recursive: true }); },
  dispose() { worker.stop(); },
  iconFor, describe, scanCandidates, tidyMode, stash, stashShared, setHidden, restore, refreshDesktop,
  writeScript, psQuote,
  runAsAdmin, revealTarget, norm,
};
