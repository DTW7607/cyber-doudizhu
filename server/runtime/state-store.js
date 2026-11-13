'use strict';

// Version 1 remains readable by the previous release. A bad checkpoint is fatal:
// never start an empty game service over somebody's existing identities or hands.
const fs = require('node:fs');
const path = require('node:path');

function validate(snapshot) {
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.identities) || !Array.isArray(snapshot.rooms)) {
    throw new Error('Unsupported saved state');
  }
  const tokens = new Set(), ids = new Set(), names = new Set(), roomIds = new Set(), seated = new Set();
  for (const entry of snapshot.identities) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error('Invalid identity record');
    const [token, identity] = entry;
    if (typeof token !== 'string' || !token || !identity || typeof identity.id !== 'string' || typeof identity.name !== 'string') throw new Error('Invalid identity record');
    const key = identity.name.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
    if (!key || tokens.has(token) || ids.has(identity.id) || names.has(key)) throw new Error('Duplicate identity in saved state');
    tokens.add(token); ids.add(identity.id); names.add(key);
  }
  for (const room of snapshot.rooms) {
    if (!room || room.game !== 'doudizhu' || typeof room.id !== 'string' || roomIds.has(room.id) || !Array.isArray(room.players)) throw new Error('Invalid saved table');
    roomIds.add(room.id);
    if (!['lobby', 'ready', 'playing'].includes(room.phase)) throw new Error('Invalid table phase');
    const seats = new Set();
    for (const player of room.players) {
      if (!Number.isInteger(player.index) || player.index < 0 || player.index > 2 || seats.has(player.index) || !ids.has(player.identityId) || seated.has(player.identityId)) throw new Error('Invalid saved seat');
      seats.add(player.index); seated.add(player.identityId);
    }
    if (room.phase === 'playing') {
      const s = room.state;
      if (!s || !Array.isArray(s.hands) || s.hands.length !== 3 || !s.hands.every(Array.isArray) || !Array.isArray(s.cumulativeScore) || s.cumulativeScore.length !== 3 || !s.cumulativeScore.every(Number.isFinite)) throw new Error('Invalid saved game');
      const cards = s.hands.flat().map(c => c && c.id);
      if (cards.some(id => typeof id !== 'string') || new Set(cards).size !== cards.length) throw new Error('Invalid saved cards');
    }
  }
  return snapshot;
}

class StateStore {
  constructor(file) { this.file = file; this.last = null; this.writes = 0; }
  load() {
    if (!fs.existsSync(this.file)) return { version: 1, identities: [], rooms: [] };
    const source = fs.readFileSync(this.file, 'utf8');
    const snapshot = validate(JSON.parse(source));
    this.last = JSON.stringify(snapshot);
    return snapshot;
  }
  save(snapshot) {
    const source = JSON.stringify(snapshot);
    if (source === this.last) return false;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = this.file + '.tmp';
    let fd;
    try {
      fd = fs.openSync(tmp, 'w', 0o600);
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, source);
      fs.fsyncSync(fd);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
    // Commit the rename as well as its contents before acknowledging a move.
    const dir = fs.openSync(path.dirname(this.file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    this.last = source;
    this.writes++;
    return true;
  }
}

module.exports = { StateStore, validate };
