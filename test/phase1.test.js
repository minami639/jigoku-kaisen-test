import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createRoom, createTestRoom, joinRoom, projectState } from '../src/game.js';
import { PACKS, CARDS, STATIONS } from '../src/definitions.js';

function completeSelfIntroductions(room) {
  room.players.forEach(player => applyAction(room, player, { type: 'COMPLETE_SELF_INTRODUCTION' }));
}

function setup() {
  const room = createRoom('獄長');
  const players = Array.from({ length: 7 }, (_, index) => joinRoom(room, `PL${index + 1}`));
  applyAction(room, room.gm, { type: 'OPEN_INTRODUCTION' });
  applyAction(room, room.gm, { type: 'START_SELF_INTRODUCTION' });
  completeSelfIntroductions(room);
  applyAction(room, room.gm, { type: 'OPEN_PACK_SELECTION' });
  players.forEach((player, index) => applyAction(room, player, { type: 'SELECT_PACK', packId: PACKS[index].id, confirmed: true }));
  applyAction(room, room.gm, { type: 'START_FIRST_STATION' });
  return { room, players };
}

test('definitions contain seven packs, 35 cards and 25 configured turns', () => {
  assert.equal(PACKS.length, 7);
  assert.equal(CARDS.length, 35);
  assert.equal(STATIONS.reduce((sum, station) => sum + station.turnCount, 0), 25);
});

test('introduction is followed by an eight-minute self-introduction phase', () => {
  const room = createRoom();
  Array.from({ length: 7 }, (_, index) => joinRoom(room, `PL${index + 1}`));
  assert.throws(() => applyAction(room, room.gm, { type: 'OPEN_PACK_SELECTION' }), /自己紹介/);
  applyAction(room, room.gm, { type: 'OPEN_INTRODUCTION' });
  assert.equal(room.phase, 'INTRODUCTION');
  assert.equal(room.introductionStep, 1);
  assert.throws(() => applyAction(room, room.players[0], { type: 'ADVANCE_INTRODUCTION' }), /GM専用/);
  while (room.introductionStep < 40) applyAction(room, room.gm, { type: 'ADVANCE_INTRODUCTION' });
  assert.equal(room.phase, 'INTRODUCTION');
  applyAction(room, room.gm, { type: 'ADVANCE_INTRODUCTION' });
  assert.equal(room.phase, 'SELF_INTRODUCTION');
  assert.equal(room.timer.endsAt - room.timer.startedAt, 480_000);
  assert.throws(() => applyAction(room, room.gm, { type: 'OPEN_PACK_SELECTION' }), /PL7人全員/);
  completeSelfIntroductions(room);
  applyAction(room, room.gm, { type: 'OPEN_PACK_SELECTION' });
  assert.equal(room.phase, 'PACK_SELECTION');
  assert.equal(room.timer, null);
});

test('exactly seven players join and pack duplication blocks station start', () => {
  const room = createRoom();
  const players = Array.from({ length: 7 }, (_, index) => joinRoom(room, `PL${index + 1}`));
  assert.throws(() => joinRoom(room, 'PL8'), /7人/);
  applyAction(room, room.gm, { type: 'OPEN_INTRODUCTION' });
  applyAction(room, room.gm, { type: 'START_SELF_INTRODUCTION' });
  completeSelfIntroductions(room);
  applyAction(room, room.gm, { type: 'OPEN_PACK_SELECTION' });
  players.forEach(player => applyAction(room, player, { type: 'SELECT_PACK', packId: 'scorch', confirmed: true }));
  assert.throws(() => applyAction(room, room.gm, { type: 'START_FIRST_STATION' }), /重複/);
});

test('pack choices and confirmation status are visible to every player during pack selection', () => {
  const room = createRoom();
  const players = Array.from({ length: 7 }, (_, index) => joinRoom(room, `PL${index + 1}`));
  applyAction(room, room.gm, { type: 'OPEN_INTRODUCTION' });
  applyAction(room, room.gm, { type: 'START_SELF_INTRODUCTION' });
  completeSelfIntroductions(room);
  applyAction(room, room.gm, { type: 'OPEN_PACK_SELECTION' });
  applyAction(room, players[0], { type: 'SELECT_PACK', packId: 'scorch', confirmed: true });
  const otherView = projectState(room, players[1]);
  assert.equal(otherView.players[0].packId, 'scorch');
  assert.equal(otherView.players[0].confirmed, true);
});

test('secret selections are projected only to owner and GM before reveal', () => {
  const { room, players } = setup();
  applyAction(room, players[0], { type: 'SELECT_CARD', cardId: 'flame-strike', targetId: players[1].participantId });
  const owner = projectState(room, players[0]);
  const other = projectState(room, players[1]);
  const gm = projectState(room, room.gm);
  assert.equal(owner.players[0].selection.cardId, 'flame-strike');
  assert.equal(other.players[0].selection, undefined);
  assert.equal(gm.players[0].selection.cardId, 'flame-strike');
});

test('GM alone reveals after all confirmations and focus-fire turn resolves', () => {
  const { room, players } = setup();
  const choices = ['flame-strike','ice-spear','follow-needle','vampire','gluttony','heavy-slash','severance'];
  players.forEach((player, index) => {
    const target = players[(index + 1) % players.length];
    applyAction(room, player, { type: 'SELECT_CARD', cardId: choices[index], targetId: target.participantId });
    applyAction(room, player, { type: 'CONFIRM_CARD' });
  });
  assert.throws(() => applyAction(room, players[0], { type: 'REVEAL_AND_RESOLVE' }), /GM専用/);
  applyAction(room, room.gm, { type: 'REVEAL_AND_RESOLVE' });
  assert.equal(room.phase, 'TURN_RESULT');
  assert.equal(room.revealedUsages.length, 7);
  const revealedView = projectState(room, players[1]);
  assert.equal(revealedView.revealedUsages[0].cardName, '炎撃');
  assert.match(revealedView.revealedUsages[0].description, /対象HP−2/);
  assert.ok(room.players.every(player => player.cardUsage.length === 1));
  assert.ok(room.events.some(event => event.type === 'TURN_RESOLVED'));
  assert.throws(() => applyAction(room, room.gm, { type: 'NEXT_TURN' }), /全PLの結果確認完了/);
  players.forEach(player => applyAction(room, player, { type: 'ACK_RESULT' }));
  assert.ok(room.players.every(player => player.confirmed));
});

test('normal cooldown uses globalTurnIndex across turns', () => {
  const { room, players } = setup();
  const choices = ['flame-strike','ice-spear','follow-needle','vampire','gluttony','heavy-slash','severance'];
  players.forEach((player, index) => {
    applyAction(room, player, { type: 'SELECT_CARD', cardId: choices[index], targetId: players[(index + 1) % 7].participantId });
    applyAction(room, player, { type: 'CONFIRM_CARD' });
  });
  applyAction(room, room.gm, { type: 'REVEAL_AND_RESOLVE' });
  players.forEach(player => applyAction(room, player, { type: 'ACK_RESULT' }));
  applyAction(room, room.gm, { type: 'NEXT_TURN' });
  assert.equal(room.globalTurnIndex, 2);
  assert.throws(() => applyAction(room, players[0], { type: 'SELECT_CARD', cardId: 'flame-strike', targetId: players[1].participantId }), /通常CT/);
  applyAction(room, players[0], { type: 'SELECT_CARD', cardId: 'immolation', targetId: players[1].participantId });
  assert.equal(players[0].selection.cardId, 'immolation');
});

test('only GM can unlock confirmations and adjust HP', () => {
  const { room, players } = setup();
  assert.throws(() => applyAction(room, players[0], { type: 'ADJUST_HP', participantId: players[1].participantId, hp: 1 }), /GM専用/);
  applyAction(room, room.gm, { type: 'ADJUST_HP', participantId: players[1].participantId, hp: 9, reason: 'test' });
  assert.equal(players[1].hp, 9);
  assert.equal(room.events.at(-1).type, 'GM_HP_ADJUSTED');
});

test('single-player test room lets GM assign seven unique packs and autofill a turn', () => {
  const room = createTestRoom();
  assert.equal(room.testMode, true);
  assert.equal(room.players.length, 7);
  assert.equal(room.phase, 'INTRODUCTION');
  assert.ok(room.players.every(player => player.packId === null));
  applyAction(room, room.gm, { type: 'START_SELF_INTRODUCTION' });
  completeSelfIntroductions(room);
  applyAction(room, room.gm, { type: 'OPEN_PACK_SELECTION' });
  room.players.forEach((player, index) => applyAction(room, room.gm, { type: 'TEST_SELECT_PACK', participantId: player.participantId, packId: PACKS[index].id }));
  assert.equal(new Set(room.players.map(player => player.packId)).size, 7);
  applyAction(room, room.gm, { type: 'START_FIRST_STATION' });
  assert.equal(room.phase, 'TURN_SELECTION');
  applyAction(room, room.gm, { type: 'TEST_AUTOFILL_TURN' });
  assert.ok(room.players.every(player => player.confirmed && player.selection));
  applyAction(room, room.gm, { type: 'REVEAL_AND_RESOLVE' });
  assert.equal(room.phase, 'TURN_RESULT');
});

test('test-room GM can inspect every PL view without exposing it to PL clients', () => {
  const room = createTestRoom();
  applyAction(room, room.gm, { type: 'START_SELF_INTRODUCTION' });
  completeSelfIntroductions(room);
  applyAction(room, room.gm, { type: 'OPEN_PACK_SELECTION' });
  room.players.forEach((player, index) => applyAction(room, room.gm, { type: 'TEST_SELECT_PACK', participantId: player.participantId, packId: PACKS[index].id }));
  const gmView = projectState(room, room.gm);
  const plView = projectState(room, room.players[0]);
  assert.equal(gmView.testPlayers.length, 7);
  assert.equal(gmView.testPlayers[0].cards.length, 5);
  assert.equal(plView.testPlayers, undefined);
  assert.equal(plView.packs.find(pack => pack.id !== room.players[0].packId).cards, undefined);
});

test('test-room GM can automatically assign all seven packs without duplication', () => {
  const room = createTestRoom();
  applyAction(room, room.gm, { type: 'START_SELF_INTRODUCTION' });
  completeSelfIntroductions(room);
  applyAction(room, room.gm, { type: 'OPEN_PACK_SELECTION' });
  applyAction(room, room.gm, { type: 'TEST_AUTOFILL_PACKS' });
  assert.ok(room.players.every(player => player.packId && player.confirmed));
  assert.equal(new Set(room.players.map(player => player.packId)).size, 7);
  assert.equal(room.events.at(-1).type, 'TEST_PACKS_AUTOFILLED');
});

test('test GM can jump freely between phases and station turns', () => {
  const room = createTestRoom();
  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'TURN_SELECTION', stationIndex: 4, stationTurn: 3 });
  assert.equal(room.phase, 'TURN_SELECTION');
  assert.equal(room.stationIndex, 4);
  assert.equal(room.stationTurn, 3);
  assert.equal(room.globalTurnIndex, 15);
  assert.equal(new Set(room.players.map(player => player.packId)).size, 7);

  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'PACK_SELECTION' });
  assert.equal(room.phase, 'PACK_SELECTION');
  assert.equal(room.stationIndex, -1);
  assert.equal(room.globalTurnIndex, 0);

  const normalRoom = createRoom();
  assert.throws(() => applyAction(normalRoom, normalRoom.gm, { type: 'TEST_JUMP_PHASE', phase: 'INTRODUCTION' }), /テストルーム専用/);
});

test('test GM can operate one PL card flow without changing normal permissions', () => {
  const room = createTestRoom();
  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'TURN_SELECTION', stationIndex: 0, stationTurn: 1 });
  const player = room.players[0];
  const target = room.players[1];
  applyAction(room, room.gm, { type: 'TEST_PLAYER_ACTION', participantId: player.participantId, playerAction: { type: 'SELECT_CARD', cardId: 'flame-strike', targetId: target.participantId } });
  assert.equal(player.selection.cardId, 'flame-strike');
  applyAction(room, room.gm, { type: 'TEST_PLAYER_ACTION', participantId: player.participantId, playerAction: { type: 'CONFIRM_CARD' } });
  assert.equal(player.confirmed, true);
  assert.throws(() => applyAction(room, room.gm, { type: 'TEST_PLAYER_ACTION', participantId: player.participantId, playerAction: { type: 'ADJUST_HP' } }), /許可されていない/);
});
