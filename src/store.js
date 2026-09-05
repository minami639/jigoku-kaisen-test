import fs from 'node:fs';
import path from 'node:path';

export class JsonStore {
  constructor(filePath = path.resolve('data', 'rooms.json')) {
    this.filePath = filePath;
    this.rooms = new Map();
    this.load();
  }

  load() {
    try {
      const rows = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      for (const room of rows) this.rooms.set(room.code, room);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify([...this.rooms.values()], null, 2));
    fs.renameSync(temporary, this.filePath);
  }

  set(room) { this.rooms.set(room.code, room); this.save(); return room; }
  get(code) { return this.rooms.get(code?.toUpperCase()); }
}
