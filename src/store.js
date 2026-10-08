// Persists Drops and settings as JSON in the user data folder.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COLORS = ['#7c6cff', '#3fa9f5', '#2ec5a5', '#f5b83f', '#ff7a59', '#ff5fa2', '#a178ff', '#94a3b8'];

const DEFAULTS = {
  version: 2,
  settings: {
    alwaysOnTop: false,
    tidyDesktop: true, // apps added to a Drop leave the desktop
    openAtLogin: false,
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

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { ...DEFAULTS, ...data, settings: { ...DEFAULTS.settings, ...data.settings } };
    } catch {
      return structuredClone(DEFAULTS);
    }
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
