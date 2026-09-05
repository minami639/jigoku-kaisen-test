import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createRoom, createTestRoom, joinRoom, projectState } from '../src/game.js';
import { PACKS, CARDS, STATIONS, SHOP_ITEMS } from '../src/definitions.js';

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

  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'FREE_TIME', stationIndex: 4, stationTurn: 0 });
  assert.equal(room.phase, 'FREE_TIME');
  assert.equal(room.stationTurn, 4);
  assert.equal(room.globalTurnIndex, 16);
  assert.ok(room.timer.endsAt - room.timer.startedAt === 300_000);

  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'PACK_SELECTION' });
  assert.equal(room.phase, 'PACK_SELECTION');
  assert.equal(room.stationIndex, -1);
  assert.equal(room.globalTurnIndex, 0);

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
  return room;
}

test('first shop exposes three stock-one products only during first free time', () => {
  const room = firstShopRoom();
  const view = projectState(room, room.players[0]);
  assert.equal(SHOP_ITEMS.length, 3);
  assert.deepEqual(view.shop.items.map(item => [item.name, item.stock, item.soldOut]), [
    ['鬼火のお守り', 1, false], ['護りの数珠', 1, false], ['赤い包帯', 1, false]
  ]);
  applyAction(room, room.gm, { type: 'START_NEXT_STATION' });
  assert.throws(() => applyAction(room, room.players[0], { type: 'BUY_SHOP_ITEM', itemId: 'will-o-wisp-amulet' }), /自由時間/);
});

test('first-shop purchases atomically exchange five one coins for item and prime change', () => {
  const cases = [
    ['will-o-wisp-amulet', 'two'],
    ['protective-rosary', 'three'],
    ['red-bandage', 'two']
  ];
  for (const [itemId, changeType] of cases) {
    const room = firstShopRoom();
    const player = room.players[0];
    applyAction(room, player, { type: 'BUY_SHOP_ITEM', itemId, paymentAmount: 5 });
    assert.equal(player.currency.one, 0);
    assert.equal(player.currency[changeType], 1);
    assert.equal(player.shopInventory[0].itemId, itemId);
    assert.equal(player.shopInventory[0].transactionId, room.purchaseTransactions[0].id);
    assert.equal(room.shopStock[itemId], 0);
    assert.equal(room.purchaseTransactions[0].cocofoliaApplied, false);
  }
});

test('first shop rejects insufficient funds and resolves stock races without revealing buyer', () => {
  const room = firstShopRoom();
  room.players[0].currency.one = 4;
  assert.throws(() => applyAction(room, room.players[0], { type: 'BUY_SHOP_ITEM', itemId: 'will-o-wisp-amulet', paymentAmount: 5 }), /あと1枚/);
  applyAction(room, room.players[1], { type: 'BUY_SHOP_ITEM', itemId: 'will-o-wisp-amulet', paymentAmount: 5 });
  assert.throws(() => applyAction(room, room.players[2], { type: 'BUY_SHOP_ITEM', itemId: 'will-o-wisp-amulet', paymentAmount: 5 }), /他のプレイヤーが先に購入/);
  const otherView = projectState(room, room.players[2]);
  assert.equal(otherView.shop.items.find(item => item.id === 'will-o-wisp-amulet').soldOut, true);
  assert.equal(otherView.purchaseTransactions, undefined);
  assert.equal(otherView.players.find(player => player.playerNumber === 2).shopInventory, undefined);
  const ownerView = projectState(room, room.players[1]);
  assert.equal(ownerView.me.shopInventory[0].itemId, 'will-o-wisp-amulet');
  assert.equal(ownerView.me.purchaseTransactions.length, 1);
});

test('GM can see and acknowledge CCF purchase work while first-purchase scene occurs once', () => {
  const room = firstShopRoom();
  applyAction(room, room.players[0], { type: 'BUY_SHOP_ITEM', itemId: 'will-o-wisp-amulet', paymentAmount: 5 });
  applyAction(room, room.players[1], { type: 'BUY_SHOP_ITEM', itemId: 'protective-rosary', paymentAmount: 5 });
  assert.equal(room.players[0].purchaseNotice.firstPurchase, true);
  assert.equal(room.players[1].purchaseNotice.firstPurchase, false);
  const gmView = projectState(room, room.gm);
  assert.equal(gmView.purchaseTransactions[0].playerName, 'テストPL1');
  assert.equal(gmView.purchaseTransactions[0].itemName, '鬼火のお守り');
  applyAction(room, room.gm, { type: 'MARK_PURCHASE_APPLIED', transactionId: room.purchaseTransactions[0].id });
  assert.equal(room.purchaseTransactions[0].cocofoliaApplied, true);
  assert.equal(room.purchaseTransactions[1].cocofoliaApplied, false);
});

test('free-time readiness never auto-advances and unused shop cards persist into ice', () => {
  const room = firstShopRoom();
  applyAction(room, room.players[0], { type: 'BUY_SHOP_ITEM', itemId: 'red-bandage', paymentAmount: 5 });
  room.players.forEach(player => applyAction(room, player, { type: 'SET_FREE_TIME_READY', ready: true }));
  assert.equal(room.phase, 'FREE_TIME');
  applyAction(room, room.gm, { type: 'START_NEXT_STATION' });
  while (room.phase === 'STATION_INTRODUCTION') applyAction(room, room.gm, { type: 'ADVANCE_STATION_INTRODUCTION' });
  assert.equal(room.phase, 'TURN_SELECTION');
  assert.equal(room.stationIndex, 1);
  assert.equal(room.players[0].shopInventory[0].used, false);
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
  applyAction(room, room.gm, { type: 'START_FREE_TIME' });
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

test('first-shop buyer chooses the one-coin payment amount and receives only the resulting change', () => {
  const exactRoom = firstShopRoom();
  applyAction(exactRoom, exactRoom.players[0], { type: 'BUY_SHOP_ITEM', itemId: 'will-o-wisp-amulet', paymentAmount: 3 });
  assert.equal(exactRoom.players[0].currency.one, 2);
  assert.equal(exactRoom.purchaseTransactions[0].change.amount, 0);

  const overpayRoom = firstShopRoom();
  applyAction(overpayRoom, overpayRoom.players[0], { type: 'BUY_SHOP_ITEM', itemId: 'protective-rosary', paymentAmount: 4 });
  assert.equal(overpayRoom.players[0].currency.one, 1);
  assert.equal(overpayRoom.players[0].currency.two, 1);
  assert.equal(overpayRoom.purchaseTransactions[0].payment.one, 4);
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

test('third scorch result advances through station result and GM-started free time', () => {
  const room = createTestRoom();
  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: 'TURN_RESULT', stationIndex: 0, stationTurn: 3 });
  applyAction(room, room.gm, { type: 'TEST_ACK_ALL_RESULTS' });
  applyAction(room, room.gm, { type: 'NEXT_TURN' });
  assert.equal(room.phase, 'STATION_RESULT');
  assert.equal(room.stationResult.rankings.length, 7);
  assert.ok(room.players.every(player => player.currency.one >= 5));
  applyAction(room, room.gm, { type: 'START_FREE_TIME' });
  assert.equal(room.phase, 'FREE_TIME');
  assert.equal(room.timer.endsAt - room.timer.startedAt, 300_000);
});
