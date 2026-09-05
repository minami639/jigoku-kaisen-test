import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAction, createTestRoom, projectState } from '../src/game.js';
import { CARD_BY_ID, CARDS } from '../src/definitions.js';

const DEFAULTS = ['flame-wall', 'freeze', 'needle-guard', 'healing-blood', 'leftover-shield', 'guard', 'reversal'];

function roomAt(stationIndex, stationTurn = 1) {
  const room = createTestRoom();
  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'TURN_SELECTION', stationIndex, stationTurn });
  return room;
}

function targetFor(room, index) {
  return room.players[(index + 1) % room.players.length].participantId;
}

function selectionFor(room, player, index, cardId, targetId) {
  const card = CARD_BY_ID[cardId];
  const selection = { type: 'SELECT_CARD', cardId };
  if (card.targetType === 'player') selection.targetId = targetId || targetFor(room, index);
  if (card.targetType === 'ownAttackCard') selection.cardTargetId = CARDS.find(item => item.packId === player.packId && item.category === 'attack').id;
  if (card.targetType === 'ownNonAttackCard') selection.cardTargetId = CARDS.find(item => item.packId === player.packId && item.category !== 'attack' && item.id !== cardId).id;
  if (cardId === 'encore') {
    const source = player.cardUsage.at(-1);
    selection.copyUsageId = source.id;
    selection.copyKind = 'attack';
  }
  return selection;
}

function resolve(room, overrides = {}) {
  room.players.forEach((player, index) => {
    const cardId = overrides[index]?.cardId || DEFAULTS[index];
    const targetId = overrides[index]?.targetId;
    applyAction(room, player, selectionFor(room, player, index, cardId, targetId));
    applyAction(room, player, { type: 'CONFIRM_CARD' });
  });
  applyAction(room, room.gm, { type: 'REVEAL_AND_RESOLVE' });
}

test('station modifiers: ice, scorch, war, blood, needle, and infinite sampled effects', () => {
  const ice = roomAt(1);
  resolve(ice, { 0: { cardId: 'flame-strike', targetId: ice.players[1].participantId } });
  assert.equal(ice.players[1].hp, 14, '炎撃2は極寒で実ダメージ1');

  const scorch = roomAt(0);
  resolve(scorch, { 0: { cardId: 'flame-strike', targetId: scorch.players[1].participantId } });
  assert.equal(scorch.players[1].hp, 12, '炎撃2は灼熱で実ダメージ3');

  const war = roomAt(5);
  resolve(war, { 0: { cardId: 'flame-strike', targetId: war.players[1].participantId } });
  assert.equal(war.players[1].hp, 12, '炎撃2は修羅で実ダメージ3');

  const blood = roomAt(3);
  blood.players[0].hp = 10;
  resolve(blood, { 3: { cardId: 'healing-blood', targetId: blood.players[0].participantId } });
  assert.equal(blood.players[0].hp, 13, '治癒血2は血潮で実回復3');

  const needle = roomAt(2);
  const focusTarget = needle.players[3];
  resolve(needle, {
    0: { cardId: 'flame-strike', targetId: focusTarget.participantId },
    1: { cardId: 'ice-spear', targetId: focusTarget.participantId }
  });
  assert.ok(needle.events.some(event => event.type === 'STATION_DAMAGE' && event.payload.targetId === focusTarget.participantId && event.payload.reason === 'NEEDLE_CONCENTRATION'));

  const infinite = roomAt(6);
  infinite.activeStationEffectIds = ['ice', 'war'];
  resolve(infinite, { 0: { cardId: 'flame-strike', targetId: infinite.players[1].participantId } });
  assert.equal(infinite.players[1].hp, 13, '修羅＋1と極寒−1だけが適用される');
  assert.deepEqual(infinite.events.find(event => event.type === 'TURN_RESOLVED').payload.stationEffects, ['ice', 'war']);
});

test('all 35 cards have an executable engine path', () => {
  for (const card of CARDS) {
    const room = roomAt(card.id === 'encore' ? 6 : 3);
    const ownerIndex = room.players.findIndex(player => player.packId === card.packId);
    const owner = room.players[ownerIndex];
    if (card.id === 'encore') owner.cardUsage.push({ id: 'old-severance', cardId: 'severance', stationIndex: 0, finalTarget: room.players[0].participantId });
    const targetId = targetFor(room, ownerIndex);
    assert.doesNotThrow(() => resolve(room, { [ownerIndex]: { cardId: card.id, targetId } }), card.name + ' should resolve');
    assert.equal(room.phase, 'TURN_RESULT', card.name + ' should complete a turn');
    assert.ok(owner.cardUsage.some(use => use.cardId === card.id), card.name + ' usage history');
  }
});

test('nullify, additional attack, full defense, carry state, CT and dead state follow the shared pipeline', () => {
  const room = roomAt(0);
  room.players[0].hp = 5;
  resolve(room, {
    0: { cardId: 'immolation', targetId: room.players[1].participantId },
    6: { cardId: 'nullify', targetId: room.players[0].participantId }
  });
  assert.equal(room.players[0].hp, 4, '焼身の攻撃を無効化しても自傷は残る');
  assert.equal(room.players[0].cardUsage.at(-1).result, 'NULLIFIED');

  const desperation = roomAt(3);
  resolve(desperation, {
    0: { cardId: 'flame-strike', targetId: desperation.players[5].participantId },
    4: { cardId: 'gluttony', targetId: desperation.players[6].participantId },
    5: { cardId: 'desperation', targetId: desperation.players[1].participantId }
  });
  const desEvents = desperation.events.filter(event => event.type === 'DIRECT_DAMAGE' && event.payload.cardId === 'desperation');
  assert.ok(desEvents.some(event => event.payload.phase === 'additional'), '捨て身は基本攻撃後に追加攻撃を生成');

  const reversed = roomAt(3);
  resolve(reversed, {
    1: { cardId: 'ice-spear', targetId: reversed.players[0].participantId },
    6: { cardId: 'reversal', targetId: reversed.players[0].participantId }
  });
  assert.ok(reversed.events.some(event => event.type === 'REVERSAL_ASSIGNED'));

  const carry = roomAt(0);
  resolve(carry, {
    1: { cardId: 'ice-spear', targetId: carry.players[0].participantId },
    6: { cardId: 'regression', targetId: carry.players[2].participantId }
  });
  assert.equal(carry.players[0].ongoingEffects[0].stackKey, 'ATTACK_DAMAGE_DOWN');
  carry.players[0].stationStats.reachedZero = true;
  carry.players[0].isDeadState = true;
  applyAction(carry, carry.gm, { type: 'TEST_JUMP_PHASE', phase: 'TURN_SELECTION', stationIndex: 1, stationTurn: 1 });
  carry.players[0].hp = 2;
  carry.players[0].stationStats.reachedZero = true;
  carry.players[0].isDeadState = true;
  resolve(carry, { 0: { cardId: 'flame-strike', targetId: carry.players[1].participantId } });
  assert.ok(carry.events.some(event => event.type === 'DIRECT_DAMAGE' && event.payload.cardId === 'flame-strike'), '亡者でも攻撃イベントは記録');
});

test('25 turns complete without a card processing error', () => {
  const room = createTestRoom();
  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'TURN_SELECTION', stationIndex: 0, stationTurn: 1 });
  let processed = 0;
  while (processed < 25) {
    assert.equal(room.phase, 'TURN_SELECTION');
    applyAction(room, room.gm, { type: 'TEST_AUTOFILL_TURN' });
    applyAction(room, room.gm, { type: 'REVEAL_AND_RESOLVE' });
    processed += 1;
    if (processed === 25) break;
    applyAction(room, room.gm, { type: 'TEST_ACK_ALL_RESULTS' });
    applyAction(room, room.gm, { type: 'NEXT_TURN' });
    if (room.phase === 'STATION_RESULT') {
      applyAction(room, room.gm, { type: 'START_FREE_TIME' });
      applyAction(room, room.gm, { type: 'START_NEXT_STATION' });
      while (room.phase === 'STATION_INTRODUCTION') applyAction(room, room.gm, { type: 'ADVANCE_STATION_INTRODUCTION' });
    }
  }
  assert.equal(processed, 25);
  assert.equal(room.globalTurnIndex, 25);
  assert.equal(room.phase, 'TURN_RESULT');
  assert.equal(room.events.filter(event => event.type === 'TURN_RESOLVED').length, 25);
});

test('dead state is retained within a station and resets only at the next-station boundary when HP is positive', () => {
  const room = createTestRoom();
  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'TURN_RESULT', stationIndex: 0, stationTurn: 3 });
  room.players[0].hp = 3;
  room.players[0].isDeadState = true;
  room.players[0].stationStats.reachedZero = true;
  room.players[1].hp = 0;
  room.players[1].isDeadState = true;
  room.players[1].stationStats.reachedZero = true;
  room.players.forEach(player => { player.confirmed = true; });
  applyAction(room, room.gm, { type: 'NEXT_TURN' });
  applyAction(room, room.gm, { type: 'START_FREE_TIME' });
  applyAction(room, room.gm, { type: 'START_NEXT_STATION' });
  assert.equal(room.players[0].isDeadState, false, '駅終了時HP1以上なら次駅で復帰');
  assert.equal(room.players[1].isDeadState, true, '駅終了時HP0なら亡者を維持');
});

test('plunder blocks both the normal cooldown turn and the following extension turn', () => {
  const room = roomAt(0);
  resolve(room, { 4: { cardId: 'plunder', targetId: room.players[0].participantId } });
  assert.equal(room.players[0].cardMarks['flame-wall'].cooldownExtensionUntil, 3);
  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'TURN_SELECTION', stationIndex: 0, stationTurn: 2 });
  let view = projectState(room, room.players[0]);
  let flameWall = view.me.cards.find(card => card.id === 'flame-wall');
  assert.equal(flameWall.cooldownStatus, 'EXTENSION');
  assert.equal(flameWall.unavailableReason, '【強奪】の効果により、あと2ターン使用できません。');
  assert.doesNotMatch(flameWall.unavailableReason, /COOLDOWN_EXTENSION/);
  assert.throws(() => applyAction(room, room.players[0], { type: 'SELECT_CARD', cardId: 'flame-wall', targetId: room.players[1].participantId, ctBypass: 'DESIRE' }), /【強奪】の効果により、あと2ターン使用できません。/);
  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'TURN_SELECTION', stationIndex: 0, stationTurn: 3 });
  view = projectState(room, room.players[0]);
  flameWall = view.me.cards.find(card => card.id === 'flame-wall');
  assert.equal(flameWall.unavailableReason, '【強奪】の効果により、あと1ターン使用できません。');
  assert.throws(() => applyAction(room, room.players[0], { type: 'SELECT_CARD', cardId: 'flame-wall', targetId: room.players[1].participantId }), /強奪/);
  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'TURN_SELECTION', stationIndex: 1, stationTurn: 1 });
  view = projectState(room, room.players[0]);
  flameWall = view.me.cards.find(card => card.id === 'flame-wall');
  assert.equal(flameWall.cooldownStatus, null);
  assert.equal(flameWall.unavailableReason, null);
  assert.doesNotThrow(() => applyAction(room, room.players[0], { type: 'SELECT_CARD', cardId: 'flame-wall', targetId: room.players[1].participantId }));
});

test('overkill prevented only on paper does not become defense support', () => {
  const room = roomAt(0);
  room.players[1].hp = 1;
  resolve(room, {
    0: { cardId: 'flame-strike', targetId: room.players[1].participantId },
    2: { cardId: 'needle-guard', targetId: room.players[1].participantId }
  });
  assert.equal(room.players[2].stationStats.support, 0);
});
