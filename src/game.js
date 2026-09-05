import crypto from 'node:crypto';
import { CARDS, CARD_BY_ID, PACKS, PACK_BY_ID, SHOP_BY_STATION_ID, SHOP_ITEMS, SHOP_ITEM_BY_ID, STATIONS, STATION_EFFECTS } from './definitions.js';
import { GAME_GUIDE } from './game-guide.js';
import { stationIntroductionFor } from './station-introductions.js';

export const PHASE = Object.freeze({ LOBBY: 'LOBBY', INTRODUCTION: 'INTRODUCTION', SELF_INTRODUCTION: 'SELF_INTRODUCTION', GAME_GUIDE: 'GAME_GUIDE', PACK_SELECTION: 'PACK_SELECTION', TURN_SELECTION: 'TURN_SELECTION', TURN_RESULT: 'TURN_RESULT', STATION_RESULT: 'STATION_RESULT', FREE_TIME: 'FREE_TIME', STATION_INTRODUCTION: 'STATION_INTRODUCTION' });
const token = () => crypto.randomBytes(24).toString('base64url');
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const INTRODUCTION_STEP_COUNT = 39;

function event(room, type, payload = {}, visibility = 'public') {
  room.events.push({ id: id(), type, payload, visibility, globalTurnIndex: room.globalTurnIndex, at: now() });
}

export function createRoom(gmName = 'GM') {
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  const gm = { participantId: id(), authToken: token(), role: 'GM', name: gmName.trim() || 'GM' };
  const room = {
    id: id(), code, phase: PHASE.LOBBY, gm, players: [], stationIndex: -1, stationTurn: 0,
    globalTurnIndex: 0, timer: null, revealedUsages: [], stationResult: null, activeStationEffectIds: [], shopStock: Object.fromEntries(SHOP_ITEMS.map(item => [item.id, item.stock])), purchaseTransactions: [], transferRequests: [], firstPurchaseCompleted: false, events: [], createdAt: now(), updatedAt: now()
  };
  event(room, 'ROOM_CREATED', { gmName: gm.name });
  return room;
}

export function createTestRoom(gmName = 'テストGM') {
  const room = createRoom(gmName);
  room.testMode = true;
  Array.from({ length: 7 }, (_, index) => joinRoom(room, `テストPL${index + 1}`));
  applyAction(room, room.gm, { type: 'OPEN_INTRODUCTION' });
  event(room, 'TEST_ROOM_READY', { players: 7 });
  return room;
}

export function joinRoom(room, name) {
  if (room.phase !== PHASE.LOBBY) throw new Error('参加受付は終了しています');
  if (room.players.length >= 7) throw new Error('PL7人が参加済みです');
  const playerNumber = room.players.length + 1;
  const player = {
    participantId: id(), authToken: token(), role: 'PL', playerNumber, name: name.trim(), hp: 15,
    isDeadState: false, turnStartDeadState: false, packId: null, selection: null, confirmed: false, selfIntroductionComplete: false, freeTimeReady: false, hungerReuseUsed: false, cardUsage: [], cardMarks: {}, shopInventory: [], purchaseNotice: null,
    ongoingEffects: [], currency: { one: 0, two: 0, three: 0, five: 0, seven: 0 },
    stationStats: freshStats(), totalStats: freshStats()
  };
  if (!player.name) throw new Error('名前を入力してください');
  room.players.push(player);
  event(room, 'PLAYER_JOINED', { participantId: player.participantId, playerNumber, name: player.name });
  return player;
}

const freshStats = () => ({ damageDealt: 0, damageTaken: 0, support: 0, stationScore: 0, reachedZero: false });

export function authenticate(room, authToken) {
  if (room.gm.authToken === authToken) return room.gm;
  const player = room.players.find(item => item.authToken === authToken);
  if (!player) throw Object.assign(new Error('認証情報が無効です'), { status: 401 });
  return player;
}

function requireGm(actor) { if (actor.role !== 'GM') throw new Error('GM専用操作です'); }
function requirePlayer(actor) { if (actor.role !== 'PL') throw new Error('PL専用操作です'); }

function ensureRoomState(room) {
  room.shopStock ||= Object.fromEntries(SHOP_ITEMS.map(item => [item.id, item.stock]));
  for (const item of SHOP_ITEMS) room.shopStock[item.id] ??= item.stock;
  room.purchaseTransactions ||= [];
  room.transferRequests ||= [];
  room.currencyTransactions ||= [];
  room.firstPurchaseCompleted ||= false;
  room.stationIntroductionStep ||= 0;
  room.activeStationEffectIds ||= [];
  room.gameGuideStep ||= 0;
  for (const transaction of room.purchaseTransactions) {
    transaction.currencyCocofoliaApplied ??= Boolean(transaction.cocofoliaApplied);
  }
  for (const player of room.players) {
    player.shopInventory ||= [];
    player.purchaseNotice ||= null;
    player.freeTimeReady ||= false;
    player.ongoingEffects ||= [];
    player.cardMarks ||= {};
    player.hungerReuseUsed ||= false;
    player.turnStartDeadState ||= false;
  }
}

export function applyAction(room, actor, action) {
  ensureRoomState(room);
  switch (action.type) {
    case 'OPEN_INTRODUCTION':
      requireGm(actor);
      if (room.phase !== PHASE.LOBBY) throw new Error('乗車受付フェーズではありません');
      if (room.players.length !== 7) throw new Error('PL7人の参加が必要です');
      room.phase = PHASE.INTRODUCTION;
      room.introductionStep = 1;
      event(room, 'INTRODUCTION_STARTED');
      break;
    case 'ADVANCE_INTRODUCTION':
      requireGm(actor);
      if (room.phase !== PHASE.INTRODUCTION) throw new Error('導入フェーズではありません');
      if (room.introductionStep < INTRODUCTION_STEP_COUNT) {
        room.introductionStep += 1;
        event(room, 'INTRODUCTION_ADVANCED', { step: room.introductionStep }, 'gm');
      } else {
        startSelfIntroduction(room);
      }
      break;
    case 'START_SELF_INTRODUCTION':
      requireGm(actor);
      if (room.phase !== PHASE.INTRODUCTION) throw new Error('導入フェーズではありません');
      startSelfIntroduction(room);
      break;
    case 'COMPLETE_SELF_INTRODUCTION':
      requirePlayer(actor);
      if (room.phase !== PHASE.SELF_INTRODUCTION) throw new Error('自己紹介フェーズではありません');
      actor.selfIntroductionComplete = true;
      event(room, 'SELF_INTRODUCTION_COMPLETED', { participantId: actor.participantId, playerNumber: actor.playerNumber });
      break;
    case 'TEST_COMPLETE_SELF_INTRODUCTION': {
      requireGm(actor);
      if (!room.testMode) throw new Error('テストルーム専用操作です');
      if (room.phase !== PHASE.SELF_INTRODUCTION) throw new Error('自己紹介フェーズではありません');
      const player = room.players.find(item => item.participantId === action.participantId);
      if (!player) throw new Error('対象PLが見つかりません');
      applyAction(room, player, { type: 'COMPLETE_SELF_INTRODUCTION' });
      break;
    }
    case 'OPEN_PACK_SELECTION':
      requireGm(actor);
      if (room.phase !== PHASE.SELF_INTRODUCTION) throw new Error('自己紹介フェーズではありません');
      if (Date.now() < room.timer.endsAt && room.players.some(player => !player.selfIntroductionComplete)) throw new Error('8分経過またはPL7人全員の完了が必要です');
      room.phase = PHASE.PACK_SELECTION;
      room.timer = null;
      event(room, 'PACK_SELECTION_STARTED');
      break;
    case 'OPEN_GAME_GUIDE':
      requireGm(actor);
      if (room.phase !== PHASE.SELF_INTRODUCTION) throw new Error('自己紹介フェーズではありません');
      if (Date.now() < room.timer.endsAt && room.players.some(player => !player.selfIntroductionComplete)) throw new Error('8分経過またはPL7人全員の完了が必要です');
      room.phase = PHASE.GAME_GUIDE;
      room.timer = null;
      room.gameGuideStep = 1;
      event(room, 'GAME_GUIDE_STARTED');
      break;
    case 'ADVANCE_GAME_GUIDE':
      requireGm(actor);
      if (room.phase !== PHASE.GAME_GUIDE) throw new Error('ゲーム説明フェーズではありません');
      if (room.gameGuideStep < GAME_GUIDE.lines.length) {
        room.gameGuideStep += 1;
        event(room, 'GAME_GUIDE_ADVANCED', { step: room.gameGuideStep }, 'gm');
      } else {
        room.phase = PHASE.PACK_SELECTION;
        room.timer = null;
        event(room, 'PACK_SELECTION_STARTED');
      }
      break;
    case 'SELECT_PACK': {
      requirePlayer(actor);
      if (room.phase !== PHASE.PACK_SELECTION) throw new Error('パック選択フェーズではありません');
      if (!PACK_BY_ID[action.packId]) throw new Error('存在しないパックです');
      actor.packId = action.packId;
      actor.confirmed = Boolean(action.confirmed);
      event(room, 'PACK_SELECTED', { participantId: actor.participantId, confirmed: actor.confirmed }, `private:${actor.participantId}`);
      break;
    }
    case 'START_FIRST_STATION':
      requireGm(actor);
      startFirstStation(room);
      break;
    case 'SELECT_CARD':
      requirePlayer(actor);
      selectCard(room, actor, action);
      break;
    case 'CONFIRM_CARD':
      requirePlayer(actor);
      if (!actor.selection) throw new Error('カードと対象を選択してください');
      validateSelection(room, actor, actor.selection);
      validateStoredCooldown(room, actor, actor.selection);
      actor.confirmed = true;
      event(room, 'CARD_CONFIRMED', { participantId: actor.participantId }, `private:${actor.participantId}`);
      break;
    case 'UNLOCK_PLAYER':
      requireGm(actor);
      room.players.find(p => p.participantId === action.participantId).confirmed = false;
      break;
    case 'REVEAL_AND_RESOLVE':
      requireGm(actor);
      if (room.phase !== PHASE.TURN_SELECTION || room.players.some(p => !p.confirmed)) throw new Error('全PLの最終確認が必要です');
      resolveTurn(room);
      break;
    case 'ACK_RESULT':
      requirePlayer(actor);
      if (room.phase !== PHASE.TURN_RESULT) throw new Error('ターン結果確認中ではありません');
      actor.confirmed = true;
      event(room, 'TURN_RESULT_ACKNOWLEDGED', { participantId: actor.participantId, playerNumber: actor.playerNumber });
      break;
    case 'NEXT_TURN':
      requireGm(actor);
      if (room.players.some(player => !player.confirmed)) throw new Error('全PLの結果確認完了が必要です');
      nextTurn(room);
      break;
    case 'START_FREE_TIME':
      requireGm(actor);
      if (room.phase !== PHASE.STATION_RESULT || room.stationIndex >= STATIONS.length - 1) throw new Error('自由時間を開始できる駅結果ではありません');
      room.phase = PHASE.FREE_TIME;
      room.timer = { startedAt: Date.now(), endsAt: Date.now() + 300_000 };
      room.players.forEach(player => { player.freeTimeReady = false; player.confirmed = false; });
      event(room, 'FREE_TIME_STARTED', { stationId: STATIONS[room.stationIndex].id, seconds: 300 });
      break;
    case 'BUY_SHOP_ITEM':
      requirePlayer(actor);
      purchaseShopItem(room, actor, action.itemId, action.paymentAmount);
      break;
    case 'CREATE_TRANSFER_REQUEST':
      requirePlayer(actor);
      createTransferRequest(room, actor, action);
      break;
    case 'DISMISS_PURCHASE_NOTICE':
      requirePlayer(actor);
      actor.purchaseNotice = null;
      break;
    case 'SET_FREE_TIME_READY':
      requirePlayer(actor);
      if (room.phase !== PHASE.FREE_TIME) throw new Error('自由時間中ではありません');
      actor.freeTimeReady = Boolean(action.ready);
      event(room, 'FREE_TIME_READY_CHANGED', { participantId: actor.participantId, ready: actor.freeTimeReady });
      break;
    case 'START_NEXT_STATION':
      requireGm(actor);
      if (room.phase !== PHASE.FREE_TIME || room.stationIndex >= STATIONS.length - 1) throw new Error('次の地獄へ進める自由時間ではありません');
      startNextStation(room);
      break;
    case 'ADVANCE_STATION_INTRODUCTION':
      requireGm(actor);
      advanceStationIntroduction(room);
      break;
    case 'MARK_PURCHASE_CURRENCY_APPLIED':
    case 'MARK_PURCHASE_APPLIED': { // 既存ルーム向けの互換アクション
      requireGm(actor);
      const transaction = room.purchaseTransactions.find(item => item.id === action.transactionId);
      if (!transaction) throw new Error('購入取引が見つかりません');
      transaction.currencyCocofoliaApplied = true;
      transaction.currencyAppliedAt = now();
      event(room, 'PURCHASE_CURRENCY_COCOFOLIA_APPLIED', { transactionId: transaction.id }, 'gm');
      break;
    }
    case 'APPROVE_TRANSFER':
      requireGm(actor);
      approveTransfer(room, action.transferId);
      break;
    case 'REJECT_TRANSFER':
      requireGm(actor);
      updateTransferStatus(room, action.transferId, 'REJECTED');
      break;
    case 'MARK_TRANSFER_APPLIED': {
      requireGm(actor);
      const transfer = room.transferRequests.find(item => item.id === action.transferId && item.status === 'CONFIRMED');
      if (!transfer) throw new Error('確定済みの譲渡が見つかりません');
      transfer.cocofoliaApplied = true;
      transfer.appliedAt = now();
      event(room, 'TRANSFER_COCOFOLIA_APPLIED', { transferId: transfer.id }, 'gm');
      break;
    }
    case 'SET_TIMER':
      requireGm(actor);
      room.timer = { startedAt: Date.now(), endsAt: Date.now() + Math.max(0, Number(action.seconds)) * 1000 };
      break;
    case 'ADJUST_HP': {
      requireGm(actor);
      const player = room.players.find(p => p.participantId === action.participantId);
      if (!player) throw new Error('対象PLが見つかりません');
      const before = player.hp;
      player.hp = Math.max(0, Math.min(15, Number(action.hp)));
      event(room, 'GM_HP_ADJUSTED', { participantId: player.participantId, before, after: player.hp, reason: String(action.reason || 'テスト用補正') }, 'gm');
      break;
    }
    case 'TEST_AUTOFILL_TURN':
      requireGm(actor);
      if (!room.testMode) throw new Error('テストルーム専用操作です');
      if (room.phase !== PHASE.TURN_SELECTION) throw new Error('カード選択フェーズではありません');
      for (const player of room.players) {
        if (player.confirmed) continue;
        const card = CARDS.find(candidate => candidate.packId === player.packId && !cooldownReason(player, candidate.id, room.globalTurnIndex) && (candidate.id !== 'encore' || hasEncoreCandidate(room, player)));
        if (!card) throw new Error(`PL${player.playerNumber}に選択可能なカードがありません`);
        const target = room.players.find(candidate => candidate.playerNumber === (player.playerNumber % 7) + 1);
        const payload = { type: 'SELECT_CARD', cardId: card.id };
        if (card.targetType === 'player') payload.targetId = target.participantId;
        if (card.targetType === 'ownAttackCard') payload.cardTargetId = CARDS.find(candidate => candidate.packId === player.packId && candidate.category === 'attack').id;
        if (card.targetType === 'ownNonAttackCard') payload.cardTargetId = CARDS.find(candidate => candidate.packId === player.packId && candidate.category !== 'attack' && candidate.id !== card.id).id;
        if (card.id === 'encore') {
          const source = [...player.cardUsage].reverse().find(use => use.stationIndex <= room.stationIndex - 3 && ['attack', 'defense', 'heal'].includes(CARD_BY_ID[use.cardId]?.effect?.kind));
          payload.copyUsageId = source?.id;
          payload.copyKind = CARD_BY_ID[source?.cardId]?.effect?.kind;
        }
        selectCard(room, player, payload);
        player.confirmed = true;
        event(room, 'TEST_SELECTION_FILLED', { participantId: player.participantId, cardId: card.id }, 'gm');
      }
      break;
    case 'TEST_ACK_ALL_RESULTS':
      requireGm(actor);
      if (!room.testMode) throw new Error('テストルーム専用操作です');
      if (room.phase !== PHASE.TURN_RESULT) throw new Error('ターン結果確認中ではありません');
      room.players.forEach(player => { player.confirmed = true; });
      event(room, 'TEST_ALL_RESULTS_ACKNOWLEDGED', { players: room.players.length }, 'gm');
      break;
    case 'TEST_GRANT_ONE_CURRENCY':
      requireGm(actor);
      if (!room.testMode) throw new Error('テストルーム専用操作です');
      room.players.forEach(player => { player.currency.one = Math.max(player.currency.one, 20); });
      event(room, 'TEST_ONE_CURRENCY_GRANTED', { amount: 20 }, 'gm');
      break;
    case 'TEST_SELECT_PACK': {
      requireGm(actor);
      if (!room.testMode) throw new Error('テストルーム専用操作です');
      if (room.phase !== PHASE.PACK_SELECTION) throw new Error('パック選択フェーズではありません');
      const player = room.players.find(p => p.participantId === action.participantId);
      if (!player) throw new Error('対象PLが見つかりません');
      applyAction(room, player, { type: 'SELECT_PACK', packId: action.packId, confirmed: true });
      event(room, 'TEST_PACK_ASSIGNED', { participantId: player.participantId, packId: action.packId }, 'gm');
      break;
    }
    case 'TEST_AUTOFILL_PACKS': {
      requireGm(actor);
      if (!room.testMode) throw new Error('テストルーム専用操作です');
      if (room.phase !== PHASE.PACK_SELECTION) throw new Error('パック選択フェーズではありません');
      const packs = PACKS.map(pack => pack.id);
      for (let index = packs.length - 1; index > 0; index -= 1) {
        const swapIndex = crypto.randomInt(index + 1);
        [packs[index], packs[swapIndex]] = [packs[swapIndex], packs[index]];
      }
      room.players.forEach((player, index) => {
        player.packId = packs[index];
        player.confirmed = true;
      });
      event(room, 'TEST_PACKS_AUTOFILLED', { assignments: room.players.map(player => ({ playerNumber: player.playerNumber, packId: player.packId })) }, 'gm');
      break;
    }
    case 'TEST_JUMP_PHASE':
      requireGm(actor);
      if (!room.testMode) throw new Error('テストルーム専用操作です');
      jumpTestPhase(room, action);
      break;
    case 'TEST_PLAYER_ACTION': {
      requireGm(actor);
      if (!room.testMode) throw new Error('テストルーム専用操作です');
      if (!['SELECT_CARD', 'CONFIRM_CARD', 'ACK_RESULT', 'BUY_SHOP_ITEM', 'CREATE_TRANSFER_REQUEST', 'DISMISS_PURCHASE_NOTICE', 'SET_FREE_TIME_READY'].includes(action.playerAction?.type)) throw new Error('許可されていないテスト操作です');
      const player = room.players.find(item => item.participantId === action.participantId);
      if (!player) throw new Error('対象PLが見つかりません');
      applyAction(room, player, action.playerAction);
      event(room, 'TEST_PLAYER_ACTION_APPLIED', { participantId: player.participantId, actionType: action.playerAction.type }, 'gm');
      break;
    }
    default: throw new Error('未対応の操作です');
  }
  room.updatedAt = now();
  return room;
}

function jumpTestPhase(room, action) {
  const destination = String(action.phase || '');
  if (![PHASE.INTRODUCTION, PHASE.SELF_INTRODUCTION, PHASE.GAME_GUIDE, PHASE.PACK_SELECTION, PHASE.TURN_SELECTION, PHASE.TURN_RESULT, PHASE.FREE_TIME, PHASE.STATION_INTRODUCTION].includes(destination)) throw new Error('移動先フェーズが不正です');
  room.revealedUsages = [];
  for (const player of room.players) { player.selection = null; player.confirmed = false; }

  if (destination === PHASE.INTRODUCTION) {
    room.phase = destination; room.stationIndex = -1; room.stationTurn = 0; room.globalTurnIndex = 0; room.timer = null; room.introductionStep = 1;
  } else if (destination === PHASE.SELF_INTRODUCTION) {
    room.stationIndex = -1; room.stationTurn = 0; room.globalTurnIndex = 0;
    startSelfIntroduction(room);
  } else if (destination === PHASE.GAME_GUIDE) {
    room.phase = destination; room.stationIndex = -1; room.stationTurn = 0; room.globalTurnIndex = 0; room.timer = null; room.gameGuideStep = 1;
  } else if (destination === PHASE.PACK_SELECTION) {
    room.phase = destination; room.stationIndex = -1; room.stationTurn = 0; room.globalTurnIndex = 0; room.timer = null;
  } else {
    const stationIndex = Number(action.stationIndex);
    const station = STATIONS[stationIndex];
    const stationTurn = Number(action.stationTurn);
    if (!station || (destination === PHASE.FREE_TIME ? stationIndex >= STATIONS.length - 1 : destination === PHASE.STATION_INTRODUCTION ? !stationIntroductionFor(station.id) : (!Number.isInteger(stationTurn) || stationTurn < 1 || stationTurn > station.turnCount))) throw new Error('駅またはターンが不正です');
    ensureTestPacks(room);
    room.phase = destination; room.stationIndex = stationIndex; room.stationTurn = destination === PHASE.FREE_TIME ? station.turnCount : destination === PHASE.STATION_INTRODUCTION ? 0 : stationTurn;
    room.globalTurnIndex = STATIONS.slice(0, stationIndex).reduce((sum, item) => sum + item.turnCount, 0) + (destination === PHASE.FREE_TIME ? station.turnCount : destination === PHASE.STATION_INTRODUCTION ? 0 : stationTurn);
    room.stationIntroductionStep = destination === PHASE.STATION_INTRODUCTION ? 1 : 0;
    room.timer = destination === PHASE.TURN_SELECTION ? { startedAt: Date.now(), endsAt: Date.now() + station.turnSeconds * 1000 } : destination === PHASE.FREE_TIME ? { startedAt: Date.now(), endsAt: Date.now() + 300_000 } : null;
    room.activeStationEffectIds = [];
    if (station.id === 'infinite') chooseInfiniteEffects(room);
    if (destination === PHASE.TURN_SELECTION) prepareTurnSnapshot(room);
  }
  event(room, 'TEST_PHASE_JUMPED', { phase: room.phase, stationIndex: room.stationIndex, stationTurn: room.stationTurn }, 'gm');
}

function ensureTestPacks(room) {
  const assigned = room.players.map(player => player.packId);
  if (assigned.every(packId => PACK_BY_ID[packId]) && new Set(assigned).size === room.players.length) return;
  room.players.forEach((player, index) => { player.packId = PACKS[index].id; });
  event(room, 'TEST_PACKS_ASSIGNED_FOR_PHASE_JUMP', {}, 'gm');
}

function startSelfIntroduction(room) {
  room.phase = PHASE.SELF_INTRODUCTION;
  room.timer = { startedAt: Date.now(), endsAt: Date.now() + 480_000 };
  for (const player of room.players) player.selfIntroductionComplete = false;
  event(room, 'SELF_INTRODUCTION_STARTED', { seconds: 480 });
}

function chooseInfiniteEffects(room) {
  if (room.activeStationEffectIds?.length === 2) return;
  const candidates = ['scorch', 'ice', 'needle', 'blood', 'hunger', 'war'];
  const first = crypto.randomInt(candidates.length);
  const [one] = candidates.splice(first, 1);
  const two = candidates[crypto.randomInt(candidates.length)];
  room.activeStationEffectIds = [one, two];
  event(room, 'INFINITE_EFFECTS_SELECTED', { effectIds: room.activeStationEffectIds }, 'public');
}
function prepareTurnSnapshot(room) {
  for (const player of room.players) {
    for (const mark of Object.values(player.cardMarks)) {
      if (mark.desireReuseAt && mark.desireReuseAt < room.globalTurnIndex) delete mark.desireReuseAt;
      if (mark.greedyTicketReuseAt && mark.greedyTicketReuseAt < room.globalTurnIndex) delete mark.greedyTicketReuseAt;
    }
    player.turnStartDeadState = Boolean(player.isDeadState);
  }
}
function prepareStationStart(room) {
  if (currentStation(room)?.id === 'infinite') chooseInfiniteEffects(room);
  else room.activeStationEffectIds = [];
  for (const player of room.players) {
    player.ongoingEffects = player.ongoingEffects.filter(effect => effect.stationIndex >= room.stationIndex);
    const startEffects = player.ongoingEffects.filter(effect => effect.stationIndex === room.stationIndex && effect.startOfStationDamage);
    for (const effect of startEffects) {
      const before = player.hp;
      player.hp = Math.max(0, player.hp - effect.startOfStationDamage);
      engineMarkZero(room, player, before);
      event(room, 'CARRY_START_DAMAGE', { participantId: player.participantId, stackKey: effect.stackKey, amount: before - player.hp });
    }
    player.ongoingEffects = player.ongoingEffects.filter(effect => !(effect.stationIndex === room.stationIndex && effect.startOfStationDamage));
    player.isDeadState = player.hp === 0;
    player.hungerReuseUsed = false;
  }
}

function startFirstStation(room) {
  if (room.phase !== PHASE.PACK_SELECTION) throw new Error('パック選択フェーズではありません');
  if (room.players.some(p => !p.confirmed || !p.packId)) throw new Error('全PLのパック確定が必要です');
  if (new Set(room.players.map(p => p.packId)).size !== 7) throw new Error('七獄パックは重複できません');
  room.stationIndex = 0; room.stationTurn = 1; room.globalTurnIndex = 1; room.phase = PHASE.TURN_SELECTION;
  room.timer = { startedAt: Date.now(), endsAt: Date.now() + STATIONS[0].turnSeconds * 1000 };
  room.activeStationEffectIds = [];
  for (const p of room.players) { p.confirmed = false; p.selection = null; p.stationStats = freshStats(); p.isDeadState = false; p.turnStartDeadState = false; }
  prepareTurnSnapshot(room);
  event(room, 'PACKS_CONFIRMED', { packs: room.players.map(p => ({ playerNumber: p.playerNumber, packId: p.packId })) });
  event(room, 'TURN_STARTED', { stationId: STATIONS[0].id, stationTurn: 1, globalTurnIndex: 1 });
}

function currentStation(room) { return STATIONS[room.stationIndex]; }
function activeStationEffectIds(room) {
  const station = currentStation(room);
  if (!station) return [];
  return station.id === 'infinite' ? room.activeStationEffectIds : [station.effectId];
}
function stationModifiers(room) {
  const effects = activeStationEffectIds(room).map(effectId => STATION_EFFECTS[effectId]).filter(Boolean);
  return {
    effectIds: effects.map(effect => effect.id),
    attackBonus: Math.max(0, ...effects.map(effect => effect.attackBonus || 0)),
    defenseBonus: Math.max(0, ...effects.map(effect => effect.defenseBonus || 0)),
    directDamagePenalty: Math.max(0, ...effects.map(effect => effect.directDamagePenalty || 0)),
    healBonus: Math.max(0, ...effects.map(effect => effect.healBonus || 0)),
    absorbBonus: Math.max(0, ...effects.map(effect => effect.absorbBonus || 0)),
    reactionBonus: Math.max(0, ...effects.map(effect => effect.reactionBonus || 0)),
    concentrationDamage: Math.max(0, ...effects.map(effect => effect.concentrationDamage || 0)),
    scorchCostAt: Math.max(0, ...effects.map(effect => effect.scorchCostAt || 0)),
    normalCooldownReuse: effects.some(effect => effect.normalCooldownReuse)
  };
}
function playerById(room, participantId) { return room.players.find(player => player.participantId === participantId); }
function supportOrder(room) {
  const start = (Math.max(1, room.globalTurnIndex) - 1) % room.players.length;
  return [...room.players.slice(start), ...room.players.slice(0, start)].map(player => player.participantId);
}
function supportOrderIndex(room, participantId) {
  const position = supportOrder(room).indexOf(participantId);
  return position < 0 ? Number.MAX_SAFE_INTEGER : position;
}
function lastUsage(player, cardId) { return [...player.cardUsage].reverse().find(use => use.cardId === cardId); }
function cooldownStatus(room, player, cardId) {
  const mark = player.cardMarks[cardId] || {};
  if (mark.cooldownExtensionUntil >= room.globalTurnIndex) return { code: 'EXTENSION', reason: `強奪によりあと${mark.cooldownExtensionUntil - room.globalTurnIndex + 1}ターン使用不能` };
  const last = lastUsage(player, cardId);
  if (last && last.globalTurnIndex + 1 === room.globalTurnIndex) return { code: 'NORMAL', reason: '前ターンに使用したため通常CT中' };
  return { code: null, reason: null };
}
function cooldownReason(player, cardId, globalTurnIndex) {
  const mark = player.cardMarks[cardId] || {};
  if (mark.cooldownExtensionUntil >= globalTurnIndex) return `強奪によりあと${mark.cooldownExtensionUntil - globalTurnIndex + 1}ターン使用不能`;
  const last = lastUsage(player, cardId);
  return last && last.globalTurnIndex + 1 === globalTurnIndex ? '前ターンに使用したため通常CT中' : null;
}

function selectCard(room, actor, action) {
  if (room.phase !== PHASE.TURN_SELECTION || actor.confirmed) throw new Error('現在は選択を変更できません');
  const card = CARD_BY_ID[action.cardId];
  if (!card || card.packId !== actor.packId) throw new Error('自分のパックのカードではありません');
  if (card.id === 'encore' && !hasEncoreCandidate(room, actor)) throw new Error('再演できる3駅以上前の基本数値効果がありません');
  const status = cooldownStatus(room, actor, card.id);
  let ctBypass = null;
  if (status.code === 'EXTENSION') throw new Error(status.reason);
  if (status.code === 'NORMAL') {
    const mark = actor.cardMarks[card.id] || {};
    if (action.ctBypass === 'DESIRE' && mark.desireReuseAt === room.globalTurnIndex) ctBypass = 'DESIRE';
    else if (action.ctBypass === 'GREEDY_TICKET' && mark.greedyTicketReuseAt === room.globalTurnIndex) ctBypass = 'GREEDY_TICKET';
    else if (action.ctBypass === 'HUNGER' && stationModifiers(room).normalCooldownReuse && !actor.hungerReuseUsed) ctBypass = 'HUNGER';
    else throw new Error(status.reason);
  }
  const selection = { cardId: card.id, targetId: action.targetId || null, cardTargetId: action.cardTargetId || null, stateKey: action.stateKey || null, copyUsageId: action.copyUsageId || null, copyKind: action.copyKind || null, ctBypass };
  validateSelection(room, actor, selection);
  actor.selection = selection;
}

function validateSelection(room, actor, selection) {
  const card = CARD_BY_ID[selection.cardId];
  if (card.targetType === 'player') {
    const target = room.players.find(p => p.participantId === selection.targetId);
    if (!target || target.participantId === actor.participantId) throw new Error('自分以外の有効な対象を選択してください');
  }
  if (card.targetType === 'ownAttackCard' || card.targetType === 'ownNonAttackCard') {
    const targetCard = CARD_BY_ID[selection.cardTargetId];
    if (!targetCard || targetCard.packId !== actor.packId) throw new Error('自分のカードを指定してください');
    const mark = actor.cardMarks[targetCard.id] || {};
    if (card.targetType === 'ownAttackCard' && targetCard.category !== 'attack') throw new Error('攻撃カードを指定してください');
    if (card.targetType === 'ownAttackCard' && mark.embers) throw new Error('そのカードにはすでに残火が付いています');
    if (card.targetType === 'ownNonAttackCard' && (targetCard.category === 'attack' || targetCard.id === card.id)) throw new Error('強欲自身を除く攻撃以外のカードを指定してください');
    if (card.id === 'greed' && (mark.desire || mark.greedyTicketPending || mark.desireReuseAt || mark.greedyTicketReuseAt || mark.cooldownExtensionUntil >= room.globalTurnIndex)) throw new Error('そのカードには欲印を付与できません');
  }
  if (card.id === 'encore' && selection.copyUsageId) {
    const source = actor.cardUsage.find(use => use.id === selection.copyUsageId);
    const sourceCard = source && CARD_BY_ID[source.cardId];
    if (!source || source.stationIndex > room.stationIndex - 3 || !sourceCard?.effect || !['attack', 'defense', 'heal'].includes(sourceCard.effect.kind)) throw new Error('再演元の選択が不正です');
  }
  if (['thaw', 'regression'].includes(card.id)) {
    const removable = playerById(room, selection.targetId).ongoingEffects.filter(effect => effect.removable !== false);
    if (removable.length && !removable.some(effect => effect.stackKey === selection.stateKey)) throw new Error('解除する持越状態を選択してください');
  }
}

function hasEncoreCandidate(room, player) {
  return player.cardUsage.some(use => use.stationIndex <= room.stationIndex - 3 && ['attack', 'defense', 'heal'].includes(CARD_BY_ID[use.cardId]?.effect?.kind));
}
function validateStoredCooldown(room, player, selection) {
  const status = cooldownStatus(room, player, selection.cardId);
  if (status.code === 'EXTENSION') throw new Error(status.reason);
  if (status.code !== 'NORMAL') return;
  const mark = player.cardMarks[selection.cardId] || {};
  if (selection.ctBypass === 'DESIRE' && mark.desireReuseAt === room.globalTurnIndex) return;
  if (selection.ctBypass === 'GREEDY_TICKET' && mark.greedyTicketReuseAt === room.globalTurnIndex) return;
  if (selection.ctBypass === 'HUNGER' && stationModifiers(room).normalCooldownReuse && !player.hungerReuseUsed) return;
  throw new Error(status.reason);
}

function resolveTurnLegacy(room) {
  const snapshot = Object.fromEntries(room.players.map(p => [p.participantId, p.hp]));
  const usages = room.players.map(p => ({ player: p, card: CARD_BY_ID[p.selection.cardId], ...p.selection, invalidated: false }));
  event(room, 'CARDS_REVEALED', { usages: usages.map(publicUsage) });

  for (const use of usages.filter(u => u.card.id === 'nullify')) {
    const targetUse = usages.find(u => u.player.participantId === use.targetId);
    if (targetUse && ['attack', 'interference'].includes(targetUse.card.category)) targetUse.invalidated = true;
  }

  const reductions = new Map();
  for (const use of usages.filter(u => u.card.category === 'defense' && !u.invalidated)) {
    const value = ['needle-guard'].includes(use.card.id) ? 1 : 2;
    reductions.set(use.targetId, (reductions.get(use.targetId) || 0) + value);
  }

  const fireSeeds = usages.filter(u => u.card.id === 'fire-seed' && !u.invalidated);
  const attacks = usages.filter(u => (u.card.category === 'attack' || u.card.damage > 0) && !u.invalidated)
    .map(use => {
      let value = use.card.damage;
      if (use.card.id === 'flame-strike' && snapshot[use.player.participantId] <= 7) value = 3;
      if (use.card.id === 'immolation' && snapshot[use.player.participantId] < snapshot[use.targetId]) value = 4;
      if (use.card.id === 'heavy-slash' && !(reductions.get(use.targetId) > 0)) value = 3;
      if (use.card.category === 'attack') value += 1;
      if (use.player.isDeadState) value -= 1;
      const seed = fireSeeds.find(seedUse => seedUse.targetId === use.player.participantId);
      if (seed) value += 1;
      return { ...use, value: Math.max(0, Math.min(4, value)), seed };
    }).sort((a, b) => b.value - a.value || a.player.playerNumber - b.player.playerNumber);

  for (const attack of attacks) {
    const target = room.players.find(p => p.participantId === attack.targetId);
    const ignored = attack.card.id === 'severance';
    const available = ignored ? 0 : reductions.get(target.participantId) || 0;
    const prevented = Math.min(available, attack.value);
    if (!ignored) reductions.set(target.participantId, available - prevented);
    const before = target.hp;
    target.hp = Math.max(0, target.hp - Math.max(0, attack.value - prevented));
    const actual = before - target.hp;
    recordDamage(attack.player, target, actual);
    if (actual > 0) event(room, 'DAMAGE', { sourceId: attack.player.participantId, targetId: target.participantId, cardId: attack.card.id, amount: actual });
    if (prevented > 0) event(room, 'DEFENSE', { targetId: target.participantId, amount: prevented });
    if (target.hp === 0 && before > 0) { target.stationStats.reachedZero = true; event(room, 'HP_ZERO_REACHED', { participantId: target.participantId }); }
    attack.actual = actual;
  }

  applyStationDamage(room, attacks);

  for (const use of usages.filter(u => !u.invalidated)) {
    let heal = use.card.id === 'healing-blood' || use.card.id === 'regression' ? 2 : use.card.id === 'transfusion' ? 3 : use.card.id === 'alms' ? (snapshot[use.targetId] === 0 ? 3 : 2) : 0;
    if (heal) applyHeal(room, use.player, use.targetId, heal, use.card.id);
    const matchingAttack = attacks.find(a => a.player === use.player);
    if (['vampire', 'gluttony'].includes(use.card.id) && matchingAttack?.actual > 0 && (use.card.id !== 'gluttony' || snapshot[use.targetId] > snapshot[use.player.participantId])) applyHeal(room, use.player, use.player.participantId, 1, use.card.id, false);
    if (use.card.id === 'embers') use.player.cardMarks[use.cardTargetId] = { ...(use.player.cardMarks[use.cardTargetId] || {}), embers: true };
    if (use.card.id === 'greed') use.player.cardMarks[use.cardTargetId] = { ...(use.player.cardMarks[use.cardTargetId] || {}), desire: true };
  }

  for (const use of usages) {
    if (['immolation', 'desperation', 'transfusion'].includes(use.card.id) || (use.card.id === 'fire-seed' && !use.invalidated && fireSeeds.includes(use))) damageSelf(room, use.player, 1, use.card.id);
    use.player.isDeadState ||= use.player.stationStats.reachedZero;
    use.player.confirmed = false;
    use.player.cardUsage.push({ cardId: use.card.id, stationId: STATIONS[room.stationIndex].id, stationTurn: room.stationTurn, globalTurnIndex: room.globalTurnIndex, result: use.invalidated ? 'NULLIFIED' : 'RESOLVED', finalTarget: use.targetId, normalCooldownStartsAt: room.globalTurnIndex + 1 });
    event(room, 'COOLDOWN_STARTED', { participantId: use.player.participantId, cardId: use.card.id, unavailableTurn: room.globalTurnIndex + 1 }, `private:${use.player.participantId}`);
  }
  room.revealedUsages = usages.map(use => ({ ...publicUsage(use), invalidated: use.invalidated }));
  room.phase = PHASE.TURN_RESULT;
  event(room, 'TURN_RESOLVED', { stationTurn: room.stationTurn, globalTurnIndex: room.globalTurnIndex });
}

function publicUsage(use) { return { participantId: use.player.participantId, playerNumber: use.player.playerNumber, cardId: use.card.id, targetId: use.targetId }; }
function recordDamage(source, target, amount) { source.stationStats.damageDealt += amount; source.totalStats.damageDealt += amount; source.stationStats.stationScore += amount; target.stationStats.damageTaken += amount; target.totalStats.damageTaken += amount; }
function applyStationDamage(room, attacks) {
  if (STATIONS[room.stationIndex]?.id !== 'needle') return;
  const focusCounts = new Map();
  for (const attack of attacks) {
    if (attack.card.category !== 'attack') continue;
    focusCounts.set(attack.targetId, (focusCounts.get(attack.targetId) || 0) + 1);
  }
  for (const [targetId, count] of focusCounts) {
    if (count < 2) continue;
    const target = room.players.find(player => player.participantId === targetId);
    const before = target.hp;
    target.hp = Math.max(0, target.hp - 1);
    const actual = before - target.hp;
    if (before > 0 && target.hp === 0) target.stationStats.reachedZero = true;
    event(room, 'STATION_DAMAGE', { stationId: 'needle', targetId, amount: actual, reason: 'NEEDLE_CONCENTRATION' });
  }
}
function damageSelf(room, player, amount, cardId) { const before = player.hp; player.hp = Math.max(0, player.hp - amount); if (before > 0 && player.hp === 0) player.stationStats.reachedZero = true; event(room, 'SELF_DAMAGE', { participantId: player.participantId, cardId, amount: before - player.hp }); }
function applyHeal(room, source, targetId, amount, cardId, support = true) { const target = room.players.find(p => p.participantId === targetId); const bloodTideBonus = STATIONS[room.stationIndex]?.id === 'blood' ? 1 : 0; const before = target.hp; target.hp = Math.min(15, target.hp + amount + bloodTideBonus); const actual = target.hp - before; if (support && source !== target) { source.stationStats.support += actual; source.totalStats.support += actual; } event(room, 'HEAL', { sourceId: source.participantId, targetId, cardId, amount: actual }); }

// 26段階のカードエンジン。各イベントに効果発生源を残すため、数値は合算せず
// 基本成分と補助成分を保持したまま、上限・軽減・HP反映へ進める。
function engineUseHasAttack(use) { return use.copied?.kind === 'attack' || use.effect.kind === 'attack'; }
function enginePrimaryAttack(use) { return use.card.category === 'attack' && engineUseHasAttack(use) && !use.attackInvalidated; }
function engineModifiers(room) { return stationModifiers(room); }
function engineMarkZero(room, player, before) {
  if (before > 0 && player.hp === 0) {
    player.stationStats.reachedZero = true;
    event(room, 'HP_ZERO_REACHED', { participantId: player.participantId });
  }
}
function engineSupport(room, player, amount, payload = {}) {
  if (!amount) return;
  player.stationStats.support += amount;
  player.totalStats.support += amount;
  event(room, 'SUPPORT_RECORDED', { sourceId: player.participantId, amount, ...payload });
}
function engineSelfDamage(room, player, amount, cardId, reason) {
  const before = player.hp;
  player.hp = Math.max(0, player.hp - amount);
  engineMarkZero(room, player, before);
  event(room, 'SELF_DAMAGE', { participantId: player.participantId, cardId, reason, amount: before - player.hp });
}
function engineAddCarry(room, target, state, source, cardId) {
  const stationIndex = room.stationIndex + 1;
  const existing = target.ongoingEffects.find(effect => effect.stackKey === state.stackKey && effect.stationIndex === stationIndex);
  if (existing) {
    existing.value = Math.max(existing.value, state.value);
    existing.startOfStationDamage = Math.max(existing.startOfStationDamage || 0, state.startOfStationDamage || 0);
  } else {
    target.ongoingEffects.push({ id: id(), stackKey: state.stackKey, value: state.value, stationIndex, sourceId: source.participantId, cardId, startOfStationDamage: state.startOfStationDamage || 0, removable: true });
  }
  event(room, 'CARRY_STATE_ADDED', { sourceId: source.participantId, targetId: target.participantId, stackKey: state.stackKey, value: state.value, stationIndex, cardId });
}
function engineRemoveCarry(room, use) {
  if (!use.stateKey) return false;
  const target = playerById(room, use.targetId);
  const index = target.ongoingEffects.findIndex(effect => effect.stackKey === use.stateKey && effect.removable !== false);
  if (index < 0) return false;
  const [removed] = target.ongoingEffects.splice(index, 1);
  event(room, 'CARRY_STATE_REMOVED', { sourceId: use.player.participantId, targetId: target.participantId, cardId: use.card.id, stackKey: removed.stackKey });
  return true;
}
function engineAttackDown(room, player) {
  return Math.max(0, ...player.ongoingEffects.filter(effect => effect.stackKey === 'ATTACK_DAMAGE_DOWN' && effect.stationIndex === room.stationIndex).map(effect => effect.value || 0));
}
function engineSupportOrder(room, participantId) { return supportOrderIndex(room, participantId); }
function engineCap(room, attack) {
  const base = attack.components[0];
  base.amount = Math.max(0, Math.min(4, base.amount));
  let remaining = 4 - base.amount;
  const supports = attack.components.slice(1).sort((a, b) => engineSupportOrder(room, a.source.participantId) - engineSupportOrder(room, b.source.participantId));
  attack.components = [base];
  for (const component of supports) {
    const accepted = Math.max(0, Math.min(component.amount, remaining));
    if (accepted) attack.components.push({ ...component, amount: accepted });
    remaining -= accepted;
  }
  attack.beforeDefense = attack.components.reduce((sum, component) => sum + component.amount, 0);
}
function engineAddDefense(defenses, targetId, defense) {
  const list = defenses.get(targetId) || [];
  list.push(defense);
  defenses.set(targetId, list);
}
function engineFocusCounts(usages) {
  const counts = new Map();
  for (const use of usages.filter(enginePrimaryAttack)) counts.set(use.targetId, (counts.get(use.targetId) || 0) + 1);
  return counts;
}
function engineExpandEncore(room, usages) {
  for (const use of usages.filter(item => item.card.id === 'encore')) {
    const candidates = use.player.cardUsage.filter(history => history.stationIndex <= room.stationIndex - 3 && ['attack', 'defense', 'heal'].includes(CARD_BY_ID[history.cardId]?.effect?.kind));
    const source = candidates.find(history => history.id === use.copyUsageId) || candidates.at(-1);
    if (!source) { use.outcome = 'FIZZLED'; continue; }
    const effect = CARD_BY_ID[source.cardId].effect;
    const kind = ['attack', 'defense', 'heal'].includes(use.copyKind) && use.copyKind === effect.kind ? use.copyKind : effect.kind;
    const value = Math.min(2, kind === 'attack' ? effect.baseDamage : kind === 'heal' ? effect.amount : effect.reduction);
    use.copied = { kind, value, sourceCardId: source.cardId, sourceUsageId: source.id };
    event(room, 'ENCORE_EXPANDED', { participantId: use.player.participantId, sourceCardId: source.cardId, kind, value });
  }
}
function engineTargetChanges(room, usages) {
  for (const use of usages.filter(item => item.effect.kind === 'targetChange')) {
    const targetUse = usages.find(item => item.player.participantId === use.targetId);
    if (!targetUse || !targetUse.targetId || targetUse.card.targetType !== 'player') { use.outcome = 'FIZZLED'; continue; }
    const candidates = room.players.filter(player => player.participantId !== targetUse.player.participantId && player.participantId !== targetUse.targetId);
    if (!candidates.length) { use.outcome = 'FIZZLED'; event(room, 'TARGET_CHANGE_FIZZLED', { sourceId: use.player.participantId, targetId: targetUse.player.participantId }); continue; }
    const fromTargetId = targetUse.targetId;
    const target = candidates[crypto.randomInt(candidates.length)];
    targetUse.targetId = target.participantId;
    event(room, 'TARGET_CHANGED_RANDOM', { sourceId: use.player.participantId, targetCardOwnerId: targetUse.player.participantId, fromTargetId, toTargetId: target.participantId, candidates: candidates.map(player => player.participantId) });
  }
}
function engineNullify(room, usages) {
  for (const use of usages.filter(item => item.effect.kind === 'nullify')) {
    const targetUse = usages.find(item => item.player.participantId === use.targetId);
    if (!targetUse) { use.outcome = 'FIZZLED'; continue; }
    if (engineUseHasAttack(targetUse)) {
      targetUse.attackInvalidated = true;
      targetUse.invalidated = true;
      targetUse.outcome = 'NULLIFIED';
      event(room, 'ATTACK_COMPONENT_NULLIFIED', { sourceId: use.player.participantId, targetPlayerId: targetUse.player.participantId, cardId: targetUse.card.id });
    } else if (targetUse.effect.kind === 'carryState') {
      targetUse.carryInvalidated = true;
      event(room, 'CARRY_COMPONENT_NULLIFIED', { sourceId: use.player.participantId, targetPlayerId: targetUse.player.participantId, cardId: targetUse.card.id });
    } else use.outcome = 'FIZZLED';
  }
}
function engineCardBoosts(room, usages) {
  const boosts = new Map();
  const add = (targetUse, source, amount, reason) => {
    if (!targetUse || targetUse.attackInvalidated) return false;
    const list = boosts.get(targetUse) || [];
    list.push({ source, amount, reason });
    boosts.set(targetUse, list);
    return true;
  };
  for (const use of usages.filter(item => item.effect.kind === 'cardAttackBoost')) {
    const targetUse = usages.find(item => item.player.participantId === use.targetId);
    use.fireSeedValid = Boolean(targetUse && targetUse.card.category === 'attack' && !targetUse.attackInvalidated && add(targetUse, use.player, use.effect.amount, 'FIRE_SEED'));
    if (!use.fireSeedValid) use.outcome = 'FIZZLED';
  }
  for (const use of usages.filter(item => item.effect.kind === 'focusAttackBoost')) {
    const specified = usages.find(item => item.player.participantId === use.targetId);
    if (!specified || specified.card.category !== 'attack' || specified.attackInvalidated || !specified.targetId) { use.outcome = 'FIZZLED'; continue; }
    const targets = usages.filter(item => item.card.category === 'attack' && !item.attackInvalidated && item.targetId === specified.targetId).sort((a, b) => a.player.playerNumber - b.player.playerNumber).slice(0, use.effect.maxTargets);
    if (!targets.length) use.outcome = 'FIZZLED';
    targets.forEach(targetUse => add(targetUse, use.player, use.effect.amount, 'TARGET_STITCH'));
  }
  for (const use of usages.filter(item => item.effect.kind === 'cardNumericBoost')) {
    const targetUse = usages.find(item => item.player.participantId === use.targetId);
    if (!targetUse || targetUse.attackInvalidated) { use.outcome = 'FIZZLED'; continue; }
    if (targetUse.card.category === 'attack' && engineUseHasAttack(targetUse)) add(targetUse, use.player, use.effect.amount, 'MORALE');
    else if (['defense', 'needleDefense', 'bloodShield', 'defenseAndRemoveState'].includes(targetUse.effect.kind)) targetUse.moraleDefense = { source: use.player, amount: use.effect.amount };
    else use.outcome = 'FIZZLED';
  }
  return boosts;
}
function engineReserveDefenses(room, usages, modifiers, focusCounts) {
  const defenses = new Map();
  for (const use of usages) {
    if (use.invalidated) continue;
    const kind = use.copied?.kind || use.effect.kind;
    let reduction = use.copied?.kind === 'defense' ? use.copied.value : use.effect.reduction || 0;
    if (kind === 'needleDefense') reduction = (focusCounts.get(use.targetId) || 0) >= 2 ? use.effect.concentrationReduction : use.effect.reduction;
    if (['defense', 'needleDefense', 'bloodShield', 'defenseAndRemoveState'].includes(kind)) {
      if (use.card.category === 'defense') reduction += modifiers.defenseBonus;
      const contributions = [{ source: use.player, amount: reduction }];
      if (use.moraleDefense) contributions.push({ source: use.moraleDefense.source, amount: use.moraleDefense.amount, reason: 'MORALE' });
      engineAddDefense(defenses, use.targetId, { use, kind: 'numeric', remaining: contributions.reduce((sum, item) => sum + item.amount, 0), contributions });
    }
    if (kind === 'reversal') engineAddDefense(defenses, use.targetId, { use, kind: 'reversal', remaining: 1, contributions: [] });
  }
  for (const entries of defenses.values()) entries.sort((a, b) => a.use.player.playerNumber - b.use.player.playerNumber);
  return defenses;
}
function engineReserveState(room, usages) {
  const healReduction = new Map();
  for (const use of usages.filter(item => !item.invalidated)) {
    if (use.effect.kind === 'carryState' && !use.carryInvalidated) engineAddCarry(room, playerById(room, use.targetId), use.effect.state, use.player, use.card.id);
    if (use.effect.kind === 'cooldownExtension') {
      const targetUse = usages.find(item => item.player.participantId === use.targetId);
      if (!targetUse) { use.outcome = 'FIZZLED'; continue; }
      const mark = targetUse.player.cardMarks[targetUse.card.id] || {};
      const until = room.globalTurnIndex + use.effect.turns;
      targetUse.player.cardMarks[targetUse.card.id] = { ...mark, cooldownExtensionUntil: Math.max(mark.cooldownExtensionUntil || 0, until) };
      event(room, 'COOLDOWN_EXTENSION_APPLIED', { sourceId: use.player.participantId, targetId: targetUse.player.participantId, cardId: targetUse.card.id, until });
    }
    if (use.effect.kind === 'healReduction') healReduction.set(use.targetId, (healReduction.get(use.targetId) || 0) + use.effect.reduction);
    if (['defenseAndRemoveState', 'healAndRemoveState'].includes(use.effect.kind)) engineRemoveCarry(room, use);
  }
  return healReduction;
}
function engineCondition(room, use, snapshot, defenses) {
  const condition = use.effect.condition;
  if (!condition) return false;
  if (condition === 'ownerHpAtMost7') return snapshot[use.player.participantId] <= 7;
  if (condition === 'ownerHpLessThanTarget') return snapshot[use.player.participantId] < snapshot[use.targetId];
  if (condition === 'targetHpGreaterThanOwner') return snapshot[use.targetId] > snapshot[use.player.participantId];
  if (condition === 'targetHpZero') return snapshot[use.targetId] === 0;
  if (condition === 'samePreviousStationTarget') return [...use.player.cardUsage].reverse().find(history => history.stationIndex === room.stationIndex - 1 && ['attack', 'interference'].includes(CARD_BY_ID[history.cardId]?.category) && history.finalTarget)?.finalTarget === use.targetId;
  if (condition === 'targetHasNoDefense') return !(defenses.get(use.targetId) || []).some(defense => defense.kind === 'numeric' || defense.kind === 'reversal');
  return false;
}
function engineBasicAttacks(room, usages, snapshot, modifiers, defenses, boosts) {
  const attacks = [];
  for (const use of usages.filter(use => engineUseHasAttack(use) && !use.attackInvalidated)) {
    const copied = use.copied?.kind === 'attack';
    let base = copied ? use.copied.value : use.effect.baseDamage || 0;
    if (engineCondition(room, use, snapshot, defenses)) base += use.effect.conditionDamage || 0;
    if (!copied && use.card.category === 'attack') base += modifiers.attackBonus;
    if (!copied && use.card.category === 'attack') base = Math.max(0, base - engineAttackDown(room, use.player));
    base = Math.max(0, base - modifiers.directDamagePenalty);
    if (use.player.turnStartDeadState) base = Math.max(0, base - 1);
    const components = [{ source: use.player, amount: base, type: 'BASE' }];
    const mark = use.player.cardMarks[use.card.id];
    if (mark?.embers) {
      components.push({ source: playerById(room, mark.embers.sourceId) || use.player, amount: 1, type: 'EMBERS' });
      delete use.player.cardMarks[use.card.id].embers;
      event(room, 'EMBER_CONSUMED', { participantId: use.player.participantId, cardId: use.card.id });
    }
    for (const boost of boosts.get(use) || []) components.push({ source: boost.source, amount: boost.amount, type: boost.reason });
    const attack = { use, player: use.player, targetId: use.targetId, phase: 'basic', ignoresDefense: Boolean(use.effect.ignoresDefense), components, actual: 0, prevented: 0 };
    engineCap(room, attack);
    if (modifiers.scorchCostAt && use.card.category === 'attack' && attack.beforeDefense >= modifiers.scorchCostAt) use.scorchCost = 1;
    attacks.push(attack);
  }
  return attacks;
}
function engineAssignCompleteDefenses(room, defenses, attacks, phase) {
  for (const [targetId, entries] of defenses) {
    const candidates = attacks.filter(attack => attack.targetId === targetId && attack.phase === phase && !attack.ignoresDefense && attack.beforeDefense > 0).sort((a, b) => b.beforeDefense - a.beforeDefense || a.player.playerNumber - b.player.playerNumber);
    for (const defense of entries.filter(item => item.kind === 'reversal' && item.remaining)) {
      const attack = candidates.find(item => !item.completeDefense);
      if (!attack) continue;
      attack.completeDefense = defense;
      attack.reversalValue = Math.min(2, Math.floor(attack.beforeDefense / 2));
      defense.remaining = 0;
      event(room, 'REVERSAL_ASSIGNED', { defenderId: defense.use.player.participantId, targetId, attackCardId: attack.use.card.id, reflection: attack.reversalValue, phase });
    }
  }
}
function engineSpendDefense(room, defense, amount, target, attack) {
  let remaining = amount;
  for (const contribution of defense.contributions) {
    const applied = Math.min(remaining, contribution.amount);
    if (!applied) continue;
    contribution.amount -= applied;
    remaining -= applied;
    attack.defenseSources ||= [];
    attack.defenseSources.push({ source: contribution.source, amount: applied, cardId: defense.use.card.id, reason: contribution.reason || 'DEFENSE' });
    event(room, 'DEFENSE_ALLOCATED', { sourceId: contribution.source.participantId, targetId: target.participantId, cardId: defense.use.card.id, amount: applied, reason: contribution.reason || 'DEFENSE' });
    if (!remaining) break;
  }
  defense.remaining -= amount;
}
function engineAllocateReduction(room, defenses, attacks, phase) {
  for (const [targetId, entries] of defenses) {
    const target = playerById(room, targetId);
    const candidates = attacks.filter(attack => attack.targetId === targetId && attack.phase === phase && !attack.ignoresDefense && !attack.completeDefense).sort((a, b) => b.beforeDefense - a.beforeDefense || a.player.playerNumber - b.player.playerNumber);
    for (const attack of candidates) {
      for (const component of attack.components) {
        let rest = component.amount;
        for (const defense of entries.filter(item => item.kind === 'numeric' && item.remaining > 0)) {
          const prevented = Math.min(rest, defense.remaining);
          if (!prevented) continue;
          engineSpendDefense(room, defense, prevented, target, attack);
          component.amount -= prevented;
          attack.prevented += prevented;
          rest -= prevented;
          if (!rest) break;
        }
      }
    }
  }
}
function engineResolveAttackEvents(room, attacks) {
  for (const attack of [...attacks].sort((a, b) => a.player.playerNumber - b.player.playerNumber)) {
    const target = playerById(room, attack.targetId);
    if (attack.completeDefense) {
      event(room, 'COMPLETE_DEFENSE', { defenderId: attack.completeDefense.use.player.participantId, targetId: target.participantId, cardId: attack.use.card.id, phase: attack.phase });
      continue;
    }
    const hpBefore = target.hp;
    for (const component of attack.components) {
      const before = target.hp;
      const actual = Math.min(before, component.amount);
      target.hp = Math.max(0, target.hp - component.amount);
      component.actual = actual;
      attack.actual += actual;
      recordDamage(component.source, target, actual);
      engineMarkZero(room, target, before);
      event(room, 'DIRECT_DAMAGE', { sourceId: component.source.participantId, attackOwnerId: attack.player.participantId, targetId: target.participantId, cardId: attack.use.card.id, phase: attack.phase, component: component.type, amount: actual, overkill: component.amount - actual });
    }
    let actualPrevention = Math.max(0, Math.min(hpBefore, attack.beforeDefense) - attack.actual);
    for (const defenseSource of attack.defenseSources || []) {
      const credited = Math.min(actualPrevention, defenseSource.amount);
      actualPrevention -= credited;
      if (credited && defenseSource.source !== target) engineSupport(room, defenseSource.source, credited, { targetId: target.participantId, cardId: defenseSource.cardId, reason: defenseSource.reason });
      if (credited) event(room, 'DEFENSE_APPLIED', { sourceId: defenseSource.source.participantId, targetId: target.participantId, cardId: defenseSource.cardId, amount: credited, reason: defenseSource.reason });
    }
    attack.use.basicActual = (attack.use.basicActual || 0) + attack.actual;
  }
}
function engineAdditionalAttacks(room, basicAttacks, modifiers, focusCounts) {
  const output = [];
  for (const basic of basicAttacks) {
    const use = basic.use;
    if (use.attackInvalidated) continue;
    let amount = 0;
    if (use.effect.condition === 'ownerDamagedByOtherBasicAttack' && basicAttacks.some(attack => attack.player !== use.player && attack.targetId === use.player.participantId && attack.actual > 0)) amount = use.effect.conditionExtraDamage;
    if (use.effect.condition === 'needleConcentration' && (focusCounts.get(use.targetId) || 0) >= 2) amount = use.effect.conditionExtraDamage;
    if (!amount) continue;
    if (use.card.category === 'attack') amount = Math.max(0, amount - engineAttackDown(room, use.player));
    amount = Math.max(0, amount - modifiers.directDamagePenalty);
    if (use.player.turnStartDeadState) amount = Math.max(0, amount - 1);
    amount = Math.min(amount, Math.max(0, 4 - basic.beforeDefense));
    if (amount) output.push({ use, player: use.player, targetId: use.targetId, phase: 'additional', ignoresDefense: false, components: [{ source: use.player, amount, type: 'ADDITIONAL' }], beforeDefense: amount, actual: 0, prevented: 0 });
  }
  return output;
}
function engineStationDamage(room, focusCounts, modifiers) {
  if (!modifiers.concentrationDamage) return;
  for (const [targetId, count] of focusCounts) {
    if (count < 2) continue;
    const target = playerById(room, targetId);
    const before = target.hp;
    target.hp = Math.max(0, target.hp - modifiers.concentrationDamage);
    engineMarkZero(room, target, before);
    event(room, 'STATION_DAMAGE', { stationId: currentStation(room).id, targetId, reason: 'NEEDLE_CONCENTRATION', amount: before - target.hp });
  }
}
function engineApplyOnHitStates(room, attacks) {
  const processed = new Set();
  for (const attack of attacks) {
    const use = attack.use;
    if (!use.effect.onHitState || !attack.actual || processed.has(use)) continue;
    processed.add(use);
    engineAddCarry(room, playerById(room, use.targetId), use.effect.onHitState, use.player, use.card.id);
  }
}
function engineReaction(room, source, target, amount, cardId, kind, modifiers) {
  const before = target.hp;
  target.hp = Math.max(0, target.hp - Math.max(0, amount + modifiers.reactionBonus));
  const actual = before - target.hp;
  recordDamage(source, target, actual);
  engineMarkZero(room, target, before);
  event(room, 'REACTION_DAMAGE', { sourceId: source.participantId, targetId: target.participantId, cardId, kind, amount: actual });
}
function engineReactions(room, usages, attacks, modifiers) {
  for (const attack of attacks.filter(item => item.completeDefense?.kind === 'reversal' && item.reversalValue > 0)) engineReaction(room, attack.completeDefense.use.player, attack.player, attack.reversalValue, 'reversal', 'REVERSAL', modifiers);
  for (const use of usages.filter(item => item.effect.kind === 'bloodShield' && !item.invalidated)) {
    const hits = attacks.filter(attack => attack.targetId === use.targetId && attack.actual > 0);
    if (!hits.length) continue;
    const attacker = [...hits].sort((a, b) => b.actual - a.actual || a.player.playerNumber - b.player.playerNumber)[0].player;
    engineReaction(room, use.player, attacker, use.effect.reflection, use.card.id, 'BLOOD_SHIELD', modifiers);
  }
  for (const use of usages.filter(item => item.effect.kind === 'counterStance' && !item.invalidated)) {
    if (attacks.some(attack => attack.player.participantId === use.targetId && attack.targetId === use.player.participantId && attack.actual > 0)) engineReaction(room, use.player, playerById(room, use.targetId), use.effect.damage, use.card.id, 'COUNTER_STANCE', modifiers);
  }
}
function engineHeal(room, source, targetId, amount, cardId, healReduction, modifiers, kind = 'HEAL', support = true) {
  const target = playerById(room, targetId);
  const boosted = amount + (kind === 'ABSORB' ? modifiers.absorbBonus : modifiers.healBonus);
  const reduced = Math.min(boosted, healReduction.get(targetId) || 0);
  if (reduced) healReduction.set(targetId, (healReduction.get(targetId) || 0) - reduced);
  const before = target.hp;
  target.hp = Math.min(15, target.hp + boosted - reduced);
  const actual = target.hp - before;
  if (support && source !== target) engineSupport(room, source, actual, { targetId, cardId, reason: 'HEAL' });
  event(room, 'HEAL', { sourceId: source.participantId, targetId, cardId, kind, amount: actual, reduced });
}
function engineRecovery(room, usages, attacks, snapshot, healReduction, modifiers) {
  for (const use of usages.filter(item => !item.invalidated)) {
    const kind = use.copied?.kind || use.effect.kind;
    let amount = use.copied?.kind === 'heal' ? use.copied.value : use.effect.amount || 0;
    if (use.effect.condition === 'targetHpZero' && snapshot[use.targetId] === 0) amount += use.effect.conditionHeal || 0;
    if (kind === 'heal' && amount) engineHeal(room, use.player, use.targetId, amount, use.card.id, healReduction, modifiers);
    if (use.effect.absorb) {
      const attack = attacks.find(item => item.use === use);
      const allowed = use.effect.condition !== 'targetHpGreaterThanOwner' || snapshot[use.targetId] > snapshot[use.player.participantId];
      if (attack?.actual > 0 && allowed) engineHeal(room, use.player, use.player.participantId, use.effect.absorb, use.card.id, healReduction, modifiers, 'ABSORB', false);
    }
  }
}
function engineCostsMarksAndHistory(room, usages) {
  for (const use of usages) {
    const mark = use.player.cardMarks[use.card.id] || {};
    if (mark.desire) {
      delete mark.desire;
      mark.desireReuseAt = room.globalTurnIndex + 1;
      use.player.cardMarks[use.card.id] = mark;
      event(room, 'DESIRE_REUSE_GRANTED', { participantId: use.player.participantId, cardId: use.card.id, turn: mark.desireReuseAt }, `private:${use.player.participantId}`);
    }
    if (mark.greedyTicketPending && !use.ctBypass) {
      delete mark.greedyTicketPending;
      mark.greedyTicketReuseAt = room.globalTurnIndex + 1;
      use.player.cardMarks[use.card.id] = mark;
    }
    if (use.effect.kind === 'markEmbers' && !use.invalidated) use.player.cardMarks[use.cardTargetId] = { ...(use.player.cardMarks[use.cardTargetId] || {}), embers: { sourceId: use.player.participantId } };
    if (use.effect.kind === 'markDesire' && !use.invalidated) use.player.cardMarks[use.cardTargetId] = { ...(use.player.cardMarks[use.cardTargetId] || {}), desire: true };
    const cost = Math.max(use.effect.selfCost || 0, use.scorchCost || 0);
    if (cost && !(use.card.id === 'fire-seed' && !use.fireSeedValid)) engineSelfDamage(room, use.player, cost, use.card.id, use.scorchCost ? 'SCORCH_COST' : 'CARD_COST');
    if (use.ctBypass === 'HUNGER') {
      use.player.hungerReuseUsed = true;
      engineSelfDamage(room, use.player, 1, use.card.id, 'HUNGER_REUSE_COST');
    }
    if (use.player.stationStats.reachedZero) use.player.isDeadState = true;
    use.player.turnStartDeadState = false;
    use.player.confirmed = false;
    const updatedMark = use.player.cardMarks[use.card.id] || {};
    const history = { id: id(), participantId: use.player.participantId, cardId: use.card.id, stationId: currentStation(room).id, stationIndex: room.stationIndex, stationTurn: room.stationTurn, globalTurnIndex: room.globalTurnIndex, result: use.outcome, finalTarget: use.targetId, normalCooldownStartsAt: room.globalTurnIndex + 1, cooldownExtensionUntil: updatedMark.cooldownExtensionUntil || null, ctBypass: use.ctBypass || null };
    use.player.cardUsage.push(history);
    event(room, 'CARD_USAGE_RECORDED', history, `private:${use.player.participantId}`);
    event(room, 'COOLDOWN_STARTED', { participantId: use.player.participantId, cardId: use.card.id, unavailableTurn: room.globalTurnIndex + 1 }, `private:${use.player.participantId}`);
  }
}
function resolveTurn(room) {
  const snapshot = Object.fromEntries(room.players.map(player => [player.participantId, player.hp]));
  const modifiers = engineModifiers(room);
  const usages = room.players.map(player => {
    const card = CARD_BY_ID[player.selection.cardId];
    return { player, card, effect: card.effect, ...player.selection, invalidated: false, attackInvalidated: false, outcome: 'RESOLVED', basicActual: 0 };
  });
  event(room, 'CARDS_REVEALED', { usages: usages.map(publicUsage), stationEffects: modifiers.effectIds });
  event(room, 'ENGINE_PHASE', { step: 1, name: 'COPY_EXPANSION' });
  engineExpandEncore(room, usages);
  event(room, 'ENGINE_PHASE', { step: 2, name: 'TARGET_CHANGE' });
  engineTargetChanges(room, usages);
  event(room, 'ENGINE_PHASE', { step: 3, name: 'NULLIFY' });
  engineNullify(room, usages);
  const focusCounts = engineFocusCounts(usages);
  event(room, 'ENGINE_PHASE', { step: 4, name: 'DEFENSE_RESERVATION' });
  const boosts = engineCardBoosts(room, usages);
  const defenses = engineReserveDefenses(room, usages, modifiers, focusCounts);
  event(room, 'ENGINE_PHASE', { step: 5, name: 'STATE_RESERVATION' });
  const healReduction = engineReserveState(room, usages);
  event(room, 'ENGINE_PHASE', { step: 6, name: 'BASIC_DIRECT_ATTACKS' });
  const basicAttacks = engineBasicAttacks(room, usages, snapshot, modifiers, defenses, boosts);
  event(room, 'ENGINE_PHASE', { step: 11, name: 'COMPLETE_DEFENSE_ASSIGNMENT' });
  engineAssignCompleteDefenses(room, defenses, basicAttacks, 'basic');
  event(room, 'ENGINE_PHASE', { step: 12, name: 'NUMERIC_DEFENSE_ASSIGNMENT' });
  engineAllocateReduction(room, defenses, basicAttacks, 'basic');
  event(room, 'ENGINE_PHASE', { step: 13, name: 'BASIC_DAMAGE_EVENTS' });
  engineResolveAttackEvents(room, basicAttacks);
  event(room, 'ENGINE_PHASE', { step: 14, name: 'CONDITIONAL_ADDITIONAL_ATTACKS' });
  const additionalAttacks = engineAdditionalAttacks(room, basicAttacks, modifiers, focusCounts);
  event(room, 'ENGINE_PHASE', { step: 16, name: 'REMAINING_DEFENSE_ON_ADDITIONALS' });
  engineAssignCompleteDefenses(room, defenses, additionalAttacks, 'additional');
  engineAllocateReduction(room, defenses, additionalAttacks, 'additional');
  event(room, 'ENGINE_PHASE', { step: 17, name: 'ADDITIONAL_DAMAGE_EVENTS' });
  engineResolveAttackEvents(room, additionalAttacks);
  const attacks = [...basicAttacks, ...additionalAttacks];
  engineApplyOnHitStates(room, attacks);
  event(room, 'ENGINE_PHASE', { step: 18, name: 'STATION_DAMAGE' });
  engineStationDamage(room, focusCounts, modifiers);
  event(room, 'ENGINE_PHASE', { step: 19, name: 'COUNTER_AND_REFLECT' });
  engineReactions(room, usages, attacks, modifiers);
  event(room, 'ENGINE_PHASE', { step: 20, name: 'RECOVERY_AND_ABSORB' });
  engineRecovery(room, usages, attacks, snapshot, healReduction, modifiers);
  event(room, 'ENGINE_PHASE', { step: 21, name: 'SELF_COSTS' });
  engineCostsMarksAndHistory(room, usages);
  room.revealedUsages = usages.map(use => ({ ...publicUsage(use), invalidated: use.invalidated || use.attackInvalidated, result: use.outcome }));
  room.phase = PHASE.TURN_RESULT;
  event(room, 'TURN_RESOLVED', { stationTurn: room.stationTurn, globalTurnIndex: room.globalTurnIndex, stationEffects: modifiers.effectIds });
}

function finishStation(room) {
  const eligible = room.players.filter(player => !player.stationStats.reachedZero);
  const sorted = [...eligible].sort((a, b) => b.stationStats.stationScore - a.stationStats.stationScore || b.hp - a.hp || b.stationStats.damageDealt - a.stationStats.damageDealt || b.stationStats.support - a.stationStats.support || a.stationStats.damageTaken - b.stationStats.damageTaken);
  const rewardByRank = { 1: 3, 2: 2, 3: 2, 4: 1, 5: 1 };
  let previous = null;
  const rankings = sorted.map((player, index) => {
    const signature = [player.stationStats.stationScore, player.hp, player.stationStats.damageDealt, player.stationStats.support, player.stationStats.damageTaken].join(':');
    const rank = previous?.signature === signature ? previous.rank : index + 1;
    const reward = rewardByRank[rank] || 0;
    if (reward) {
      player.currency.one += reward;
      room.currencyTransactions.push({ id: id(), type: 'STATION_REWARD', participantId: player.participantId, stationId: STATIONS[room.stationIndex].id, currency: 'one', amount: reward, cocofoliaApplied: false, createdAt: now() });
    }
    previous = { signature, rank };
    return { participantId: player.participantId, playerNumber: player.playerNumber, rank, reward, stationScore: player.stationStats.stationScore, hp: player.hp };
  });
  room.stationResult = { stationId: STATIONS[room.stationIndex].id, rankings, excludedPlayerNumbers: room.players.filter(player => player.stationStats.reachedZero).map(player => player.playerNumber) };
  room.phase = PHASE.STATION_RESULT;
  room.timer = null;
  event(room, 'STATION_RESULT_CONFIRMED', { stationId: room.stationResult.stationId, rankings });
}

const CURRENCY_LABELS = { one: '壱', two: '弐', three: '参', five: '伍', seven: '漆' };

function purchaseShopItem(room, player, itemId, requestedPayment) {
  const shop = SHOP_BY_STATION_ID[STATIONS[room.stationIndex]?.id];
  if (room.phase !== PHASE.FREE_TIME || !shop) throw new Error('この自由時間ではショップを利用できません');
  if (!room.timer || Date.now() >= room.timer.endsAt) throw new Error('ショップ購入受付は終了しました');
  const item = SHOP_ITEM_BY_ID[itemId];
  if (!item || item.shop !== shop.id) throw new Error('現在のショップの商品ではありません');
  if ((room.shopStock[item.id] || 0) < 1) throw new Error('他のプレイヤーが先に購入しました');
  const paymentAmount = Number(requestedPayment);
  if (paymentAmount !== shop.deposit) throw new Error(`このショップでは壱×${shop.deposit}を投入します`);
  if (player.currency.one < shop.deposit) throw new Error(`壱の冥貨があと${shop.deposit - player.currency.one}枚必要です`);
  const change = item.change;
  const transactionId = id();
  const isPrimeChange = ['two', 'three', 'five', 'seven'].includes(change.type);
  const isFirstPurchase = isPrimeChange && !room.firstPurchaseCompleted;
  player.currency.one -= shop.deposit;
  if (change.type) player.currency[change.type] += change.amount;
  player.shopInventory.push({ itemId: item.id, transactionId, used: false, acquiredAt: now() });
  room.shopStock[item.id] -= 1;
  const transaction = { id: transactionId, participantId: player.participantId, playerNumber: player.playerNumber, itemId: item.id, payment: { one: shop.deposit }, change, currencyCocofoliaApplied: false, createdAt: now() };
  room.purchaseTransactions.push(transaction);
  if (isPrimeChange) room.firstPurchaseCompleted = true;
  player.purchaseNotice = { transactionId, itemId: item.id, firstPurchase: isFirstPurchase };
  event(room, 'SHOP_PURCHASE_COMPLETED', { transactionId, itemId: item.id }, `private:${player.participantId}`);
}

function requireFreeTime(room) {
  if (room.phase !== PHASE.FREE_TIME || !room.timer || Date.now() >= room.timer.endsAt) throw new Error('冥貨を譲渡できる自由時間ではありません');
}

function createTransferRequest(room, sender, action) {
  requireFreeTime(room);
  const recipient = room.players.find(player => player.participantId === action.recipientId);
  if (!recipient || recipient === sender) throw new Error('自分以外の譲渡先を選択してください');
  const currencyType = String(action.currencyType || '');
  if (!CURRENCY_LABELS[currencyType]) throw new Error('冥貨種別が不正です');
  const amount = Number(action.amount);
  if (!Number.isInteger(amount) || amount < 1) throw new Error('譲渡枚数は1枚以上を指定してください');
  const reserved = room.transferRequests.filter(item => item.senderId === sender.participantId && item.currencyType === currencyType && item.status === 'PENDING').reduce((sum, item) => sum + item.amount, 0);
  if (sender.currency[currencyType] - reserved < amount) throw new Error('申請可能な所持冥貨が不足しています');
  const transfer = { id: id(), senderId: sender.participantId, recipientId: recipient.participantId, currencyType, amount, status: 'PENDING', cocofoliaApplied: false, createdAt: now() };
  room.transferRequests.push(transfer);
  event(room, 'TRANSFER_REQUESTED', { transferId: transfer.id }, `private:${sender.participantId}`);
}

function transferById(room, transferId) {
  const transfer = room.transferRequests.find(item => item.id === transferId);
  if (!transfer) throw new Error('譲渡申請が見つかりません');
  return transfer;
}

function approveTransfer(room, transferId) {
  if (room.phase !== PHASE.FREE_TIME) throw new Error('自由時間中の譲渡申請ではありません');
  const transfer = transferById(room, transferId);
  if (transfer.status !== 'PENDING') throw new Error('未処理の譲渡申請ではありません');
  const sender = room.players.find(player => player.participantId === transfer.senderId);
  const recipient = room.players.find(player => player.participantId === transfer.recipientId);
  if (!sender || !recipient || sender.currency[transfer.currencyType] < transfer.amount) throw new Error('譲渡可能な所持冥貨が不足しています');
  sender.currency[transfer.currencyType] -= transfer.amount;
  recipient.currency[transfer.currencyType] += transfer.amount;
  transfer.status = 'CONFIRMED';
  transfer.confirmedAt = now();
  event(room, 'TRANSFER_CONFIRMED', { transferId: transfer.id }, 'gm');
}

function updateTransferStatus(room, transferId, status) {
  const transfer = transferById(room, transferId);
  if (transfer.status !== 'PENDING') throw new Error('未処理の譲渡申請ではありません');
  transfer.status = status;
  transfer.resolvedAt = now();
  event(room, 'TRANSFER_REJECTED', { transferId: transfer.id }, 'gm');
}

function startNextStation(room) {
  const nextStationIndex = room.stationIndex + 1;
  const nextStation = STATIONS[nextStationIndex];
  if (!nextStation) throw new Error('次の地獄が見つかりません');
  if (!stationIntroductionFor(nextStation.id)) throw new Error('次の地獄の導入が未設定です');
  room.stationIndex = nextStationIndex;
  room.stationTurn = 0;
  room.phase = PHASE.STATION_INTRODUCTION;
  room.stationIntroductionStep = 1;
  room.stationResult = null;
  room.revealedUsages = [];
  room.timer = null;
  room.players.forEach(player => { player.selection = null; player.confirmed = false; player.freeTimeReady = false; player.stationStats = freshStats(); });
  prepareStationStart(room);
  event(room, 'STATION_INTRODUCTION_STARTED', { stationId: nextStation.id, stationEffects: activeStationEffectIds(room) });
}

function advanceStationIntroduction(room) {
  if (room.phase !== PHASE.STATION_INTRODUCTION) throw new Error('駅導入中ではありません');
  const introduction = stationIntroductionFor(STATIONS[room.stationIndex]?.id);
  if (!introduction) throw new Error('この駅の導入はありません');
  if (room.stationIntroductionStep < introduction.lines.length) {
    room.stationIntroductionStep += 1;
    event(room, 'STATION_INTRODUCTION_ADVANCED', { stationId: STATIONS[room.stationIndex].id, step: room.stationIntroductionStep }, 'gm');
    return;
  }
  room.stationIntroductionStep = 0;
  room.stationTurn = 1;
  room.globalTurnIndex += 1;
  room.phase = PHASE.TURN_SELECTION;
  room.timer = { startedAt: Date.now(), endsAt: Date.now() + STATIONS[room.stationIndex].turnSeconds * 1000 };
  prepareTurnSnapshot(room);
  event(room, 'STATION_STARTED', { stationId: STATIONS[room.stationIndex].id, stationTurn: 1, globalTurnIndex: room.globalTurnIndex, stationEffects: activeStationEffectIds(room) });
}

function shopForRoom(room) {
  const definition = SHOP_BY_STATION_ID[STATIONS[room.stationIndex]?.id];
  if (!definition) return { items: [] };
  return {
    id: definition.id,
    name: definition.name,
    deposit: definition.deposit,
    items: SHOP_ITEMS.filter(item => item.shop === definition.id).map(({ change, ...item }) => ({ ...item, soldOut: (room.shopStock[item.id] || 0) < 1 }))
  };
}

function nextTurn(room) {
  if (room.phase !== PHASE.TURN_RESULT) throw new Error('ターン結果確認中ではありません');
  const station = STATIONS[room.stationIndex];
  if (room.stationTurn >= station.turnCount) {
    if (room.stationIndex < STATIONS.length - 1) return finishStation(room);
    throw new Error('無間地獄終了後の処理は未実装です');
  }
  room.stationTurn += 1; room.globalTurnIndex += 1; room.phase = PHASE.TURN_SELECTION; room.revealedUsages = [];
  room.timer = { startedAt: Date.now(), endsAt: Date.now() + station.turnSeconds * 1000 };
  for (const player of room.players) { player.selection = null; player.confirmed = false; }
  prepareTurnSnapshot(room);
  event(room, 'TURN_STARTED', { stationId: station.id, stationTurn: room.stationTurn, globalTurnIndex: room.globalTurnIndex });
}

export function projectState(room, actor) {
  ensureRoomState(room);
  const isGm = actor.role === 'GM';
  const stationIntroduction = room.phase === PHASE.STATION_INTRODUCTION ? stationIntroductionFor(STATIONS[room.stationIndex]?.id) : null;
  const visibleTransfers = room.transferRequests.filter(item => isGm || item.senderId === actor.participantId || item.recipientId === actor.participantId).map(item => ({
    ...item,
    currencyLabel: CURRENCY_LABELS[item.currencyType],
    senderNumber: room.players.find(player => player.participantId === item.senderId)?.playerNumber,
    senderName: room.players.find(player => player.participantId === item.senderId)?.name,
    recipientNumber: room.players.find(player => player.participantId === item.recipientId)?.playerNumber,
    recipientName: room.players.find(player => player.participantId === item.recipientId)?.name
  }));
  const publicEvents = room.events.filter(item => item.visibility === 'public' || isGm || item.visibility === `private:${actor.participantId}`).slice(-100);
  return {
    code: room.code, testMode: Boolean(room.testMode), phase: room.phase, station: room.stationIndex >= 0 ? STATIONS[room.stationIndex] : null,
    stationTurn: room.stationTurn, globalTurnIndex: room.globalTurnIndex, timer: room.timer, introductionStep: room.introductionStep || 0, activeStationEffectIds: activeStationEffectIds(room),
    gameGuide: room.phase === PHASE.GAME_GUIDE ? { title: GAME_GUIDE.title, lines: GAME_GUIDE.lines, step: room.gameGuideStep } : null,
    stationIntroduction: stationIntroduction ? { title: stationIntroduction.title, lines: stationIntroduction.lines, step: room.stationIntroductionStep } : null,
    me: actor.role === 'GM' ? { participantId: actor.participantId, role: 'GM', name: actor.name } : privatePlayer(actor, room),
    players: room.players.map(player => ({ participantId: player.participantId, playerNumber: player.playerNumber, name: player.name, hp: player.hp, isDeadState: player.isDeadState, packId: player.packId, confirmed: player.confirmed, selfIntroductionComplete: Boolean(player.selfIntroductionComplete), freeTimeReady: Boolean(player.freeTimeReady), ongoingEffects: player.ongoingEffects.map(({ sourceId, cardId, ...effect }) => effect), selection: isGm || player.participantId === actor.participantId ? player.selection : undefined })),
    packs: PACKS.map(pack => ({ ...pack, cards: isGm || actor.packId === pack.id ? CARDS.filter(card => card.packId === pack.id) : undefined })), stations: STATIONS,
    testPlayers: isGm ? room.players.map(player => ({ ...privatePlayer(player, room), selection: player.selection, confirmed: player.confirmed })) : undefined,
    stationResult: room.stationResult,
    shop: shopForRoom(room),
    purchaseTransactions: isGm ? room.purchaseTransactions.map(transaction => ({ ...transaction, playerName: room.players.find(player => player.participantId === transaction.participantId)?.name, itemName: SHOP_ITEM_BY_ID[transaction.itemId]?.name })) : undefined,
    transferRequests: visibleTransfers,
    pendingCurrencyTransactions: isGm ? room.currencyTransactions.filter(transaction => !transaction.cocofoliaApplied) : undefined,
    revealedUsages: room.phase === PHASE.TURN_RESULT ? room.revealedUsages.map(use => { const card = CARDS.find(item => item.id === use.cardId); return { ...use, cardName: card?.name, category: card?.category, description: card?.description }; }) : [], events: publicEvents
  };
}

function privatePlayer(player, room) {
  const cards = CARDS.filter(card => card.packId === player.packId).map(card => {
    const status = cooldownStatus(room, player, card.id);
    const mark = player.cardMarks[card.id] || {};
    const bypassOptions = status.code === 'NORMAL' ? [
      ...(mark.desireReuseAt === room.globalTurnIndex ? ['DESIRE'] : []),
      ...(mark.greedyTicketReuseAt === room.globalTurnIndex ? ['GREEDY_TICKET'] : []),
      ...(stationModifiers(room).normalCooldownReuse && !player.hungerReuseUsed ? ['HUNGER'] : [])
    ] : [];
    return { ...card, unavailableReason: status.code === 'EXTENSION' ? status.reason : card.id === 'encore' && !hasEncoreCandidate(room, player) ? '3駅以上前のコピー候補がありません' : status.code === 'NORMAL' && !bypassOptions.length ? status.reason : null, cooldownStatus: status.code, bypassOptions };
  });
  const encoreCandidates = player.cardUsage.filter(use => use.stationIndex <= room.stationIndex - 3 && ['attack', 'defense', 'heal'].includes(CARD_BY_ID[use.cardId]?.effect?.kind)).map(use => ({ id: use.id, cardId: use.cardId, cardName: CARD_BY_ID[use.cardId]?.name, kind: CARD_BY_ID[use.cardId]?.effect?.kind }));
  return { participantId: player.participantId, role: 'PL', playerNumber: player.playerNumber, name: player.name, hp: player.hp, packId: player.packId, cards, cardMarks: player.cardMarks, ongoingEffects: player.ongoingEffects, encoreCandidates, hungerReuseUsed: player.hungerReuseUsed, currency: player.currency, shopInventory: player.shopInventory.map(entry => ({ ...entry, item: SHOP_ITEM_BY_ID[entry.itemId] })), purchaseTransactions: room.purchaseTransactions.filter(transaction => transaction.participantId === player.participantId).map(transaction => ({ ...transaction, itemName: SHOP_ITEM_BY_ID[transaction.itemId]?.name })), purchaseNotice: player.purchaseNotice };
}
