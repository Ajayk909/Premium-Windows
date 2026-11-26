// Tiny JSON store in %APPDATA%\Premium. Writes are batched and atomic (temp file + rename).
import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(dir) {
    this.file = path.join(dir, 'premium-data.json');
    this.data = {};
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      // First launch, or a damaged file: try the backup copy.
      try { this.data = JSON.parse(fs.readFileSync(this.file + '.bak', 'utf8')); } catch { this.data = {}; }
    }
    this.timer = null;
  }

  get(key) { return this.data[key]; }

  set(key, value) {
    this.data[key] = value;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 800);
  }

  flush() {
    clearTimeout(this.timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + '.bak');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[store]', e);
    }
  }
}
