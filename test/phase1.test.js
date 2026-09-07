import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createRoom, createTestRoom, joinRoom, projectState } from '../src/game.js';
import { PACKS, CARDS, STATIONS, SHOP_DEFINITIONS, SHOP_ITEMS } from '../src/definitions.js';

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
  players.forEach((player, index) => applyAction(room, player, { type: 'SELECT_PACK', packId: PACKS[index].id }));
  applyAction(room, room.gm, { type: 'START_FIRST_STATION' });
  while (room.phase === 'STATION_INTRODUCTION') applyAction(room, room.gm, { type: 'ADVANCE_STATION_INTRODUCTION' });
  return { room, players };
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

const payment = coins => ({ one: 0, two: 0, three: 0, five: 0, seven: 0, ...coins });

test('definitions contain seven packs, 35 cards and 25 configured turns', () => {
  assert.equal(PACKS.length, 7);
  assert.equal(CARDS.length, 35);
  assert.equal(STATIONS.reduce((sum, station) => sum + station.turnCount, 0), 25);
});

test('seven selected packs let the GM open the first Hell introduction', () => {
  const room = createRoom();
  const players = Array.from({ length: 7 }, (_, index) => joinRoom(room, `PL${index + 1}`));
  applyAction(room, room.gm, { type: 'OPEN_INTRODUCTION' });
  applyAction(room, room.gm, { type: 'START_SELF_INTRODUCTION' });
  completeSelfIntroductions(room);
  applyAction(room, room.gm, { type: 'OPEN_PACK_SELECTION' });
  players.forEach((player, index) => applyAction(room, player, { type: 'SELECT_PACK', packId: PACKS[index].id }));

  applyAction(room, room.gm, { type: 'START_FIRST_STATION' });
  assert.equal(room.phase, 'STATION_INTRODUCTION');
  assert.equal(room.stationIndex, 0);
  assert.equal(room.stationTurn, 0);
  assert.equal(room.globalTurnIndex, 0);
  const introduction = projectState(room, players[0]).stationIntroduction;
  assert.equal(introduction.title, '第一地獄へ');
  assert.match(introduction.lines.join('\n'), /駅固有效果：灼熱/);
  assert.throws(() => applyAction(room, players[0], { type: 'ADVANCE_STATION_INTRODUCTION' }), /GM専用/);

  while (room.phase === 'STATION_INTRODUCTION') applyAction(room, room.gm, { type: 'ADVANCE_STATION_INTRODUCTION' });
  assert.equal(room.phase, 'TURN_SELECTION');
  assert.equal(room.stationTurn, 1);
  assert.equal(room.globalTurnIndex, 1);
});

test('introduction is followed by an eight-minute self-introduction phase', () => {
  const room = createRoom();
  Array.from({ length: 7 }, (_, index) => joinRoom(room, `PL${index + 1}`));
  assert.throws(() => applyAction(room, room.gm, { type: 'OPEN_PACK_SELECTION' }), /自己紹介/);
  applyAction(room, room.gm, { type: 'OPEN_INTRODUCTION' });
  assert.equal(room.phase, 'INTRODUCTION');
  assert.equal(room.introductionStep, 1);
  assert.throws(() => applyAction(room, room.players[0], { type: 'ADVANCE_INTRODUCTION' }), /GM専用/);
  while (room.phase === 'INTRODUCTION') applyAction(room, room.gm, { type: 'ADVANCE_INTRODUCTION' });
  assert.equal(room.phase, 'SELF_INTRODUCTION');
  assert.equal(room.timer.endsAt - room.timer.startedAt, 480_000);
  assert.throws(() => applyAction(room, room.gm, { type: 'OPEN_PACK_SELECTION' }), /PL7人全員/);
  completeSelfIntroductions(room);
  applyAction(room, room.gm, { type: 'OPEN_PACK_SELECTION' });
  assert.equal(room.phase, 'PACK_SELECTION');
  assert.equal(room.timer, null);
});

test('game guide is shown after self-introduction and every player starts with no currency', () => {
  const room = createRoom();
  Array.from({ length: 7 }, (_, index) => joinRoom(room, 'PL' + (index + 1)));
  assert.ok(room.players.every(player => player.currency.one === 0));
  applyAction(room, room.gm, { type: 'OPEN_INTRODUCTION' });
  applyAction(room, room.gm, { type: 'START_SELF_INTRODUCTION' });
  completeSelfIntroductions(room);
  applyAction(room, room.gm, { type: 'OPEN_GAME_GUIDE' });
  assert.equal(room.phase, 'GAME_GUIDE');
  const playerView = projectState(room, room.players[0]);
  assert.match(playerView.gameGuide.lines.join('\n'), /ココフォリア/);
  assert.ok(playerView.gameGuide.lines.every(block => Array.isArray(block) && block.length >= 1 && block.length <= 2));
  assert.throws(() => applyAction(room, room.players[0], { type: 'ADVANCE_GAME_GUIDE' }), /GM専用/);
  while (room.gameGuideStep < playerView.gameGuide.lines.length) applyAction(room, room.gm, { type: 'ADVANCE_GAME_GUIDE' });
  applyAction(room, room.gm, { type: 'ADVANCE_GAME_GUIDE' });
  assert.equal(room.phase, 'PACK_SELECTION');
});

test('exactly seven players join and pack duplication blocks station start', () => {
  const room = createRoom();
  const players = Array.from({ length: 7 }, (_, index) => joinRoom(room, `PL${index + 1}`));
  assert.throws(() => joinRoom(room, 'PL8'), /7人/);
  applyAction(room, room.gm, { type: 'OPEN_INTRODUCTION' });
  applyAction(room, room.gm, { type: 'START_SELF_INTRODUCTION' });
  completeSelfIntroductions(room);
  applyAction(room, room.gm, { type: 'OPEN_PACK_SELECTION' });
  players.forEach(player => applyAction(room, player, { type: 'SELECT_PACK', packId: 'scorch' }));
  assert.throws(() => applyAction(room, room.gm, { type: 'START_FIRST_STATION' }), /重複/);
});

test('pack choices are visible to every player without a separate confirmation step', () => {
  const room = createRoom();
  const players = Array.from({ length: 7 }, (_, index) => joinRoom(room, `PL${index + 1}`));
  applyAction(room, room.gm, { type: 'OPEN_INTRODUCTION' });
  applyAction(room, room.gm, { type: 'START_SELF_INTRODUCTION' });
  completeSelfIntroductions(room);
  applyAction(room, room.gm, { type: 'OPEN_PACK_SELECTION' });
  applyAction(room, players[0], { type: 'SELECT_PACK', packId: 'scorch', confirmed: true });
  const otherView = projectState(room, players[1]);
  assert.equal(otherView.players[0].packId, 'scorch');
  assert.equal(otherView.players[0].confirmed, false);
});

test('a player can clear any pack selection and choose again before the first station starts', () => {
  const room = createRoom();
  const gm = room.gm;
  const player = joinRoom(room, 'PL1');
  Array.from({ length: 6 }, (_, index) => joinRoom(room, `PL${index + 2}`));
  applyAction(room, gm, { type: 'OPEN_INTRODUCTION' });
  applyAction(room, gm, { type: 'START_SELF_INTRODUCTION' });
  completeSelfIntroductions(room);
  applyAction(room, gm, { type: 'OPEN_PACK_SELECTION' });

  applyAction(room, player, { type: 'SELECT_PACK', packId: 'scorch' });
  applyAction(room, player, { type: 'CLEAR_PACK_SELECTION' });
  assert.equal(player.packId, null);
  assert.equal(player.confirmed, false);

  applyAction(room, player, { type: 'SELECT_PACK', packId: 'scorch' });
  applyAction(room, player, { type: 'CLEAR_PACK_SELECTION' });
  assert.equal(player.packId, null);
  assert.equal(player.confirmed, false);
  applyAction(room, player, { type: 'SELECT_PACK', packId: 'ice', confirmed: false });
  assert.equal(player.packId, 'ice');
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
  assert.throws(() => applyAction(room, players[0], { type: 'SELECT_CARD', cardId: 'flame-strike', targetId: players[1].participantId }), /前のターンに使用したため、このターンは使用できません。/);
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
  while (room.phase === 'STATION_INTRODUCTION') applyAction(room, room.gm, { type: 'ADVANCE_STATION_INTRODUCTION' });
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
  assert.ok(room.players.every(player => player.packId && !player.confirmed));
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

  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'FREE_TIME', stationIndex: 4, stationTurn: 0 });
  assert.equal(room.phase, 'FREE_TIME');
  assert.equal(room.stationTurn, 4);
  assert.equal(room.globalTurnIndex, 16);
  assert.ok(room.timer.endsAt - room.timer.startedAt === 300_000);

  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'PACK_SELECTION' });
  assert.equal(room.phase, 'PACK_SELECTION');
  assert.equal(room.stationIndex, -1);
  assert.equal(room.globalTurnIndex, 0);

  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'GAME_GUIDE' });
  assert.equal(room.phase, 'GAME_GUIDE');
  assert.equal(room.gameGuideStep, 1);

  const normalRoom = createRoom();
  assert.throws(() => applyAction(normalRoom, normalRoom.gm, { type: 'TEST_JUMP_PHASE', phase: 'INTRODUCTION' }), /テストルーム専用/);
});

test('test GM can acknowledge every turn result at once', () => {
  const room = createTestRoom();
  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'TURN_RESULT', stationIndex: 0, stationTurn: 1 });
  assert.ok(room.players.every(player => !player.confirmed));
  applyAction(room, room.gm, { type: 'TEST_ACK_ALL_RESULTS' });
  assert.ok(room.players.every(player => player.confirmed));
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

function firstShopRoom() {
  const room = createTestRoom();
  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'FREE_TIME', stationIndex: 0, stationTurn: 0 });
  room.players.forEach(player => { player.currency.one = 5; });
  return room;
}

test('shops expose the newly unlocked first-shop products during the first free time', () => {
  const room = firstShopRoom();
  const view = projectState(room, room.players[0]);
  assert.equal(SHOP_ITEMS.length, 22);
  assert.equal(SHOP_DEFINITIONS.length, 6);
  assert.ok(SHOP_ITEMS.every(item => item.id && item.name && item.price && item.unlockAfterStation && item.effect && item.stock));
  assert.deepEqual(view.shop.items.map(item => [item.name, item.stock, item.soldOut]), [
    ['鬼火のお守り', 1, false], ['護りの数珠', 1, false], ['赤い包帯', 1, false]
  ]);
  applyAction(room, room.gm, { type: 'START_NEXT_STATION' });
  assert.throws(() => applyAction(room, room.players[0], { type: 'BUY_SHOP_ITEM', itemId: 'will-o-wisp-amulet' }), /自由時間/);
});

test('unlocked shop products remain available in later free time while locked shops stay unavailable', () => {
  const room = createTestRoom();
  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'FREE_TIME', stationIndex: 1, stationTurn: 0 });
  room.players[0].currency.one = 3;
  const view = projectState(room, room.players[0]);
  assert.equal(view.shop.items.length, 7);
  assert.equal(view.shop.items.filter(item => item.isNew).length, 4);
  assert.ok(view.shop.items.some(item => item.id === 'will-o-wisp-amulet' && item.isNew === false));
  applyAction(room, room.players[0], { type: 'BUY_SHOP_ITEM', itemId: 'will-o-wisp-amulet', payment: payment({ one: 3 }) });
  assert.equal(room.players[0].shopInventory[0].itemId, 'will-o-wisp-amulet');
  assert.throws(() => applyAction(room, room.players[1], { type: 'BUY_SHOP_ITEM', itemId: 'bloodstop-charm', payment: payment({ five: 1 }) }), /まだ解禁/);
});

test('SHOP解禁は3/4/4/4/4/3で、移動した3商品は指定駅まで販売されない', () => {
  const expectedNewItems = [
    ['scorch', 3, ['will-o-wisp-amulet', 'protective-rosary', 'red-bandage']],
    ['ice', 4, ['needle-ward', 'decoy-doll', 'demon-eye', 'accomplice-thread']],
    ['needle', 4, ['bloodstop-charm', 'shared-life-cup', 'blood-divination-needle', 'grudge-slip']],
    ['blood', 4, ['leftover-bag', 'hunger-lock', 'greedy-ticket', 'hell-key']],
    ['hunger', 4, ['war-mask', 'hell-chain', 'battle-medicine', 'scapegoat-slip']],
    ['war', 3, ['enma-eye', 'six-realms-chain', 'infinite-slip']]
  ];
  for (let stationIndex = 0; stationIndex < expectedNewItems.length; stationIndex += 1) {
    const room = createTestRoom();
    applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'FREE_TIME', stationIndex, stationTurn: 0 });
    const [, count, ids] = expectedNewItems[stationIndex];
    const view = projectState(room, room.players[0]);
    assert.equal(view.shop.items.filter(item => item.isNew).length, count);
    assert.deepEqual(view.shop.items.filter(item => item.isNew).map(item => item.id), ids);
  }

  const second = createTestRoom();
  applyAction(second, second.gm, { type: 'TEST_JUMP_PHASE', phase: 'FREE_TIME', stationIndex: 1, stationTurn: 0 });
  second.players[0].currency.two = 1;
  assert.throws(() => applyAction(second, second.players[0], { type: 'BUY_SHOP_ITEM', itemId: 'grudge-slip', payment: payment({ two: 1 }) }), /まだ解禁/);
  const third = createTestRoom();
  applyAction(third, third.gm, { type: 'TEST_JUMP_PHASE', phase: 'FREE_TIME', stationIndex: 2, stationTurn: 0 });
  third.players[0].currency.two = 1;
  assert.doesNotThrow(() => applyAction(third, third.players[0], { type: 'BUY_SHOP_ITEM', itemId: 'grudge-slip', payment: payment({ two: 1 }) }));
  const fourth = createTestRoom();
  applyAction(fourth, fourth.gm, { type: 'TEST_JUMP_PHASE', phase: 'FREE_TIME', stationIndex: 3, stationTurn: 0 });
  fourth.players[0].currency.three = 1;
  assert.doesNotThrow(() => applyAction(fourth, fourth.players[0], { type: 'BUY_SHOP_ITEM', itemId: 'hell-key', payment: payment({ three: 1 }) }));
  const fifth = createTestRoom();
  applyAction(fifth, fifth.gm, { type: 'TEST_JUMP_PHASE', phase: 'FREE_TIME', stationIndex: 4, stationTurn: 0 });
  fifth.players[0].currency.three = 1;
  assert.doesNotThrow(() => applyAction(fifth, fifth.players[0], { type: 'BUY_SHOP_ITEM', itemId: 'scapegoat-slip', payment: payment({ three: 1 }) }));
});

test('first-shop purchases accept chosen coin types and return canonical change atomically', () => {
  const room = firstShopRoom();
  const player = room.players[0];
  player.currency.five = 1;
  applyAction(room, player, { type: 'BUY_SHOP_ITEM', itemId: 'will-o-wisp-amulet', payment: payment({ five: 1 }) });
  assert.equal(player.currency.five, 0);
  assert.equal(player.currency.two, 1);
  assert.equal(player.shopInventory[0].itemId, 'will-o-wisp-amulet');
  assert.equal(player.shopInventory[0].transactionId, room.purchaseTransactions[0].id);
  assert.deepEqual(room.purchaseTransactions[0].payment, payment({ five: 1 }));
  assert.equal(room.purchaseTransactions[0].change.label, '弐×1');
  assert.equal(room.shopStock['will-o-wisp-amulet'], 0);
  assert.equal(room.purchaseTransactions[0].currencyCocofoliaApplied, false);

  const exactRoom = firstShopRoom();
  exactRoom.players[0].currency.two = 1;
  applyAction(exactRoom, exactRoom.players[0], { type: 'BUY_SHOP_ITEM', itemId: 'protective-rosary', payment: payment({ two: 1 }) });
  assert.equal(exactRoom.players[0].currency.two, 0);
  assert.equal(exactRoom.purchaseTransactions[0].change.total, 0);
});

test('shop payment change uses deterministic high-denomination decomposition', () => {
  const cases = [
    [{ one: 3 }, { one: 0, two: 0, three: 0, five: 0, seven: 0 }],
    [{ one: 1, two: 1 }, { one: 0, two: 0, three: 0, five: 0, seven: 0 }],
    [{ three: 1 }, { one: 0, two: 0, three: 0, five: 0, seven: 0 }],
    [{ seven: 1 }, { one: 1, two: 0, three: 1, five: 0, seven: 0 }],
    [{ two: 1, seven: 1 }, { one: 1, two: 0, three: 0, five: 1, seven: 0 }],
    [{ three: 1, seven: 1 }, { one: 0, two: 0, three: 0, five: 0, seven: 1 }]
  ];
  for (const [coins, expectedChange] of cases) {
    const room = firstShopRoom();
    const player = room.players[0];
    player.currency = payment(coins);
    applyAction(room, player, { type: 'BUY_SHOP_ITEM', itemId: 'will-o-wisp-amulet', payment: payment(coins) });
    assert.deepEqual(room.purchaseTransactions[0].change.coins, expectedChange);
  }
});

test('shop payment rejects an overpayment greater than 7', () => {
  const room = firstShopRoom();
  room.players[0].currency = payment({ three: 1, five: 1, seven: 1 });
  assert.throws(() => applyAction(room, room.players[0], { type: 'BUY_SHOP_ITEM', itemId: 'will-o-wisp-amulet', payment: payment({ three: 1, five: 1, seven: 1 }) }), /商品価格より7まで/);
});

test('paid prime coins are consumed and returned change can be used for a later purchase', () => {
  const room = firstShopRoom();
  const player = room.players[0];
  player.currency = payment({ five: 1 });
  applyAction(room, player, { type: 'BUY_SHOP_ITEM', itemId: 'will-o-wisp-amulet', payment: payment({ five: 1 }) });
  assert.equal(player.currency.five, 0);
  assert.equal(player.currency.two, 1);
  assert.throws(() => applyAction(room, player, { type: 'BUY_SHOP_ITEM', itemId: 'red-bandage', payment: payment({ five: 1 }) }), /伍/);
  applyAction(room, player, { type: 'BUY_SHOP_ITEM', itemId: 'protective-rosary', payment: payment({ two: 1 }) });
  assert.equal(player.currency.two, 0);
});

test('first shop rejects insufficient funds and resolves stock races without revealing buyer', () => {
  const room = firstShopRoom();
  room.players[0].currency.one = 4;
  assert.throws(() => applyAction(room, room.players[0], { type: 'BUY_SHOP_ITEM', itemId: 'will-o-wisp-amulet', payment: payment({ one: 2 }) }), /あと1/);
  applyAction(room, room.players[1], { type: 'BUY_SHOP_ITEM', itemId: 'will-o-wisp-amulet', payment: payment({ one: 3 }) });
  assert.throws(() => applyAction(room, room.players[2], { type: 'BUY_SHOP_ITEM', itemId: 'will-o-wisp-amulet', payment: payment({ one: 3 }) }), /他のプレイヤーが先に購入/);
  const otherView = projectState(room, room.players[2]);
  assert.equal(otherView.shop.items.find(item => item.id === 'will-o-wisp-amulet').soldOut, true);
  assert.equal(otherView.purchaseTransactions, undefined);
  assert.equal(otherView.players.find(player => player.playerNumber === 2).shopInventory, undefined);
  const ownerView = projectState(room, room.players[1]);
  assert.equal(ownerView.me.shopInventory[0].itemId, 'will-o-wisp-amulet');
  assert.equal(ownerView.me.purchaseTransactions.length, 1);
});

test('GM tracks only purchase currency reflection while the shop card remains Web-managed', () => {
  const room = firstShopRoom();
  room.players[0].currency.five = 1;
  applyAction(room, room.players[0], { type: 'BUY_SHOP_ITEM', itemId: 'will-o-wisp-amulet', payment: payment({ five: 1 }) });
  applyAction(room, room.players[1], { type: 'BUY_SHOP_ITEM', itemId: 'protective-rosary', payment: payment({ one: 2 }) });
  assert.equal(room.players[0].purchaseNotice.firstPurchase, true);
  assert.equal(room.players[1].purchaseNotice.firstPurchase, false);
  const gmView = projectState(room, room.gm);
  assert.equal(gmView.purchaseTransactions[0].playerName, 'テストPL1');
  assert.equal(gmView.purchaseTransactions[0].itemName, '鬼火のお守り');
  applyAction(room, room.gm, { type: 'MARK_PURCHASE_CURRENCY_APPLIED', transactionId: room.purchaseTransactions[0].id });
  assert.equal(room.purchaseTransactions[0].currencyCocofoliaApplied, true);
  assert.equal(room.purchaseTransactions[1].currencyCocofoliaApplied, false);
});

test('free-time readiness never auto-advances and owned reusable shop cards persist into ice', () => {
  const room = firstShopRoom();
  applyAction(room, room.players[0], { type: 'BUY_SHOP_ITEM', itemId: 'red-bandage', payment: payment({ one: 3 }) });
  room.players.forEach(player => applyAction(room, player, { type: 'SET_FREE_TIME_READY', ready: true }));
  assert.equal(room.phase, 'FREE_TIME');
  applyAction(room, room.gm, { type: 'START_NEXT_STATION' });
  while (room.phase === 'STATION_INTRODUCTION') applyAction(room, room.gm, { type: 'ADVANCE_STATION_INTRODUCTION' });
  assert.equal(room.phase, 'TURN_SELECTION');
  assert.equal(room.stationIndex, 1);
  assert.equal(room.players[0].shopInventory[0].purchased, true);
  assert.equal(room.players[0].shopInventory[0].totalUseCount, 0);
});

test('ice station uses a GM-controlled persistent introduction before its first turn', () => {
  const room = firstShopRoom();
  applyAction(room, room.gm, { type: 'START_NEXT_STATION' });

  assert.equal(room.phase, 'STATION_INTRODUCTION');
  assert.equal(room.stationIndex, 1);
  assert.equal(room.stationTurn, 0);
  assert.equal(room.globalTurnIndex, 3);
  const playerView = projectState(room, room.players[0]);
  assert.equal(playerView.stationIntroduction.title, '第二地獄へ');
  assert.match(playerView.stationIntroduction.lines.join('\n'), /極寒/);
  assert.equal(playerView.stationIntroduction.step, 1);
  assert.throws(() => applyAction(room, room.players[0], { type: 'ADVANCE_STATION_INTRODUCTION' }), /GM専用/);

  while (room.phase === 'STATION_INTRODUCTION') applyAction(room, room.gm, { type: 'ADVANCE_STATION_INTRODUCTION' });
  assert.equal(room.phase, 'TURN_SELECTION');
  assert.equal(room.stationTurn, 1);
  assert.equal(room.globalTurnIndex, 4);
});

test('needle station introduction is reachable after Ice Hell and needle concentration deals station damage once', () => {
  const room = createTestRoom();
  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'TURN_RESULT', stationIndex: 1, stationTurn: 3 });
  applyAction(room, room.gm, { type: 'TEST_ACK_ALL_RESULTS' });
  applyAction(room, room.gm, { type: 'NEXT_TURN' });
  assert.equal(room.phase, 'STATION_RESULT');
  completeRewardSyncAndStartFreeTime(room);
  applyAction(room, room.gm, { type: 'START_NEXT_STATION' });
  assert.equal(room.phase, 'STATION_INTRODUCTION');
  assert.equal(room.stationIndex, 2);
  assert.match(projectState(room, room.players[0]).stationIntroduction.lines.join('\n'), /針の集中/);

  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'TURN_SELECTION', stationIndex: 2, stationTurn: 1 });
  const cardIds = ['flame-strike', 'ice-spear', 'follow-needle', 'vampire', 'gluttony', 'heavy-slash', 'severance'];
  room.players.forEach((player, index) => {
    const target = room.players[index === 1 ? 0 : index === 0 || index === 2 ? 1 : 0];
    applyAction(room, player, { type: 'SELECT_CARD', cardId: cardIds[index], targetId: target.participantId });
    applyAction(room, player, { type: 'CONFIRM_CARD' });
  });
  applyAction(room, room.gm, { type: 'REVEAL_AND_RESOLVE' });
  assert.ok(room.events.some(item => item.type === 'STATION_DAMAGE' && item.payload.targetId === room.players[1].participantId && item.payload.reason === 'NEEDLE_CONCENTRATION'));
});

test('Blood Hell introduction is available and Blood Tide adds one to real recovery', () => {
  const room = createTestRoom();
  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'STATION_INTRODUCTION', stationIndex: 3, stationTurn: 0 });
  assert.match(projectState(room, room.players[0]).stationIntroduction.lines.join('\n'), /血潮/);

  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'TURN_SELECTION', stationIndex: 3, stationTurn: 1 });
  room.players[0].hp = 10;
  const cardIds = ['flame-strike', 'ice-spear', 'follow-needle', 'healing-blood', 'gluttony', 'heavy-slash', 'severance'];
  const targetIndexes = [1, 2, 1, 0, 1, 1, 1];
  room.players.forEach((player, index) => {
    applyAction(room, player, { type: 'SELECT_CARD', cardId: cardIds[index], targetId: room.players[targetIndexes[index]].participantId });
    applyAction(room, player, { type: 'CONFIRM_CARD' });
  });
  applyAction(room, room.gm, { type: 'REVEAL_AND_RESOLVE' });
  assert.equal(room.players[0].hp, 13);
  assert.ok(room.events.some(item => item.type === 'HEAL' && item.payload.cardId === 'healing-blood' && item.payload.amount === 3));
});

test('Hunger Hell introduction is available before its first turn', () => {
  const room = createTestRoom();
  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'STATION_INTRODUCTION', stationIndex: 4, stationTurn: 0 });
  const introduction = projectState(room, room.players[0]).stationIntroduction;
  assert.equal(introduction.title, '第五地獄へ');
  assert.match(introduction.lines.join('\\n'), /駅固有效果：強欲/);
  assert.match(introduction.lines.join('\\n'), /COOLDOWN_EXTENSION/);

  while (room.phase === 'STATION_INTRODUCTION') applyAction(room, room.gm, { type: 'ADVANCE_STATION_INTRODUCTION' });
  assert.equal(room.phase, 'TURN_SELECTION');
  assert.equal(room.stationTurn, 1);
  assert.equal(room.globalTurnIndex, 13);
});

test('War Hell introduction is available before its first turn', () => {
  const room = createTestRoom();
  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'STATION_INTRODUCTION', stationIndex: 5, stationTurn: 0 });
  const introduction = projectState(room, room.players[0]).stationIntroduction;
  assert.equal(introduction.title, '第六地獄へ');
  assert.match(introduction.lines.join('\\n'), /駅固有效果：修羅の戦場/);
  assert.match(introduction.lines.join('\\n'), /直接ダメージの上限は、これまでどおり4/);

  while (room.phase === 'STATION_INTRODUCTION') applyAction(room, room.gm, { type: 'ADVANCE_STATION_INTRODUCTION' });
  assert.equal(room.phase, 'TURN_SELECTION');
  assert.equal(room.stationTurn, 1);
  assert.equal(room.globalTurnIndex, 17);
});

test('Infinite Hell introduction presents Six-Hell Reenactment before its first turn', () => {
  const room = createTestRoom();
  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'STATION_INTRODUCTION', stationIndex: 6, stationTurn: 0 });
  const introduction = projectState(room, room.players[0]).stationIntroduction;
  assert.equal(introduction.title, '第七地獄へ');
  assert.match(introduction.lines.join('\\n'), /駅固有效果：六獄再演/);
  assert.match(introduction.lines.join('\\n'), /ランダムに2つの駅固有效果/);
  assert.match(introduction.lines.join('\\n'), /第七・無間地獄：全5ターン/);
  assert.doesNotMatch(introduction.lines.join('\\n'), /修羅の戦場/);

  while (room.phase === 'STATION_INTRODUCTION') applyAction(room, room.gm, { type: 'ADVANCE_STATION_INTRODUCTION' });
  assert.equal(room.phase, 'TURN_SELECTION');
  assert.equal(room.stationTurn, 1);
  assert.equal(room.globalTurnIndex, 21);
});

test('every shop settles chosen payment coins and returns value-based change', () => {
  const firstRoom = firstShopRoom();
  firstRoom.players[0].currency.five = 1;
  applyAction(firstRoom, firstRoom.players[0], { type: 'BUY_SHOP_ITEM', itemId: 'will-o-wisp-amulet', payment: payment({ five: 1 }) });
  assert.equal(firstRoom.players[0].currency.five, 0);
  assert.equal(firstRoom.players[0].currency.two, 1);

  const secondRoom = createTestRoom();
  secondRoom.players[0].currency.three = 1;
  applyAction(secondRoom, secondRoom.gm, { type: 'TEST_JUMP_PHASE', phase: 'FREE_TIME', stationIndex: 3, stationTurn: 0 });
  applyAction(secondRoom, secondRoom.players[0], { type: 'BUY_SHOP_ITEM', itemId: 'hell-key', payment: payment({ three: 1 }) });
  assert.equal(secondRoom.players[0].currency.three, 0);
  assert.equal(secondRoom.purchaseTransactions[0].change.total, 0);
  secondRoom.players[1].currency.one = 3;
  applyAction(secondRoom, secondRoom.players[1], { type: 'BUY_SHOP_ITEM', itemId: 'will-o-wisp-amulet', payment: payment({ one: 3 }) });
  assert.equal(secondRoom.players[1].shopInventory[0].itemId, 'will-o-wisp-amulet');

  const thirdRoom = createTestRoom();
  thirdRoom.players[0].currency.seven = 1;
  applyAction(thirdRoom, thirdRoom.gm, { type: 'TEST_JUMP_PHASE', phase: 'FREE_TIME', stationIndex: 2, stationTurn: 0 });
  applyAction(thirdRoom, thirdRoom.players[0], { type: 'BUY_SHOP_ITEM', itemId: 'bloodstop-charm', payment: payment({ seven: 1 }) });
  assert.equal(thirdRoom.players[0].currency.seven, 0);
  assert.equal(thirdRoom.players[0].currency.two, 1);
});

test('currency transfer requires GM confirmation and tracks CCF reflection', () => {
  const room = firstShopRoom();
  const [sender, recipient, outsider] = room.players;
  applyAction(room, sender, { type: 'CREATE_TRANSFER_REQUEST', recipientId: recipient.participantId, currencyType: 'one', amount: 2 });
  assert.equal(sender.currency.one, 5);
  assert.equal(projectState(room, outsider).transferRequests.length, 0);
  assert.equal(projectState(room, recipient).transferRequests.length, 1);
  applyAction(room, room.gm, { type: 'APPROVE_TRANSFER', transferId: room.transferRequests[0].id });
  assert.equal(sender.currency.one, 3);
  assert.equal(recipient.currency.one, 7);
  assert.equal(room.transferRequests[0].status, 'CONFIRMED');
  assert.equal(room.transferRequests[0].cocofoliaApplied, false);
  applyAction(room, room.gm, { type: 'MARK_TRANSFER_APPLIED', transferId: room.transferRequests[0].id });
  assert.equal(room.transferRequests[0].cocofoliaApplied, true);
});

test('third scorch result follows reward narration, Cocofolia sync, and GM-started free time', () => {
  const room = createTestRoom();
  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'TURN_RESULT', stationIndex: 0, stationTurn: 3 });
  room.players[0].stationStats.damageDealt = 3;
  room.players[0].stationStats.support = 1;
  room.players[0].stationStats.stationScore = 3;
  applyAction(room, room.gm, { type: 'TEST_ACK_ALL_RESULTS' });
  applyAction(room, room.gm, { type: 'NEXT_TURN' });
  assert.equal(room.phase, 'STATION_RESULT');
  assert.equal(room.stationResult.rankings.length, 7);
  const summary = room.stationResult.rewardSummary.find(entry => entry.participantId === room.players[0].participantId);
  assert.equal(summary.rankReward, 3);
  assert.equal(summary.supportAward, 1);
  assert.equal(summary.specialBonus, 1);
  assert.equal(summary.totalOne, 5);
  assert.match(room.stationResult.specialBonus.condition, /実ダメージ合計3以上/);
  assert.throws(() => applyAction(room, room.players[0], { type: 'BUY_SHOP_ITEM', itemId: 'will-o-wisp-amulet', payment: payment({ one: 5 }) }), /自由時間/);
  assert.throws(() => applyAction(room, room.gm, { type: 'START_NEXT_STATION' }), /自由時間/);
  applyAction(room, room.gm, { type: 'START_REWARD_NARRATION' });
  assert.equal(room.phase, 'REWARD_NARRATION');
  assert.match(projectState(room, room.players[0]).rewardNarration.lines.join('\n'), /支援賞/);
  while (room.phase === 'REWARD_NARRATION') applyAction(room, room.gm, { type: 'ADVANCE_REWARD_NARRATION' });
  assert.equal(room.phase, 'CURRENCY_SYNC_WAIT');
  assert.equal(room.timer, null);
  const playerView = projectState(room, room.players[0]);
  assert.equal(playerView.stationResult.rewardSummary.find(entry => entry.participantId === room.players[0].participantId).totalOne, 5);
  assert.throws(() => applyAction(room, room.gm, { type: 'START_FREE_TIME' }), /未反映/);
  assert.throws(() => applyAction(room, room.players[0], { type: 'CREATE_TRANSFER_REQUEST', recipientId: room.players[1].participantId, currencyType: 'one', amount: 1 }), /自由時間/);
  assert.throws(() => applyAction(room, room.gm, { type: 'START_NEXT_STATION' }), /自由時間/);
  const transactions = room.currencyTransactions.filter(item => item.stationId === 'scorch');
  assert.ok(transactions.length > 0);
  applyAction(room, room.gm, { type: 'MARK_PLAYER_STATION_REWARDS_APPLIED', participantId: room.players[0].participantId });
  assert.equal(room.phase, 'CURRENCY_SYNC_WAIT');
  for (const transaction of room.currencyTransactions.filter(item => item.stationId === 'scorch' && !item.cocofoliaApplied)) {
    applyAction(room, room.gm, { type: 'MARK_CURRENCY_TRANSACTION_APPLIED', transactionId: transaction.id });
  }
  applyAction(room, room.gm, { type: 'START_FREE_TIME' });
  assert.equal(room.phase, 'FREE_TIME_INTRO');
  const freeTimeNarration = projectState(room, room.players[0]).freeTimeIntroduction;
  assert.match(freeTimeNarration.lines.flat().join('\n'), /第一ショップ/);
  assert.match(freeTimeNarration.lines.flat().join('\n'), /1ターンに使えるSHOPカードは1枚まで/);
  while (room.phase === 'FREE_TIME_INTRO') applyAction(room, room.gm, { type: 'ADVANCE_FREE_TIME_INTRODUCTION' });
  assert.equal(room.phase, 'FREE_TIME');
  assert.equal(room.timer.endsAt - room.timer.startedAt, 300_000);
  applyAction(room, room.players[0], { type: 'BUY_SHOP_ITEM', itemId: 'will-o-wisp-amulet', payment: payment({ one: 5 }) });
});

test('Infinite Hell announces support and special outcomes without creating currency, then enters final flow', () => {
  const room = createTestRoom();
  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'TURN_RESULT', stationIndex: 6, stationTurn: 5 });
  const player = room.players[0];
  const fallenPlayer = room.players[1];
  player.hp = 4;
  fallenPlayer.hp = 6;
  fallenPlayer.stationStats.reachedZero = true;
  fallenPlayer.isDeadState = true;
  player.stationStats.support = 2;
  player.cardUsage = [
    { id: 'history-1', cardId: 'flame-strike', stationId: 'scorch', stationIndex: 0, stationTurn: 1, globalTurnIndex: 1, result: 'RESOLVED' },
    { id: 'history-2', cardId: 'flame-strike', stationId: 'war', stationIndex: 5, stationTurn: 1, globalTurnIndex: 17, result: 'RESOLVED' },
    { id: 'history-3', cardId: 'flame-strike', stationId: 'infinite', stationIndex: 6, stationTurn: 5, globalTurnIndex: 25, result: 'RESOLVED' }
  ];
  applyAction(room, room.gm, { type: 'TEST_ACK_ALL_RESULTS' });
  applyAction(room, room.gm, { type: 'NEXT_TURN' });
  assert.equal(room.phase, 'STATION_RESULT');
  assert.equal(room.stationResult.noCurrencyRewards, true);
  assert.deepEqual(room.stationResult.rankings, []);
  assert.equal(room.stationResult.specialBonus.amount, 0);
  assert.deepEqual(room.stationResult.specialBonus.winnerIds, [player.participantId]);
  assert.equal(room.currencyTransactions.filter(transaction => transaction.stationId === 'infinite').length, 0);
  applyAction(room, room.gm, { type: 'START_REWARD_NARRATION' });
  const narration = projectState(room, player).rewardNarration.lines.join('\n');
  assert.match(narration, /支援結果/);
  assert.match(narration, /新しい冥貨は配布されません/);
  while (room.phase === 'REWARD_NARRATION') applyAction(room, room.gm, { type: 'ADVANCE_REWARD_NARRATION' });
  assert.equal(room.phase, 'FINAL_RANKING');
  assert.equal(room.finalRanking.length, 7);
  assert.equal(room.infiniteSurvivorIds.includes(player.participantId), true);
  assert.equal(room.infiniteSurvivorIds.includes(fallenPlayer.participantId), false);
  assert.equal(projectState(room, player).finalRanking.find(entry => entry.participantId === player.participantId).survivedInfinite, true);
  applyAction(room, room.gm, { type: 'START_FINAL_ALIGNMENT' });
  assert.equal(room.phase, 'FINAL_ALIGNMENT');
  assert.equal(room.timer.endsAt - room.timer.startedAt, 180_000);
  applyAction(room, room.gm, { type: 'START_FINAL_JUDGMENT' });
  assert.equal(room.phase, 'FINAL_JUDGMENT');
  applyAction(room, room.gm, { type: 'CONFIRM_FINAL_ENDING', endingId: 'HELL_LOOP' });
  assert.equal(room.phase, 'ENDING');
  assert.equal(room.finalEnding.title, '地獄廻線');
  assert.equal(room.finalEnding.infiniteSurvivorIds.includes(player.participantId), true);
  assert.equal(room.finalEnding.infiniteSurvivorIds.includes(fallenPlayer.participantId), false);
});

test('test-mode playthrough reaches the final result after all 25 turns', () => {
  const room = createTestRoom();
  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'PACK_SELECTION' });
  applyAction(room, room.gm, { type: 'TEST_AUTOFILL_PACKS' });
  applyAction(room, room.gm, { type: 'START_FIRST_STATION' });
  let guard = 0;
  while (room.phase !== 'FINAL_RANKING' && guard++ < 1_200) {
    if (room.phase === 'STATION_INTRODUCTION') applyAction(room, room.gm, { type: 'ADVANCE_STATION_INTRODUCTION' });
    else if (room.phase === 'TURN_SELECTION') {
      applyAction(room, room.gm, { type: 'TEST_AUTOFILL_TURN' });
      applyAction(room, room.gm, { type: 'REVEAL_AND_RESOLVE' });
    } else if (room.phase === 'TURN_RESULT') {
      applyAction(room, room.gm, { type: 'TEST_ACK_ALL_RESULTS' });
      applyAction(room, room.gm, { type: 'NEXT_TURN' });
    } else if (room.phase === 'STATION_RESULT') applyAction(room, room.gm, { type: 'START_REWARD_NARRATION' });
    else if (room.phase === 'REWARD_NARRATION') applyAction(room, room.gm, { type: 'ADVANCE_REWARD_NARRATION' });
    else if (room.phase === 'CURRENCY_SYNC_WAIT') {
      room.currencyTransactions.filter(transaction => transaction.stationId === room.stationResult.stationId && !transaction.cocofoliaApplied).forEach(transaction => applyAction(room, room.gm, { type: 'MARK_CURRENCY_TRANSACTION_APPLIED', transactionId: transaction.id }));
      applyAction(room, room.gm, { type: 'START_FREE_TIME' });
    } else if (room.phase === 'FREE_TIME_INTRO') applyAction(room, room.gm, { type: 'ADVANCE_FREE_TIME_INTRODUCTION' });
    else if (room.phase === 'FREE_TIME') applyAction(room, room.gm, { type: 'START_NEXT_STATION' });
    else assert.fail(`想定外のフェーズ: ${room.phase}`);
  }
  assert.equal(guard < 1_200, true);
  assert.equal(room.globalTurnIndex, 25);
  assert.equal(room.phase, 'FINAL_RANKING');
  applyAction(room, room.gm, { type: 'START_FINAL_ALIGNMENT' });
  applyAction(room, room.gm, { type: 'START_FINAL_JUDGMENT' });
  applyAction(room, room.gm, { type: 'CONFIRM_FINAL_ENDING', endingId: 'HELL_LOOP' });
  assert.equal(room.phase, 'ENDING');
  assert.equal(room.finalEnding.id, 'HELL_LOOP');
});
