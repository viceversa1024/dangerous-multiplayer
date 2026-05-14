const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DOOM_MS = 5000;
const ALLOWED_ROUND_MS = new Set([60_000, 300_000, 600_000]);
const DEFAULT_ROUND_MS = 300_000;
const ALLOWED_MODES = new Set(['iased', 'classic']);
const DEFAULT_MODE = 'iased';
const TICK_MS = 200;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(__dirname, 'public', urlPath);
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

// rooms: code -> { host: ws|null, players: Map<id, player>, started: bool, lastReset: number }
// player: { id, ws, name, lastKey, words }
const rooms = new Map();
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcastPlayers(room) {
  for (const p of room.players.values()) {
    send(p.ws, { type: 'players', players: playerList(room), started: room.started });
  }
}

function broadcastToHost(room) {
  if (!room.host) return;
  const now = Date.now();
  send(room.host, {
    type: 'host_state',
    started: room.started,
    players: [...room.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      idleMs: room.started ? now - p.lastKey : 0,
      words: p.words,
      connected: p.ws && p.ws.readyState === 1,
    })),
  });
}

function playerList(room) {
  return [...room.players.values()].map(p => ({ id: p.id, name: p.name }));
}

function broadcastDoomTimer(room) {
  if (!room.started) return;
  const now = Date.now();
  const roundRemaining = Math.max(0, room.roundMs - (now - room.startedAt));
  if (room.mode === 'classic') {
    for (const p of room.players.values()) {
      const remaining = Math.max(0, DOOM_MS - (now - p.lastKey));
      send(p.ws, { type: 'doom', remaining, worst: null, roundRemaining });
    }
    return;
  }
  let minRemaining = DOOM_MS;
  let worstName = null;
  for (const p of room.players.values()) {
    const remaining = Math.max(0, DOOM_MS - (now - p.lastKey));
    if (remaining < minRemaining) { minRemaining = remaining; worstName = p.name; }
  }
  for (const p of room.players.values()) {
    send(p.ws, { type: 'doom', remaining: minRemaining, worst: worstName, roundRemaining });
  }
}

function doReset(room, reason) {
  const now = Date.now();
  room.lastReset = now;
  room.startedAt = now;
  for (const p of room.players.values()) {
    p.lastKey = now;
    p.words = 0;
    p.chars = 0;
    send(p.ws, { type: 'reset', reason, roundMs: room.roundMs });
  }
  broadcastToHost(room);
}

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (!room.started || room.players.size === 0) continue;
    if (now - room.startedAt >= room.roundMs) {
      room.started = false;
      room.gallery = [];
      const leaderboard = [...room.players.values()]
        .map(p => ({ id: p.id, name: p.name, words: p.words, chars: p.chars }))
        .sort((a, b) => b.words - a.words || b.chars - a.chars);
      for (const p of room.players.values()) send(p.ws, { type: 'round_complete' });
      if (room.host) send(room.host, { type: 'round_complete', leaderboard, roundMs: room.roundMs });
      broadcastToHost(room);
      continue;
    }
    if (room.mode === 'classic') {
      for (const p of room.players.values()) {
        if (now - p.lastKey > DOOM_MS) {
          p.lastKey = now;
          p.words = 0;
          p.chars = 0;
          send(p.ws, { type: 'reset', reason: 'you stopped typing', roundMs: room.roundMs });
        }
      }
      broadcastDoomTimer(room);
      broadcastToHost(room);
    } else {
      let triggered = null;
      for (const p of room.players.values()) {
        if (now - p.lastKey > DOOM_MS) { triggered = p; break; }
      }
      if (triggered) {
        doReset(room, `${triggered.name} stopped typing`);
      } else {
        broadcastDoomTimer(room);
        broadcastToHost(room);
      }
    }
  }
}, TICK_MS);

wss.on('connection', (ws) => {
  ws.role = null;
  ws.roomCode = null;
  ws.playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'create_room') {
      const code = makeRoomCode();
      const room = { host: ws, players: new Map(), started: false, lastReset: Date.now() };
      rooms.set(code, room);
      ws.role = 'host';
      ws.roomCode = code;
      send(ws, { type: 'room_created', code });
      broadcastToHost(room);
      return;
    }

    if (msg.type === 'join_room') {
      const code = (msg.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { type: 'error', message: 'Room not found' });
      if (room.started) return send(ws, { type: 'error', message: 'Game already in progress' });
      const name = (msg.name || '').trim().slice(0, 20) || 'Anonymous';
      const id = Math.random().toString(36).slice(2, 10);
      const player = { id, ws, name, lastKey: Date.now(), words: 0, chars: 0 };
      room.players.set(id, player);
      ws.role = 'player';
      ws.roomCode = code;
      ws.playerId = id;
      send(ws, { type: 'joined', id, name, code });
      broadcastPlayers(room);
      broadcastToHost(room);
      return;
    }

    if (msg.type === 'start' && ws.role === 'host') {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      if (room.players.size === 0) return send(ws, { type: 'error', message: 'No players yet' });
      const requested = Number(msg.durationMs);
      room.roundMs = ALLOWED_ROUND_MS.has(requested) ? requested : DEFAULT_ROUND_MS;
      room.mode = ALLOWED_MODES.has(msg.mode) ? msg.mode : DEFAULT_MODE;
      const now = Date.now();
      room.started = true;
      room.startedAt = now;
      for (const p of room.players.values()) { p.lastKey = now; p.words = 0; p.chars = 0; }
      for (const p of room.players.values()) send(p.ws, { type: 'started', roundMs: room.roundMs, mode: room.mode });
      send(ws, { type: 'started', roundMs: room.roundMs, mode: room.mode });
      broadcastToHost(room);
      return;
    }

    if (msg.type === 'stop' && ws.role === 'host') {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      room.started = false;
      for (const p of room.players.values()) send(p.ws, { type: 'stopped' });
      send(ws, { type: 'stopped' });
      broadcastToHost(room);
      return;
    }

    if (msg.type === 'submit_text' && ws.role === 'player') {
      const room = rooms.get(ws.roomCode);
      if (!room || room.started) return;
      const p = room.players.get(ws.playerId);
      if (!p) return;
      const text = String(msg.text || '').slice(0, 50000);
      if (!text.trim()) return;
      if (!Array.isArray(room.gallery)) room.gallery = [];
      const existing = room.gallery.findIndex(e => e.id === p.id);
      const entry = { id: p.id, from: p.name, text };
      if (existing >= 0) room.gallery[existing] = entry;
      else room.gallery.push(entry);
      if (room.host) send(room.host, { type: 'gallery_list', entries: room.gallery });
      return;
    }

    if (msg.type === 'gallery_show' && ws.role === 'host') {
      const room = rooms.get(ws.roomCode);
      if (!room || !Array.isArray(room.gallery) || !room.gallery.length) return;
      let index = -1;
      if (typeof msg.index === 'number') index = msg.index;
      else if (msg.id) index = room.gallery.findIndex(e => e.id === msg.id);
      if (index < 0 || index >= room.gallery.length) return;
      const entry = room.gallery[index];
      const payload = { type: 'gallery_show', entry, index, total: room.gallery.length };
      for (const p of room.players.values()) send(p.ws, payload);
      send(ws, payload);
      return;
    }

    if (msg.type === 'gallery_hide' && ws.role === 'host') {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      const payload = { type: 'gallery_hide' };
      for (const p of room.players.values()) send(p.ws, payload);
      send(ws, payload);
      return;
    }

    if (msg.type === 'keystroke' && ws.role === 'player') {
      const room = rooms.get(ws.roomCode);
      if (!room || !room.started) return;
      const p = room.players.get(ws.playerId);
      if (!p) return;
      p.lastKey = Date.now();
      if (typeof msg.words === 'number') p.words = msg.words;
      if (typeof msg.chars === 'number') p.chars = msg.chars;
      return;
    }
  });

  ws.on('close', () => {
    if (ws.role === 'host' && ws.roomCode) {
      const room = rooms.get(ws.roomCode);
      if (room) {
        for (const p of room.players.values()) send(p.ws, { type: 'host_left' });
        rooms.delete(ws.roomCode);
      }
    } else if (ws.role === 'player' && ws.roomCode) {
      const room = rooms.get(ws.roomCode);
      if (room) {
        room.players.delete(ws.playerId);
        broadcastPlayers(room);
        broadcastToHost(room);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Dangerous Multiplayer running on http://localhost:${PORT}`);
});
