import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

class MemoryStore {
  rooms = new Map();
  set(room) { this.rooms.set(room.code, room); return room; }
  get(code) { return this.rooms.get(code?.toUpperCase()); }
}

async function withServer(options, run) {
  const server = createServer({ roomStore: new MemoryStore(), ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try { await run(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('health check and production config are publicly readable without exposing game state', async () => {
  await withServer({ allowTestRooms: false }, async origin => {
    const health = await fetch(`${origin}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
    const config = await fetch(`${origin}/api/config`);
    assert.deepEqual(await config.json(), { testRoomsEnabled: false });
  });
});

test('test-room API is unavailable when disabled for production', async () => {
  await withServer({ allowTestRooms: false }, async origin => {
    const response = await fetch(`${origin}/api/test-room`, { method: 'POST' });
    assert.equal(response.status, 404);
  });
});

test('test-room API creates GM plus seven players only when explicitly enabled', async () => {
  await withServer({ allowTestRooms: true }, async origin => {
    const created = await fetch(`${origin}/api/test-room`, { method: 'POST' });
    assert.equal(created.status, 201);
    const session = await created.json();
    const state = await fetch(`${origin}/api/rooms/${session.roomCode}/state`, { headers: { authorization: `Bearer ${session.token}` } });
    assert.equal(state.status, 200);
    const payload = await state.json();
    assert.equal(payload.me.role, 'GM');
    assert.equal(payload.players.length, 7);
    assert.equal(payload.phase, 'INTRODUCTION');
  });
});

test('state and SSE tickets require authorization, tickets are one-time', async () => {
  await withServer({ allowTestRooms: true }, async origin => {
    const session = await (await fetch(`${origin}/api/test-room`, { method: 'POST' })).json();
    assert.equal((await fetch(`${origin}/api/rooms/${session.roomCode}/state`)).status, 401);
    const issued = await fetch(`${origin}/api/rooms/${session.roomCode}/stream-ticket`, { method: 'POST', headers: { authorization: `Bearer ${session.token}` } });
    assert.equal(issued.status, 201);
    const { ticket } = await issued.json();
    const controller = new AbortController();
    const first = await fetch(`${origin}/api/rooms/${session.roomCode}/events?ticket=${ticket}`, { signal: controller.signal });
    assert.equal(first.status, 200);
    controller.abort();
    const reused = await fetch(`${origin}/api/rooms/${session.roomCode}/events?ticket=${ticket}`);
    assert.equal(reused.status, 401);
  });
});
