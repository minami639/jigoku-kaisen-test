import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyAction, collectSimulationMetrics, createTestRoom, PHASE, projectState } from '../src/game.js';
import { CARD_BY_ID, CARDS, PACKS, SHOP_ITEMS, STATIONS } from '../src/definitions.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CURRENCY_VALUES = Object.freeze({ one: 1, two: 2, three: 3, five: 5, seven: 7 });
// 通常100戦では4方針を均等に回す。ROUTE_OPTIMALは診断専用で、別途1000戦を行う。
const PAYMENT_STRATEGIES = Object.freeze(['EXACT_OR_MINIMUM', 'ROUTE_AWARE', 'ROUTE_KEEP', 'ROUTE_OPTIMAL']);
const PLAY_STRATEGIES = Object.freeze(['RANDOM', 'BALANCED', 'AGGRESSIVE', 'DEFENSIVE']);
const ROUTE_REQUIREMENTS = Object.freeze({ two: 2, three: 2, five: 1, seven: 1 });

function parseArgs(argv) {
  const options = { runs: 100, seed: 12345, output: null, paymentStrategy: null };
  for (const token of argv) {
    const [key, value] = token.split('=', 2);
    if (key === '--runs') options.runs = Number(value);
    if (key === '--seed') options.seed = Number(value);
    if (key === '--output') options.output = value;
    if (key === '--paymentStrategy') options.paymentStrategy = value;
  }
  if (!Number.isInteger(options.runs) || options.runs < 1) throw new Error('--runs は1以上の整数で指定してください。');
  if (!Number.isInteger(options.seed)) throw new Error('--seed は整数で指定してください。');
  if (options.paymentStrategy && !PAYMENT_STRATEGIES.includes(options.paymentStrategy)) throw new Error(`未対応の支払い方針です: ${options.paymentStrategy}`);
  return options;
}

function createRng(seed) {
  let state = (seed >>> 0) || 0x6d2b79f5;
  const next = () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: max => Math.floor(next() * max),
    pick: values => values[Math.floor(next() * values.length)],
    shuffle: values => {
      const copy = [...values];
      for (let index = copy.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(next() * (index + 1));
        [copy[index], copy[swap]] = [copy[swap], copy[index]];
      }
      return copy;
    }
  };
}

const sum = values => values.reduce((total, value) => total + Number(value || 0), 0);
const average = values => values.length ? sum(values) / values.length : 0;
const ratio = (numerator, denominator) => denominator ? numerator / denominator : 0;
const median = values => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const percent = value => `${(value * 100).toFixed(1)}%`;
const decimal = value => Number(value || 0).toFixed(2);
const moneyValue = coins => Object.entries(CURRENCY_VALUES).reduce((total, [type, value]) => total + Number(coins?.[type] || 0) * value, 0);
const zeroCoins = () => ({ one: 0, two: 0, three: 0, five: 0, seven: 0 });
const cloneCoins = coins => Object.fromEntries(Object.keys(CURRENCY_VALUES).map(type => [type, Number(coins?.[type] || 0)]));
const currencyLabel = coins => Object.entries(coins).filter(([, count]) => count).map(([type, count]) => `${({ one: '壱', two: '弐', three: '参', five: '伍', seven: '漆' })[type]}×${count}`).join('、') || 'なし';
const specialTypes = Object.freeze(['two', 'three', 'five', 'seven']);

function totalHoldings(room) {
  const holdings = zeroCoins();
  for (const player of room.players) for (const type of Object.keys(CURRENCY_VALUES)) holdings[type] += Number(player.currency[type] || 0);
  return holdings;
}

function hasRouteParts(coins, includeSeven = false) {
  return coins.two >= 2 && coins.three >= 2 && coins.five >= 1 && (!includeSeven || coins.seven >= 1);
}

function createShopTelemetry() {
  return {
    freeTimes: [],
    byItem: Object.fromEntries(SHOP_ITEMS.map(item => [item.id, {
      unlockCount: 0, saleCandidateCount: 0, purchaseOpportunityCount: 0, purchaseStations: [], payments: zeroCoins(), change: zeroCoins()
    }])),
    generatedSpecial: zeroCoins(),
    spentSpecial: zeroCoins(),
    routeReachedThenLost: { heaven: false, best: false },
    routeEverReached: { heaven: false, best: false }
  };
}

function recordRouteThreshold(context, room) {
  const holdings = totalHoldings(room);
  const heaven = hasRouteParts(holdings, false);
  const best = hasRouteParts(holdings, true);
  if (context.shopTelemetry.routeEverReached.heaven && !heaven) context.shopTelemetry.routeReachedThenLost.heaven = true;
  if (context.shopTelemetry.routeEverReached.best && !best) context.shopTelemetry.routeReachedThenLost.best = true;
  context.shopTelemetry.routeEverReached.heaven ||= heaven;
  context.shopTelemetry.routeEverReached.best ||= best;
}

function stablePackAssignment(runIndex) {
  // 7ゲームごとにPL番号との対応が一巡するため、100回でも各セルは14～15回となる。
  return Array.from({ length: 7 }, (_, playerIndex) => PACKS[(playerIndex + runIndex) % PACKS.length].id);
}

function playerStrategy(runIndex, playerIndex) {
  return PLAY_STRATEGIES[(runIndex + playerIndex) % PLAY_STRATEGIES.length];
}

function cardViewFor(room, player, cardId) {
  return projectState(room, player).me.cards.find(card => card.id === cardId);
}

function otherPlayers(room, player) {
  return room.players.filter(candidate => candidate !== player);
}

function lowestHpPlayer(room, player) {
  return [...otherPlayers(room, player)].sort((a, b) => a.hp - b.hp || a.playerNumber - b.playerNumber)[0];
}

function highestHpPlayer(room, player) {
  return [...otherPlayers(room, player)].sort((a, b) => b.hp - a.hp || a.playerNumber - b.playerNumber)[0];
}

function likelyAttacker(room, player) {
  const candidates = otherPlayers(room, player);
  return [...candidates].sort((a, b) => b.totalStats.damageDealt - a.totalStats.damageDealt || b.hp - a.hp || a.playerNumber - b.playerNumber)[0];
}

function cardIsFeasible(room, player, card) {
  if (card.id === 'encore') return Boolean(projectState(room, player).me.encoreCandidates.length);
  if (card.id === 'embers') return CARDS.some(candidate => candidate.packId === player.packId && candidate.category === 'attack' && !player.cardMarks[candidate.id]?.embers);
  if (card.id === 'greed') return CARDS.some(candidate => candidate.packId === player.packId && candidate.category !== 'attack' && candidate.id !== card.id && !player.cardMarks[candidate.id]?.desire && !player.cardMarks[candidate.id]?.greedyTicketPending && !player.cardMarks[candidate.id]?.desireReuseAt && !player.cardMarks[candidate.id]?.greedyTicketReuseAt);
  return true;
}

function scoreCard(room, player, card, strategy, rng) {
  const hp = player.hp;
  let score = rng.next() * 1.25;
  if (strategy === 'RANDOM') return score;
  if (card.category === 'attack') score += strategy === 'AGGRESSIVE' ? 8 : strategy === 'DEFENSIVE' ? 1 : 5;
  if (card.category === 'interference') score += strategy === 'AGGRESSIVE' ? 5 : 2.5;
  if (card.category === 'defense') score += strategy === 'DEFENSIVE' ? 8 : hp <= 6 ? 6 : 2;
  if (card.category === 'heal') score += strategy === 'DEFENSIVE' ? 7 : hp <= 6 ? 5 : 2;
  if (card.category === 'support') score += strategy === 'BALANCED' ? 4 : 2;
  if (['vampire', 'gluttony', 'healing-blood', 'transfusion', 'alms', 'regression'].includes(card.id) && hp <= 7) score += 3;
  if (['immolation', 'desperation'].includes(card.id) && hp <= 3) score -= 4;
  if (card.id === 'fire-seed' || card.id === 'target-stitch' || card.id === 'morale') score += strategy === 'BALANCED' ? 2 : 0;
  return score;
}

function pickCardCandidate(room, player, strategy, rng) {
  const me = projectState(room, player).me;
  const usable = me.cards.filter(view => !view.cooldownStatus && cardIsFeasible(room, player, view));
  const normalCt = me.cards.filter(view => view.cooldownStatus === 'NORMAL' && view.bypassOptions?.length && cardIsFeasible(room, player, view));
  const candidates = [...usable];
  // 餓鬼・欲印等のCT無視も低確率で使い、通常CTを無視するカードの実戦量を測る。
  if (normalCt.length && rng.next() < 0.18) candidates.push(...normalCt.map(view => ({ ...view, simulationCtBypass: view.bypassOptions[0] })));
  if (!candidates.length) throw new Error(`PL${player.playerNumber}に選択可能な七獄カードがありません。`);
  if (strategy === 'RANDOM') return rng.pick(candidates);
  return candidates.map(card => ({ card, score: scoreCard(room, player, card, strategy, rng) })).sort((a, b) => b.score - a.score)[0].card;
}

function ownAttackTarget(player, excludedId = null) {
  return CARDS.find(card => card.packId === player.packId && card.category === 'attack' && card.id !== excludedId && !player.cardMarks[card.id]?.embers)?.id;
}

function ownNonAttackTarget(player, excludedId = null) {
  return CARDS.find(card => card.packId === player.packId && card.category !== 'attack' && card.id !== excludedId && !player.cardMarks[card.id]?.desire && !player.cardMarks[card.id]?.greedyTicketPending && !player.cardMarks[card.id]?.desireReuseAt && !player.cardMarks[card.id]?.greedyTicketReuseAt)?.id;
}

function buildCardSelection(room, player, card, strategy, rng) {
  const selection = { type: 'SELECT_CARD', cardId: card.id };
  if (card.simulationCtBypass) selection.ctBypass = card.simulationCtBypass;
  if (card.targetType === 'player') {
    let target;
    if (card.category === 'attack') target = strategy === 'AGGRESSIVE' ? highestHpPlayer(room, player) : likelyAttacker(room, player);
    else if (card.category === 'heal' || card.category === 'defense') target = lowestHpPlayer(room, player);
    else if (['fire-seed', 'target-stitch', 'morale', 'counter-stance'].includes(card.id)) target = likelyAttacker(room, player);
    else target = strategy === 'DEFENSIVE' ? likelyAttacker(room, player) : highestHpPlayer(room, player);
    selection.targetId = (target || rng.pick(otherPlayers(room, player))).participantId;
    if (['thaw', 'regression'].includes(card.id)) {
      const removable = target?.ongoingEffects?.find(effect => effect.removable !== false);
      if (removable) selection.stateKey = removable.stackKey;
    }
  }
  if (card.targetType === 'ownAttackCard') selection.cardTargetId = ownAttackTarget(player, card.id);
  if (card.targetType === 'ownNonAttackCard') selection.cardTargetId = ownNonAttackTarget(player, card.id);
  if (card.id === 'encore') {
    const source = projectState(room, player).me.encoreCandidates.at(-1);
    selection.copyUsageId = source?.id;
    selection.copyKind = source?.kind;
  }
  return selection;
}

function readyShopEntries(room, player, timing = 'reveal') {
  return player.shopInventory.filter(entry => {
    const item = SHOP_ITEMS.find(candidate => candidate.id === entry.itemId);
    if (!item || (timing === 'info') !== (item.timing === 'info')) return false;
    return Number(entry.cooldownUntilGlobalTurnIndex || 0) < room.globalTurnIndex;
  }).map(entry => ({ entry, item: SHOP_ITEMS.find(candidate => candidate.id === entry.itemId) }));
}

function scoreShopUse(room, player, item, card, strategy, rng) {
  let score = rng.next();
  if (item.effectType === 'ATTACK_BONUS' && card.category === 'attack') score += 8;
  if (item.effectType === 'ALLY_HEAL_BONUS' && card.category === 'heal') score += 8;
  if (item.effectType === 'NORMAL_CT_BYPASS' && card.simulationCtBypass === 'HELL_KEY') score += 10;
  if (['DIRECT_REDUCTION', 'ALLY_DIRECT_REDUCTION', 'FIRST_DIRECT_REDUCTION', 'PREVENT_TARGET_CHANGE', 'PREVENT_TARGET_CHANGE_ONCE', 'PREVENT_TARGET_CHANGE_ONCE_ATTACK', 'REACTION_REDUCTION', 'FIRST_REACTION_ZERO'].includes(item.effectType) && (player.hp <= 8 || strategy === 'DEFENSIVE')) score += 5;
  if (item.effectType === 'POST_HEAL' && player.hp < 15) score += 5;
  if (item.effectType === 'SECRET_TARGET_NOTICE' && card.category === 'attack') score += 4;
  if (item.effectType === 'GREEDY_TICKET' && ownNonAttackTarget(player, card.id)) score += 3;
  if (item.effectType === 'GRUDGE' || item.effectType === 'FIZZLE_HEAL' || item.effectType === 'DIRECT_DAMAGE_THRESHOLD_HEAL') score += player.hp <= 8 ? 3 : 1;
  if (item.effectType === 'PREVENT_EXTENSION' && strategy === 'DEFENSIVE') score += 2;
  return score;
}

function addShopSelection(room, player, card, selection, strategy, rng) {
  const choices = readyShopEntries(room, player).filter(({ item }) => {
    if (item.effectType === 'ATTACK_BONUS' || item.effectType === 'SECRET_TARGET_NOTICE' || item.effectType === 'PREVENT_TARGET_CHANGE_ONCE_ATTACK') return card.category === 'attack';
    if (item.effectType === 'ALLY_HEAL_BONUS') return card.category === 'heal' && selection.targetId !== player.participantId;
    if (item.effectType === 'NORMAL_CT_BYPASS') return card.simulationCtBypass === 'HELL_KEY';
    if (item.effectType === 'GREEDY_TICKET') return Boolean(ownNonAttackTarget(player, card.id));
    return true;
  });
  if (!choices.length) return selection;
  const ranked = choices.map(choice => ({ ...choice, score: scoreShopUse(room, player, choice.item, card, strategy, rng) })).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const minimum = best.item.effectType === 'NORMAL_CT_BYPASS' ? 1 : 2.25;
  if (best.score < minimum) return selection;
  selection.shopEntryId = best.entry.inventoryId;
  if (best.item.effectType === 'GRUDGE' || best.item.effectType === 'SECRET_TARGET_NOTICE' || best.item.effectType === 'ALLY_DIRECT_REDUCTION') selection.shopTargetId = likelyAttacker(room, player).participantId;
  if (best.item.effectType === 'GREEDY_TICKET') selection.shopCardTargetId = ownNonAttackTarget(player, card.id);
  if (best.item.effectType === 'NORMAL_CT_BYPASS') selection.ctBypass = 'HELL_KEY';
  return selection;
}

function useInformationShopIfUseful(room, player, rng) {
  const choices = readyShopEntries(room, player, 'info');
  const targets = room.players.filter(candidate => candidate !== player && candidate.selection);
  if (!choices.length || !targets.length || rng.next() > 0.42) return;
  const choice = rng.pick(choices);
  const target = rng.pick(targets);
  applyAction(room, player, { type: 'USE_INFORMATION_SHOP', shopEntryId: choice.entry.inventoryId, targetId: target.participantId });
}

function chooseAndConfirm(room, player, strategy, rng) {
  useInformationShopIfUseful(room, player, rng);
  const me = projectState(room, player).me;
  const candidates = me.cards.filter(card => (!card.cooldownStatus || (card.cooldownStatus === 'NORMAL' && card.bypassOptions?.length)) && cardIsFeasible(room, player, card));
  const ordered = strategy === 'RANDOM' ? rng.shuffle(candidates) : candidates.map(card => ({ card, score: scoreCard(room, player, card, strategy, rng) })).sort((a, b) => b.score - a.score).map(entry => entry.card);
  let lastError = null;
  for (const candidate of ordered) {
    const card = candidate.cooldownStatus === 'NORMAL' ? { ...candidate, simulationCtBypass: candidate.bypassOptions[0] } : candidate;
    const base = buildCardSelection(room, player, card, strategy, rng);
    const withShop = addShopSelection(room, player, card, { ...base }, strategy, rng);
    for (const selection of withShop.shopEntryId ? [withShop, base] : [base]) {
      try {
        applyAction(room, player, selection);
        applyAction(room, player, { type: 'CONFIRM_CARD' });
        return;
      } catch (error) {
        lastError = error;
        player.selection = null;
        player.confirmed = false;
      }
    }
  }
  throw new Error(`PL${player.playerNumber}の選択AIが有効な行動を作れませんでした: ${lastError?.message || 'unknown'}`);
}

function enumeratePayments(coins, price) {
  const types = Object.keys(CURRENCY_VALUES);
  const output = [];
  const maxTotal = price + 7;
  const visit = (index, current, total) => {
    if (index === types.length) {
      if (total >= price && total <= maxTotal) output.push({ coins: { ...current }, total });
      return;
    }
    const type = types[index];
    const unit = CURRENCY_VALUES[type];
    const limit = Math.min(Number(coins[type] || 0), Math.floor((maxTotal - total) / unit));
    for (let amount = 0; amount <= limit; amount += 1) {
      current[type] = amount;
      visit(index + 1, current, total + amount * unit);
    }
  };
  visit(0, zeroCoins(), 0);
  return output;
}

function makeChange(value) {
  const output = zeroCoins();
  let remaining = value;
  for (const type of ['seven', 'five', 'three', 'two', 'one']) {
    output[type] = Math.floor(remaining / CURRENCY_VALUES[type]);
    remaining %= CURRENCY_VALUES[type];
  }
  return output;
}

function routePaymentScore(holdings, item, payment) {
  const change = makeChange(payment.total - item.price);
  let gained = 0;
  let lost = 0;
  for (const type of specialTypes) {
    const missing = Math.max(0, ROUTE_REQUIREMENTS[type] - holdings[type]);
    gained += Math.min(missing, change[type]) * CURRENCY_VALUES[type];
    const protectedCoins = Math.min(ROUTE_REQUIREMENTS[type], holdings[type]);
    lost += Math.min(protectedCoins, payment.coins[type]) * CURRENCY_VALUES[type];
  }
  return gained * 1000 - lost * 2000 - (payment.total - item.price) * 0.1;
}

function choosePayment(room, player, item, strategy, rng) {
  const candidates = enumeratePayments(player.currency, item.price);
  if (!candidates.length) return null;
  if (strategy === 'RANDOM_PAYMENT') return rng.pick(candidates);
  if (strategy === 'EXACT_OR_MINIMUM') return candidates.sort((a, b) => a.total - b.total || sum(Object.values(a.coins)) - sum(Object.values(b.coins)))[0];
  const holdings = totalHoldings(room);
  return candidates.map(candidate => {
    const change = makeChange(candidate.total - item.price);
    const createdSpecial = sum(specialTypes.map(type => change[type]));
    const spentSpecial = sum(specialTypes.map(type => candidate.coins[type]));
    if (strategy === 'ROUTE_KEEP') {
      const retainedRouteParts = sum(specialTypes.map(type => Math.min(ROUTE_REQUIREMENTS[type], holdings[type] - candidate.coins[type] + change[type])));
      const specialSpendPenalty = sum(specialTypes.map(type => candidate.coins[type] * CURRENCY_VALUES[type]));
      return { candidate, score: retainedRouteParts * 100 - specialSpendPenalty * 5 - (candidate.total - item.price) * 0.1 + rng.next() };
    }
    if (strategy === 'ROUTE_OPTIMAL') {
      const projected = { ...holdings };
      for (const type of Object.keys(CURRENCY_VALUES)) projected[type] += change[type] - candidate.coins[type];
      const fulfilled = sum(specialTypes.map(type => Math.min(ROUTE_REQUIREMENTS[type], projected[type]) * CURRENCY_VALUES[type]));
      // 路線図の不足額を埋めるおつりを最優先し、必要数を満たした特殊冥貨の再投入を強く避ける。
      return { candidate, score: routePaymentScore(holdings, item, candidate) + fulfilled * 10 - spentSpecial * 5 + createdSpecial * 0.1 + rng.next() };
    }
    const wanted = specialTypes.filter(type => !player.currency[type]);
    const createdWanted = sum(wanted.map(type => change[type]));
    return { candidate, score: createdWanted * 12 + createdSpecial * 3 + (candidate.total - item.price) - spentSpecial * 2 + rng.next() };
  }).sort((a, b) => b.score - a.score)[0].candidate;
}

function scorePurchase(item, player, strategy, rng) {
  let score = rng.next() * 2 - item.price * 0.06;
  const attackPack = ['scorch', 'needle', 'war', 'infinite'].includes(player.packId);
  const healPack = player.packId === 'blood';
  if (item.effectType === 'ATTACK_BONUS' && attackPack) score += 6;
  if (item.effectType === 'ALLY_HEAL_BONUS' && healPack) score += 5;
  if (['DIRECT_REDUCTION', 'ALLY_DIRECT_REDUCTION', 'FIRST_DIRECT_REDUCTION', 'REACTION_REDUCTION', 'FIRST_REACTION_ZERO', 'POST_HEAL', 'DIRECT_DAMAGE_THRESHOLD_HEAL'].includes(item.effectType) && player.hp < 10) score += 4;
  if (item.timing === 'info') score += 1.5;
  if (strategy === 'AGGRESSIVE' && ['ATTACK_BONUS', 'NORMAL_CT_BYPASS', 'SECRET_TARGET_NOTICE', 'GRUDGE'].includes(item.effectType)) score += 4;
  if (strategy === 'DEFENSIVE' && ['DIRECT_REDUCTION', 'ALLY_DIRECT_REDUCTION', 'FIRST_DIRECT_REDUCTION', 'REACTION_REDUCTION', 'FIRST_REACTION_ZERO', 'POST_HEAL', 'DIRECT_DAMAGE_THRESHOLD_HEAL'].includes(item.effectType)) score += 5;
  if (strategy === 'BALANCED') score += 1;
  return score;
}

function runShopPurchases(room, context) {
  const shopTelemetry = context.shopTelemetry;
  const unlocked = SHOP_ITEMS.filter(item => item.unlockAfterStation && item.shop <= room.stationIndex + 1);
  const newlyUnlocked = unlocked.filter(item => item.shop === room.stationIndex + 1);
  for (const item of newlyUnlocked) shopTelemetry.byItem[item.id].unlockCount += 1;
  const freeTime = {
    stationIndex: room.stationIndex,
    newCount: newlyUnlocked.length,
    saleCandidateCount: unlocked.filter(item => (room.shopStock[item.id] || 0) > 0).length,
    soldOutCount: unlocked.filter(item => (room.shopStock[item.id] || 0) <= 0).length,
    purchasableCounts: []
  };
  for (const item of unlocked) if ((room.shopStock[item.id] || 0) > 0) shopTelemetry.byItem[item.id].saleCandidateCount += 1;
  recordRouteThreshold(context, room);
  const order = context.rng.shuffle(room.players);
  for (const player of order) {
    const available = SHOP_ITEMS.filter(item => item.unlockAfterStation && (room.shopStock[item.id] || 0) > 0 && item.shop <= room.stationIndex + 1 && !player.shopInventory.some(entry => entry.itemId === item.id));
    const affordable = available.filter(item => enumeratePayments(player.currency, item.price).length);
    freeTime.purchasableCounts.push(affordable.length);
    for (const item of affordable) shopTelemetry.byItem[item.id].purchaseOpportunityCount += 1;
    if (!affordable.length) continue;
    // 1自由時間に全員が買い物をする前提にせず、低価格商品が毎回必ず売り切れる
    // テスト専用の経済にならないよう、戦略ごとに控えめな購入意思を持たせる。
    const tendency = context.paymentStrategy === 'ROUTE_OPTIMAL'
      ? 1
      : player.simulationStrategy === 'AGGRESSIVE' ? 0.24 : player.simulationStrategy === 'DEFENSIVE' ? 0.20 : player.simulationStrategy === 'BALANCED' ? 0.18 : 0.12;
    if (context.rng.next() > tendency) continue;
    let item;
    let payment;
    if (context.paymentStrategy === 'ROUTE_OPTIMAL') {
      const holdings = totalHoldings(room);
      const plans = affordable.map(candidate => {
        const nextPayment = choosePayment(room, player, candidate, context.paymentStrategy, context.rng);
        return { item: candidate, payment: nextPayment, score: nextPayment ? routePaymentScore(holdings, candidate, nextPayment) : -Infinity };
      }).filter(plan => plan.payment && plan.score > 0).sort((a, b) => b.score - a.score);
      // 路線図に必要な新しいおつりを作れない支払いは、診断用の最適方針では行わない。
      if (!plans.length) continue;
      ({ item, payment } = plans[0]);
    } else {
      item = affordable.map(candidate => ({ item: candidate, score: scorePurchase(candidate, player, player.simulationStrategy, context.rng) })).sort((a, b) => b.score - a.score)[0].item;
      payment = choosePayment(room, player, item, context.paymentStrategy, context.rng);
    }
    if (!payment) continue;
    applyAction(room, player, { type: 'BUY_SHOP_ITEM', itemId: item.id, payment: payment.coins });
    const transaction = room.purchaseTransactions.at(-1);
    const itemTelemetry = shopTelemetry.byItem[item.id];
    itemTelemetry.purchaseStations.push(room.stationIndex + 1);
    for (const type of Object.keys(CURRENCY_VALUES)) {
      itemTelemetry.payments[type] += Number(transaction.payment?.[type] || 0);
      itemTelemetry.change[type] += Number(transaction.change?.coins?.[type] || 0);
      shopTelemetry.generatedSpecial[type] += Number(transaction.change?.coins?.[type] || 0);
      shopTelemetry.spentSpecial[type] += Number(transaction.payment?.[type] || 0);
    }
    recordRouteThreshold(context, room);
  }
  shopTelemetry.freeTimes.push(freeTime);
}

function advanceStationIntroduction(room) {
  let guard = 0;
  while (room.phase === PHASE.STATION_INTRODUCTION) {
    if (guard++ > 100) throw new Error('駅導入の進行が停止しました。');
    applyAction(room, room.gm, { type: 'ADVANCE_STATION_INTRODUCTION' });
  }
}

function currentStationTelemetry(room) {
  return {
    stationId: STATIONS[room.stationIndex].id,
    stationIndex: room.stationIndex,
    eventStart: room.events.length,
    startHp: Object.fromEntries(room.players.map(player => [player.participantId, player.hp])),
    turnDeltas: []
  };
}

function finalizeStationTelemetry(room, telemetry) {
  const events = room.events.slice(telemetry.eventStart);
  const damageTypes = new Set(['DIRECT_DAMAGE', 'REACTION_DAMAGE', 'STATION_DAMAGE', 'SELF_DAMAGE', 'CARRY_START_DAMAGE', 'SHOP_DAMAGE']);
  const damage = sum(events.filter(event => damageTypes.has(event.type)).map(event => event.payload.amount));
  const recovery = sum(events.filter(event => event.type === 'HEAL').map(event => event.payload.amount));
  const result = room.stationResult;
  return {
    ...telemetry,
    endHp: Object.fromEntries(room.players.map(player => [player.participantId, player.hp])),
    damage,
    recovery,
    hpZeroPlayers: room.players.filter(player => player.stationStats.reachedZero).map(player => player.participantId),
    stationScores: room.players.map(player => player.stationStats.stationScore),
    supportAwarded: Boolean(result?.supportAward?.winnerIds?.length),
    specialWinners: result?.specialBonus?.winnerIds?.length || 0,
    result: result ? { rankings: result.rankings, excludedPlayerNumbers: result.excludedPlayerNumbers, supportAward: result.supportAward, specialBonus: result.specialBonus } : null
  };
}

function projectionViolations(room) {
  const problems = [];
  for (const observer of room.players) {
    const view = projectState(room, observer);
    for (const player of view.players) {
      if (player.participantId !== observer.participantId && player.selection != null) problems.push(`PL${observer.playerNumber}へPL${player.playerNumber}の選択が投影された`);
      if (player.participantId !== observer.participantId && Array.isArray(player.shopInventory) && player.shopInventory.length) problems.push(`PL${observer.playerNumber}へPL${player.playerNumber}の所持SHOPが投影された`);
    }
  }
  return problems;
}

function invariantViolations(room) {
  const problems = [];
  if (room.globalTurnIndex !== 25) problems.push(`globalTurnIndex=${room.globalTurnIndex}`);
  for (const player of room.players) {
    if (!Number.isFinite(player.hp) || player.hp < 0 || player.hp > 15) problems.push(`PL${player.playerNumber} HP=${player.hp}`);
    for (const [type, count] of Object.entries(player.currency)) if (!Number.isFinite(count) || count < 0 || !Number.isInteger(count)) problems.push(`PL${player.playerNumber} ${type}=${count}`);
    const cardTurns = new Map();
    for (const use of player.cardUsage) {
      if (!CARD_BY_ID[use.cardId]) problems.push(`PL${player.playerNumber} unknownCard=${use.cardId}`);
      const key = use.globalTurnIndex;
      cardTurns.set(key, (cardTurns.get(key) || 0) + 1);
    }
    if ([...cardTurns.values()].some(count => count > 1)) problems.push(`PL${player.playerNumber} 同一ターンに七獄カード複数使用`);
    const duplicateItems = player.shopInventory.map(entry => entry.itemId).filter((itemId, index, all) => all.indexOf(itemId) !== index);
    if (duplicateItems.length) problems.push(`PL${player.playerNumber} SHOP重複所有=${duplicateItems.join(',')}`);
  }
  const ownedItems = room.players.flatMap(player => player.shopInventory.map(entry => entry.itemId));
  if (new Set(ownedItems).size !== ownedItems.length) problems.push('同一SHOP商品の複数所有');
  const shopUses = new Map();
  for (const event of room.events.filter(event => event.type === 'SHOP_USED')) {
    const key = `${event.payload.participantId}:${event.payload.globalTurnIndex}`;
    shopUses.set(key, (shopUses.get(key) || 0) + 1);
  }
  if ([...shopUses.values()].some(count => count > 1)) problems.push('同一ターンにSHOP複数使用');
  const extensions = room.events.filter(event => event.type === 'COOLDOWN_EXTENSION_APPLIED');
  for (const player of room.players) {
    for (const use of player.cardUsage) {
      const blocked = extensions.some(event => event.payload.targetId === player.participantId && event.payload.cardId === use.cardId && event.globalTurnIndex < use.globalTurnIndex && event.payload.until >= use.globalTurnIndex);
      if (blocked) problems.push(`PL${player.playerNumber} 強奪中に${use.cardId}を使用`);
    }
  }
  if (room.events.filter(event => event.type === 'TURN_RESOLVED').length !== 25) problems.push(`TURN_RESOLVED=${room.events.filter(event => event.type === 'TURN_RESOLVED').length}`);
  return [...new Set(problems)];
}

function startGame(runIndex, seed, rng) {
  const room = createTestRoom(`SIM GM ${runIndex + 1}`);
  room.randomInt = max => rng.int(max);
  applyAction(room, room.gm, { type: 'TEST_JUMP_PHASE', phase: PHASE.PACK_SELECTION });
  const packs = stablePackAssignment(runIndex);
  room.players.forEach((player, playerIndex) => {
    player.simulationStrategy = playerStrategy(runIndex, playerIndex);
    applyAction(room, room.gm, { type: 'TEST_SELECT_PACK', participantId: player.participantId, packId: packs[playerIndex] });
  });
  applyAction(room, room.gm, { type: 'START_FIRST_STATION' });
  advanceStationIntroduction(room);
  return room;
}

function completeStationFlow(room, context, telemetry) {
  const finalTelemetry = finalizeStationTelemetry(room, telemetry);
  applyAction(room, room.gm, { type: 'START_REWARD_NARRATION' });
  let guard = 0;
  while (room.phase === PHASE.REWARD_NARRATION) {
    if (guard++ > 100) throw new Error('報酬発表の進行が停止しました。');
    applyAction(room, room.gm, { type: 'ADVANCE_REWARD_NARRATION' });
  }
  if (room.phase === PHASE.FINAL_RANKING) return { telemetry: finalTelemetry, finished: true };
  if (room.phase !== PHASE.CURRENCY_SYNC_WAIT) throw new Error(`想定外の駅結果フェーズ: ${room.phase}`);
  for (const transaction of room.currencyTransactions.filter(transaction => transaction.stationId === STATIONS[room.stationIndex].id && !transaction.cocofoliaApplied)) {
    applyAction(room, room.gm, { type: 'MARK_CURRENCY_TRANSACTION_APPLIED', transactionId: transaction.id });
  }
  applyAction(room, room.gm, { type: 'START_FREE_TIME' });
  guard = 0;
  while (room.phase === PHASE.FREE_TIME_INTRO) {
    if (guard++ > 100) throw new Error('自由時間案内の進行が停止しました。');
    applyAction(room, room.gm, { type: 'ADVANCE_FREE_TIME_INTRODUCTION' });
  }
  runShopPurchases(room, context);
  applyAction(room, room.gm, { type: 'START_NEXT_STATION' });
  advanceStationIntroduction(room);
  return { telemetry: finalTelemetry, finished: false };
}

function summarizeSingleRun(room, context, telemetry) {
  const metrics = collectSimulationMetrics(room);
  const rankings = new Map((room.finalRanking || []).map(entry => [entry.participantId, entry]));
  const players = metrics.players.map(({ sevenCardUsage, shopUsage, ...player }) => ({
    ...player,
    finalRank: rankings.get(player.participantId)?.rank || null,
    strategy: room.players.find(candidate => candidate.participantId === player.participantId)?.simulationStrategy,
    purchases: room.purchaseTransactions.filter(transaction => transaction.participantId === player.participantId).length,
    cardUseCount: sevenCardUsage.length,
    shopUseCount: shopUsage.length
  }));
  const generated = zeroCoins();
  for (const transaction of room.purchaseTransactions) for (const type of Object.keys(CURRENCY_VALUES)) generated[type] += transaction.change?.coins?.[type] || 0;
  const totalHoldings = zeroCoins();
  for (const player of room.players) for (const type of Object.keys(CURRENCY_VALUES)) totalHoldings[type] += player.currency[type];
  const issuedOne = sum(room.currencyTransactions.filter(transaction => transaction.currency === 'one').map(transaction => transaction.amount));
  const payments = sum(room.purchaseTransactions.map(transaction => transaction.paymentTotal));
  const shopUses = room.events.filter(event => event.type === 'SHOP_USED').length;
  return {
    run: context.runIndex + 1,
    seed: context.seed,
    paymentStrategy: context.paymentStrategy,
    packAssignments: room.players.map(player => ({ playerNumber: player.playerNumber, packId: player.packId, strategy: player.simulationStrategy })),
    players,
    shops: metrics.shops,
    shopTelemetry: context.shopTelemetry,
    stationTelemetry: telemetry,
    issuedOne,
    paymentValue: payments,
    generated,
    totalHoldings,
    shopPurchases: room.purchaseTransactions.length,
    shopUses,
    heavenPartsAvailable: totalHoldings.two >= 2 && totalHoldings.three >= 2 && totalHoldings.five >= 1,
    bestEndPartsAvailable: totalHoldings.two >= 2 && totalHoldings.three >= 2 && totalHoldings.five >= 1 && totalHoldings.seven >= 1,
    invariantViolations: invariantViolations(room),
    cardEvents: room.events.filter(event => ['DIRECT_DAMAGE', 'REACTION_DAMAGE', 'HEAL', 'DEFENSE_APPLIED', 'CARRY_STATE_ADDED'].includes(event.type)).map(event => ({ type: event.type, payload: event.payload })),
    cardUsages: room.players.flatMap(player => player.cardUsage.map(use => ({ ...use, packId: player.packId, playerNumber: player.playerNumber }))),
    purchaseTransactions: room.purchaseTransactions.map(transaction => ({ participantId: transaction.participantId, itemId: transaction.itemId, stationIndex: transaction.stationIndex, payment: transaction.payment, change: transaction.change })),
    shopUseEvents: room.events.filter(event => ['SHOP_USED', 'SHOP_EFFECT_APPLIED', 'SHOP_EFFECT_FAILED', 'SHOP_DAMAGE', 'SHOP_INFORMATION_REVEALED'].includes(event.type)).map(event => ({ type: event.type, payload: event.payload, globalTurnIndex: event.globalTurnIndex })),
    finalRanking: room.finalRanking || []
  };
}

function runSingleGame(runIndex, seed, forcedPaymentStrategy = null) {
  const rng = createRng(seed);
  const context = { runIndex, seed, rng, paymentStrategy: forcedPaymentStrategy || PAYMENT_STRATEGIES[runIndex % PAYMENT_STRATEGIES.length], shopTelemetry: createShopTelemetry() };
  const room = startGame(runIndex, seed, rng);
  const telemetry = [currentStationTelemetry(room)];
  const projectionProblems = [];
  let processed = 0;
  while (processed < 25) {
    if (room.phase !== PHASE.TURN_SELECTION) throw new Error(`T${processed + 1}がカード選択フェーズではありません: ${room.phase}`);
    for (const player of room.players) chooseAndConfirm(room, player, player.simulationStrategy, rng);
    projectionProblems.push(...projectionViolations(room));
    const beforeHp = Object.fromEntries(room.players.map(player => [player.participantId, player.hp]));
    applyAction(room, room.gm, { type: 'REVEAL_AND_RESOLVE' });
    telemetry.at(-1).turnDeltas.push({ globalTurnIndex: room.globalTurnIndex, beforeHp, afterHp: Object.fromEntries(room.players.map(player => [player.participantId, player.hp])) });
    processed += 1;
    applyAction(room, room.gm, { type: 'TEST_ACK_ALL_RESULTS' });
    applyAction(room, room.gm, { type: 'NEXT_TURN' });
    if (room.phase === PHASE.STATION_RESULT) {
      const completed = completeStationFlow(room, context, telemetry.at(-1));
      telemetry[telemetry.length - 1] = completed.telemetry;
      if (!completed.finished) telemetry.push(currentStationTelemetry(room));
    }
  }
  if (room.phase !== PHASE.FINAL_RANKING) throw new Error(`最終駅の結果処理が完了していません: ${room.phase}`);
  const summary = summarizeSingleRun(room, context, telemetry);
  summary.invariantViolations.push(...projectionProblems);
  summary.invariantViolations = [...new Set(summary.invariantViolations)];
  return summary;
}

function newCounter() { return { count: 0, sum: 0, values: [] }; }
function add(counter, value) { counter.count += 1; counter.sum += Number(value || 0); counter.values.push(Number(value || 0)); }
function summarizeCounter(counter) { return { count: counter.count, average: average(counter.values), median: median(counter.values), sum: counter.sum }; }

function makeAggregate() {
  return {
    players: Array.from({ length: 7 }, (_, index) => ({ playerNumber: index + 1, finalHp: newCounter(), finalRank: newCounter(), zeroReached: 0, deadStations: newCounter(), damageDealt: newCounter(), damageTaken: newCounter(), support: newCounter(), first: 0, last: 0, stationRanks: [], special: newCounter(), cardUses: newCounter(), shopUses: newCounter(), shopPurchases: newCounter() })),
    packs: Object.fromEntries(PACKS.map(pack => [pack.id, { id: pack.id, name: pack.name, assignmentsByPlayer: Array(7).fill(0), finalHp: newCounter(), finalRank: newCounter(), first: 0, top3: 0, last: 0, zero: 0, damageDealt: newCounter(), damageTaken: newCounter(), support: newCounter(), stationRanks: [], special: newCounter(), shopPurchases: newCounter(), shopUses: newCounter(), purchasedItems: {}, cards: {} }])),
    cards: Object.fromEntries(CARDS.map(card => [card.id, { id: card.id, name: card.name, packId: card.packId, selected: 0, resolved: 0, fizzled: 0, nullified: 0, damage: newCounter(), heal: newCounter(), reduction: newCounter(), stateSuccess: 0 }])),
    shops: Object.fromEntries(SHOP_ITEMS.map(item => [item.id, { id: item.id, name: item.name, shop: item.shop, purchase: 0, unlock: 0, saleCandidates: 0, purchaseOpportunities: 0, purchaseStations: newCounter(), use: 0, usedInventories: 0, applied: 0, failed: 0, damageIncrease: newCounter(), reduction: newCounter(), recovery: newCounter(), info: 0, firstUses: newCounter(), lastUses: newCounter(), rosaryTargets: 0, rosaryOthersProtected: 0, hellChainPrevented: 0, sixChainPrevented: 0, sixChainMultiUse: 0, bloodAttackInfo: 0, bloodSelfTargetInfo: 0 }])),
    stations: Object.fromEntries(STATIONS.map(station => [station.id, { id: station.id, name: station.name, startHp: newCounter(), endHp: newCounter(), damage: newCounter(), recovery: newCounter(), zeroPlayers: newCounter(), supportAwardGames: 0, specialWinners: newCounter(), scores: [], turnDeltas: [] }])),
    economy: { issuedOne: newCounter(), paymentValue: newCounter(), shopPurchases: newCounter(), shopUses: newCounter(), holdings: Object.fromEntries(Object.keys(CURRENCY_VALUES).map(type => [type, newCounter()])), generated: Object.fromEntries(Object.keys(CURRENCY_VALUES).map(type => [type, newCounter()])), spentAfterGenerated: Object.fromEntries(specialTypes.map(type => [type, newCounter()])), heaven: 0, best: 0, routeReachedThenLost: { heaven: 0, best: 0 }, strategies: Object.fromEntries(PAYMENT_STRATEGIES.map(strategy => [strategy, { games: 0, purchases: newCounter(), holdings: Object.fromEntries(Object.keys(CURRENCY_VALUES).map(type => [type, newCounter()])), generated: Object.fromEntries(Object.keys(CURRENCY_VALUES).map(type => [type, newCounter()])), heaven: 0, best: 0 }])), freeTimes: Object.fromEntries(STATIONS.slice(0, 6).map((station, index) => [station.id, { newCount: newCounter(), saleCandidateCount: newCounter(), soldOutCount: newCounter(), purchasablePerPlayer: newCounter() }])) },
    invariantViolations: [],
    outliers: []
  };
}

function mergeRun(aggregate, run) {
  for (const player of run.players) {
    const row = aggregate.players[player.playerNumber - 1];
    add(row.finalHp, player.finalHp);
    add(row.finalRank, player.finalRank || 7);
    row.first += player.finalRank === 1 ? 1 : 0;
    row.last += player.finalRank === 7 ? 1 : 0;
    row.zeroReached += player.hpZeroCount > 0 ? 1 : 0;
    add(row.deadStations, player.deadStations.length);
    add(row.damageDealt, player.totalDamageDealt);
    add(row.damageTaken, player.totalDamageTaken);
    add(row.support, player.totalSupport);
    row.stationRanks.push(...player.stationRanks);
    add(row.special, player.specialConditionCount);
    add(row.cardUses, player.cardUseCount);
    add(row.shopUses, player.shopUseCount);
    add(row.shopPurchases, player.purchases);
    const pack = aggregate.packs[player.packId];
    pack.assignmentsByPlayer[player.playerNumber - 1] += 1;
    add(pack.finalHp, player.finalHp);
    add(pack.finalRank, player.finalRank || 7);
    pack.first += player.finalRank === 1 ? 1 : 0;
    pack.top3 += player.finalRank && player.finalRank <= 3 ? 1 : 0;
    pack.last += player.finalRank === 7 ? 1 : 0;
    pack.zero += player.hpZeroCount > 0 ? 1 : 0;
    add(pack.damageDealt, player.totalDamageDealt);
    add(pack.damageTaken, player.totalDamageTaken);
    add(pack.support, player.totalSupport);
    pack.stationRanks.push(...player.stationRanks);
    add(pack.special, player.specialConditionCount);
    add(pack.shopUses, player.shopUseCount);
    add(pack.shopPurchases, player.purchases);
  }
  for (const transaction of run.purchaseTransactions) {
    const player = run.players.find(candidate => candidate.participantId === transaction.participantId);
    if (!player) continue;
    const pack = aggregate.packs[player.packId];
    pack.purchasedItems[transaction.itemId] = (pack.purchasedItems[transaction.itemId] || 0) + 1;
  }
  for (const usage of run.cardUsages) {
    const card = aggregate.cards[usage.cardId];
    card.selected += 1;
    if (usage.result === 'RESOLVED') card.resolved += 1;
    if (usage.result === 'FIZZLED') card.fizzled += 1;
    if (usage.result === 'NULLIFIED') card.nullified += 1;
    aggregate.packs[usage.packId].cards[usage.cardId] ||= { selected: 0, resolved: 0, fizzled: 0, nullified: 0 };
    const packCard = aggregate.packs[usage.packId].cards[usage.cardId];
    packCard.selected += 1;
    packCard.resolved += usage.result === 'RESOLVED' ? 1 : 0;
    packCard.fizzled += usage.result === 'FIZZLED' ? 1 : 0;
    packCard.nullified += usage.result === 'NULLIFIED' ? 1 : 0;
  }
  for (const event of run.cardEvents) {
    const card = aggregate.cards[event.payload.cardId];
    if (!card) continue;
    if (event.type === 'DIRECT_DAMAGE' || event.type === 'REACTION_DAMAGE') add(card.damage, event.payload.amount);
    if (event.type === 'HEAL') add(card.heal, event.payload.amount);
    if (event.type === 'DEFENSE_APPLIED') add(card.reduction, event.payload.amount);
    if (event.type === 'CARRY_STATE_ADDED') card.stateSuccess += 1;
  }
  for (const [itemId, shop] of Object.entries(aggregate.shops)) {
    const result = run.shops.find(candidate => candidate.itemId === itemId);
    const telemetry = run.shopTelemetry.byItem[itemId];
    shop.purchase += result.purchaseCount;
    shop.unlock += telemetry.unlockCount;
    shop.saleCandidates += telemetry.saleCandidateCount;
    shop.purchaseOpportunities += telemetry.purchaseOpportunityCount;
    for (const station of telemetry.purchaseStations) add(shop.purchaseStations, station);
    shop.use += result.useCount;
    shop.applied += result.appliedCount;
    shop.failed += result.failedCount;
    add(shop.damageIncrease, result.directDamageIncrease + result.directDamageFromShop);
    add(shop.reduction, result.actualReduction);
    add(shop.recovery, result.actualRecovery);
    shop.info += result.informationUseCount;
  }
  for (const event of run.shopUseEvents) {
    const itemId = event.payload?.itemId;
    const shop = aggregate.shops[itemId];
    if (!shop) continue;
    if (itemId === 'protective-rosary' && event.type === 'SHOP_USED') shop.rosaryTargets += 1;
    if (itemId === 'protective-rosary' && event.type === 'SHOP_EFFECT_APPLIED' && event.payload.effect === 'SHOP_ALLY_DIRECT_REDUCTION' && event.payload.prevented > 0) shop.rosaryOthersProtected += 1;
    if (itemId === 'hell-chain' && event.type === 'SHOP_EFFECT_APPLIED' && event.payload.effect === 'TARGET_CHANGE_PREVENTED_ONCE_ATTACK') shop.hellChainPrevented += 1;
    if (itemId === 'six-realms-chain' && event.type === 'SHOP_EFFECT_APPLIED' && event.payload.effect === 'TARGET_CHANGE_PREVENTED') shop.sixChainPrevented += 1;
    if (itemId === 'blood-divination-needle' && event.type === 'SHOP_INFORMATION_REVEALED') {
      shop.bloodAttackInfo += event.payload?.result?.includes('「攻撃」です') ? 1 : 0;
      shop.bloodSelfTargetInfo += event.payload?.result?.includes('あなたです') ? 1 : 0;
    }
  }
  const sixPreventionsByTurn = new Map();
  for (const event of run.shopUseEvents.filter(event => event.type === 'SHOP_EFFECT_APPLIED' && event.payload?.itemId === 'six-realms-chain' && event.payload?.effect === 'TARGET_CHANGE_PREVENTED')) {
    const key = `${event.payload.participantId}:${event.globalTurnIndex}`;
    sixPreventionsByTurn.set(key, (sixPreventionsByTurn.get(key) || 0) + 1);
  }
  aggregate.shops['six-realms-chain'].sixChainMultiUse += [...sixPreventionsByTurn.values()].filter(count => count >= 2).length;
  const useByInventory = new Map();
  for (const event of run.shopUseEvents.filter(event => event.type === 'SHOP_USED')) {
    const key = event.payload.shopEntryId;
    const current = useByInventory.get(key) || { itemId: event.payload.itemId, turns: [] };
    current.turns.push(event.payload.globalTurnIndex);
    useByInventory.set(key, current);
  }
  for (const entry of useByInventory.values()) {
    const row = aggregate.shops[entry.itemId];
    row.usedInventories += 1;
    add(row.firstUses, Math.min(...entry.turns));
    add(row.lastUses, Math.max(...entry.turns));
  }
  for (const telemetry of run.stationTelemetry) {
    const station = aggregate.stations[telemetry.stationId];
    add(station.startHp, average(Object.values(telemetry.startHp)));
    add(station.endHp, average(Object.values(telemetry.endHp)));
    add(station.damage, telemetry.damage);
    add(station.recovery, telemetry.recovery);
    add(station.zeroPlayers, telemetry.hpZeroPlayers.length);
    station.supportAwardGames += telemetry.supportAwarded ? 1 : 0;
    add(station.specialWinners, telemetry.specialWinners);
    station.scores.push(...telemetry.stationScores);
    for (const turn of telemetry.turnDeltas) station.turnDeltas.push(average(Object.values(turn.afterHp)) - average(Object.values(turn.beforeHp)));
  }
  add(aggregate.economy.issuedOne, run.issuedOne);
  add(aggregate.economy.paymentValue, run.paymentValue);
  add(aggregate.economy.shopPurchases, run.shopPurchases);
  add(aggregate.economy.shopUses, run.shopUses);
  for (const type of Object.keys(CURRENCY_VALUES)) add(aggregate.economy.holdings[type], run.totalHoldings[type]);
  for (const type of Object.keys(CURRENCY_VALUES)) add(aggregate.economy.generated[type], run.generated[type]);
  for (const type of specialTypes) add(aggregate.economy.spentAfterGenerated[type], Math.min(run.shopTelemetry.generatedSpecial[type], run.shopTelemetry.spentSpecial[type]));
  aggregate.economy.heaven += run.heavenPartsAvailable ? 1 : 0;
  aggregate.economy.best += run.bestEndPartsAvailable ? 1 : 0;
  aggregate.economy.routeReachedThenLost.heaven += run.shopTelemetry.routeReachedThenLost.heaven ? 1 : 0;
  aggregate.economy.routeReachedThenLost.best += run.shopTelemetry.routeReachedThenLost.best ? 1 : 0;
  for (const freeTime of run.shopTelemetry.freeTimes) {
    const station = STATIONS[freeTime.stationIndex];
    const row = aggregate.economy.freeTimes[station.id];
    add(row.newCount, freeTime.newCount);
    add(row.saleCandidateCount, freeTime.saleCandidateCount);
    add(row.soldOutCount, freeTime.soldOutCount);
    add(row.purchasablePerPlayer, average(freeTime.purchasableCounts));
  }
  const strategy = aggregate.economy.strategies[run.paymentStrategy];
  strategy.games += 1;
  add(strategy.purchases, run.shopPurchases);
  for (const type of Object.keys(CURRENCY_VALUES)) add(strategy.holdings[type], run.totalHoldings[type]);
  for (const type of Object.keys(CURRENCY_VALUES)) add(strategy.generated[type], run.generated[type]);
  strategy.heaven += run.heavenPartsAvailable ? 1 : 0;
  strategy.best += run.bestEndPartsAvailable ? 1 : 0;
  for (const violation of run.invariantViolations) aggregate.invariantViolations.push({ seed: run.seed, violation });
}

function findOutliers(runs) {
  const shopUses = runs.map(run => run.shopUses);
  const maxDamages = runs.map(run => Math.max(...run.players.map(player => player.totalDamageDealt)));
  const mean = values => values.reduce((total, value) => total + value, 0) / values.length;
  const standardDeviation = values => {
    const meanValue = mean(values);
    return Math.sqrt(values.reduce((total, value) => total + (value - meanValue) ** 2, 0) / values.length);
  };
  const shopUseThreshold = mean(shopUses) + Math.max(5, standardDeviation(shopUses) * 2);
  const maxDamageThreshold = mean(maxDamages) + Math.max(8, standardDeviation(maxDamages) * 2);
  const candidates = [];
  for (const run of runs) {
    const zero = run.players.filter(player => player.finalHp === 0).length;
    const allHigh = run.players.every(player => player.finalHp >= 10);
    const maxDamage = Math.max(...run.players.map(player => player.totalDamageDealt));
    const totalShopUse = run.shopUses;
    const reasons = [];
    if (zero === 7) reasons.push('全員HP0終了');
    else if (zero >= 6) reasons.push(`${zero}人HP0終了`);
    if (allHigh) reasons.push('全員HP10以上で終了');
    if (maxDamage >= maxDamageThreshold) reasons.push(`最大総与ダメージ${maxDamage}`);
    if (totalShopUse >= shopUseThreshold) reasons.push(`SHOP使用${totalShopUse}回`);
    if (!run.generated.two && !run.generated.three && !run.generated.five && !run.generated.seven) reasons.push('素数冥貨が生成されない');
    if (run.generated.seven >= 4) reasons.push(`漆を${run.generated.seven}枚生成`);
    if (reasons.length) candidates.push({
      seed: run.seed,
      run: run.run,
      reasons,
      finalHp: run.players.map(player => player.finalHp),
      paymentStrategy: run.paymentStrategy,
      shopUses: totalShopUse,
      generated: run.generated,
      severity: (zero >= 6 ? 1000 : 0) + (allHigh ? 800 : 0) + (maxDamage >= maxDamageThreshold ? 600 : 0) + (totalShopUse >= shopUseThreshold ? 500 : 0) + (run.generated.seven >= 4 ? 400 : 0) + (!run.generated.two && !run.generated.three && !run.generated.five && !run.generated.seven ? 100 : 0)
    });
  }
  const selected = [];
  const takeFirst = predicate => {
    const match = candidates.filter(predicate).sort((a, b) => b.severity - a.severity || a.seed - b.seed)[0];
    if (match && !selected.includes(match)) selected.push(match);
  };
  // 同じ「素数冥貨なし」のケースだけで埋めず、再現に役立つ異なる種類の外れ値を優先する。
  takeFirst(item => item.finalHp.filter(value => value === 0).length >= 6);
  takeFirst(item => item.reasons.some(reason => reason.startsWith('最大総与ダメージ')));
  takeFirst(item => item.reasons.some(reason => reason.startsWith('SHOP使用')));
  takeFirst(item => item.reasons.includes('素数冥貨が生成されない'));
  takeFirst(item => item.reasons.some(reason => reason.startsWith('漆を')));
  for (const item of candidates.sort((a, b) => b.severity - a.severity || a.seed - b.seed)) {
    if (selected.length >= 5) break;
    if (!selected.includes(item)) selected.push(item);
  }
  return selected.slice(0, 5).map(({ severity, ...item }) => item);
}

function packRows(aggregate, runs) {
  const games = runs.length;
  return Object.values(aggregate.packs).map(pack => ({
    pack: pack.name,
    avgRank: average(pack.finalRank.values),
    firstRate: ratio(pack.first, games),
    top3Rate: ratio(pack.top3, games),
    lastRate: ratio(pack.last, games),
    zeroRate: ratio(pack.zero, games),
    avgHp: average(pack.finalHp.values),
    avgDamage: average(pack.damageDealt.values),
    avgTaken: average(pack.damageTaken.values),
    avgSupport: average(pack.support.values),
    avgStationRank: average(pack.stationRanks),
    specialRate: ratio(sum(pack.special.values), games),
    assignments: pack.assignmentsByPlayer
  }));
}

function reviewCandidates(aggregate, runs) {
  const notes = { packs: [], cards: [], shops: [], stations: [] };
  const packs = packRows(aggregate, runs);
  const overallRank = average(packs.map(pack => pack.avgRank));
  for (const pack of packs) if (Math.abs(pack.avgRank - overallRank) >= 0.55 || pack.firstRate >= 0.28 || pack.lastRate >= 0.28) notes.packs.push(`${pack.pack}: 平均順位${decimal(pack.avgRank)}、1位率${percent(pack.firstRate)}、最下位率${percent(pack.lastRate)}`);
  for (const card of Object.values(aggregate.cards)) {
    const rate = ratio(card.resolved, card.selected);
    if (card.selected >= 25 && (rate <= 0.35 || card.fizzled + card.nullified >= card.selected * 0.5)) notes.cards.push(`${card.name}: 選択${card.selected}回、成立率${percent(rate)}、不発${card.fizzled}、無効${card.nullified}`);
    if (!card.selected) notes.cards.push(`${card.name}: 100ゲームで未選択`);
  }
  for (const shop of Object.values(aggregate.shops)) {
    if (!shop.purchase) notes.shops.push(`${shop.name}: 未購入`);
    else if (!shop.use) notes.shops.push(`${shop.name}: 購入${shop.purchase}回だが未使用`);
    else if (shop.use / shop.purchase >= 2.5) notes.shops.push(`${shop.name}: 1購入あたり${decimal(shop.use / shop.purchase)}回使用`);
  }
  for (const station of Object.values(aggregate.stations)) {
    const loss = average(station.startHp.values) - average(station.endHp.values);
    if (loss >= 3 || average(station.zeroPlayers.values) >= 1.2) notes.stations.push(`${station.name}: 平均HP変化${decimal(-loss)}、駅中HP0人数${decimal(average(station.zeroPlayers.values))}`);
  }
  return notes;
}

function legacyReference() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', 'balance-simulation-100.json'), 'utf8'));
    const counterAverage = counter => average(counter?.values || []);
    const economy = raw.aggregate?.economy;
    const players = raw.runs?.flatMap(run => run.players || []) || [];
    return {
      label: '旧SHOP配置・効果を含む参考データ（balance-simulation-100）',
      averagePurchases: counterAverage(economy?.shopPurchases),
      averageUses: counterAverage(economy?.shopUses),
      averageFinalHp: average(players.map(player => player.finalHp)),
      heavenRate: ratio(economy?.heaven || 0, raw.runs?.length || 0),
      bestRate: ratio(economy?.best || 0, raw.runs?.length || 0),
      bloodAverageRank: counterAverage(raw.aggregate?.packs?.blood?.finalRank)
    };
  } catch {
    return null;
  }
}

function economyFailureSignals(runs) {
  const signals = { oneSupplyShortage: 0, purchaseCountShortage: 0, overpaymentHeadroomShortage: 0, paymentDecision: 0, specialCoinRespent: 0, unlockTiming: 0, shopPurchaseAi: 0, deadStateRewardLoss: 0 };
  for (const run of runs.filter(run => !run.bestEndPartsAvailable)) {
    const generatedSpecial = sum(specialTypes.map(type => run.generated[type]));
    const latePurchases = Object.entries(run.shopTelemetry.byItem).filter(([itemId, row]) => SHOP_ITEMS.find(item => item.id === itemId)?.shop >= 5).reduce((total, [, row]) => total + row.purchaseStations.length, 0);
    const opportunityCount = sum(Object.values(run.shopTelemetry.byItem).map(row => row.purchaseOpportunityCount));
    const hpZeroPlayers = run.players.filter(player => player.hpZeroCount > 0).length;
    if (run.issuedOne < 40) signals.oneSupplyShortage += 1;
    if (run.shopPurchases < 6) signals.purchaseCountShortage += 1;
    if (generatedSpecial < 3) signals.overpaymentHeadroomShortage += 1;
    if (!generatedSpecial && run.shopPurchases) signals.paymentDecision += 1;
    if (sum(specialTypes.map(type => Math.min(run.shopTelemetry.generatedSpecial[type], run.shopTelemetry.spentSpecial[type]))) > 0 || run.shopTelemetry.routeReachedThenLost.best) signals.specialCoinRespent += 1;
    if (!latePurchases) signals.unlockTiming += 1;
    if (opportunityCount >= 15 && run.shopPurchases <= 2) signals.shopPurchaseAi += 1;
    if (hpZeroPlayers >= 4) signals.deadStateRewardLoss += 1;
  }
  return signals;
}

function topPurchasedItems(pack, limit = 5) {
  return Object.entries(pack.purchasedItems)
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([itemId, count]) => `${SHOP_ITEMS.find(item => item.id === itemId)?.name || itemId}×${count}`)
    .join('、') || 'なし';
}

function markdownReport(options, runs, aggregate) {
  const totalPlayers = runs.length * 7;
  const allPlayers = runs.flatMap(run => run.players);
  const finalHp = allPlayers.map(player => player.finalHp);
  const zeroFinal = allPlayers.filter(player => player.finalHp === 0).length;
  const everZero = allPlayers.filter(player => player.hpZeroCount > 0).length;
  const earlyZero = runs.flatMap(run => run.stationTelemetry.filter(station => station.stationIndex <= 4).flatMap(station => station.hpZeroPlayers)).length;
  const sixthZero = runs.flatMap(run => run.stationTelemetry.filter(station => station.stationIndex === 5).flatMap(station => station.hpZeroPlayers)).length;
  const seventhZero = runs.flatMap(run => run.stationTelemetry.filter(station => station.stationIndex === 6).flatMap(station => station.hpZeroPlayers)).length;
  const sixthEndZero = runs.flatMap(run => run.stationTelemetry.filter(station => station.stationIndex === 5).map(station => Object.values(station.endHp).filter(hp => hp === 0).length)).reduce((total, value) => total + value, 0);
  const seventhEndZero = runs.flatMap(run => run.stationTelemetry.filter(station => station.stationIndex === 6).map(station => Object.values(station.endHp).filter(hp => hp === 0).length)).reduce((total, value) => total + value, 0);
  const neverDead = allPlayers.filter(player => !player.hpZeroCount).length;
  const multiDead = allPlayers.filter(player => player.deadStations.length >= 2).length;
  const packs = packRows(aggregate, runs);
  const reviews = reviewCandidates(aggregate, runs);
  const outliers = findOutliers(runs);
  const cardRows = Object.values(aggregate.cards).map(card => `| ${PACKS.find(pack => pack.id === card.packId)?.name || card.packId} | ${card.name} | ${card.selected} | ${percent(ratio(card.selected, runs.length * 25))} | ${card.resolved} | ${card.fizzled} | ${card.nullified} | ${percent(ratio(card.resolved, card.selected))} | ${decimal(ratio(card.damage.sum, card.selected))} | ${decimal(ratio(card.heal.sum, card.selected))} | ${decimal(ratio(card.reduction.sum, card.selected))} | ${card.stateSuccess} |`).join('\n');
  const shopRows = Object.values(aggregate.shops).map(shop => `| ${shop.name} | ${shop.unlock} | ${decimal(shop.purchaseOpportunities / runs.length)} | ${shop.purchase} | ${percent(ratio(shop.purchase, runs.length))} | ${percent(ratio(shop.purchase, shop.purchaseOpportunities))} | ${decimal(average(shop.purchaseStations.values))} | ${shop.use} | ${Math.max(0, shop.use - shop.usedInventories)} | ${decimal(ratio(shop.use, shop.purchase))} | ${shop.applied} | ${shop.failed} | ${decimal(ratio(shop.damageIncrease.sum, shop.use))} | ${decimal(ratio(shop.reduction.sum, shop.use))} | ${decimal(ratio(shop.recovery.sum, shop.use))} | ${shop.info} |`).join('\n');
  const stationRows = Object.values(aggregate.stations).map(station => `| ${station.name} | ${decimal(average(station.startHp.values))} | ${decimal(average(station.endHp.values))} | ${decimal(average(station.damage.values))} | ${decimal(average(station.recovery.values))} | ${decimal(average(station.zeroPlayers.values))} | ${percent(ratio(sum(station.zeroPlayers.values), runs.length * 7))} | ${percent(ratio(station.supportAwardGames, runs.length))} | ${percent(ratio(sum(station.specialWinners.values), runs.length * 7))} | ${decimal(average(station.scores))} | ${decimal(median(station.scores))} | ${decimal(average(station.turnDeltas))} |`).join('\n');
  const packTable = packs.map(pack => `| ${pack.pack} | ${decimal(pack.avgHp)} | ${decimal(pack.avgRank)} | ${percent(pack.firstRate)} | ${percent(pack.top3Rate)} | ${percent(pack.lastRate)} | ${percent(pack.zeroRate)} | ${decimal(pack.avgDamage)} | ${decimal(pack.avgTaken)} | ${decimal(pack.avgSupport)} | ${decimal(pack.avgStationRank)} | ${percent(pack.specialRate)} | ${pack.assignments.join('/')} |`).join('\n');
  const strategyRows = Object.entries(aggregate.economy.strategies).map(([name, result]) => `| ${name} | ${result.games} | ${decimal(average(result.purchases.values))} | ${decimal(average(result.holdings.two.values))} | ${decimal(average(result.holdings.three.values))} | ${decimal(average(result.holdings.five.values))} | ${decimal(average(result.holdings.seven.values))} | ${percent(ratio(result.heaven, result.games))} | ${percent(ratio(result.best, result.games))} |`).join('\n');
  const playerRows = aggregate.players.map(row => `| PL${row.playerNumber} | ${decimal(average(row.finalHp.values))} | ${decimal(median(row.finalHp.values))} | ${decimal(average(row.finalRank.values))} | ${percent(ratio(row.first, runs.length))} | ${percent(ratio(row.last, runs.length))} | ${row.zeroReached} | ${percent(ratio(row.zeroReached, runs.length))} | ${decimal(average(row.deadStations.values))} | ${decimal(average(row.damageDealt.values))} | ${decimal(average(row.damageTaken.values))} | ${decimal(average(row.support.values))} | ${decimal(average(row.stationRanks))} | ${decimal(average(row.special.values))} | ${decimal(average(row.cardUses.values))} | ${decimal(average(row.shopUses.values))} | ${decimal(average(row.shopPurchases.values))} |`).join('\n');
  const outlierRows = outliers.length ? outliers.map(item => `| ${item.run} | ${item.seed} | ${item.paymentStrategy} | ${item.finalHp.join('/')} | ${item.shopUses} | ${currencyLabel(item.generated)} | ${item.reasons.join('、')} |`).join('\n') : '| - | - | - | - | - | - | 該当なし |';
  const review = group => reviews[group].length ? reviews[group].map(item => `- ${item}`).join('\n') : '- 該当なし';
  const specialShopRows = [
    { label: '護りの数珠', data: aggregate.shops['protective-rosary'], detail: shop => `他PLを実際に守った回数 ${shop.rosaryOthersProtected} / 対象選択率 ${percent(ratio(shop.rosaryTargets, shop.use))}` },
    { label: '針除けの護符', data: aggregate.shops['needle-ward'], detail: shop => `実軽減合計 ${decimal(shop.reduction.sum)}` },
    { label: '地獄の鎖', data: aggregate.shops['hell-chain'], detail: shop => `初回対象変更を防止 ${shop.hellChainPrevented} / 未発動 ${Math.max(0, shop.use - shop.hellChainPrevented)}` },
    { label: '六道の鎖', data: aggregate.shops['six-realms-chain'], detail: shop => `対象変更防止総数 ${shop.sixChainPrevented} / 1使用で2回以上 ${shop.sixChainMultiUse}` },
    { label: '鬼の眼', data: aggregate.shops['demon-eye'], detail: shop => `情報使用 ${shop.info}` },
    { label: '血占いの針', data: aggregate.shops['blood-divination-needle'], detail: shop => `攻撃判定 ${shop.bloodAttackInfo} / 自分が対象 ${shop.bloodSelfTargetInfo} / 行動変更: AIモデルでは反実仮想を持たないため未計測` },
    { label: '閻魔の眼', data: aggregate.shops['enma-eye'], detail: shop => `情報使用 ${shop.info}` }
  ].map(({ label, data, detail }) => `| ${label} | ${data.purchase} | ${data.use} | ${decimal(ratio(data.use, data.purchase))} | ${detail(data)} |`).join('\n');
  const freeTimeRows = Object.entries(aggregate.economy.freeTimes).map(([stationId, row]) => `| ${STATIONS.find(station => station.id === stationId)?.name || stationId}後 | ${decimal(average(row.newCount.values))} | ${decimal(average(row.saleCandidateCount.values))} | ${decimal(average(row.soldOutCount.values))} | ${decimal(average(row.purchasablePerPlayer.values))} |`).join('\n');
  const packShopRows = Object.values(aggregate.packs).map(pack => `| ${pack.name} | ${decimal(average(pack.shopPurchases.values))} | ${decimal(average(pack.shopUses.values))} | ${topPurchasedItems(pack)} |`).join('\n');
  const lateShopRows = [3, 4, 5, 6].map(shopNumber => {
    const rows = Object.values(aggregate.shops).filter(shop => shop.shop === shopNumber);
    return `| 第${shopNumber}SHOP | ${decimal(sum(rows.map(shop => shop.purchase)) / (rows.length * runs.length))} | ${rows.map(shop => `${shop.name}: ${decimal(shop.purchase / runs.length)}`).join('、')} |`;
  }).join('\n');
  const failureSignals = economyFailureSignals(runs);
  const reference = legacyReference();
  return `# バランス自動シミュレーション（${runs.length}ゲーム）\n\n` +
`- 実行コマンド: \`npm run simulate:balance -- --runs=${options.runs} --seed=${options.seed}\`\n` +
`- seed: run 001 = ${options.seed}、以後1ずつ加算\n` +
`- 七獄パック割当: 各runでPL番号をローテーション（各パック→各PLは${Math.floor(runs.length / 7)}～${Math.ceil(runs.length / 7)}回）\n` +
`- AI: RANDOM / BALANCED / AGGRESSIVE / DEFENSIVE をPLごとにローテーション。支払い方針はゲーム単位で4種をローテーション。\n` +
`- 注意: 数値を最適化するAIではなく、実戦の傾向を見るための簡易方針である。\n\n` +
`## 完走・不変条件\n\n` +
`- 完走: ${runs.length}/${runs.length}\n` +
`- 不変条件違反: ${aggregate.invariantViolations.length}件\n` +
(aggregate.invariantViolations.length ? aggregate.invariantViolations.slice(0, 20).map(item => `  - seed ${item.seed}: ${item.violation}`).join('\n') + '\n' : '') +
`\n## HP15の観測\n\n` +
`- 平均最終HP: ${decimal(average(finalHp))}\n` +
`- 最終HP0率: ${percent(ratio(zeroFinal, totalPlayers))}\n` +
`- 一度以上HP0到達: ${percent(ratio(everZero, totalPlayers))}\n` +
`- 第5地獄以前のHP0イベント（駅単位・重複あり）: ${earlyZero} / ${runs.length * 5 * 7}（${percent(ratio(earlyZero, runs.length * 5 * 7))}）\n` +
`- 第6地獄のHP0イベント: ${sixthZero} / ${totalPlayers}（${percent(ratio(sixthZero, totalPlayers))}）、終了時HP0: ${sixthEndZero} / ${totalPlayers}（${percent(ratio(sixthEndZero, totalPlayers))}）\n` +
`- 第7地獄のHP0イベント: ${seventhZero} / ${totalPlayers}（${percent(ratio(seventhZero, totalPlayers))}）、終了時HP0: ${seventhEndZero} / ${totalPlayers}（${percent(ratio(seventhEndZero, totalPlayers))}）\n` +
`- 一度も亡者にならないPL率: ${percent(ratio(neverDead, totalPlayers))}\n` +
`- 複数駅で亡者になるPL率: ${percent(ratio(multiDead, totalPlayers))}\n\n` +
`## PL番号別\n\n| PL | 平均最終HP | HP中央値 | 平均最終順位 | 1位率 | 最下位率 | HP0到達ゲーム数 | HP0到達率 | 平均亡者駅数 | 平均与ダメ | 平均被ダメ | 平均支援 | 駅順位平均 | 特殊条件/ゲーム | 七獄使用 | SHOP使用 | SHOP購入 |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${playerRows}\n\n` +
`## パック別\n\n| パック | 平均最終HP | 平均最終順位 | 1位率 | 上位3位率 | 最下位率 | HP0率 | 平均与ダメ | 平均被ダメ | 平均支援 | 駅順位平均 | 特殊条件/ゲーム | PL1→PL7割当 |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|\n${packTable}\n\n` +
`## 七獄カード別\n\n| パック | カード | 選択/使用 | 使用率（各パック25ターン基準） | 成立 | 不発 | 無効 | 成立率 | 平均実ダメージ | 平均実回復 | 平均実軽減 | 状態付与 |\n|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${cardRows}\n\n` +
`## SHOP別\n\n| SHOP | 解禁回数 | 購入可能機会/ゲーム | 購入 | 購入ゲーム率 | 機会あたり購入率 | 平均購入駅 | 使用 | 再使用 | 1購入あたり使用 | 発動 | 不発 | 平均ダメージ増加 | 平均実軽減 | 平均実回復 | 情報使用 |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${shopRows}\n\n` +
`### 差別化・情報系SHOPの重点計測\n\n| SHOP | 購入 | 使用 | 1購入あたり使用 | 重点指標 |\n|---|---:|---:|---:|---|\n${specialShopRows}\n\n` +
`### 後半SHOPの新規商品購入\n\n| 解禁SHOP | 商品あたり平均購入数/ゲーム | 個別購入数/ゲーム |\n|---|---:|---|\n${lateShopRows}\n\n` +
`### 自由時間ごとの累計販売候補\n\n| 自由時間 | NEW | 販売中 | SOLD OUT | PL1人あたり購入可能商品 |\n|---|---:|---:|---:|---:|\n${freeTimeRows}\n\n` +
`### パック別SHOP利用\n\n| パック | 平均SHOP購入 | 平均SHOP使用 | 最頻購入SHOP上位5 |\n|---|---:|---:|---|\n${packShopRows}\n\n` +
`## 駅別\n\n| 駅 | 開始平均HP | 終了平均HP | 駅中ダメージ | 駅中回復 | HP0人数/ゲーム | 亡者発生率 | 支援賞発生率 | 特殊条件達成率 | 駅スコア平均 | 駅スコア中央値 | ターン平均HP変化 |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${stationRows}\n\n` +
`## 冥貨経済\n\n` +
`- 平均発行壱: ${decimal(average(aggregate.economy.issuedOne.values))}\n` +
`- 平均SHOP支払総額: ${decimal(average(aggregate.economy.paymentValue.values))}\n` +
`- 平均最終所持: 壱 ${decimal(average(aggregate.economy.holdings.one.values))} / 弐 ${decimal(average(aggregate.economy.holdings.two.values))} / 参 ${decimal(average(aggregate.economy.holdings.three.values))} / 伍 ${decimal(average(aggregate.economy.holdings.five.values))} / 漆 ${decimal(average(aggregate.economy.holdings.seven.values))}\n` +
`- 平均SHOP購入数: ${decimal(average(aggregate.economy.shopPurchases.values))}\n` +
`- 平均SHOP使用数: ${decimal(average(aggregate.economy.shopUses.values))}\n` +
`- 平均おつり生成: 弐 ${decimal(average(aggregate.economy.generated.two.values))} / 参 ${decimal(average(aggregate.economy.generated.three.values))} / 伍 ${decimal(average(aggregate.economy.generated.five.values))} / 漆 ${decimal(average(aggregate.economy.generated.seven.values))}\n` +
`- 天国線必要パーツ（弐×2・参×2・伍×1）が物理的に揃う率: ${percent(ratio(aggregate.economy.heaven, runs.length))}\n` +
`- 最高END必要パーツ（＋漆×1）が物理的に揃う率: ${percent(ratio(aggregate.economy.best, runs.length))}\n\n` +
`- 生成後に再支払いされた特殊冥貨（生成量を上限にした近似）: 弐 ${decimal(average(aggregate.economy.spentAfterGenerated.two.values))} / 参 ${decimal(average(aggregate.economy.spentAfterGenerated.three.values))} / 伍 ${decimal(average(aggregate.economy.spentAfterGenerated.five.values))} / 漆 ${decimal(average(aggregate.economy.spentAfterGenerated.seven.values))}\n` +
`- 必要数を一度満たした後に再支払いで下回ったゲーム: 天国線 ${aggregate.economy.routeReachedThenLost.heaven} / 最高END ${aggregate.economy.routeReachedThenLost.best}\n\n` +
`### 支払い方針別\n\n| 方針 | ゲーム | 平均SHOP購入 | 平均弐 | 平均参 | 平均伍 | 平均漆 | 天国線パーツ率 | 最高ENDパーツ率 |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${strategyRows}\n\n` +
`### 最高ENDパーツ未達の診断信号（重複計上）\n\n| 信号 | 該当ゲーム数 |\n|---|---:|\n| 壱供給不足（発行壱40未満） | ${failureSignals.oneSupplyShortage} |\n| 購入回数不足（6未満） | ${failureSignals.purchaseCountShortage} |\n| 過払い・おつり不足（特殊冥貨生成3未満） | ${failureSignals.overpaymentHeadroomShortage} |\n| 支払い判断（購入したが特殊冥貨生成なし） | ${failureSignals.paymentDecision} |\n| 素数冥貨の再支払い | ${failureSignals.specialCoinRespent} |\n| 後半商品を購入しない（解禁時期影響） | ${failureSignals.unlockTiming} |\n| 購入可能機会が多いのに購入が少ないAI | ${failureSignals.shopPurchaseAi} |\n| HP0到達者4人以上（報酬減少の可能性） | ${failureSignals.deadStateRewardLoss} |\n\n` +
`## 旧100ゲーム（参考データ）との比較\n\n` +
(reference ? `- ${reference.label}\n\n| 指標 | 旧 | 今回 | 差分（今回−旧） |\n|---|---:|---:|---:|\n| 平均SHOP購入 | ${decimal(reference.averagePurchases)} | ${decimal(average(aggregate.economy.shopPurchases.values))} | ${decimal(average(aggregate.economy.shopPurchases.values) - reference.averagePurchases)} |\n| 平均SHOP使用 | ${decimal(reference.averageUses)} | ${decimal(average(aggregate.economy.shopUses.values))} | ${decimal(average(aggregate.economy.shopUses.values) - reference.averageUses)} |\n| 血の池平均順位 | ${decimal(reference.bloodAverageRank)} | ${decimal(aggregate.packs.blood.finalRank.values.length ? average(aggregate.packs.blood.finalRank.values) : 0)} | ${decimal(average(aggregate.packs.blood.finalRank.values) - reference.bloodAverageRank)} |\n| 平均最終HP | ${decimal(reference.averageFinalHp)} | ${decimal(average(finalHp))} | ${decimal(average(finalHp) - reference.averageFinalHp)} |\n| 天国線成立率 | ${percent(reference.heavenRate)} | ${percent(ratio(aggregate.economy.heaven, runs.length))} | - |\n| 最高END成立率 | ${percent(reference.bestRate)} | ${percent(ratio(aggregate.economy.best, runs.length))} | - |\n\n` : '- 旧参照データが見つからないため、比較表は生成していません。\n\n') +
`## 外れ値（再現用seed）\n\n| run | seed | 支払い方針 | 最終HP（PL1→7） | SHOP使用 | おつり生成 | 条件 |\n|---:|---:|---|---|---:|---|---|\n${outlierRows}\n\n` +
`## 要確認候補（今回は調整しない）\n\n### パック\n${review('packs')}\n\n### 七獄カード\n${review('cards')}\n\n### SHOP\n${review('shops')}\n\n### 駅\n${review('stations')}\n`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const runs = [];
  const aggregate = makeAggregate();
  for (let index = 0; index < options.runs; index += 1) {
    const seed = options.seed + index;
    try {
      const result = runSingleGame(index, seed, options.paymentStrategy);
      runs.push(result);
      mergeRun(aggregate, result);
    } catch (error) {
      runs.push({ run: index + 1, seed, error: error.stack || error.message, invariantViolations: [`SIMULATION_ERROR: ${error.message}`] });
      aggregate.invariantViolations.push({ seed, violation: `SIMULATION_ERROR: ${error.message}` });
    }
  }
  const outputBase = options.output || `balance-simulation-${options.runs}`;
  const reportDir = path.join(ROOT, 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const jsonPath = path.join(reportDir, `${outputBase}.json`);
  const markdownPath = path.join(reportDir, `${outputBase}.md`);
  const completed = runs.filter(run => !run.error);
  const serializableRuns = completed.map(({ cardEvents, cardUsages, shopUseEvents, stationTelemetry, ...run }) => ({
    ...run,
    stationTelemetry: stationTelemetry.map(({ startHp, endHp, turnDeltas, ...station }) => ({
      ...station,
      startAverageHp: average(Object.values(startHp)),
      endAverageHp: average(Object.values(endHp)),
      turnAverageHpChanges: turnDeltas.map(turn => average(Object.values(turn.afterHp)) - average(Object.values(turn.beforeHp)))
    }))
  }));
  fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), options, aggregate, runs: serializableRuns }, null, 2), 'utf8');
  fs.writeFileSync(markdownPath, markdownReport(options, completed, aggregate), 'utf8');
  console.log(`balance simulation: ${completed.length}/${options.runs} completed`);
  console.log(`report: ${path.relative(ROOT, markdownPath)}`);
  console.log(`data: ${path.relative(ROOT, jsonPath)}`);
  if (aggregate.invariantViolations.length) process.exitCode = 1;
}

main();
