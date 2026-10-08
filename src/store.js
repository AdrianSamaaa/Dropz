// Persists Drops and settings as JSON in the user data folder.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COLORS = ['#7c6cff', '#3fa9f5', '#2ec5a5', '#f5b83f', '#ff7a59', '#ff5fa2', '#a178ff', '#94a3b8'];

const DEFAULTS = {
  version: 3,
  settings: {
    alwaysOnTop: false,
    tidyDesktop: true, // apps added to a Drop leave the desktop
    openAtLogin: true, // Drops come back after a restart
  },
  drops: [],
};

const uid = () => crypto.randomBytes(6).toString('hex');

class Store {
  constructor(file) {
    this.file = file;
    this.timer = null;
    this.data = this.load();
  }

  // Loads drops.json, falling back to drops.json.bak (the last copy that loaded fine).
  // A file that can't be read is set aside rather than overwritten by the next save.
  load() {
    for (const file of [this.file, this.file + '.bak']) {
      let raw;
      try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
      try {
        const data = JSON.parse(raw);
        if (file === this.file) fs.writeFileSync(this.file + '.bak', raw);
        return { ...DEFAULTS, ...data, settings: { ...DEFAULTS.settings, ...data.settings } };
      } catch {
        try { fs.renameSync(file, `${file}.broken-${Date.now()}`); } catch { /* leave it */ }
      }
    }
    return structuredClone(DEFAULTS);
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveNow(), 250);
  }

  saveNow() {
    clearTimeout(this.timer);
    this.timer = null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get settings() { return this.data.settings; }
  get drops() { return this.data.drops; }

  drop(id) { return this.data.drops.find(d => d.id === id); }

  createDrop({ name, x, y }) {
    const drop = {
      id: uid(),
      name: name || 'New Drop',
      color: COLORS[this.data.drops.length % COLORS.length],
      x, y,
      pinned: false,
      items: [],
    };
    this.data.drops.push(drop);
    this.save();
    return drop;
  }

  removeDrop(id) {
    this.data.drops = this.data.drops.filter(d => d.id !== id);
    this.save();
  }
}

module.exports = { Store, COLORS, uid };
