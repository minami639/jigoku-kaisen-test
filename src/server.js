import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from './store.js';
import { applyAction, authenticate, createRoom, createTestRoom, joinRoom, projectState } from './game.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(root, 'public');
const store = new JsonStore(process.env.DATA_FILE || path.join(root, 'data', 'rooms.json'));
const streams = new Map();
const streamTickets = new Map();
const streamTicketLifetimeMs = 30_000;

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function credentials(req) {
  return (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
}

function roomContext(roomStore, req, code) {
  const room = roomStore.get(code);
  if (!room) throw Object.assign(new Error('ルームが見つかりません'), { status: 404 });
  return { room, actor: authenticate(room, credentials(req)) };
}

function broadcast(room) {
  for (const client of streams.get(room.code) || []) {
    try { client.res.write(`event: state\ndata: ${JSON.stringify(projectState(room, client.actor))}\n\n`); } catch {}
  }
}

function serveStatic(req, res, url) {
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const target = path.resolve(publicRoot, relative);
  if (!target.startsWith(publicRoot) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) return false;
  const ext = path.extname(target);
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
  res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream' });
  fs.createReadStream(target).pipe(res);
  return true;
}

export function createServer({ roomStore = store, allowTestRooms = process.env.ENABLE_TEST_ROOMS === 'true' || process.env.NODE_ENV !== 'production' } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { status: 'ok' });
      if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { testRoomsEnabled: allowTestRooms });
      if (req.method === 'POST' && url.pathname === '/api/rooms') {
        const input = await body(req); const room = createRoom(input.name, { playtestMode: Boolean(input.playtestMode) }); roomStore.set(room);
        return json(res, 201, { roomCode: room.code, participantId: room.gm.participantId, role: 'GM', token: room.gm.authToken, playtestMode: room.playtestMode });
      }
      if (req.method === 'POST' && url.pathname === '/api/test-room') {
        if (!allowTestRooms) return json(res, 404, { error: 'Not found' });
        const room = createTestRoom(); roomStore.set(room);
        return json(res, 201, { roomCode: room.code, participantId: room.gm.participantId, role: 'GM', token: room.gm.authToken, testMode: true });
      }
      const join = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/join$/);
      if (req.method === 'POST' && join) {
        const room = roomStore.get(join[1]); if (!room) return json(res, 404, { error: 'ルームが見つかりません' });
        const player = joinRoom(room, (await body(req)).name); roomStore.set(room); broadcast(room);
        return json(res, 201, { roomCode: room.code, participantId: player.participantId, role: 'PL', token: player.authToken });
      }
      const state = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/state$/);
      if (req.method === 'GET' && state) {
        const { room, actor } = roomContext(roomStore, req, state[1]); return json(res, 200, projectState(room, actor));
      }
      const ticket = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/stream-ticket$/);
      if (req.method === 'POST' && ticket) {
        const { room, actor } = roomContext(roomStore, req, ticket[1]);
        const value = crypto.randomBytes(24).toString('base64url');
        streamTickets.set(value, { roomCode: room.code, actor, expiresAt: Date.now() + streamTicketLifetimeMs });
        return json(res, 201, { ticket: value });
      }
      const events = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/events$/);
      if (req.method === 'GET' && events) {
        const value = url.searchParams.get('ticket');
        const entry = streamTickets.get(value);
        streamTickets.delete(value);
        if (!entry || entry.expiresAt < Date.now() || entry.roomCode !== events[1].toUpperCase()) return json(res, 401, { error: '認証に失敗しました' });
        const room = roomStore.get(entry.roomCode);
        if (!room) return json(res, 404, { error: 'ルームが見つかりません' });
        const actor = entry.actor;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(`event: state\ndata: ${JSON.stringify(projectState(room, actor))}\n\n`);
        const client = { res, actor }; const clients = streams.get(room.code) || new Set(); clients.add(client); streams.set(room.code, clients);
        req.on('close', () => clients.delete(client)); return;
      }
      const action = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/actions$/);
      if (req.method === 'POST' && action) {
        const { room, actor } = roomContext(roomStore, req, action[1]); applyAction(room, actor, await body(req)); roomStore.set(room); broadcast(room);
        return json(res, 200, projectState(room, actor));
      }
      if (req.method === 'GET' && serveStatic(req, res, url)) return;
      json(res, 404, { error: 'Not found' });
    } catch (error) {
      json(res, error.status || 400, { error: error.message || '処理に失敗しました' });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  createServer().listen(port, host, () => console.log(`地獄廻線 server listening on ${host}:${port}`));
}
