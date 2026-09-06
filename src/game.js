import crypto from 'node:crypto';
import { CARDS, CARD_BY_ID, PACKS, PACK_BY_ID, SHOP_BY_STATION_ID, SHOP_ITEMS, SHOP_ITEM_BY_ID, STATIONS, STATION_EFFECTS } from './definitions.js';
import { GAME_GUIDE } from './game-guide.js';
import { stationIntroductionFor } from './station-introductions.js';

export const PHASE = Object.freeze({ LOBBY: 'LOBBY', INTRODUCTION: 'INTRODUCTION', SELF_INTRODUCTION: 'SELF_INTRODUCTION', GAME_GUIDE: 'GAME_GUIDE', PACK_SELECTION: 'PACK_SELECTION', TURN_SELECTION: 'TURN_SELECTION', TURN_RESULT: 'TURN_RESULT', STATION_RESULT: 'STATION_RESULT', REWARD_NARRATION: 'REWARD_NARRATION', CURRENCY_SYNC_WAIT: 'CURRENCY_SYNC_WAIT', FREE_TIME_INTRO: 'FREE_TIME_INTRO', FREE_TIME: 'FREE_TIME', STATION_INTRODUCTION: 'STATION_INTRODUCTION', FINAL_RANKING: 'FINAL_RANKING', FINAL_ALIGNMENT: 'FINAL_ALIGNMENT', FINAL_JUDGMENT: 'FINAL_JUDGMENT', ENDING: 'ENDING' });
const token = () => crypto.randomBytes(24).toString('base64url');
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const INTRODUCTION_STEP_COUNT = 39;

// 通常ゲームは暗号学的乱数を使う。バランスシミュレーションだけは room.randomInt を
// 注入して、対象変更・無間地獄の抽選・テスト用パックシャッフルを再現可能にする。
function randomInt(room, maxExclusive) {
  if (typeof room?.randomInt === 'function') return room.randomInt(maxExclusive);
  return crypto.randomInt(maxExclusive);
}

function event(room, type, payload = {}, visibility = 'public') {
  room.events.push({ id: id(), type, payload, visibility, globalTurnIndex: room.globalTurnIndex, at: now() });
}

export function createRoom(gmName = 'GM') {
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  const gm = { participantId: id(), authToken: token(), role: 'GM', name: gmName.trim() || 'GM' };
  const room = {
    id: id(), code, phase: PHASE.LOBBY, gm, players: [], stationIndex: -1, stationTurn: 0,
    globalTurnIndex: 0, timer: null, revealedUsages: [], stationResult: null, stationResults: [], finalRanking: null, finalEnding: null, rewardNarrationStep: 0, freeTimeIntroductionStep: 0, activeStationEffectIds: [], shopStock: Object.fromEntries(SHOP_ITEMS.map(item => [item.id, item.stock])), currencyTransactions: [], purchaseTransactions: [], transferRequests: [], firstPurchaseCompleted: false, events: [], createdAt: now(), updatedAt: now()
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
  room.rewardNarrationStep ||= 0;
  room.freeTimeIntroductionStep ||= 0;
  room.activeStationEffectIds ||= [];
  room.gameGuideStep ||= 0;
  room.finalRanking ||= null;
  room.finalEnding ||= null;
  room.stationResults ||= [];
  for (const transaction of room.purchaseTransactions) {
    transaction.currencyCocofoliaApplied ??= Boolean(transaction.cocofoliaApplied);
  }
  for (const player of room.players) {
    player.shopInventory ||= [];
    for (const entry of player.shopInventory) {
      entry.inventoryId ||= id();
      entry.ownerPlayerId ||= player.participantId;
      entry.purchased ??= true;
      entry.lastUsedGlobalTurnIndex ??= null;
      entry.cooldownUntilGlobalTurnIndex ??= null;
      entry.totalUseCount ??= 0;
      delete entry.used;
      delete entry.consumed;
      delete entry.removedFromGame;
    }
    player.infoShopResults ||= [];
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
      if (actor.confirmed) throw new Error('最終確認済みのパックはGMが解除するまで変更できません');
      if (!PACK_BY_ID[action.packId]) throw new Error('存在しないパックです');
      actor.packId = action.packId;
      actor.confirmed = Boolean(action.confirmed);
      event(room, 'PACK_SELECTED', { participantId: actor.participantId, confirmed: actor.confirmed }, `private:${actor.participantId}`);
      break;
    }
    case 'CLEAR_PACK_SELECTION':
      requirePlayer(actor);
      if (room.phase !== PHASE.PACK_SELECTION) throw new Error('パック選択フェーズではありません');
      actor.packId = null;
      actor.confirmed = false;
      event(room, 'PACK_SELECTION_CLEARED', { participantId: actor.participantId }, `private:${actor.participantId}`);
      break;
    case 'START_FIRST_STATION':
      requireGm(actor);
      startFirstStation(room);
      break;
    case 'SELECT_CARD':
      requirePlayer(actor);
      selectCard(room, actor, action);
      break;
    case 'USE_INFORMATION_SHOP':
      requirePlayer(actor);
      useInformationShop(room, actor, action);
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
    case 'START_REWARD_NARRATION':
      requireGm(actor);
      if (room.phase !== PHASE.STATION_RESULT) throw new Error('報酬発表を開始できる駅結果ではありません');
      room.phase = PHASE.REWARD_NARRATION;
      room.rewardNarrationStep = 1;
      event(room, 'STATION_REWARD_NARRATION_STARTED', { stationId: STATIONS[room.stationIndex].id });
      break;
    case 'ADVANCE_REWARD_NARRATION':
      requireGm(actor);
      advanceRewardNarration(room);
      break;
    case 'START_FREE_TIME':
      requireGm(actor);
      startFreeTimeIntroduction(room);
      break;
    case 'ADVANCE_FREE_TIME_INTRODUCTION':
      requireGm(actor);
      advanceFreeTimeIntroduction(room);
      break;
    case 'BUY_SHOP_ITEM':
      requirePlayer(actor);
      purchaseShopItem(room, actor, action.itemId, action.payment);
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
    case 'START_FINAL_ALIGNMENT':
      requireGm(actor);
      if (room.phase !== PHASE.FINAL_RANKING) throw new Error('最終順位の発表後に最終整線を開始できます');
      room.phase = PHASE.FINAL_ALIGNMENT;
      room.timer = { startedAt: Date.now(), endsAt: Date.now() + 180_000 };
      event(room, 'FINAL_ALIGNMENT_STARTED', { seconds: 180 });
      break;
    case 'START_FINAL_JUDGMENT':
      requireGm(actor);
      if (room.phase !== PHASE.FINAL_ALIGNMENT) throw new Error('最終整線中ではありません');
      room.phase = PHASE.FINAL_JUDGMENT;
      room.timer = null;
      event(room, 'FINAL_JUDGMENT_STARTED');
      break;
    case 'CONFIRM_FINAL_ENDING': {
      requireGm(actor);
      if (room.phase !== PHASE.FINAL_JUDGMENT) throw new Error('GM最終判定中ではありません');
      const endings = {
        HEAVEN_BOUND: '天国行き',
        HEAVEN_PASSING: '通過する天国',
        HELL_LOOP: '地獄廻線'
      };
      if (!endings[action.endingId]) throw new Error('エンディング種別が不正です');
      room.finalEnding = { id: action.endingId, title: endings[action.endingId], decidedAt: now() };
      room.phase = PHASE.ENDING;
      event(room, 'ENDING_CONFIRMED', { endingId: action.endingId });
      break;
    }
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
    case 'MARK_CURRENCY_TRANSACTION_APPLIED': {
      requireGm(actor);
      markCurrencyTransactionApplied(room, action.transactionId);
      break;
    }
    case 'MARK_PLAYER_STATION_REWARDS_APPLIED': {
      requireGm(actor);
      markPlayerStationRewardsApplied(room, action.participantId);
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
        const swapIndex = randomInt(room, index + 1);
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
      if (!['SELECT_PACK', 'CLEAR_PACK_SELECTION', 'SELECT_CARD', 'CONFIRM_CARD', 'ACK_RESULT', 'BUY_SHOP_ITEM', 'CREATE_TRANSFER_REQUEST', 'DISMISS_PURCHASE_NOTICE', 'SET_FREE_TIME_READY', 'USE_INFORMATION_SHOP'].includes(action.playerAction?.type)) throw new Error('許可されていないテスト操作です');
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
  const first = randomInt(room, candidates.length);
  const [one] = candidates.splice(first, 1);
  const two = candidates[randomInt(room, candidates.length)];
  room.activeStationEffectIds = [one, two];
  event(room, 'INFINITE_EFFECTS_SELECTED', { effectIds: room.activeStationEffectIds }, 'public');
}
function prepareTurnSnapshot(room) {
  for (const player of room.players) {
    for (const mark of Object.values(player.cardMarks)) {
      if (mark.desireReuseAt && mark.desireReuseAt < room.globalTurnIndex) delete mark.desireReuseAt;
      if (mark.greedyTicketReuseAt && mark.greedyTicketReuseAt < room.globalTurnIndex) delete mark.greedyTicketReuseAt;
    }
    for (const entry of player.shopInventory) {
      if (entry.cooldownUntilGlobalTurnIndex === room.globalTurnIndex - 1 && entry.cooldownEndedAtGlobalTurnIndex !== room.globalTurnIndex) {
        entry.cooldownEndedAtGlobalTurnIndex = room.globalTurnIndex;
        event(room, 'SHOP_COOLDOWN_ENDED', { participantId: player.participantId, playerNumber: player.playerNumber, shopEntryId: entry.inventoryId, itemId: entry.itemId, globalTurnIndex: room.globalTurnIndex }, `private:${player.participantId}`);
      }
    }
    player.immediateShopUse = null;
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
  if (new Set(room.players.map(p => p.packId)).size !== 7) throw new Error('カードパックは重複できません');
  room.stationIndex = 0; room.stationTurn = 0; room.globalTurnIndex = 0; room.phase = PHASE.STATION_INTRODUCTION;
  room.timer = null;
  room.rewardNarrationStep = 0;
  room.freeTimeIntroductionStep = 0;
  room.activeStationEffectIds = [];
  room.stationResults = [];
  for (const p of room.players) { p.confirmed = false; p.selection = null; p.stationStats = freshStats(); p.isDeadState = false; p.turnStartDeadState = false; }
  prepareStationStart(room);
  room.stationIntroductionStep = 1;
  event(room, 'PACKS_CONFIRMED', { packs: room.players.map(p => ({ playerNumber: p.playerNumber, packId: p.packId })) });
  event(room, 'STATION_INTRODUCTION_STARTED', { stationId: STATIONS[0].id, stationEffects: activeStationEffectIds(room) });
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
  if (mark.cooldownExtensionUntil >= room.globalTurnIndex) return { code: 'EXTENSION', reason: `【強奪】の効果により、あと${mark.cooldownExtensionUntil - room.globalTurnIndex + 1}ターン使用できません。` };
  const last = lastUsage(player, cardId);
  if (last?.normalCooldownStartsAt === room.globalTurnIndex) return { code: 'NORMAL', reason: '前のターンに使用したため、このターンは使用できません。' };
  return { code: null, reason: null };
}
function cooldownReason(player, cardId, globalTurnIndex) {
  const mark = player.cardMarks[cardId] || {};
  if (mark.cooldownExtensionUntil >= globalTurnIndex) return `【強奪】の効果により、あと${mark.cooldownExtensionUntil - globalTurnIndex + 1}ターン使用できません。`;
  const last = lastUsage(player, cardId);
  return last?.normalCooldownStartsAt === globalTurnIndex ? '前のターンに使用したため、このターンは使用できません。' : null;
}

function shopEntryById(player, entryIdOrItemId) {
  return player.shopInventory.find(entry => entry.inventoryId === entryIdOrItemId)
    || player.shopInventory.find(entry => entry.itemId === entryIdOrItemId);
}
function shopCooldownStatus(room, entry) {
  if (Number(entry.cooldownUntilGlobalTurnIndex || 0) >= room.globalTurnIndex) {
    return { code: 'NORMAL', reason: 'このSHOPカードは前のターンに使用したため、このターンは使用できません。' };
  }
  return { code: null, reason: null };
}
function currentImmediateShopUse(room, player) {
  return player.immediateShopUse?.globalTurnIndex === room.globalTurnIndex ? player.immediateShopUse : null;
}
function selectedShopEntry(room, player, selection) {
  if (!selection?.shopEntryId) return null;
  const entry = shopEntryById(player, selection.shopEntryId);
  if (!entry) throw new Error('指定したSHOPカードを所持していません。');
  const item = SHOP_ITEM_BY_ID[entry.itemId];
  if (!item) throw new Error('指定したSHOPカードが見つかりません。');
  return { entry, item };
}
function validateShopEntryForUse(room, player, entry, item) {
  if (!entry || entry.ownerPlayerId !== player.participantId || !entry.purchased) throw new Error('指定したSHOPカードを所持していません。');
  const status = shopCooldownStatus(room, entry);
  if (status.code) throw new Error(status.reason);
  return status;
}
function startShopUse(room, player, entry, item, { timing = 'REVEAL', visibility = 'public', targetId = null } = {}) {
  entry.lastUsedGlobalTurnIndex = room.globalTurnIndex;
  entry.cooldownUntilGlobalTurnIndex = room.globalTurnIndex + 1;
  entry.totalUseCount = Number(entry.totalUseCount || 0) + 1;
  const payload = { participantId: player.participantId, playerNumber: player.playerNumber, shopEntryId: entry.inventoryId, itemId: item.id, useCount: entry.totalUseCount, timing, globalTurnIndex: room.globalTurnIndex };
  event(room, 'SHOP_USED', payload, visibility);
  event(room, 'SHOP_COOLDOWN_STARTED', { ...payload, unavailableTurn: entry.cooldownUntilGlobalTurnIndex }, visibility);
  return { entry, item, targetId, timing };
}
function shopUseLabel(item) { return `【${item.name}】`; }

function useInformationShop(room, actor, action) {
  if (room.phase !== PHASE.TURN_SELECTION || actor.confirmed) throw new Error('カード選択中のみ情報系SHOPを使用できます。');
  if (actor.selection?.shopEntryId || currentImmediateShopUse(room, actor)) throw new Error('このターンはすでにSHOPカードを使用しています。');
  const entry = shopEntryById(actor, action.shopEntryId || action.shopItemId);
  const item = entry && SHOP_ITEM_BY_ID[entry.itemId];
  if (!item || item.timing !== 'info') throw new Error('情報系SHOPカードを指定してください。');
  validateShopEntryForUse(room, actor, entry, item);
  const target = playerById(room, action.targetId);
  if (!target || target === actor) throw new Error('自分以外のPLを指定してください。');
  const targetCard = target.selection ? CARD_BY_ID[target.selection.cardId] : null;
  let result;
  if (!targetCard) result = '仮選択はまだありません。';
  else if (item.effectType === 'INFO_CATEGORY') result = `PL${target.playerNumber}の仮選択カードの主分類は「${targetCard.category === 'attack' ? '攻撃' : ({ defense: '防御', support: '補助', heal: '回復', interference: '妨害' }[targetCard.category] || 'それ以外')}」です。`;
  else if (item.effectType === 'INFO_ATTACK_OR_OTHER') {
    result = targetCard.category === 'attack'
      ? `PL${target.playerNumber}の仮選択カードは「攻撃」です。現在の対象は${target.selection?.targetId === actor.participantId ? 'あなたです。' : 'あなたではありません。'}`
      : `PL${target.playerNumber}の仮選択カードは「攻撃以外」です。`;
  }
  else result = `PL${target.playerNumber}の仮選択カードは【${targetCard.name}】です。`;
  const shopUse = startShopUse(room, actor, entry, item, { timing: 'INFO', visibility: `private:${actor.participantId}`, targetId: target.participantId });
  actor.immediateShopUse = { entryId: entry.inventoryId, itemId: item.id, globalTurnIndex: room.globalTurnIndex, targetId: target.participantId };
  actor.infoShopResults.push({ id: id(), itemId: item.id, targetId: target.participantId, result, globalTurnIndex: room.globalTurnIndex, at: now() });
  event(room, 'SHOP_INFORMATION_REVEALED', { ...shopUse, result }, `private:${actor.participantId}`);
}

function selectCard(room, actor, action) {
  if (room.phase !== PHASE.TURN_SELECTION || actor.confirmed) throw new Error('現在は選択を変更できません');
  const card = CARD_BY_ID[action.cardId];
  if (!card || card.packId !== actor.packId) throw new Error('自分のパックのカードではありません');
  if (card.id === 'encore' && !hasEncoreCandidate(room, actor)) throw new Error('再演できる使用履歴がありません。');
  const requestedShopEntryId = action.shopEntryId || action.shopItemId || null;
  const shop = requestedShopEntryId ? selectedShopEntry(room, actor, { shopEntryId: requestedShopEntryId }) : null;
  if (shop) {
    if (shop.item.timing === 'info') throw new Error('情報系SHOPカードは情報確認ボタンから使用してください。');
    if (currentImmediateShopUse(room, actor)) throw new Error('このターンはすでに情報系SHOPカードを使用しています。');
    validateShopEntryForUse(room, actor, shop.entry, shop.item);
  }
  const status = cooldownStatus(room, actor, card.id);
  let ctBypass = null;
  if (status.code === 'EXTENSION') throw new Error(status.reason);
  if (status.code === 'NORMAL') {
    const mark = actor.cardMarks[card.id] || {};
    if (action.ctBypass === 'DESIRE' && mark.desireReuseAt === room.globalTurnIndex) ctBypass = 'DESIRE';
    else if (action.ctBypass === 'GREEDY_TICKET' && mark.greedyTicketReuseAt === room.globalTurnIndex) ctBypass = 'GREEDY_TICKET';
    else if (action.ctBypass === 'HUNGER' && stationModifiers(room).normalCooldownReuse && !actor.hungerReuseUsed) ctBypass = 'HUNGER';
    else if (shop?.item.effectType === 'NORMAL_CT_BYPASS') ctBypass = 'HELL_KEY';
    else throw new Error(status.reason);
  } else if (shop?.item.effectType === 'NORMAL_CT_BYPASS') {
    throw new Error('【地獄の鍵】は通常クールタイム中の七獄カードにのみ使用できます。');
  }
  const selection = { cardId: card.id, targetId: action.targetId || null, cardTargetId: action.cardTargetId || null, stateKey: action.stateKey || null, copyUsageId: action.copyUsageId || null, copyKind: action.copyKind || null, shopEntryId: shop?.entry.inventoryId || null, shopTargetId: action.shopTargetId || null, shopCardTargetId: action.shopCardTargetId || null, ctBypass };
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
  const shop = selectedShopEntry(room, actor, selection);
  if (!shop) return;
  validateShopEntryForUse(room, actor, shop.entry, shop.item);
  if (currentImmediateShopUse(room, actor)) throw new Error('このターンはすでに情報系SHOPカードを使用しています。');
  if (shop.item.effectType === 'GRUDGE' || shop.item.effectType === 'SECRET_TARGET_NOTICE' || shop.item.effectType === 'ALLY_DIRECT_REDUCTION') {
    const target = playerById(room, selection.shopTargetId);
    if (!target || target === actor) {
      const message = shop.item.effectType === 'GRUDGE'
        ? '怨返しする相手を自分以外から1人選んでください。'
        : shop.item.effectType === 'ALLY_DIRECT_REDUCTION'
          ? '守るプレイヤーを自分以外から1人選んでください。'
          : '通知先を自分以外から1人選んでください。';
      throw new Error(message);
    }
  }
  if (shop.item.effectType === 'SECRET_TARGET_NOTICE' && card.category !== 'attack') throw new Error('【共犯の糸】は攻撃カードと組み合わせて使用してください。');
  if (shop.item.effectType === 'PREVENT_TARGET_CHANGE_ONCE_ATTACK' && card.category !== 'attack') throw new Error('【地獄の鎖】は攻撃カードと一緒に使用してください。');
  if (shop.item.effectType === 'GREEDY_TICKET') {
    const targetCard = CARD_BY_ID[selection.shopCardTargetId];
    const mark = targetCard && actor.cardMarks[targetCard.id] || {};
    if (!targetCard || targetCard.packId !== actor.packId || targetCard.category === 'attack') throw new Error('【欲張り札】は自分の攻撃以外の七獄カードを指定してください。');
    if (cooldownStatus(room, actor, targetCard.id).code === 'NORMAL' || mark.desire || mark.greedyTicketPending || mark.desireReuseAt || mark.greedyTicketReuseAt || mark.cooldownExtensionUntil >= room.globalTurnIndex) throw new Error('そのカードには欲張り札を予約できません。');
  }
}

function hasEncoreCandidate(room, player) {
  return player.cardUsage.some(use => use.stationIndex <= room.stationIndex - 3 && ['attack', 'defense', 'heal'].includes(CARD_BY_ID[use.cardId]?.effect?.kind));
}
function validateStoredCooldown(room, player, selection) {
  const shop = selectedShopEntry(room, player, selection);
  if (shop) {
    validateShopEntryForUse(room, player, shop.entry, shop.item);
    if (currentImmediateShopUse(room, player)) throw new Error('このターンはすでに情報系SHOPカードを使用しています。');
  }
  const status = cooldownStatus(room, player, selection.cardId);
  if (status.code === 'EXTENSION') throw new Error(status.reason);
  if (status.code !== 'NORMAL') return;
  const mark = player.cardMarks[selection.cardId] || {};
  if (selection.ctBypass === 'DESIRE' && mark.desireReuseAt === room.globalTurnIndex) return;
  if (selection.ctBypass === 'GREEDY_TICKET' && mark.greedyTicketReuseAt === room.globalTurnIndex) return;
  if (selection.ctBypass === 'HUNGER' && stationModifiers(room).normalCooldownReuse && !player.hungerReuseUsed) return;
  if (selection.ctBypass === 'HELL_KEY' && shop?.item.effectType === 'NORMAL_CT_BYPASS') return;
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

function publicUsage(use) {
  return {
    participantId: use.player.participantId,
    playerNumber: use.player.playerNumber,
    cardId: use.card.id,
    targetId: use.targetId,
    shopItemId: use.shopItem?.id || null,
    // 護りの数珠の支援先だけは一斉公開時に公開する。怨返し等の秘密対象は含めない。
    shopTargetId: use.shopItem?.effectType === 'ALLY_DIRECT_REDUCTION' ? use.shopTargetId || null : null
  };
}
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
    event(room, 'HP_ZERO_REACHED', { participantId: player.participantId, stationId: currentStation(room)?.id || null });
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
function engineStartShopUses(room, usages) {
  for (const use of usages.filter(item => item.shopEntry && item.shopItem)) {
    use.shop = startShopUse(room, use.player, use.shopEntry, use.shopItem, { timing: 'REVEAL', visibility: 'public', targetId: use.shopTargetId || null });
  }
}
function engineTargetChanges(room, usages) {
  for (const use of usages.filter(item => item.effect.kind === 'targetChange')) {
    const targetUse = usages.find(item => item.player.participantId === use.targetId);
    if (!targetUse || !targetUse.targetId || targetUse.card.targetType !== 'player') { use.outcome = 'FIZZLED'; continue; }
    if (targetUse.shopItem?.effectType === 'PREVENT_TARGET_CHANGE') {
      use.outcome = 'FIZZLED';
      event(room, 'SHOP_EFFECT_APPLIED', { participantId: targetUse.player.participantId, itemId: targetUse.shopItem.id, effect: 'TARGET_CHANGE_PREVENTED', sourceId: use.player.participantId });
      continue;
    }
    if (targetUse.shopItem?.effectType === 'PREVENT_TARGET_CHANGE_ONCE_ATTACK' && targetUse.card.category === 'attack' && !targetUse.shopTargetChangePrevented) {
      targetUse.shopTargetChangePrevented = true;
      use.outcome = 'FIZZLED';
      event(room, 'SHOP_EFFECT_APPLIED', { participantId: targetUse.player.participantId, itemId: targetUse.shopItem.id, effect: 'TARGET_CHANGE_PREVENTED_ONCE_ATTACK', sourceId: use.player.participantId });
      continue;
    }
    if (targetUse.shopItem?.effectType === 'PREVENT_TARGET_CHANGE_ONCE' && !targetUse.shopTargetChangePrevented) {
      targetUse.shopTargetChangePrevented = true;
      use.outcome = 'FIZZLED';
      event(room, 'SHOP_EFFECT_APPLIED', { participantId: targetUse.player.participantId, itemId: targetUse.shopItem.id, effect: 'TARGET_CHANGE_PREVENTED_ONCE', sourceId: use.player.participantId });
      continue;
    }
    const candidates = room.players.filter(player => player.participantId !== targetUse.player.participantId && player.participantId !== targetUse.targetId);
    if (!candidates.length) { use.outcome = 'FIZZLED'; event(room, 'TARGET_CHANGE_FIZZLED', { sourceId: use.player.participantId, targetId: targetUse.player.participantId }); continue; }
    const fromTargetId = targetUse.targetId;
    const target = candidates[randomInt(room, candidates.length)];
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
    if ((targetUse.invalidated || targetUse.carryInvalidated) && targetUse.shopItem?.effectType === 'NO_NORMAL_CT_ON_NULLIFY') {
      targetUse.skipNormalCooldown = true;
      event(room, 'SHOP_EFFECT_APPLIED', { participantId: targetUse.player.participantId, itemId: targetUse.shopItem.id, effect: 'NORMAL_COOLDOWN_PREVENTED', cardId: targetUse.card.id });
    }
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
  for (const use of usages.filter(item => item.shopItem?.effectType === 'ATTACK_BONUS')) {
    if (engineUseHasAttack(use) && !use.attackInvalidated) add(use, use.player, 1, 'SHOP_ATTACK_BONUS');
    else {
      use.shopEffectFailed = true;
      event(room, 'SHOP_EFFECT_FAILED', { participantId: use.player.participantId, itemId: use.shopItem.id, reason: 'ATTACK_EFFECT_REQUIRED' });
    }
  }
  return boosts;
}
function engineReserveDefenses(room, usages, modifiers, focusCounts) {
  const defenses = new Map();
  for (const use of usages) {
    if (!use.invalidated) {
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
    if (use.shopItem?.effectType === 'DIRECT_REDUCTION') {
      engineAddDefense(defenses, use.player.participantId, { use, shopItemId: use.shopItem.id, kind: 'numeric', remaining: 1, contributions: [{ source: use.player, amount: 1, reason: 'SHOP_DIRECT_REDUCTION', isShop: true }] });
    }
    if (use.shopItem?.effectType === 'ALLY_DIRECT_REDUCTION') {
      const protectedPlayer = playerById(room, use.shopTargetId);
      if (protectedPlayer && protectedPlayer !== use.player) {
        engineAddDefense(defenses, protectedPlayer.participantId, { use, shopItemId: use.shopItem.id, kind: 'numeric', remaining: 1, contributions: [{ source: use.player, amount: 1, reason: 'SHOP_ALLY_DIRECT_REDUCTION', isShop: true }] });
      } else {
        use.shopEffectFailed = true;
        event(room, 'SHOP_EFFECT_FAILED', { participantId: use.player.participantId, itemId: use.shopItem.id, reason: 'PROTECTED_PLAYER_REQUIRED' });
      }
    }
    if (use.shopItem?.effectType === 'FIRST_DIRECT_REDUCTION') {
      engineAddDefense(defenses, use.player.participantId, { use, shopItemId: use.shopItem.id, kind: 'firstDirect', remaining: 2, contributions: [{ source: use.player, amount: 2, reason: 'SHOP_FIRST_DIRECT_REDUCTION', isShop: true }] });
    }
  }
  for (const entries of defenses.values()) entries.sort((a, b) => a.use.player.playerNumber - b.use.player.playerNumber);
  return defenses;
}
function engineReserveState(room, usages) {
  const healReduction = new Map();
  for (const use of usages) {
    if (!use.invalidated && use.effect.kind === 'carryState' && !use.carryInvalidated) engineAddCarry(room, playerById(room, use.targetId), use.effect.state, use.player, use.card.id);
    if (!use.invalidated && use.effect.kind === 'cooldownExtension') {
      const targetUse = usages.find(item => item.player.participantId === use.targetId);
      if (!targetUse) { use.outcome = 'FIZZLED'; continue; }
      if (targetUse.shopItem?.effectType === 'PREVENT_EXTENSION') {
        event(room, 'SHOP_EFFECT_APPLIED', { participantId: targetUse.player.participantId, itemId: targetUse.shopItem.id, effect: 'COOLDOWN_EXTENSION_PREVENTED', cardId: targetUse.card.id });
        continue;
      }
      const mark = targetUse.player.cardMarks[targetUse.card.id] || {};
      const until = room.globalTurnIndex + use.effect.turns;
      targetUse.player.cardMarks[targetUse.card.id] = { ...mark, cooldownExtensionUntil: Math.max(mark.cooldownExtensionUntil || 0, until) };
      event(room, 'COOLDOWN_EXTENSION_APPLIED', { sourceId: use.player.participantId, targetId: targetUse.player.participantId, cardId: targetUse.card.id, until });
    }
    if (!use.invalidated && use.effect.kind === 'healReduction') healReduction.set(use.targetId, (healReduction.get(use.targetId) || 0) + use.effect.reduction);
    if (!use.invalidated && ['defenseAndRemoveState', 'healAndRemoveState'].includes(use.effect.kind)) engineRemoveCarry(room, use);
    if (use.shopItem?.effectType === 'GREEDY_TICKET') {
      const targetCard = CARD_BY_ID[use.shopCardTargetId];
      if (!targetCard) {
        use.shopEffectFailed = true;
        event(room, 'SHOP_EFFECT_FAILED', { participantId: use.player.participantId, itemId: use.shopItem.id, reason: 'CARD_TARGET_REQUIRED' });
      } else {
        use.player.cardMarks[targetCard.id] = { ...(use.player.cardMarks[targetCard.id] || {}), greedyTicketPending: true };
        event(room, 'SHOP_EFFECT_APPLIED', { participantId: use.player.participantId, itemId: use.shopItem.id, effect: 'GREEDY_TICKET_RESERVED', cardId: targetCard.id }, `private:${use.player.participantId}`);
      }
    }
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
    const cardId = defense.shopItemId || defense.use.card.id;
    attack.defenseSources.push({ source: contribution.source, amount: applied, cardId, reason: contribution.reason || 'DEFENSE', isShop: Boolean(contribution.isShop) });
    event(room, 'DEFENSE_ALLOCATED', { sourceId: contribution.source.participantId, targetId: target.participantId, cardId, amount: applied, reason: contribution.reason || 'DEFENSE' });
    if (!remaining) break;
  }
  defense.remaining -= amount;
}
function engineApplyFirstDirectReduction(room, defenses, target, attack) {
  const entries = defenses.get(target.participantId) || [];
  const defense = entries.find(item => item.kind === 'firstDirect' && item.remaining > 0);
  if (!defense) return;
  let remaining = defense.remaining;
  for (const component of attack.components) {
    const prevented = Math.min(component.amount, remaining);
    if (!prevented) continue;
    engineSpendDefense(room, defense, prevented, target, attack);
    component.amount -= prevented;
    attack.prevented += prevented;
    remaining -= prevented;
    if (!remaining) break;
  }
  event(room, 'SHOP_EFFECT_APPLIED', { participantId: defense.use.player.participantId, itemId: defense.shopItemId, effect: 'FIRST_DIRECT_REDUCTION', amount: 2 - defense.remaining });
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
function engineResolveAttackEvents(room, attacks, defenses) {
  for (const attack of [...attacks].sort((a, b) => a.player.playerNumber - b.player.playerNumber)) {
    const target = playerById(room, attack.targetId);
    if (attack.completeDefense) {
      event(room, 'COMPLETE_DEFENSE', { defenderId: attack.completeDefense.use.player.participantId, targetId: target.participantId, cardId: attack.use.card.id, phase: attack.phase });
      continue;
    }
    engineApplyFirstDirectReduction(room, defenses, target, attack);
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
      // SHOP単体による軽減は七獄カードの支援点・駅スコアへ混ぜず、SHOP成果として個別に記録する。
      if (credited && defenseSource.source !== target && !defenseSource.isShop) engineSupport(room, defenseSource.source, credited, { targetId: target.participantId, cardId: defenseSource.cardId, reason: defenseSource.reason });
      if (credited) event(room, 'DEFENSE_APPLIED', { sourceId: defenseSource.source.participantId, targetId: target.participantId, cardId: defenseSource.cardId, amount: credited, reason: defenseSource.reason });
      if (credited && defenseSource.isShop) event(room, 'SHOP_EFFECT_APPLIED', { participantId: defenseSource.source.participantId, itemId: defenseSource.cardId, effect: defenseSource.reason, targetId: target.participantId, prevented: credited });
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
function engineReaction(room, source, target, amount, cardId, kind, modifiers, usages) {
  const shopUse = usages.find(use => use.player === target && (use.shopItem?.effectType === 'FIRST_REACTION_ZERO' || use.shopItem?.effectType === 'REACTION_REDUCTION'));
  let prevented = 0;
  if (shopUse?.shopItem?.effectType === 'FIRST_REACTION_ZERO' && !shopUse.shopReactionUsed) {
    shopUse.shopReactionUsed = true;
    prevented = Math.max(0, amount + modifiers.reactionBonus);
    event(room, 'SHOP_EFFECT_APPLIED', { participantId: target.participantId, itemId: shopUse.shopItem.id, effect: 'FIRST_REACTION_ZERO', prevented });
  } else if (shopUse?.shopItem?.effectType === 'REACTION_REDUCTION') {
    shopUse.shopReactionRemaining ??= 2;
    prevented = Math.min(shopUse.shopReactionRemaining, Math.max(0, amount + modifiers.reactionBonus));
    shopUse.shopReactionRemaining -= prevented;
    if (prevented) event(room, 'SHOP_EFFECT_APPLIED', { participantId: target.participantId, itemId: shopUse.shopItem.id, effect: 'REACTION_REDUCTION', prevented });
  }
  const before = target.hp;
  target.hp = Math.max(0, target.hp - Math.max(0, amount + modifiers.reactionBonus - prevented));
  const actual = before - target.hp;
  recordDamage(source, target, actual);
  engineMarkZero(room, target, before);
  event(room, 'REACTION_DAMAGE', { sourceId: source.participantId, targetId: target.participantId, cardId, kind, amount: actual, prevented });
}
function engineReactions(room, usages, attacks, modifiers) {
  for (const attack of attacks.filter(item => item.completeDefense?.kind === 'reversal' && item.reversalValue > 0)) engineReaction(room, attack.completeDefense.use.player, attack.player, attack.reversalValue, 'reversal', 'REVERSAL', modifiers, usages);
  for (const use of usages.filter(item => item.effect.kind === 'bloodShield' && !item.invalidated)) {
    const hits = attacks.filter(attack => attack.targetId === use.targetId && attack.actual > 0);
    if (!hits.length) continue;
    const attacker = [...hits].sort((a, b) => b.actual - a.actual || a.player.playerNumber - b.player.playerNumber)[0].player;
    engineReaction(room, use.player, attacker, use.effect.reflection, use.card.id, 'BLOOD_SHIELD', modifiers, usages);
  }
  for (const use of usages.filter(item => item.effect.kind === 'counterStance' && !item.invalidated)) {
    if (attacks.some(attack => attack.player.participantId === use.targetId && attack.targetId === use.player.participantId && attack.actual > 0)) engineReaction(room, use.player, playerById(room, use.targetId), use.effect.damage, use.card.id, 'COUNTER_STANCE', modifiers, usages);
  }
}
function engineHeal(room, source, targetId, amount, cardId, healReduction, modifiers, kind = 'HEAL', support = true, metadata = {}) {
  const target = playerById(room, targetId);
  const boosted = amount + (kind === 'ABSORB' ? modifiers.absorbBonus : modifiers.healBonus);
  const reduced = Math.min(boosted, healReduction.get(targetId) || 0);
  if (reduced) healReduction.set(targetId, (healReduction.get(targetId) || 0) - reduced);
  const before = target.hp;
  target.hp = Math.min(15, target.hp + boosted - reduced);
  const actual = target.hp - before;
  const withoutShopActual = metadata.shopBonusAmount
    ? Math.max(0, Math.min(15, before + Math.max(0, boosted - metadata.shopBonusAmount - reduced)) - before)
    : 0;
  const shopRecoveryAmount = metadata.shopItemId ? (metadata.shopBonusAmount ? Math.max(0, actual - withoutShopActual) : actual) : 0;
  if (support && source !== target) engineSupport(room, source, actual, { targetId, cardId, reason: 'HEAL' });
  event(room, 'HEAL', { sourceId: source.participantId, targetId, cardId, kind, amount: actual, reduced, ...metadata, shopRecoveryAmount });
}
function engineRecovery(room, usages, attacks, snapshot, healReduction, modifiers) {
  for (const use of usages.filter(item => !item.invalidated)) {
    const kind = use.copied?.kind || use.effect.kind;
    let amount = use.copied?.kind === 'heal' ? use.copied.value : use.effect.amount || 0;
    if (use.effect.condition === 'targetHpZero' && snapshot[use.targetId] === 0) amount += use.effect.conditionHeal || 0;
    if (kind === 'heal' && use.shopItem?.effectType === 'ALLY_HEAL_BONUS' && use.targetId !== use.player.participantId) amount += 1;
    if (kind === 'heal' && amount) engineHeal(room, use.player, use.targetId, amount, use.card.id, healReduction, modifiers, 'HEAL', true, use.shopItem?.effectType === 'ALLY_HEAL_BONUS' ? { shopItemId: use.shopItem.id, shopBonusAmount: 1 } : {});
    if (use.effect.absorb) {
      const attack = attacks.find(item => item.use === use);
      const allowed = use.effect.condition !== 'targetHpGreaterThanOwner' || snapshot[use.targetId] > snapshot[use.player.participantId];
      if (attack?.actual > 0 && allowed) engineHeal(room, use.player, use.player.participantId, use.effect.absorb, use.card.id, healReduction, modifiers, 'ABSORB', false);
    }
  }
}
function engineShopPostEffects(room, usages, attacks, healReduction, modifiers) {
  for (const use of usages.filter(item => item.shopItem)) {
    const item = use.shopItem;
    const owner = use.player;
    if (item.effectType === 'SECRET_TARGET_NOTICE') {
      const recipient = playerById(room, use.shopTargetId);
      if (recipient && use.card.category === 'attack' && use.targetId) {
        event(room, 'SHOP_SECRET_TARGET_NOTIFIED', { sourceId: owner.participantId, recipientId: recipient.participantId, itemId: item.id, targetId: use.targetId }, `private:${recipient.participantId}`);
      } else {
        use.shopEffectFailed = true;
        event(room, 'SHOP_EFFECT_FAILED', { participantId: owner.participantId, itemId: item.id, reason: 'NO_ATTACK_TARGET' });
      }
    }
    if (item.effectType === 'GRUDGE') {
      const target = playerById(room, use.shopTargetId);
      const triggered = attacks.some(attack => attack.targetId === owner.participantId && attack.components.some(component => component.source.participantId === target?.participantId && component.actual > 0));
      if (target && triggered) {
        const before = target.hp;
        target.hp = Math.max(0, target.hp - 1);
        recordDamage(owner, target, before - target.hp);
        engineMarkZero(room, target, before);
        event(room, 'SHOP_EFFECT_APPLIED', { participantId: owner.participantId, itemId: item.id, effect: 'GRUDGE_TRIGGERED', targetId: target.participantId, amount: before - target.hp });
        event(room, 'SHOP_DAMAGE', { sourceId: owner.participantId, targetId: target.participantId, itemId: item.id, amount: before - target.hp, reason: 'GRUDGE' });
      } else {
        use.shopEffectFailed = true;
        event(room, 'SHOP_EFFECT_FAILED', { participantId: owner.participantId, itemId: item.id, reason: 'GRUDGE_NOT_TRIGGERED' });
      }
    }
    if (item.effectType === 'POST_HEAL') {
      engineHeal(room, owner, owner.participantId, 1, item.id, healReduction, modifiers, 'SHOP_HEAL', false, { shopItemId: item.id });
      event(room, 'SHOP_EFFECT_APPLIED', { participantId: owner.participantId, itemId: item.id, effect: 'POST_HEAL' });
    }
    if (item.effectType === 'FIZZLE_HEAL') {
      if (use.outcome === 'FIZZLED' || use.attackInvalidated || use.invalidated) {
        engineHeal(room, owner, owner.participantId, 1, item.id, healReduction, modifiers, 'SHOP_HEAL', false, { shopItemId: item.id });
        event(room, 'SHOP_EFFECT_APPLIED', { participantId: owner.participantId, itemId: item.id, effect: 'FIZZLE_HEAL' });
      } else {
        use.shopEffectFailed = true;
        event(room, 'SHOP_EFFECT_FAILED', { participantId: owner.participantId, itemId: item.id, reason: 'CARD_EFFECT_RESOLVED' });
      }
    }
    if (item.effectType === 'DIRECT_DAMAGE_THRESHOLD_HEAL') {
      const total = attacks.filter(attack => attack.targetId === owner.participantId && attack.player !== owner).reduce((sum, attack) => sum + attack.actual, 0);
      if (total >= 2) {
        engineHeal(room, owner, owner.participantId, 2, item.id, healReduction, modifiers, 'SHOP_HEAL', false, { shopItemId: item.id });
        event(room, 'SHOP_EFFECT_APPLIED', { participantId: owner.participantId, itemId: item.id, effect: 'DIRECT_DAMAGE_THRESHOLD_HEAL', damageTaken: total });
      } else {
        use.shopEffectFailed = true;
        event(room, 'SHOP_EFFECT_FAILED', { participantId: owner.participantId, itemId: item.id, reason: 'DIRECT_DAMAGE_BELOW_TWO', damageTaken: total });
      }
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
    const normalCooldownStartsAt = use.skipNormalCooldown ? null : room.globalTurnIndex + 1;
    const history = { id: id(), participantId: use.player.participantId, cardId: use.card.id, stationId: currentStation(room).id, stationIndex: room.stationIndex, stationTurn: room.stationTurn, globalTurnIndex: room.globalTurnIndex, result: use.outcome, finalTarget: use.targetId, normalCooldownStartsAt, cooldownExtensionUntil: updatedMark.cooldownExtensionUntil || null, ctBypass: use.ctBypass || null };
    use.player.cardUsage.push(history);
    event(room, 'CARD_USAGE_RECORDED', history, `private:${use.player.participantId}`);
    if (normalCooldownStartsAt) event(room, 'COOLDOWN_STARTED', { participantId: use.player.participantId, cardId: use.card.id, unavailableTurn: normalCooldownStartsAt }, `private:${use.player.participantId}`);
    else event(room, 'COOLDOWN_SKIPPED', { participantId: use.player.participantId, cardId: use.card.id, reason: 'INFINITE_SLIP' }, `private:${use.player.participantId}`);
  }
}
function resolveTurn(room) {
  const snapshot = Object.fromEntries(room.players.map(player => [player.participantId, player.hp]));
  const modifiers = engineModifiers(room);
  const usages = room.players.map(player => {
    const card = CARD_BY_ID[player.selection.cardId];
    const shop = selectedShopEntry(room, player, player.selection);
    return { player, card, effect: card.effect, ...player.selection, shopEntry: shop?.entry || null, shopItem: shop?.item || null, invalidated: false, attackInvalidated: false, outcome: 'RESOLVED', basicActual: 0 };
  });
  event(room, 'CARDS_REVEALED', { usages: usages.map(publicUsage), stationEffects: modifiers.effectIds });
  engineStartShopUses(room, usages);
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
  engineResolveAttackEvents(room, basicAttacks, defenses);
  event(room, 'ENGINE_PHASE', { step: 14, name: 'CONDITIONAL_ADDITIONAL_ATTACKS' });
  const additionalAttacks = engineAdditionalAttacks(room, basicAttacks, modifiers, focusCounts);
  event(room, 'ENGINE_PHASE', { step: 16, name: 'REMAINING_DEFENSE_ON_ADDITIONALS' });
  engineAssignCompleteDefenses(room, defenses, additionalAttacks, 'additional');
  engineAllocateReduction(room, defenses, additionalAttacks, 'additional');
  event(room, 'ENGINE_PHASE', { step: 17, name: 'ADDITIONAL_DAMAGE_EVENTS' });
  engineResolveAttackEvents(room, additionalAttacks, defenses);
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
  engineShopPostEffects(room, usages, attacks, healReduction, modifiers);
  room.revealedUsages = usages.map(use => ({ ...publicUsage(use), invalidated: use.invalidated || use.attackInvalidated, result: use.outcome }));
  room.phase = PHASE.TURN_RESULT;
  event(room, 'TURN_RESOLVED', { stationTurn: room.stationTurn, globalTurnIndex: room.globalTurnIndex, stationEffects: modifiers.effectIds });
}

function finishStation(room) {
  const station = STATIONS[room.stationIndex];
  const rewardFlow = station.rewardFlow || {};
  const noCurrencyRewards = Boolean(rewardFlow.noCurrencyRewards);
  const eligible = room.players.filter(player => !player.stationStats.reachedZero);
  const sorted = [...eligible].sort((a, b) => b.stationStats.stationScore - a.stationStats.stationScore || b.hp - a.hp || b.stationStats.damageDealt - a.stationStats.damageDealt || b.stationStats.support - a.stationStats.support || a.stationStats.damageTaken - b.stationStats.damageTaken);
  const rewardByRank = { 1: 3, 2: 2, 3: 2, 4: 1, 5: 1 };
  let previous = null;
  const rankings = noCurrencyRewards ? [] : sorted.map((player, index) => {
    const signature = [player.stationStats.stationScore, player.hp, player.stationStats.damageDealt, player.stationStats.support, player.stationStats.damageTaken].join(':');
    const rank = previous?.signature === signature ? previous.rank : index + 1;
    const reward = rewardByRank[rank] || 0;
    awardStationCurrency(room, player, 'RANK_REWARD', '順位報酬', reward);
    previous = { signature, rank };
    return { participantId: player.participantId, playerNumber: player.playerNumber, rank, reward, stationScore: player.stationStats.stationScore, hp: player.hp };
  });
  const supportConfig = rewardFlow.supportAward;
  const supportCandidates = supportConfig ? room.players.filter(player => player.stationStats.support >= supportConfig.minimum) : [];
  const maxSupport = supportCandidates.length ? Math.max(...supportCandidates.map(player => player.stationStats.support)) : 0;
  const supportAwardees = supportCandidates.filter(player => player.stationStats.support === maxSupport);
  if (!noCurrencyRewards) for (const player of supportAwardees) awardStationCurrency(room, player, 'SUPPORT_AWARD', '支援賞', supportConfig.amount);

  const specialConfig = rewardFlow.specialBonus;
  const specialAwardees = specialConfig ? room.players.filter(player => !player.stationStats.reachedZero && stationSpecialSatisfied(room, player, specialConfig)) : [];
  if (!noCurrencyRewards) for (const player of specialAwardees) awardStationCurrency(room, player, 'SPECIAL_BONUS', '特殊ボーナス', specialConfig.amount);

  const rankById = new Map(rankings.map(entry => [entry.participantId, entry]));
  const rewardSummary = room.players.map(player => {
    const rank = rankById.get(player.participantId);
    const rankReward = rank?.reward || 0;
    const supportAward = !noCurrencyRewards && supportAwardees.includes(player) ? supportConfig?.amount || 0 : 0;
    const specialBonus = !noCurrencyRewards && specialAwardees.includes(player) ? specialConfig?.amount || 0 : 0;
    return { participantId: player.participantId, playerNumber: player.playerNumber, rank: rank?.rank || null, rankReward, supportAward, specialBonus, totalOne: rankReward + supportAward + specialBonus };
  });
  room.stationResult = {
    stationId: station.id,
    noCurrencyRewards,
    rankings,
    excludedPlayerNumbers: room.players.filter(player => player.stationStats.reachedZero).map(player => player.playerNumber),
    supportAward: supportConfig ? { minimum: supportConfig.minimum, amount: noCurrencyRewards ? 0 : supportConfig.amount, winnerIds: supportAwardees.map(player => player.participantId) } : null,
    specialBonus: specialConfig ? { id: specialConfig.id, condition: specialConfig.condition, amount: noCurrencyRewards ? 0 : specialConfig.amount, winnerIds: specialAwardees.map(player => player.participantId) } : null,
    rewardSummary
  };
  room.stationResults.push(room.stationResult);
  room.phase = PHASE.STATION_RESULT;
  room.timer = null;
  event(room, 'STATION_RESULT_CONFIRMED', { stationId: room.stationResult.stationId, rankings });
}

const CURRENCY_LABELS = { one: '壱', two: '弐', three: '参', five: '伍', seven: '漆' };

function stationSpecialSatisfied(room, player, special) {
  if (special.evaluator === 'DAMAGE_DEALT_AT_LEAST') return player.stationStats.damageDealt >= special.minimum;
  if (special.evaluator === 'THIRD_CARD_EFFECT') {
    return player.cardUsage.some(usage => {
      if (usage.stationId !== STATIONS[room.stationIndex].id || usage.result !== 'RESOLVED') return false;
      return player.cardUsage.filter(item => item.cardId === usage.cardId && item.globalTurnIndex <= usage.globalTurnIndex).length === 3;
    });
  }
  return false;
}

function awardStationCurrency(room, player, type, label, amount) {
  if (!amount) return;
  player.currency.one += amount;
  room.currencyTransactions.push({ id: id(), type, label, participantId: player.participantId, stationId: STATIONS[room.stationIndex].id, currency: 'one', amount, cocofoliaApplied: false, createdAt: now() });
}

function stationRewardNarration(room) {
  const station = STATIONS[room.stationIndex];
  const result = room.stationResult;
  const playerName = participantId => {
    const player = room.players.find(item => item.participantId === participantId);
    return player ? `PL${player.playerNumber} ${player.name}` : '該当者なし';
  };
  const rankingLines = result.rankings.length ? result.rankings.map(entry => `${entry.rank}位：${playerName(entry.participantId)}`) : ['順位対象者はいません。'];
  const rankRewardLines = result.rewardSummary.filter(entry => entry.rankReward > 0).map(entry => `${playerName(entry.participantId)}：壱×${entry.rankReward}`);
  const supportWinners = result.supportAward?.winnerIds || [];
  const specialWinners = result.specialBonus?.winnerIds || [];
  if (result.noCurrencyRewards) {
    const supportLines = supportWinners.length ? supportWinners.map(participantId => {
      const player = room.players.find(item => item.participantId === participantId);
      return `${playerName(participantId)}：支援点${player?.stationStats.support || 0}`;
    }) : ['支援条件の達成者はいません。'];
    return {
      title: `${station.name} 結果発表`,
      lines: [
        `「${station.name}、これにて終了で〜す！」`,
        '「無間地獄では、駅順位と順位報酬はありません。」',
        '「ではでは、支援結果の発表で〜す！」',
        ...supportLines,
        '「今回の隠し特殊条件を公開しま〜す！」',
        result.specialBonus ? `「${result.specialBonus.condition}」` : '「今回の駅の特殊条件は設定されていません。」',
        ...(specialWinners.length ? specialWinners.map(playerName).map(name => `${name}：達成`) : ['特殊条件の達成者はいません。']),
        '「無間地獄では、新しい冥貨は配布されません。」',
        '「それでは、ゲーム全体の最終順位を発表しま〜す！」'
      ]
    };
  }
  return {
    title: `${station.name} 報酬発表`,
    lines: [
      `「${station.name}、これにて終了で〜す！」`,
      '「ではでは、駅順位の発表で〜す！」',
      ...rankingLines,
      '「続いて、順位報酬で〜す！」',
      ...(rankRewardLines.length ? rankRewardLines : ['順位報酬の獲得者はいません。']),
      '「支援賞の発表で〜す！」',
      ...(supportWinners.length ? supportWinners.map(playerName).map(name => `${name}：壱×${result.supportAward.amount}`) : ['支援賞の獲得者はいません。']),
      '「今回の隠し特殊条件を公開しま〜す！」',
      result.specialBonus ? `「${result.specialBonus.condition}」` : '「今回の駅の特殊条件は設定されていません。」',
      ...(result.specialBonus ? (specialWinners.length ? specialWinners.map(playerName).map(name => `${name}：壱×${result.specialBonus.amount}`) : ['特殊ボーナスの達成者はいません。']) : []),
      '「最後に、今回の獲得冥貨で〜す！」',
      ...result.rewardSummary.map(entry => `${playerName(entry.participantId)}：壱×${entry.totalOne}`)
    ]
  };
}

function freeTimeNarration(room) {
  const station = STATIONS[room.stationIndex];
  return {
    title: `${station.name} 自由時間`,
    lines: station.rewardFlow?.freeTimeLines || ['「冥貨もちゃんと配り終わりましたねぇ！」', '「それでは、5分間の自由時間で〜す！」']
  };
}

function advanceRewardNarration(room) {
  if (room.phase !== PHASE.REWARD_NARRATION) throw new Error('報酬発表中ではありません');
  const narration = stationRewardNarration(room);
  if (room.rewardNarrationStep < narration.lines.length) {
    room.rewardNarrationStep += 1;
    event(room, 'STATION_REWARD_NARRATION_ADVANCED', { stationId: STATIONS[room.stationIndex].id, step: room.rewardNarrationStep }, 'gm');
    return;
  }
  room.rewardNarrationStep = 0;
  room.timer = null;
  if (room.stationResult?.noCurrencyRewards) {
    room.finalRanking = calculateFinalRanking(room);
    room.phase = PHASE.FINAL_RANKING;
    event(room, 'FINAL_RANKING_READY', { stationId: STATIONS[room.stationIndex].id, rankings: room.finalRanking });
    return;
  }
  room.phase = PHASE.CURRENCY_SYNC_WAIT;
  event(room, 'CURRENCY_SYNC_WAIT_STARTED', { stationId: STATIONS[room.stationIndex].id });
}

function calculateFinalRanking(room) {
  const sorted = [...room.players].sort((a, b) => b.hp - a.hp || b.totalStats.damageDealt - a.totalStats.damageDealt || b.totalStats.support - a.totalStats.support || a.totalStats.damageTaken - b.totalStats.damageTaken || a.playerNumber - b.playerNumber);
  let previous = null;
  return sorted.map((player, index) => {
    const signature = [player.hp, player.totalStats.damageDealt, player.totalStats.support, player.totalStats.damageTaken].join(':');
    const rank = previous?.signature === signature ? previous.rank : index + 1;
    previous = { signature, rank };
    return { participantId: player.participantId, playerNumber: player.playerNumber, rank, hp: player.hp, totalDamageDealt: player.totalStats.damageDealt, totalSupport: player.totalStats.support, totalDamageTaken: player.totalStats.damageTaken };
  });
}

function pendingStationCurrencyTransactions(room) {
  const stationId = STATIONS[room.stationIndex]?.id;
  return room.currencyTransactions.filter(transaction => transaction.stationId === stationId && !transaction.cocofoliaApplied);
}

function markCurrencyTransactionApplied(room, transactionId) {
  if (room.phase !== PHASE.CURRENCY_SYNC_WAIT) throw new Error('駅報酬の反映待機中ではありません');
  const transaction = room.currencyTransactions.find(item => item.id === transactionId && item.stationId === STATIONS[room.stationIndex]?.id);
  if (!transaction) throw new Error('今回の駅報酬が見つかりません');
  transaction.cocofoliaApplied = true;
  transaction.cocofoliaAppliedAt = now();
  event(room, 'STATION_REWARD_COCOFOLIA_APPLIED', { transactionId: transaction.id, stationId: transaction.stationId }, 'gm');
}

function markPlayerStationRewardsApplied(room, participantId) {
  if (room.phase !== PHASE.CURRENCY_SYNC_WAIT) throw new Error('駅報酬の反映待機中ではありません');
  const transactions = room.currencyTransactions.filter(item => item.stationId === STATIONS[room.stationIndex]?.id && item.participantId === participantId);
  if (!transactions.length) throw new Error('このPLに今回の報酬はありません');
  for (const transaction of transactions) {
    transaction.cocofoliaApplied = true;
    transaction.cocofoliaAppliedAt = now();
  }
  event(room, 'PLAYER_STATION_REWARDS_COCOFOLIA_APPLIED', { participantId, stationId: STATIONS[room.stationIndex].id, transactionCount: transactions.length }, 'gm');
}

function startFreeTimeIntroduction(room) {
  if (room.phase !== PHASE.CURRENCY_SYNC_WAIT || room.stationIndex >= STATIONS.length - 1) throw new Error('自由時間を開始できる報酬反映待機ではありません');
  const pending = pendingStationCurrencyTransactions(room);
  if (pending.length) throw new Error(`ココフォリア未反映の駅報酬が${pending.length}件あります`);
  room.phase = PHASE.FREE_TIME_INTRO;
  room.freeTimeIntroductionStep = 1;
  room.timer = null;
  event(room, 'FREE_TIME_INTRODUCTION_STARTED', { stationId: STATIONS[room.stationIndex].id });
}

function advanceFreeTimeIntroduction(room) {
  if (room.phase !== PHASE.FREE_TIME_INTRO) throw new Error('自由時間の案内中ではありません');
  const narration = freeTimeNarration(room);
  if (room.freeTimeIntroductionStep < narration.lines.length) {
    room.freeTimeIntroductionStep += 1;
    event(room, 'FREE_TIME_INTRODUCTION_ADVANCED', { stationId: STATIONS[room.stationIndex].id, step: room.freeTimeIntroductionStep }, 'gm');
    return;
  }
  room.phase = PHASE.FREE_TIME;
  room.freeTimeIntroductionStep = 0;
  room.timer = { startedAt: Date.now(), endsAt: Date.now() + 300_000 };
  room.players.forEach(player => { player.freeTimeReady = false; player.confirmed = false; });
  event(room, 'FREE_TIME_STARTED', { stationId: STATIONS[room.stationIndex].id, seconds: 300 });
}

const CURRENCY_VALUES = Object.freeze({ one: 1, two: 2, three: 3, five: 5, seven: 7 });
const CHANGE_ORDER = Object.freeze(['seven', 'five', 'three', 'two', 'one']);

function normalizeShopPayment(payment) {
  if (!payment || typeof payment !== 'object' || Array.isArray(payment)) throw new Error('投入する冥貨と枚数を指定してください');
  return Object.fromEntries(Object.keys(CURRENCY_VALUES).map(type => {
    const amount = Number(payment[type] || 0);
    if (!Number.isInteger(amount) || amount < 0) throw new Error('投入枚数は0枚以上の整数で指定してください');
    return [type, amount];
  }));
}

function currencyValue(coins) {
  return Object.entries(CURRENCY_VALUES).reduce((total, [type, value]) => total + (coins[type] || 0) * value, 0);
}

function currencyLabel(coins) {
  return Object.keys(CURRENCY_VALUES).filter(type => coins[type]).map(type => `${CURRENCY_LABELS[type]}×${coins[type]}`).join('、') || 'なし';
}

function makeChange(value) {
  const coins = Object.fromEntries(Object.keys(CURRENCY_VALUES).map(type => [type, 0]));
  let remaining = value;
  for (const type of CHANGE_ORDER) {
    coins[type] = Math.floor(remaining / CURRENCY_VALUES[type]);
    remaining %= CURRENCY_VALUES[type];
  }
  return { coins, total: value, label: currencyLabel(coins) };
}

function purchaseShopItem(room, player, itemId, requestedPayment) {
  if (room.phase !== PHASE.FREE_TIME || !STATIONS[room.stationIndex]) throw new Error('この自由時間ではショップを利用できません');
  if (!room.timer || Date.now() >= room.timer.endsAt) throw new Error('ショップ購入受付は終了しました');
  const item = SHOP_ITEM_BY_ID[itemId];
  if (!item || !unlockedShopItems(room).some(candidate => candidate.id === item.id)) throw new Error('まだ解禁されていないショップ商品です');
  if ((room.shopStock[item.id] || 0) < 1) throw new Error('他のプレイヤーが先に購入しました');
  const payment = normalizeShopPayment(requestedPayment);
  const paymentTotal = currencyValue(payment);
  if (paymentTotal < item.price) throw new Error(`投入額があと${item.price - paymentTotal}不足しています`);
  if (paymentTotal > item.price + 7) throw new Error(`投入額は商品価格より7まで多くできます（現在${paymentTotal}）`);
  for (const type of Object.keys(CURRENCY_VALUES)) {
    if (payment[type] > player.currency[type]) throw new Error(`${CURRENCY_LABELS[type]}の冥貨があと${payment[type] - player.currency[type]}枚必要です`);
  }
  const change = makeChange(paymentTotal - item.price);
  const transactionId = id();
  const isPrimeChange = ['two', 'three', 'five', 'seven'].some(type => change.coins[type] > 0);
  const isFirstPurchase = isPrimeChange && !room.firstPurchaseCompleted;
  for (const type of Object.keys(CURRENCY_VALUES)) player.currency[type] -= payment[type];
  for (const type of Object.keys(CURRENCY_VALUES)) player.currency[type] += change.coins[type];
  player.shopInventory.push({ inventoryId: id(), itemId: item.id, transactionId, ownerPlayerId: player.participantId, purchased: true, lastUsedGlobalTurnIndex: null, cooldownUntilGlobalTurnIndex: null, totalUseCount: 0, acquiredAt: now() });
  room.shopStock[item.id] -= 1;
  const transaction = { id: transactionId, participantId: player.participantId, playerNumber: player.playerNumber, itemId: item.id, payment, paymentTotal, change, currencyCocofoliaApplied: false, createdAt: now() };
  room.purchaseTransactions.push(transaction);
  if (isPrimeChange) room.firstPurchaseCompleted = true;
  player.purchaseNotice = { transactionId, itemId: item.id, firstPurchase: isFirstPurchase };
  event(room, 'SHOP_PURCHASE_COMPLETED', { transactionId, itemId: item.id, payment, change }, `private:${player.participantId}`);
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
  room.rewardNarrationStep = 0;
  room.freeTimeIntroductionStep = 0;
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
  const currentStation = STATIONS[room.stationIndex];
  const definition = SHOP_BY_STATION_ID[currentStation?.id];
  const items = unlockedShopItems(room);
  return {
    id: definition?.id,
    name: definition ? `${definition.name}を解禁` : 'ショップ',
    currentShopId: definition?.id,
    items: items.map(item => ({ ...item, soldOut: (room.shopStock[item.id] || 0) < 1, shopName: SHOP_BY_STATION_ID[item.unlockAfterStation]?.name, isNew: item.unlockAfterStation === currentStation?.id }))
  };
}

function unlockedShopItems(room) {
  const currentStationIndex = room.stationIndex;
  return SHOP_ITEMS.filter(item => {
    const unlockStationIndex = STATIONS.findIndex(station => station.id === item.unlockAfterStation);
    return unlockStationIndex >= 0 && unlockStationIndex <= currentStationIndex;
  });
}

function nextTurn(room) {
  if (room.phase !== PHASE.TURN_RESULT) throw new Error('ターン結果確認中ではありません');
  const station = STATIONS[room.stationIndex];
  if (room.stationTurn >= station.turnCount) {
    return finishStation(room);
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
  const stationCurrencyTransactions = room.currencyTransactions.filter(transaction => transaction.stationId === STATIONS[room.stationIndex]?.id).map(transaction => ({
    ...transaction,
    playerNumber: room.players.find(player => player.participantId === transaction.participantId)?.playerNumber,
    playerName: room.players.find(player => player.participantId === transaction.participantId)?.name,
    currencyLabel: CURRENCY_LABELS[transaction.currency]
  }));
  const rewardNarration = room.phase === PHASE.REWARD_NARRATION ? { ...stationRewardNarration(room), step: room.rewardNarrationStep } : null;
  const freeTimeIntroduction = room.phase === PHASE.FREE_TIME_INTRO ? { ...freeTimeNarration(room), step: room.freeTimeIntroductionStep } : null;
  return {
    code: room.code, testMode: Boolean(room.testMode), phase: room.phase, station: room.stationIndex >= 0 ? STATIONS[room.stationIndex] : null,
    stationTurn: room.stationTurn, globalTurnIndex: room.globalTurnIndex, timer: room.timer, introductionStep: room.introductionStep || 0, activeStationEffectIds: activeStationEffectIds(room),
    gameGuide: room.phase === PHASE.GAME_GUIDE ? { title: GAME_GUIDE.title, lines: GAME_GUIDE.lines, step: room.gameGuideStep } : null,
    stationIntroduction: stationIntroduction ? { title: stationIntroduction.title, lines: stationIntroduction.lines, step: room.stationIntroductionStep } : null,
    rewardNarration,
    freeTimeIntroduction,
    me: actor.role === 'GM' ? { participantId: actor.participantId, role: 'GM', name: actor.name } : privatePlayer(actor, room),
    players: room.players.map(player => ({ participantId: player.participantId, playerNumber: player.playerNumber, name: player.name, hp: player.hp, isDeadState: player.isDeadState, packId: player.packId, confirmed: player.confirmed, selfIntroductionComplete: Boolean(player.selfIntroductionComplete), freeTimeReady: Boolean(player.freeTimeReady), ongoingEffects: player.ongoingEffects.map(({ sourceId, cardId, ...effect }) => effect), selection: isGm || player.participantId === actor.participantId ? player.selection : undefined })),
    packs: PACKS.map(pack => ({ ...pack, cards: isGm || actor.packId === pack.id ? CARDS.filter(card => card.packId === pack.id) : undefined })), stations: STATIONS,
    testPlayers: isGm ? room.players.map(player => ({ ...privatePlayer(player, room), selection: player.selection, confirmed: player.confirmed })) : undefined,
    stationResult: room.stationResult,
    finalRanking: room.finalRanking,
    finalEnding: room.finalEnding,
    currencySync: room.phase === PHASE.CURRENCY_SYNC_WAIT ? { total: stationCurrencyTransactions.length, pending: stationCurrencyTransactions.filter(transaction => !transaction.cocofoliaApplied).length } : null,
    stationCurrencyTransactions: isGm ? stationCurrencyTransactions : undefined,
    shop: shopForRoom(room),
    purchaseTransactions: isGm ? room.purchaseTransactions.map(transaction => ({ ...transaction, playerName: room.players.find(player => player.participantId === transaction.participantId)?.name, itemName: SHOP_ITEM_BY_ID[transaction.itemId]?.name })) : undefined,
    transferRequests: visibleTransfers,
    pendingCurrencyTransactions: isGm ? room.currencyTransactions.filter(transaction => !transaction.cocofoliaApplied) : undefined,
    revealedUsages: room.phase === PHASE.TURN_RESULT ? room.revealedUsages.map(use => { const card = CARDS.find(item => item.id === use.cardId); const shopItem = SHOP_ITEM_BY_ID[use.shopItemId]; return { ...use, cardName: card?.name, category: card?.category, description: card?.description, shopItemName: shopItem?.name || null, shopItemEffect: shopItem?.effect || null }; }) : [], events: publicEvents
  };
}

function privatePlayer(player, room) {
  const cards = CARDS.filter(card => card.packId === player.packId).map(card => {
    const status = cooldownStatus(room, player, card.id);
    const mark = player.cardMarks[card.id] || {};
    const shopKeyAvailable = player.shopInventory.some(entry => SHOP_ITEM_BY_ID[entry.itemId]?.effectType === 'NORMAL_CT_BYPASS' && !shopCooldownStatus(room, entry).code && !currentImmediateShopUse(room, player));
    const bypassOptions = status.code === 'NORMAL' ? [
      ...(mark.desireReuseAt === room.globalTurnIndex ? ['DESIRE'] : []),
      ...(mark.greedyTicketReuseAt === room.globalTurnIndex ? ['GREEDY_TICKET'] : []),
      ...(stationModifiers(room).normalCooldownReuse && !player.hungerReuseUsed ? ['HUNGER'] : []),
      ...(shopKeyAvailable ? ['HELL_KEY'] : [])
    ] : [];
    return { ...card, unavailableReason: status.code === 'EXTENSION' ? status.reason : card.id === 'encore' && !hasEncoreCandidate(room, player) ? '再演できる使用履歴がありません。' : status.code === 'NORMAL' && !bypassOptions.length ? status.reason : null, cooldownStatus: status.code, bypassOptions };
  });
  const encoreCandidates = player.cardUsage.filter(use => use.stationIndex <= room.stationIndex - 3 && ['attack', 'defense', 'heal'].includes(CARD_BY_ID[use.cardId]?.effect?.kind)).map(use => ({ id: use.id, cardId: use.cardId, cardName: CARD_BY_ID[use.cardId]?.name, kind: CARD_BY_ID[use.cardId]?.effect?.kind }));
  return { participantId: player.participantId, role: 'PL', playerNumber: player.playerNumber, name: player.name, hp: player.hp, packId: player.packId, cards, cardMarks: player.cardMarks, ongoingEffects: player.ongoingEffects, encoreCandidates, hungerReuseUsed: player.hungerReuseUsed, currency: player.currency, shopInventory: player.shopInventory.map(entry => ({ ...entry, item: SHOP_ITEM_BY_ID[entry.itemId], cooldownStatus: shopCooldownStatus(room, entry).code, unavailableReason: shopCooldownStatus(room, entry).reason })), immediateShopUse: currentImmediateShopUse(room, player), infoShopResults: player.infoShopResults.slice(-10), purchaseTransactions: room.purchaseTransactions.filter(transaction => transaction.participantId === player.participantId).map(transaction => ({ ...transaction, itemName: SHOP_ITEM_BY_ID[transaction.itemId]?.name })), purchaseNotice: player.purchaseNotice };
}

// バランス検証・シミュレーション専用の集計。PL向けAPIには含めない。
export function collectSimulationMetrics(room) {
  ensureRoomState(room);
  const events = room.events || [];
  const stationResults = room.stationResults || [];
  const sum = values => values.reduce((total, value) => total + Number(value || 0), 0);
  const coinValue = coins => Object.entries(CURRENCY_VALUES).reduce((total, [type, value]) => total + Number(coins?.[type] || 0) * value, 0);
  const metricsByPlayer = room.players.map(player => {
    const rankings = stationResults.map(result => result.rankings?.find(entry => entry.participantId === player.participantId)?.rank).filter(Number.isFinite);
    const zeroEvents = events.filter(event => event.type === 'HP_ZERO_REACHED' && event.payload?.participantId === player.participantId);
    const shopUsage = events.filter(event => event.type === 'SHOP_USED' && event.payload?.participantId === player.participantId).map(event => ({ itemId: event.payload.itemId, globalTurnIndex: event.payload.globalTurnIndex, useCount: event.payload.useCount, timing: event.payload.timing }));
    const purchases = room.purchaseTransactions.filter(transaction => transaction.participantId === player.participantId);
    const generatedChange = Object.fromEntries(Object.keys(CURRENCY_VALUES).map(type => [type, sum(purchases.map(transaction => transaction.change?.coins?.[type]))]));
    return {
      participantId: player.participantId,
      playerNumber: player.playerNumber,
      name: player.name,
      packId: player.packId,
      finalHp: player.hp,
      hpZeroCount: zeroEvents.length,
      deadStations: [...new Set(zeroEvents.map(event => event.payload?.stationId).filter(Boolean))],
      totalDamageDealt: player.totalStats.damageDealt,
      totalDamageTaken: player.totalStats.damageTaken,
      totalSupport: player.totalStats.support,
      stationRanks: rankings,
      averageStationRank: rankings.length ? sum(rankings) / rankings.length : null,
      specialConditionCount: stationResults.filter(result => result.specialBonus?.winnerIds?.includes(player.participantId)).length,
      sevenCardUsage: player.cardUsage.map(usage => ({ cardId: usage.cardId, stationId: usage.stationId, stationTurn: usage.stationTurn, globalTurnIndex: usage.globalTurnIndex, result: usage.result, finalTarget: usage.finalTarget })),
      shopUsage,
      currency: {
        earnedOne: sum(room.currencyTransactions.filter(transaction => transaction.participantId === player.participantId && transaction.currency === 'one').map(transaction => transaction.amount)),
        paymentValue: sum(purchases.map(transaction => transaction.paymentTotal ?? coinValue(transaction.payment))),
        changeGenerated: generatedChange,
        finalHoldings: { ...player.currency }
      }
    };
  });
  const shops = SHOP_ITEMS.map(item => {
    const itemEvents = events.filter(event => event.payload?.itemId === item.id);
    const reactionReduction = sum(itemEvents.filter(event => event.type === 'SHOP_EFFECT_APPLIED' && ['FIRST_REACTION_ZERO', 'REACTION_REDUCTION'].includes(event.payload.effect)).map(event => event.payload.prevented));
    return {
      itemId: item.id,
      name: item.name,
      purchaseCount: room.purchaseTransactions.filter(transaction => transaction.itemId === item.id).length,
      useCount: itemEvents.filter(event => event.type === 'SHOP_USED').length,
      appliedCount: itemEvents.filter(event => event.type === 'SHOP_EFFECT_APPLIED').length,
      failedCount: itemEvents.filter(event => event.type === 'SHOP_EFFECT_FAILED').length,
      directDamageIncrease: item.effectType === 'ATTACK_BONUS' ? sum(events.filter(event => event.type === 'DIRECT_DAMAGE' && event.payload?.component === 'SHOP_ATTACK_BONUS').map(event => event.payload.amount)) : 0,
      directDamageFromShop: sum(itemEvents.filter(event => event.type === 'SHOP_DAMAGE').map(event => event.payload.amount)),
      actualReduction: sum(events.filter(event => event.type === 'DEFENSE_APPLIED' && event.payload?.cardId === item.id).map(event => event.payload.amount)) + reactionReduction,
      actualRecovery: sum(events.filter(event => event.type === 'HEAL' && event.payload?.shopItemId === item.id).map(event => event.payload.shopRecoveryAmount)),
      informationUseCount: itemEvents.filter(event => event.type === 'SHOP_USED' && event.payload.timing === 'INFO').length
    };
  });
  const packs = PACKS.map(pack => {
    const players = metricsByPlayer.filter(player => player.packId === pack.id);
    const ranks = players.flatMap(player => player.stationRanks);
    return {
      packId: pack.id,
      name: pack.name,
      totalDamageDealt: sum(players.map(player => player.totalDamageDealt)),
      totalSupport: sum(players.map(player => player.totalSupport)),
      averageStationRank: ranks.length ? sum(ranks) / ranks.length : null,
      hpZeroRate: players.length ? players.filter(player => player.hpZeroCount > 0).length / players.length : null
    };
  });
  return { players: metricsByPlayer, packs, shops, stationResults };
}
