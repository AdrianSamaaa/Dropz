// Development helper: DROPS_SNAPSHOT=<dir> [DROPS_SEED=<json file>] npm start
// Seeds Drops, captures every window collapsed/expanded plus the picker, then quits.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const apps = require('./apps');

const wait = ms => new Promise(r => setTimeout(r, ms));
const isHidden = p => {
  const out = execFileSync('attrib.exe', [p], { windowsHide: true }).toString();
  return out.slice(0, out.indexOf(':\\') - 1).includes('H');
};

module.exports = async function snapshot(ctx) {
  const dir = path.resolve(process.env.DROPS_SNAPSHOT);
  fs.mkdirSync(dir, { recursive: true });
  const log = [];

  if (process.env.DROPS_SEED) {
    const seed = JSON.parse(fs.readFileSync(process.env.DROPS_SEED, 'utf8'));
    for (const { name, paths, x, y, color } of seed) {
      let drop = ctx.store.drops.find(d => d.name === name);
      if (!drop) {
        drop = ctx.store.createDrop({ name, x, y });
        if (color) drop.color = color;
        ctx.createDropWindow(drop);
      }
      await ctx.addPaths(drop, paths, null, false);
    }
  }

  await wait(2500);
  const capture = async (win, name) => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(dir, `${name}.png`), img.toPNG());
        log.push(`${name}: ${JSON.stringify(win.getBounds())}`);
        return;
      } catch (err) {
        if (attempt === 4) log.push(`${name}: capture failed (${err.message})`);
        await wait(500);
      }
    }
  };

  for (const [id, win] of ctx.dropWins) await capture(win, `${ctx.store.drop(id).name}-collapsed`);
  for (const win of ctx.dropWins.values()) win.webContents.send('drop:setExpanded', true);
  await wait(900);
  for (const [id, win] of ctx.dropWins) await capture(win, `${ctx.store.drop(id).name}-expanded`);

  ctx.openPicker(ctx.store.drops[ctx.store.drops.length - 1].id);
  await wait(4000);
  const picker = ctx.getPicker();
  if (picker) await capture(picker, 'picker');

  if (process.env.DROPS_SELFTEST) await selfTest(ctx, dir, log);

  fs.writeFileSync(path.join(dir, 'bounds.txt'), log.join('\n'));
  app.quit();
};

// Exercises tidy (against a fake desktop) and the rename flows through the real UI.
async function selfTest(ctx, dir, log) {
  const check = (name, ok) => log.push(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  const fakeDesktop = path.join(dir, 'FakeDesktop');
  fs.mkdirSync(fakeDesktop, { recursive: true });
  app.setPath('desktop', fakeDesktop);
  const shortcut = path.join(fakeDesktop, 'Example Site.url');
  fs.writeFileSync(shortcut, '[InternetShortcut]\r\nURL=https://example.com/\r\n');

  const drop = ctx.store.drops[0];
  const win = ctx.dropWins.get(drop.id);
  await ctx.addPaths(drop, [shortcut], 0, true);
  const item = drop.items[0];
  check('tidy moves shortcut off desktop', !fs.existsSync(shortcut) && fs.existsSync(item.path) && item.originalPath === shortcut);
  check('tidied item keeps name', item.name === 'Example Site');

  await ctx.removeItem(drop, item.id);
  check('removing puts shortcut back', fs.existsSync(shortcut) && !drop.items.some(i => i.id === item.id));

  // folders on your desktop are hidden in place, not moved
  const folder = path.join(fakeDesktop, 'School Notes');
  fs.mkdirSync(folder, { recursive: true });
  await ctx.addPaths(drop, [folder], null, true);
  const folderItem = drop.items.find(i => i.path === folder);
  check('folder is hidden, not moved', folderItem?.hidden === true && isHidden(folder));
  await ctx.removeItem(drop, folderItem.id);
  check('removing unhides folder', !isHidden(folder) && fs.existsSync(folder));

  // shared (Public) desktop shortcuts leave too, and come back to your own desktop
  const fakePublic = path.join(dir, 'FakePublic');
  fs.mkdirSync(path.join(fakePublic, 'Desktop'), { recursive: true });
  process.env.PUBLIC = fakePublic;
  const shared = path.join(fakePublic, 'Desktop', 'Shared Game.url');
  fs.writeFileSync(shared, '[InternetShortcut]\r\nURL=https://example.org/\r\n');
  await ctx.addPaths(drop, [shared], null, true);
  const sharedItem = drop.items.find(i => i.originalPath === shared);
  check('shared shortcut leaves the shared desktop', !!sharedItem && !fs.existsSync(shared) && fs.existsSync(sharedItem.path));
  await ctx.removeItem(drop, sharedItem.id);
  check('shared shortcut comes back on your desktop', fs.existsSync(path.join(fakeDesktop, 'Shared Game.url')));

  // the admin script survives awkward file names
  const awkward = path.join(fakePublic, 'Desktop', "Bob's Gämë – test.lnk");
  fs.writeFileSync(awkward, 'x');
  const script = apps.writeScript([`Remove-Item -LiteralPath ${apps.psQuote(awkward)} -Force`]);
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true });
  fs.rmSync(script, { force: true });
  check('admin script handles quotes and accents', !fs.existsSync(awkward));

  await ctx.addPaths(drop, [shortcut, shortcut], null, false);
  check('duplicates ignored', drop.items.filter(i => i.originalPath === shortcut || i.path === shortcut).length === 1);

  win.show();
  win.focus();
  win.webContents.send('drop:beginRename');
  await wait(300);
  await win.webContents.executeJavaScript(`(() => {
    const i = document.getElementById('nameInput');
    i.value = 'Renamed Drop';
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await wait(400);
  check('drop rename saves', drop.name === 'Renamed Drop');

  const target = drop.items[drop.items.length - 1];
  win.webContents.send('item:beginRename', target.id);
  await wait(400);
  await win.webContents.executeJavaScript(`(() => {
    const i = document.querySelector('.row-input');
    i.value = 'Renamed Item';
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await wait(400);
  check('item rename saves', target.name === 'Renamed Item');
  await win.webContents.executeJavaScript(`document.querySelectorAll('.row').length`).then(n =>
    check('list shows all items after rename', n === drop.items.length));

  const img = await win.webContents.capturePage().catch(() => null);
  if (img) fs.writeFileSync(path.join(dir, 'selftest.png'), img.toPNG());
}
