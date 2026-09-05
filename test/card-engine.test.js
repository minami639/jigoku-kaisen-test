import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAction, collectSimulationMetrics, createTestRoom, projectState } from '../src/game.js';
import { CARD_BY_ID, CARDS, SHOP_ITEMS } from '../src/definitions.js';

const DEFAULTS = ['flame-wall', 'freeze', 'needle-guard', 'healing-blood', 'leftover-shield', 'guard', 'reversal'];

function roomAt(stationIndex, stationTurn = 1) {
  const room = createTestRoom();
  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'TURN_SELECTION', stationIndex, stationTurn });
  return room;
}

function completeRewardSyncAndStartFreeTime(room) {
  applyAction(room, room.gm, { type: 'START_REWARD_NARRATION' });
  while (room.phase === 'REWARD_NARRATION') applyAction(room, room.gm, { type: 'ADVANCE_REWARD_NARRATION' });
  for (const transaction of room.currencyTransactions.filter(item => item.stationId === room.stationResult.stationId && !item.cocofoliaApplied)) {
    applyAction(room, room.gm, { type: 'MARK_CURRENCY_TRANSACTION_APPLIED', transactionId: transaction.id });
  }
  applyAction(room, room.gm, { type: 'START_FREE_TIME' });
  while (room.phase === 'FREE_TIME_INTRO') applyAction(room, room.gm, { type: 'ADVANCE_FREE_TIME_INTRODUCTION' });
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
    const override = overrides[index] || {};
    const cardId = override.cardId || DEFAULTS[index];
    const selection = { ...selectionFor(room, player, index, cardId, override.targetId) };
    for (const key of ['shopEntryId', 'shopTargetId', 'shopCardTargetId', 'ctBypass']) if (override[key] !== undefined) selection[key] = override[key];
    applyAction(room, player, selection);
    applyAction(room, player, { type: 'CONFIRM_CARD' });
  });
  applyAction(room, room.gm, { type: 'REVEAL_AND_RESOLVE' });
}

function grantShop(player, itemId, inventoryId = `${itemId}-${player.playerNumber}`) {
  const entry = { inventoryId, itemId, ownerPlayerId: player.participantId, purchased: true, lastUsedGlobalTurnIndex: null, cooldownUntilGlobalTurnIndex: null, totalUseCount: 0, acquiredAt: new Date().toISOString() };
  player.shopInventory.push(entry);
  return entry;
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

test('SHOP cards remain owned, have independent one-turn cooldowns, and continue across a station boundary', () => {
  const room = roomAt(0, 1);
  const owner = room.players[0];
  const will = grantShop(owner, 'will-o-wisp-amulet', 'will');
  const bandage = grantShop(owner, 'red-bandage', 'bandage');
  resolve(room, { 0: { cardId: 'flame-strike', targetId: room.players[1].participantId, shopEntryId: will.inventoryId } });
  assert.equal(will.totalUseCount, 1);
  assert.equal(will.cooldownUntilGlobalTurnIndex, 2);
  assert.equal(owner.shopInventory.length, 2, 'SHOP card is not consumed');
  assert.equal(room.revealedUsages[0].shopItemId, 'will-o-wisp-amulet');

  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'TURN_SELECTION', stationIndex: 0, stationTurn: 2 });
  room.players.forEach(player => { player.cardUsage = []; });
  assert.throws(() => applyAction(room, owner, { type: 'SELECT_CARD', cardId: 'flame-wall', targetId: room.players[1].participantId, shopEntryId: will.inventoryId }), /SHOPカード.*前のターン/);
  resolve(room, { 0: { cardId: 'flame-wall', targetId: room.players[1].participantId, shopEntryId: bandage.inventoryId } });
  assert.equal(bandage.totalUseCount, 1, 'another SHOP card can be used while the first is cooling down');

  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'TURN_SELECTION', stationIndex: 0, stationTurn: 3 });
  room.players.forEach(player => { player.cardUsage = []; });
  resolve(room, { 0: { cardId: 'flame-strike', targetId: room.players[1].participantId, shopEntryId: will.inventoryId } });
  assert.equal(will.totalUseCount, 2, 'the same SHOP card becomes usable again on T+2');

  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'TURN_SELECTION', stationIndex: 1, stationTurn: 1 });
  room.players.forEach(player => { player.cardUsage = []; });
  assert.throws(() => applyAction(room, owner, { type: 'SELECT_CARD', cardId: 'flame-wall', targetId: room.players[1].participantId, shopEntryId: will.inventoryId }), /SHOPカード.*前のターン/);
  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'TURN_SELECTION', stationIndex: 1, stationTurn: 2 });
  room.players.forEach(player => { player.cardUsage = []; });
  assert.doesNotThrow(() => applyAction(room, owner, { type: 'SELECT_CARD', cardId: 'flame-wall', targetId: room.players[1].participantId, shopEntryId: will.inventoryId }));
});

test('information SHOP is immediate, private, consumes the shop slot, and has the same cooldown', () => {
  const room = roomAt(1, 1);
  const owner = room.players[0];
  const eye = grantShop(owner, 'demon-eye', 'eye');
  const rosary = grantShop(owner, 'protective-rosary', 'rosary');
  applyAction(room, room.players[1], selectionFor(room, room.players[1], 1, 'ice-spear', owner.participantId));
  applyAction(room, owner, { type: 'USE_INFORMATION_SHOP', shopEntryId: eye.inventoryId, targetId: room.players[1].participantId });
  assert.equal(eye.totalUseCount, 1);
  assert.match(projectState(room, owner).me.infoShopResults.at(-1).result, /攻撃/);
  assert.equal(projectState(room, room.players[2]).me.infoShopResults.length, 0, 'other players never receive the private result');
  assert.throws(() => applyAction(room, owner, { type: 'SELECT_CARD', cardId: 'flame-wall', targetId: room.players[1].participantId, shopEntryId: rosary.inventoryId }), /すでに情報系SHOPカード/);

  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'TURN_SELECTION', stationIndex: 1, stationTurn: 2 });
  assert.throws(() => applyAction(room, owner, { type: 'USE_INFORMATION_SHOP', shopEntryId: eye.inventoryId, targetId: room.players[1].participantId }), /SHOPカード.*前のターン/);
  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'TURN_SELECTION', stationIndex: 1, stationTurn: 3 });
  assert.doesNotThrow(() => applyAction(room, owner, { type: 'USE_INFORMATION_SHOP', shopEntryId: eye.inventoryId, targetId: room.players[1].participantId }));
});

test('怨返しの札 secretly fixes its target and reacts once only to that PL’s direct actual damage', () => {
  const room = roomAt(0, 1);
  const owner = room.players[0];
  const designated = room.players[1];
  const grudge = grantShop(owner, 'grudge-slip', 'grudge');
  resolve(room, {
    0: { cardId: 'flame-wall', targetId: room.players[2].participantId, shopEntryId: grudge.inventoryId, shopTargetId: designated.participantId },
    1: { cardId: 'ice-spear', targetId: owner.participantId },
    6: { cardId: 'regression', targetId: room.players[2].participantId }
  });
  assert.equal(designated.hp, 14, 'specified attacker receives exactly one point after card processing');
  assert.ok(room.events.some(event => event.type === 'SHOP_DAMAGE' && event.payload.itemId === 'grudge-slip' && event.payload.targetId === designated.participantId));
  const uninvolvedView = projectState(room, room.players[2]);
  assert.equal(uninvolvedView.revealedUsages.find(use => use.participantId === owner.participantId).shopItemId, 'grudge-slip');
  assert.equal(uninvolvedView.players.find(player => player.participantId === owner.participantId).selection, undefined, 'the designated target was never projected before the reveal');

  const redirected = roomAt(0, 1);
  const redirectedOwner = redirected.players[0];
  const redirectedAttacker = redirected.players[2];
  const redirectedGrudge = grantShop(redirectedOwner, 'grudge-slip', 'redirected-grudge');
  resolve(redirected, {
    0: { cardId: 'flame-wall', targetId: redirected.players[3].participantId, shopEntryId: redirectedGrudge.inventoryId, shopTargetId: redirectedAttacker.participantId },
    1: { cardId: 'blizzard', targetId: redirectedAttacker.participantId },
    2: { cardId: 'follow-needle', targetId: redirectedOwner.participantId }
  });
  const redirectedAttack = redirected.events.find(event => event.type === 'TARGET_CHANGED_RANDOM' && event.payload.targetCardOwnerId === redirectedAttacker.participantId);
  assert.ok(redirectedAttack && redirectedAttack.payload.toTargetId !== redirectedOwner.participantId, 'the specified PL attack was redirected away from the owner');
  assert.ok(!redirected.events.some(event => event.type === 'SHOP_DAMAGE' && event.payload.itemId === 'grudge-slip'), 'a redirected attack that does not deal damage to the owner cannot trigger grudge');
  assert.ok(redirected.events.some(event => event.type === 'SHOP_EFFECT_FAILED' && event.payload.itemId === 'grudge-slip' && event.payload.reason === 'GRUDGE_NOT_TRIGGERED'));
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
      completeRewardSyncAndStartFreeTime(room);
      applyAction(room, room.gm, { type: 'START_NEXT_STATION' });
      while (room.phase === 'STATION_INTRODUCTION') applyAction(room, room.gm, { type: 'ADVANCE_STATION_INTRODUCTION' });
    }
  }
  assert.equal(processed, 25);
  assert.equal(room.globalTurnIndex, 25);
  assert.equal(room.phase, 'TURN_RESULT');
  assert.equal(room.events.filter(event => event.type === 'TURN_RESOLVED').length, 25);
});

test('25 turns execute every SHOP card, including reusable and information SHOP cards', () => {
  const room = createTestRoom();
  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'TURN_SELECTION', stationIndex: 0, stationTurn: 1 });
  const assigned = [
    [0, 'will-o-wisp-amulet'], [0, 'protective-rosary'], [0, 'red-bandage'], [0, 'needle-ward'], [0, 'decoy-doll'], [1, 'demon-eye'], [0, 'accomplice-thread'], [0, 'scapegoat-slip'], [0, 'grudge-slip'], [0, 'hell-key'],
    [1, 'bloodstop-charm'], [3, 'shared-life-cup'], [3, 'blood-divination-needle'], [4, 'leftover-bag'], [4, 'hunger-lock'], [4, 'greedy-ticket'], [5, 'war-mask'], [5, 'hell-chain'], [5, 'battle-medicine'], [6, 'enma-eye'], [6, 'six-realms-chain'], [6, 'infinite-slip']
  ];
  const entries = new Map();
  for (const [ownerIndex, itemId] of assigned) entries.set(itemId, grantShop(room.players[ownerIndex], itemId, `sim-${itemId}`));
  const schedule = new Map([
    [1, new Map([[0, 'will-o-wisp-amulet'], [1, 'demon-eye'], [3, 'shared-life-cup'], [4, 'leftover-bag'], [5, 'war-mask'], [6, 'enma-eye']])],
    [2, new Map([[0, 'protective-rosary'], [1, 'bloodstop-charm'], [3, 'blood-divination-needle'], [4, 'hunger-lock'], [5, 'hell-chain'], [6, 'six-realms-chain']])],
    [3, new Map([[0, 'will-o-wisp-amulet'], [4, 'greedy-ticket'], [5, 'battle-medicine'], [6, 'infinite-slip']])],
    [4, new Map([[0, 'needle-ward']])],
    [5, new Map([[0, 'will-o-wisp-amulet']])],
    [6, new Map([[0, 'decoy-doll']])],
    [7, new Map([[0, 'accomplice-thread']])],
    [8, new Map([[0, 'scapegoat-slip']])],
    [9, new Map([[0, 'hell-key']])],
    [10, new Map([[0, 'grudge-slip']])],
    [11, new Map([[0, 'red-bandage']])]
  ]);
  const preferredCard = new Map([
    ['will-o-wisp-amulet', 'flame-strike'], ['shared-life-cup', 'healing-blood'], ['accomplice-thread', 'flame-strike'], ['scapegoat-slip', 'immolation'], ['hell-key', 'immolation'], ['grudge-slip', 'flame-wall'], ['red-bandage', 'flame-strike']
  ]);
  let processed = 0;
  while (processed < 25) {
    assert.equal(room.phase, 'TURN_SELECTION');
    const turn = room.globalTurnIndex;
    const planned = schedule.get(turn) || new Map();
    const selectedPlayers = new Set();
    for (const [ownerIndex, itemId] of planned) {
      const item = SHOP_ITEMS.find(candidate => candidate.id === itemId);
      if (item.timing !== 'info') continue;
      const target = room.players[2];
      if (!selectedPlayers.has(2)) {
        const card = projectState(room, target).me.cards.find(candidate => !candidate.cooldownStatus && candidate.id !== 'encore');
        applyAction(room, target, selectionFor(room, target, 2, card.id));
        applyAction(room, target, { type: 'CONFIRM_CARD' });
        selectedPlayers.add(2);
      }
      const owner = room.players[ownerIndex];
      applyAction(room, owner, { type: 'USE_INFORMATION_SHOP', shopEntryId: entries.get(itemId).inventoryId, targetId: target.participantId });
    }
    room.players.forEach((player, index) => {
      if (selectedPlayers.has(index)) return;
      const itemId = planned.get(index);
      const item = itemId && SHOP_ITEMS.find(candidate => candidate.id === itemId);
      const view = projectState(room, player).me;
      let card = item && preferredCard.get(item.id) ? view.cards.find(candidate => candidate.id === preferredCard.get(item.id)) : null;
      if (!card || card.cooldownStatus || (card.id === 'encore' && !view.encoreCandidates.length)) card = view.cards.find(candidate => !candidate.cooldownStatus && candidate.id !== 'encore');
      const selection = selectionFor(room, player, index, card.id);
      if (item && item.timing !== 'info') {
        selection.shopEntryId = entries.get(itemId).inventoryId;
        if (item.effectType === 'GRUDGE') selection.shopTargetId = room.players[1].participantId;
        if (item.effectType === 'SECRET_TARGET_NOTICE') selection.shopTargetId = room.players[1].participantId;
        if (item.effectType === 'GREEDY_TICKET') selection.shopCardTargetId = view.cards.find(candidate => candidate.category !== 'attack' && candidate.id !== card.id && !candidate.cooldownStatus)?.id;
        if (item.effectType === 'NORMAL_CT_BYPASS') {
          selection.cardId = 'immolation';
          selection.targetId = room.players[1].participantId;
        }
      }
      if (turn === 10 && index === 1) {
        selection.cardId = view.cards.find(candidate => candidate.category === 'attack' && !candidate.cooldownStatus)?.id || selection.cardId;
        selection.targetId = room.players[0].participantId;
      }
      try { applyAction(room, player, selection); } catch (error) { error.message = `T${turn} PL${index + 1} ${selection.cardId}: ${error.message}`; throw error; }
      applyAction(room, player, { type: 'CONFIRM_CARD' });
    });
    applyAction(room, room.gm, { type: 'REVEAL_AND_RESOLVE' });
    processed += 1;
    if (processed === 25) break;
    applyAction(room, room.gm, { type: 'TEST_ACK_ALL_RESULTS' });
    applyAction(room, room.gm, { type: 'NEXT_TURN' });
    if (room.phase === 'STATION_RESULT') {
      completeRewardSyncAndStartFreeTime(room);
      applyAction(room, room.gm, { type: 'START_NEXT_STATION' });
      while (room.phase === 'STATION_INTRODUCTION') applyAction(room, room.gm, { type: 'ADVANCE_STATION_INTRODUCTION' });
    }
  }
  assert.equal(processed, 25);
  assert.equal(room.globalTurnIndex, 25);
  assert.ok(SHOP_ITEMS.every(item => entries.get(item.id).totalUseCount >= 1), 'all 22 SHOP cards were actually used');
  assert.ok(entries.get('will-o-wisp-amulet').totalUseCount >= 3, 'a reusable SHOP card can be used repeatedly across station boundaries');
  assert.ok(room.events.filter(event => event.type === 'SHOP_USED').length >= SHOP_ITEMS.length);
  assert.ok(room.events.filter(event => event.type === 'SHOP_COOLDOWN_STARTED').length >= SHOP_ITEMS.length);
  const metrics = collectSimulationMetrics(room);
  assert.equal(metrics.players.length, 7);
  assert.equal(metrics.packs.length, 7);
  assert.equal(metrics.shops.length, SHOP_ITEMS.length);
  assert.ok(metrics.players.every(player => Array.isArray(player.sevenCardUsage) && Array.isArray(player.shopUsage) && Number.isFinite(player.finalHp)));
  assert.ok(metrics.shops.find(item => item.itemId === 'will-o-wisp-amulet').useCount >= 3);
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
  completeRewardSyncAndStartFreeTime(room);
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
