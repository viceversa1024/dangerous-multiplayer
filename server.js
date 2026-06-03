const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DOOM_MS = 5000;
const MIN_ROUND_MS = 10_000;
const MAX_ROUND_MS = 3_600_000;
const DEFAULT_ROUND_MS = 300_000;
const ALLOWED_MODES = new Set(['iased', 'classic']);
const DEFAULT_MODE = 'classic';
const RECONNECT_GRACE_MS = 60_000;

function makeToken() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}
const TICK_MS = 200;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const FEEDBACK_WEBHOOK_URL = process.env.DISCORD_FEEDBACK_WEBHOOK_URL || '';
const feedbackRate = new Map(); // ip -> [timestamps]
const FEEDBACK_WINDOW_MS = 60_000;
const FEEDBACK_MAX_PER_WINDOW = 5;

const RECAP_DIR = process.env.RECAP_DIR
  || (fs.existsSync('/data') ? '/data/recaps' : path.join(__dirname, '.recap-data'));
try { fs.mkdirSync(RECAP_DIR, { recursive: true }); }
catch (e) { console.error('failed to create RECAP_DIR', RECAP_DIR, e); }

const recapCache = new Map(); // code -> data (LRU via Map iteration order)
const RECAP_CACHE_MAX = 200;
function cacheGet(code) {
  if (!recapCache.has(code)) return null;
  const v = recapCache.get(code);
  recapCache.delete(code); recapCache.set(code, v);
  return v;
}
function cacheSet(code, v) {
  if (recapCache.has(code)) recapCache.delete(code);
  recapCache.set(code, v);
  if (recapCache.size > RECAP_CACHE_MAX) {
    const oldest = recapCache.keys().next().value;
    recapCache.delete(oldest);
  }
}

function postToDiscord(content, webhookUrl) {
  const url = webhookUrl || FEEDBACK_WEBHOOK_URL;
  if (!url) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const body = JSON.stringify({ content: content.slice(0, 1900) });
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (r) => { r.resume(); r.on('end', resolve); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function formatRecapDate(d) { return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${d.getFullYear()}`; }
function formatRoundDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}-second`;
  return `${totalSec / 60}-minute`;
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildRecapText({ gallery, prompt, roundMs, createdAt }) {
  const entries = shuffled(gallery);
  const lines = [];
  lines.push('Dangerous Writing: Round Recap');
  lines.push(`Date: ${formatRecapDate(new Date(createdAt))}`);
  lines.push(`Round length: ${formatRoundDuration(roundMs)}`);
  if (prompt) lines.push(`Prompt: ${prompt}`);
  lines.push(`Submissions: ${entries.length} (names anonymized, order shuffled)`);
  lines.push('');
  for (let i = 0; i < entries.length; i++) {
    lines.push(`--- Anonymous ${i + 1} ---`);
    lines.push(entries[i].text);
    lines.push('');
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildRecapHtml({ text, submissions, createdAt }) {
  const title = `Dangerous Writing: Recap, ${formatRecapDate(new Date(createdAt))}`;
  const desc = `${submissions} anonymized submissions from a Dangerous Writing round.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)}</title>
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(desc)}" />
<meta name="theme-color" content="#ef4444" />
<style>
  :root { --bg:#181d20; --fg:#f4f4f5; --muted:#71717a; --accent:#ef4444; --accent-2:#fbbf24; --panel:#18181b; --border:#27272a; }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; background:var(--bg); color:var(--fg); font-family: Helvetica, Arial, sans-serif; }
  header { padding:18px 24px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
  header h1 { margin:0; font-size:16px; letter-spacing:0.02em; }
  .actions { display:flex; gap:8px; align-items:center; }
  button, .btn { font:inherit; font-size:13px; padding:8px 14px; border-radius:8px; border:1px solid var(--border); background:transparent; color:var(--fg); cursor:pointer; display:inline-block; text-decoration:none; line-height:1.2; }
  button:hover, .btn:hover { filter: brightness(1.15); border-color: var(--accent-2); color: var(--accent-2); }
  .btn-primary { padding: 12px 22px; font-size: 14px; color: var(--muted); }
  .btn-primary:hover { color: var(--accent-2); border-color: var(--accent-2); }
  main { max-width: 760px; margin: 0 auto; padding: 28px 24px 80px; }
  pre { white-space: pre-wrap; word-wrap: break-word; font-family: Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.6; margin: 0; color: var(--fg); }
  .footer { margin-top: 48px; display:flex; justify-content:center; }
</style>
</head>
<body>
<header>
  <h1>⚠️ Dangerous Writing: Recap</h1>
  <div class="actions">
    <button id="copy">Copy</button>
    <a class="btn" href="?txt=1" download="dangerous-writing-recap.txt">Download .txt</a>
  </div>
</header>
<main>
<pre id="body">${escapeHtml(text)}</pre>
<div class="footer"><a class="btn btn-primary" href="/">New round</a></div>
</main>
<script>
  document.getElementById('copy').onclick = async () => {
    const base = document.getElementById('body').textContent.replace(/\\s+$/, '');
    const t = base + '\\n\\nPlayed at ' + location.origin + '/';
    try { await navigator.clipboard.writeText(t); }
    catch { const ta=document.createElement('textarea'); ta.value=t; document.body.appendChild(ta); ta.select(); try{document.execCommand('copy');}catch{} ta.remove(); }
    const b = document.getElementById('copy'); const o = b.textContent; b.textContent = '✓ Copied'; setTimeout(()=>b.textContent=o, 1200);
  };
</script>
</body>
</html>`;
}

const RECAP_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeRecapCode() {
  let code = '';
  for (let i = 0; i < 8; i++) code += RECAP_CODE_CHARS[Math.floor(Math.random() * RECAP_CODE_CHARS.length)];
  return code;
}

function recapFilePath(code) { return path.join(RECAP_DIR, `${code}.json`); }

async function writeRecap(code, data) {
  const tmp = recapFilePath(code) + '.tmp';
  const final = recapFilePath(code);
  await fs.promises.writeFile(tmp, JSON.stringify(data));
  await fs.promises.rename(tmp, final);
  cacheSet(code, data);
}

async function readRecap(code) {
  const cached = cacheGet(code);
  if (cached) return cached;
  const buf = await fs.promises.readFile(recapFilePath(code), 'utf8');
  const data = JSON.parse(buf);
  cacheSet(code, data);
  return data;
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/feedback') {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const now = Date.now();
    const recent = (feedbackRate.get(ip) || []).filter(t => now - t < FEEDBACK_WINDOW_MS);
    if (recent.length >= FEEDBACK_MAX_PER_WINDOW) {
      res.writeHead(429); return res.end('Too many');
    }
    recent.push(now);
    feedbackRate.set(ip, recent);

    let body = '';
    let aborted = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 8000) { aborted = true; req.destroy(); }
    });
    req.on('end', () => {
      if (aborted) return;
      let data;
      try { data = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad JSON'); }
      const message = String(data.message || '').slice(0, 2000).trim();
      const page = String(data.page || '').slice(0, 200);
      if (!message) { res.writeHead(400); return res.end('Empty'); }
      const content = `**Feedback** from \`${page || '?'}\` (ip ${ip || '?'}):\n${message}`;
      postToDiscord(content)
        .then(() => { res.writeHead(204); res.end(); })
        .catch((e) => {
          console.error('feedback webhook failed', e);
          res.writeHead(502); res.end('Webhook failed');
        });
    });
    return;
  }

  let urlPath = req.url.split('?')[0];

  const recapMatch = req.method === 'GET' && urlPath.match(/^\/r\/([A-Z0-9]{4,12})(\.txt)?$/);
  if (recapMatch) {
    const code = recapMatch[1];
    const wantTxt = !!recapMatch[2] || /[?&]txt=1\b/.test(req.url);
    readRecap(code).then((data) => {
      if (wantTxt) {
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
          'Content-Disposition': `inline; filename="dangerous-writing-recap_${code}.txt"`,
        });
        return res.end(data.text);
      }
      const html = buildRecapHtml(data);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
      res.end(html);
    }).catch((err) => {
      if (err && err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><meta charset=utf-8><body style="font-family:Helvetica,Arial,sans-serif;background:#181d20;color:#f4f4f5;padding:48px;text-align:center"><h1>Recap not found</h1><p style="color:#71717a">That link is invalid or has been removed.</p><p><a href="/" style="color:#fbbf24">Back to dangerous-multiplayer</a></p></body>');
      }
      console.error('recap read failed', code, err);
      res.writeHead(500); res.end('Server error');
    });
    return;
  }

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
    roundRemaining: room.started ? Math.max(0, room.roundMs - (now - room.startedAt)) : 0,
    players: [...room.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      idleMs: room.started ? now - p.lastKey : 0,
      words: p.words,
      connected: p.ws && p.ws.readyState === 1,
    })),
  });
}

function leaderboardOf(room) {
  return [...room.players.values()]
    .map(p => ({ id: p.id, name: p.name, words: p.words, chars: p.chars }))
    .sort((a, b) => b.words - a.words || b.chars - a.chars);
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
      if (p.disconnected) continue;
      const remaining = Math.max(0, DOOM_MS - (now - p.lastKey));
      send(p.ws, { type: 'doom', remaining, worst: null, roundRemaining });
    }
    return;
  }
  let minRemaining = DOOM_MS;
  let worstName = null;
  for (const p of room.players.values()) {
    if (p.disconnected) continue;
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
      const leaderboard = leaderboardOf(room);
      for (const p of room.players.values()) send(p.ws, { type: 'round_complete' });
      if (room.host) send(room.host, { type: 'round_complete', leaderboard, roundMs: room.roundMs, prompt: room.prompt });
      broadcastToHost(room);
      continue;
    }
    if (room.mode === 'classic') {
      for (const p of room.players.values()) {
        if (p.disconnected) continue;
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
        if (p.disconnected) continue;
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
      const hostToken = makeToken();
      const room = { host: ws, hostToken, players: new Map(), started: false, lastReset: Date.now() };
      rooms.set(code, room);
      ws.role = 'host';
      ws.roomCode = code;
      send(ws, { type: 'room_created', code, hostToken });
      broadcastToHost(room);
      return;
    }

    if (msg.type === 'claim_host') {
      const code = String(msg.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room || room.hostToken !== msg.hostToken) {
        return send(ws, { type: 'host_claim_failed' });
      }
      if (room.host && room.host !== ws && room.host.readyState === 1) {
        try { room.host.close(); } catch {}
      }
      if (room.hostDeathTimer) { clearTimeout(room.hostDeathTimer); room.hostDeathTimer = null; }
      room.host = ws;
      ws.role = 'host';
      ws.roomCode = code;
      send(ws, {
        type: 'host_claimed',
        code,
        started: room.started,
        roundMs: room.roundMs,
        mode: room.mode,
        prompt: room.prompt,
      });
      broadcastToHost(room);
      if (!room.started && Array.isArray(room.gallery) && room.gallery.length) {
        send(ws, { type: 'round_complete', leaderboard: leaderboardOf(room), roundMs: room.roundMs, prompt: room.prompt });
        send(ws, { type: 'gallery_list', entries: room.gallery });
      }
      return;
    }

    if (msg.type === 'join_room') {
      const code = (msg.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { type: 'error', message: 'Room not found' });
      const name = (msg.name || '').trim().slice(0, 20) || 'Anonymous';

      let player = null;
      if (msg.token) {
        for (const p of room.players.values()) {
          if (p.token === msg.token) { player = p; break; }
        }
      }

      if (player) {
        if (player.ws && player.ws !== ws && player.ws.readyState === 1) {
          try { player.ws.close(); } catch {}
        }
        if (player.removeTimer) { clearTimeout(player.removeTimer); player.removeTimer = null; }
        player.ws = ws;
        player.disconnected = false;
        player.lastKey = Date.now();
        ws.role = 'player';
        ws.roomCode = code;
        ws.playerId = player.id;
        send(ws, { type: 'joined', id: player.id, name: player.name, code, token: player.token, resumed: true });
      } else {
        const id = Math.random().toString(36).slice(2, 10);
        const token = makeToken();
        player = { id, ws, name, token, lastKey: Date.now(), words: 0, chars: 0, disconnected: false };
        room.players.set(id, player);
        ws.role = 'player';
        ws.roomCode = code;
        ws.playerId = id;
        send(ws, { type: 'joined', id, name, code, token });
      }

      broadcastPlayers(room);
      broadcastToHost(room);
      if (room.started) {
        send(ws, { type: 'started', roundMs: room.roundMs, mode: room.mode, prompt: room.prompt });
      } else if (Array.isArray(room.gallery) && room.gallery.length) {
        send(ws, { type: 'round_complete' });
      }
      return;
    }

    if (msg.type === 'start' && ws.role === 'host') {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      if (room.players.size === 0) return send(ws, { type: 'error', message: 'No players yet' });
      const requested = Number(msg.durationMs);
      room.roundMs = (Number.isFinite(requested) && requested >= MIN_ROUND_MS && requested <= MAX_ROUND_MS)
        ? Math.round(requested) : DEFAULT_ROUND_MS;
      room.mode = ALLOWED_MODES.has(msg.mode) ? msg.mode : DEFAULT_MODE;
      room.prompt = String(msg.prompt || '').slice(0, 500);
      const now = Date.now();
      room.started = true;
      room.startedAt = now;
      for (const p of room.players.values()) { p.lastKey = now; p.words = 0; p.chars = 0; }
      for (const p of room.players.values()) send(p.ws, { type: 'started', roundMs: room.roundMs, mode: room.mode, prompt: room.prompt });
      send(ws, { type: 'started', roundMs: room.roundMs, mode: room.mode, prompt: room.prompt });
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

    if (msg.type === 'share_recap' && ws.role === 'host') {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      if (room.started) return send(ws, { type: 'recap_share_failed', reason: 'Round still running' });
      if (!Array.isArray(room.gallery) || room.gallery.length === 0) {
        return send(ws, { type: 'recap_share_failed', reason: 'No submissions yet' });
      }
      const createdAt = Date.now();
      const text = buildRecapText({
        gallery: room.gallery,
        prompt: room.prompt || '',
        roundMs: room.roundMs || 0,
        createdAt,
      });
      const data = {
        text,
        prompt: room.prompt || '',
        roundMs: room.roundMs || 0,
        submissions: room.gallery.length,
        createdAt,
      };
      const code = makeRecapCode();
      writeRecap(code, data).then(() => {
        const proto = msg.proto === 'http' ? 'http' : 'https';
        const host = String(msg.host || 'dangerous-multiplayer.fly.dev').slice(0, 200);
        const url = `${proto}://${host}/r/${code}`;
        const dateStr = formatRecapDate(new Date(createdAt));
        const dur = formatRoundDuration(data.roundMs);
        const promptLine = data.prompt ? `\nPrompt: ${data.prompt.slice(0, 200)}` : '';
        const summary = `Dangerous Writing recap · ${dateStr}\n${data.submissions} submissions · ${dur} round${promptLine}\n${url}`;
        send(ws, { type: 'recap_shared', code, url, summary });
      }).catch((err) => {
        console.error('recap write failed', err);
        send(ws, { type: 'recap_share_failed', reason: 'Server error' });
      });
      return;
    }

    if (msg.type === 'rename' && ws.role === 'player') {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      const p = room.players.get(ws.playerId);
      if (!p) return;
      const name = String(msg.name || '').trim().slice(0, 20);
      if (!name) return;
      p.name = name;
      send(ws, { type: 'renamed', name });
      broadcastPlayers(room);
      broadcastToHost(room);
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
      if (!room || room.host !== ws) return;
      room.host = null;
      if (room.hostDeathTimer) clearTimeout(room.hostDeathTimer);
      room.hostDeathTimer = setTimeout(() => {
        const r = rooms.get(ws.roomCode);
        if (!r || r.host) return;
        for (const p of r.players.values()) send(p.ws, { type: 'host_left' });
        rooms.delete(ws.roomCode);
      }, RECONNECT_GRACE_MS);
    } else if (ws.role === 'player' && ws.roomCode) {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      const p = room.players.get(ws.playerId);
      if (!p || p.ws !== ws) return;
      p.disconnected = true;
      if (p.removeTimer) clearTimeout(p.removeTimer);
      p.removeTimer = setTimeout(() => {
        const r = rooms.get(ws.roomCode);
        if (!r) return;
        const cur = r.players.get(ws.playerId);
        if (!cur || !cur.disconnected) return;
        r.players.delete(ws.playerId);
        broadcastPlayers(r);
        broadcastToHost(r);
      }, RECONNECT_GRACE_MS);
      broadcastPlayers(room);
      broadcastToHost(room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Dangerous Multiplayer running on http://localhost:${PORT}`);
});
