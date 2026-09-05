import crypto from 'node:crypto';
import { CARDS, CARD_BY_ID, PACKS, PACK_BY_ID, STATIONS } from './definitions.js';

export const PHASE = Object.freeze({ LOBBY: 'LOBBY', PACK_SELECTION: 'PACK_SELECTION', TURN_SELECTION: 'TURN_SELECTION', TURN_RESULT: 'TURN_RESULT' });
const token = () => crypto.randomBytes(24).toString('base64url');
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();

function event(room, type, payload = {}, visibility = 'public') {
  room.events.push({ id: id(), type, payload, visibility, globalTurnIndex: room.globalTurnIndex, at: now() });
}

export function createRoom(gmName = 'GM') {
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  const gm = { participantId: id(), authToken: token(), role: 'GM', name: gmName.trim() || 'GM' };
  const room = {
    id: id(), code, phase: PHASE.LOBBY, gm, players: [], stationIndex: -1, stationTurn: 0,
    globalTurnIndex: 0, timer: null, revealedUsages: [], events: [], createdAt: now(), updatedAt: now()
  };
  event(room, 'ROOM_CREATED', { gmName: gm.name });
  return room;
}

export function createTestRoom(gmName = 'テストGM') {
  const room = createRoom(gmName);
  room.testMode = true;
  Array.from({ length: 7 }, (_, index) => joinRoom(room, `テストPL${index + 1}`));
  applyAction(room, room.gm, { type: 'OPEN_PACK_SELECTION' });
  event(room, 'TEST_ROOM_READY', { players: 7 });
  return room;
}

export function joinRoom(room, name) {
  if (room.phase !== PHASE.LOBBY) throw new Error('参加受付は終了しています');
  if (room.players.length >= 7) throw new Error('PL7人が参加済みです');
  const playerNumber = room.players.length + 1;
  const player = {
    participantId: id(), authToken: token(), role: 'PL', playerNumber, name: name.trim(), hp: 15,
    isDeadState: false, packId: null, selection: null, confirmed: false, cardUsage: [], cardMarks: {},
    ongoingEffects: [], currency: { one: 5, two: 0, three: 0, five: 0, seven: 0 },
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

export function applyAction(room, actor, action) {
  switch (action.type) {
    case 'OPEN_PACK_SELECTION':
      requireGm(actor);
      if (room.players.length !== 7) throw new Error('PL7人の参加が必要です');
      room.phase = PHASE.PACK_SELECTION;
      event(room, 'INTRODUCTION_STARTED');
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
    case 'NEXT_TURN':
      requireGm(actor);
      nextTurn(room);
      break;
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
        const card = CARDS.find(candidate => candidate.packId === player.packId && !cooldownReason(player, candidate.id, room.globalTurnIndex));
        if (!card) throw new Error(`PL${player.playerNumber}に選択可能なカードがありません`);
        const target = room.players.find(candidate => candidate.playerNumber === (player.playerNumber % 7) + 1);
        const payload = { type: 'SELECT_CARD', cardId: card.id };
        if (card.targetType === 'player') payload.targetId = target.participantId;
        if (card.targetType === 'ownAttackCard') payload.cardTargetId = CARDS.find(candidate => candidate.packId === player.packId && candidate.category === 'attack').id;
        if (card.targetType === 'ownNonAttackCard') payload.cardTargetId = CARDS.find(candidate => candidate.packId === player.packId && candidate.category !== 'attack' && candidate.id !== card.id).id;
        selectCard(room, player, payload);
        player.confirmed = true;
        event(room, 'TEST_SELECTION_FILLED', { participantId: player.participantId, cardId: card.id }, 'gm');
      }
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
    default: throw new Error('未対応の操作です');
  }
  room.updatedAt = now();
  return room;
}

function startFirstStation(room) {
  if (room.phase !== PHASE.PACK_SELECTION) throw new Error('パック選択フェーズではありません');
  if (room.players.some(p => !p.confirmed || !p.packId)) throw new Error('全PLのパック確定が必要です');
  if (new Set(room.players.map(p => p.packId)).size !== 7) throw new Error('七獄パックは重複できません');
  room.stationIndex = 0; room.stationTurn = 1; room.globalTurnIndex = 1; room.phase = PHASE.TURN_SELECTION;
  room.timer = { startedAt: Date.now(), endsAt: Date.now() + STATIONS[0].turnSeconds * 1000 };
  for (const p of room.players) { p.confirmed = false; p.selection = null; p.stationStats = freshStats(); }
  event(room, 'PACKS_CONFIRMED', { packs: room.players.map(p => ({ playerNumber: p.playerNumber, packId: p.packId })) });
  event(room, 'TURN_STARTED', { stationId: STATIONS[0].id, stationTurn: 1, globalTurnIndex: 1 });
}

function cooldownReason(player, cardId, globalTurnIndex) {
  const last = [...player.cardUsage].reverse().find(use => use.cardId === cardId);
  if (last && last.globalTurnIndex + 1 === globalTurnIndex) return '前ターンに使用したため通常CT中';
  const extension = player.cardMarks[cardId]?.cooldownExtensionUntil;
  if (extension >= globalTurnIndex) return `強奪によりあと${extension - globalTurnIndex + 1}ターン使用不能`;
  return null;
}

function selectCard(room, actor, action) {
  if (room.phase !== PHASE.TURN_SELECTION || actor.confirmed) throw new Error('現在は選択を変更できません');
  const card = CARD_BY_ID[action.cardId];
  if (!card || card.packId !== actor.packId) throw new Error('自分のパックのカードではありません');
  const reason = cooldownReason(actor, card.id, room.globalTurnIndex);
  if (reason) throw new Error(reason);
  const selection = { cardId: card.id, targetId: action.targetId || null, cardTargetId: action.cardTargetId || null };
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
    if (card.targetType === 'ownAttackCard' && targetCard.category !== 'attack') throw new Error('攻撃カードを指定してください');
    if (card.targetType === 'ownNonAttackCard' && (targetCard.category === 'attack' || targetCard.id === card.id)) throw new Error('強欲自身を除く攻撃以外のカードを指定してください');
  }
}

function resolveTurn(room) {
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
function damageSelf(room, player, amount, cardId) { const before = player.hp; player.hp = Math.max(0, player.hp - amount); if (before > 0 && player.hp === 0) player.stationStats.reachedZero = true; event(room, 'SELF_DAMAGE', { participantId: player.participantId, cardId, amount: before - player.hp }); }
function applyHeal(room, source, targetId, amount, cardId, support = true) { const target = room.players.find(p => p.participantId === targetId); const before = target.hp; target.hp = Math.min(15, target.hp + amount); const actual = target.hp - before; if (support && source !== target) { source.stationStats.support += actual; source.totalStats.support += actual; } event(room, 'HEAL', { sourceId: source.participantId, targetId, cardId, amount: actual }); }

function nextTurn(room) {
  if (room.phase !== PHASE.TURN_RESULT) throw new Error('ターン結果確認中ではありません');
  const station = STATIONS[room.stationIndex];
  if (room.stationTurn >= station.turnCount) throw new Error('Phase 1では第一ターン以降の駅終了処理は未実装です');
  room.stationTurn += 1; room.globalTurnIndex += 1; room.phase = PHASE.TURN_SELECTION; room.revealedUsages = [];
  room.timer = { startedAt: Date.now(), endsAt: Date.now() + station.turnSeconds * 1000 };
  for (const player of room.players) { player.selection = null; player.confirmed = false; }
  event(room, 'TURN_STARTED', { stationId: station.id, stationTurn: room.stationTurn, globalTurnIndex: room.globalTurnIndex });
}

export function projectState(room, actor) {
  const isGm = actor.role === 'GM';
  const publicEvents = room.events.filter(item => item.visibility === 'public' || isGm || item.visibility === `private:${actor.participantId}`).slice(-100);
  return {
    code: room.code, testMode: Boolean(room.testMode), phase: room.phase, station: room.stationIndex >= 0 ? STATIONS[room.stationIndex] : null,
    stationTurn: room.stationTurn, globalTurnIndex: room.globalTurnIndex, timer: room.timer,
    me: actor.role === 'GM' ? { participantId: actor.participantId, role: 'GM', name: actor.name } : privatePlayer(actor, room),
    players: room.players.map(player => ({ participantId: player.participantId, playerNumber: player.playerNumber, name: player.name, hp: player.hp, isDeadState: player.isDeadState, packId: room.phase === PHASE.PACK_SELECTION && !isGm ? null : player.packId, confirmed: player.confirmed, selection: isGm || player.participantId === actor.participantId ? player.selection : undefined })),
    packs: PACKS.map(pack => ({ ...pack, cards: isGm || actor.packId === pack.id ? CARDS.filter(card => card.packId === pack.id) : undefined })),
    revealedUsages: room.phase === PHASE.TURN_RESULT ? room.revealedUsages : [], events: publicEvents
  };
}

function privatePlayer(player, room) {
  const cards = CARDS.filter(card => card.packId === player.packId).map(card => ({ ...card, unavailableReason: cooldownReason(player, card.id, room.globalTurnIndex) }));
  return { participantId: player.participantId, role: 'PL', playerNumber: player.playerNumber, name: player.name, hp: player.hp, packId: player.packId, cards, cardMarks: player.cardMarks, currency: player.currency };
}
