import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARD_BY_ID, SHOP_ITEM_BY_ID, STATIONS } from '../src/definitions.js';
import { runSingleGame } from './simulate-balance.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLOOD_CARDS = ['vampire', 'blood-murk', 'blood-shield', 'healing-blood', 'transfusion'];
const LATE_SHOPS = ['enma-eye', 'six-realms-chain', 'infinite-slip'];
const BLOOD_SHOPS = ['red-bandage', 'protective-rosary', 'shared-life-cup', 'bloodstop-charm', 'war-mask', 'battle-medicine'];
const LABEL = Object.freeze({
  vampire: '吸血', 'blood-murk': '血濁', 'blood-shield': '血の盾', 'healing-blood': '治癒血', transfusion: '輸血',
  'red-bandage': '赤い包帯', 'protective-rosary': '護りの数珠', 'shared-life-cup': '共命の杯', 'bloodstop-charm': '血止めの護符', 'war-mask': '修羅の面', 'battle-medicine': '戦傷薬',
  'enma-eye': '閻魔の眼', 'six-realms-chain': '六道の鎖', 'infinite-slip': '無間の札'
});

const sum = values => values.reduce((total, value) => total + Number(value || 0), 0);
const average = values => values.length ? sum(values) / values.length : 0;
const ratio = (numerator, denominator) => denominator ? numerator / denominator : 0;
const decimal = value => Number(value || 0).toFixed(2);
const percent = value => `${(value * 100).toFixed(1)}%`;
const counter = () => ({ values: [], sum: 0, count: 0 });
const add = (row, value) => { row.values.push(Number(value || 0)); row.sum += Number(value || 0); row.count += 1; };
const avg = row => average(row.values);
const pearson = (xs, ys) => {
  if (xs.length < 2 || xs.length !== ys.length) return 0;
  const xMean = average(xs); const yMean = average(ys);
  const numerator = sum(xs.map((x, index) => (x - xMean) * (ys[index] - yMean)));
  const xDev = Math.sqrt(sum(xs.map(x => (x - xMean) ** 2)));
  const yDev = Math.sqrt(sum(ys.map(y => (y - yMean) ** 2)));
  return xDev && yDev ? numerator / (xDev * yDev) : 0;
};

function rankAggregate() {
  return { games: 0, rank: counter(), hp: counter(), damage: counter(), support: counter(), taken: counter(), first: 0, last: 0 };
}
function addRank(aggregate, player, rank = player.finalRank) {
  aggregate.games += 1;
  add(aggregate.rank, rank); add(aggregate.hp, player.finalHp); add(aggregate.damage, player.totalDamageDealt); add(aggregate.support, player.totalSupport); add(aggregate.taken, player.totalDamageTaken);
  aggregate.first += rank === 1 ? 1 : 0; aggregate.last += rank === 7 ? 1 : 0;
}
function rankRow(aggregate) {
  return `${rankCells(aggregate)} |`;
}
function rankCells(aggregate) {
  return `${aggregate.games} | ${decimal(avg(aggregate.rank))} | ${percent(ratio(aggregate.first, aggregate.games))} | ${percent(ratio(aggregate.last, aggregate.games))} | ${decimal(avg(aggregate.hp))} | ${decimal(avg(aggregate.damage))} | ${decimal(avg(aggregate.support))} | ${decimal(avg(aggregate.taken))}`;
}
function playerById(run, id) { return run.players.find(player => player.participantId === id); }
function bloodPlayers(run) { return run.players.filter(player => player.packId === 'blood'); }

function createBloodAggregate() {
  return {
    cards: Object.fromEntries(BLOOD_CARDS.map(id => [id, {
      available: 0, selected: 0, resolved: 0, fizzled: 0, nullified: 0,
      damage: 0, healing: 0, reduction: 0, reflection: 0, selfHeal: 0, selfDamage: 0, support: 0, score: 0,
      rankPairs: [[], []]
    }])),
    overall: rankAggregate(),
    paths: { rank: [], hp: [], damage: [], support: [], taken: [] },
    healGroups: { healed: rankAggregate(), none: rankAggregate(), targetRank: counter(), rankGap: counter(), targetHp: counter(), events: 0 },
    seats: Object.fromEntries(Array.from({ length: 7 }, (_, index) => [index + 1, rankAggregate()])),
    shop: Object.fromEntries(BLOOD_SHOPS.map(id => [id, { purchase: 0, use: 0, applied: 0, failed: 0, effect: 0, affordable: 0, insufficient: 0, soldOut: 0 }]))
  };
}

function addBloodRun(aggregate, run) {
  const blood = bloodPlayers(run);
  const cardsByPlayer = new Map(blood.map(player => [player.participantId, player]));
  for (const snapshot of run.cardAvailability.filter(item => item.packId === 'blood')) {
    for (const cardId of BLOOD_CARDS) if (snapshot.availableCardIds.includes(cardId)) aggregate.cards[cardId].available += 1;
  }
  for (const bloodPlayer of blood) {
    addRank(aggregate.overall, bloodPlayer);
    addRank(aggregate.seats[bloodPlayer.playerNumber], bloodPlayer);
    aggregate.paths.rank.push(bloodPlayer.finalRank);
    aggregate.paths.hp.push(bloodPlayer.finalHp);
    aggregate.paths.damage.push(bloodPlayer.totalDamageDealt);
    aggregate.paths.support.push(bloodPlayer.totalSupport);
    aggregate.paths.taken.push(bloodPlayer.totalDamageTaken);
    const cardCounts = Object.fromEntries(BLOOD_CARDS.map(id => [id, 0]));
    for (const usage of run.cardUsages.filter(use => use.playerNumber === bloodPlayer.playerNumber && BLOOD_CARDS.includes(use.cardId))) {
      const row = aggregate.cards[usage.cardId];
      row.selected += 1; cardCounts[usage.cardId] += 1;
      if (usage.result === 'RESOLVED') row.resolved += 1;
      if (usage.result === 'FIZZLED') row.fizzled += 1;
      if (usage.result === 'NULLIFIED') row.nullified += 1;
    }
    for (const cardId of BLOOD_CARDS) {
      aggregate.cards[cardId].rankPairs[0].push(cardCounts[cardId]);
      aggregate.cards[cardId].rankPairs[1].push(bloodPlayer.finalRank);
    }
    const heals = run.cardEvents.filter(event => event.type === 'HEAL' && event.payload.sourceId === bloodPlayer.participantId && ['healing-blood', 'transfusion'].includes(event.payload.cardId) && event.payload.targetId !== bloodPlayer.participantId && event.payload.amount > 0);
    if (heals.length) {
      addRank(aggregate.healGroups.healed, bloodPlayer);
      const targets = heals.map(event => playerById(run, event.payload.targetId)).filter(Boolean);
      const targetRank = average(targets.map(target => target.finalRank));
      add(aggregate.healGroups.targetRank, targetRank);
      add(aggregate.healGroups.targetHp, average(targets.map(target => target.finalHp)));
      add(aggregate.healGroups.rankGap, bloodPlayer.finalRank - targetRank);
      aggregate.healGroups.events += heals.length;
    } else addRank(aggregate.healGroups.none, bloodPlayer);
  }
  for (const event of run.cardEvents) {
    const source = cardsByPlayer.get(event.payload.sourceId);
    const owner = cardsByPlayer.get(event.payload.participantId);
    const cardId = event.payload.cardId;
    if (source && BLOOD_CARDS.includes(cardId)) {
      const row = aggregate.cards[cardId];
      if (event.type === 'DIRECT_DAMAGE') { row.damage += event.payload.amount; row.score += event.payload.amount; }
      if (event.type === 'REACTION_DAMAGE') { row.damage += event.payload.amount; row.reflection += event.payload.amount; row.score += event.payload.amount; }
      if (event.type === 'HEAL') { row.healing += event.payload.amount; if (event.payload.targetId === source.participantId) row.selfHeal += event.payload.amount; }
      if (event.type === 'SUPPORT_RECORDED') row.support += event.payload.amount;
    }
    if (owner && BLOOD_CARDS.includes(cardId) && event.type === 'SELF_DAMAGE') aggregate.cards[cardId].selfDamage += event.payload.amount;
    if (source && BLOOD_CARDS.includes(cardId) && event.type === 'DEFENSE_APPLIED') aggregate.cards[cardId].reduction += event.payload.amount;
  }
  for (const transaction of run.purchaseTransactions) {
    if (cardsByPlayer.has(transaction.participantId) && aggregate.shop[transaction.itemId]) aggregate.shop[transaction.itemId].purchase += 1;
  }
  for (const event of run.shopUseEvents) {
    const row = aggregate.shop[event.payload.itemId];
    if (!row || !cardsByPlayer.has(event.payload.participantId)) continue;
    if (event.type === 'SHOP_USED') row.use += 1;
    if (event.type === 'SHOP_EFFECT_APPLIED') { row.applied += 1; row.effect += Number(event.payload.prevented || event.payload.amount || 0); }
    if (event.type === 'SHOP_EFFECT_FAILED') row.failed += 1;
  }
  for (const event of run.cardEvents.filter(event => event.type === 'HEAL' && aggregate.shop[event.payload.shopItemId])) {
    if (cardsByPlayer.has(event.payload.sourceId)) aggregate.shop[event.payload.shopItemId].effect += Number(event.payload.shopRecoveryAmount || 0);
  }
  for (const event of run.shopAffordabilityEvents || []) {
    const row = aggregate.shop[event.itemId];
    if (!row || !cardsByPlayer.has(event.participantId)) continue;
    if (event.status === 'AFFORDABLE') row.affordable += 1;
    if (event.status === 'INSUFFICIENT_CURRENCY') row.insufficient += 1;
    if (event.status === 'SOLD_OUT') row.soldOut += 1;
  }
}

function addScenarioRun(aggregate, run, { useVirtualSupportRank = false } = {}) {
  for (const player of bloodPlayers(run)) {
    let rank = player.finalRank;
    if (useVirtualSupportRank) {
      const sorted = [...run.players].sort((a, b) => b.finalHp - a.finalHp || (b.totalDamageDealt + (b.packId === 'blood' ? b.totalSupport : 0)) - (a.totalDamageDealt + (a.packId === 'blood' ? a.totalSupport : 0)) || b.totalSupport - a.totalSupport || a.totalDamageTaken - b.totalDamageTaken || a.playerNumber - b.playerNumber);
      rank = sorted.findIndex(candidate => candidate.participantId === player.participantId) + 1;
    }
    addRank(aggregate, player, rank);
  }
}

function createLateAggregate() {
  return {
    decisions: Object.fromEntries(LATE_SHOPS.map(id => [id, { PURCHASED: 0, INSUFFICIENT_CURRENCY: 0, AFFORDABLE_SKIPPED: 0, OTHER_SHOP_CHOSEN: 0, SOLD_OUT: 0, similarOwned: 0, remainingTurns: counter() }])),
    items: Object.fromEntries(LATE_SHOPS.map(id => [id, { purchase: 0, use: 0, applied: 0, failed: 0, effect: 0, info: 0, targetChanges: 0, prevented: 0, multi: 0, nullified: 0, cooldownSaved: 0, rank: rankAggregate() }]))
  };
}
function addLateRun(aggregate, run) {
  for (const decision of run.shopDecisionEvents || []) {
    const row = aggregate.decisions[decision.itemId];
    if (!row) continue;
    row[decision.status] ??= 0; row[decision.status] += 1;
    if (decision.hasSimilarOwned) row.similarOwned += 1;
    add(row.remainingTurns, decision.remainingTurns);
  }
  const playerRanks = new Map(run.players.map(player => [player.participantId, player]));
  for (const transaction of run.purchaseTransactions.filter(transaction => aggregate.items[transaction.itemId])) {
    aggregate.items[transaction.itemId].purchase += 1;
    const player = playerRanks.get(transaction.participantId);
    if (player) addRank(aggregate.items[transaction.itemId].rank, player);
  }
  const preventedByOwnerAndTurn = new Map();
  for (const event of run.shopUseEvents) {
    const row = aggregate.items[event.payload.itemId];
    if (!row) continue;
    if (event.type === 'SHOP_USED') { row.use += 1; if (event.payload.timing === 'INFO') row.info += 1; }
    if (event.type === 'SHOP_EFFECT_APPLIED') {
      row.applied += 1; row.effect += Number(event.payload.prevented || event.payload.amount || 0);
      if (event.payload.effect === 'TARGET_CHANGE_PREVENTED') {
        row.prevented += 1; row.effect += 1;
        const key = `${event.payload.participantId}:${event.globalTurnIndex}`;
        preventedByOwnerAndTurn.set(key, (preventedByOwnerAndTurn.get(key) || 0) + 1);
      }
      if (event.payload.effect === 'NORMAL_COOLDOWN_PREVENTED') { row.cooldownSaved += 1; row.effect += 1; }
    }
    if (event.type === 'SHOP_EFFECT_FAILED') row.failed += 1;
  }
  for (const event of run.cardEvents.filter(event => event.globalTurnIndex >= 21)) {
    if (event.type === 'TARGET_CHANGED_RANDOM') aggregate.items['six-realms-chain'].targetChanges += 1;
    if (event.type === 'ATTACK_COMPONENT_NULLIFIED' || event.type === 'CARRY_COMPONENT_NULLIFIED') aggregate.items['infinite-slip'].nullified += 1;
  }
  aggregate.items['six-realms-chain'].multi += [...preventedByOwnerAndTurn.values()].filter(count => count >= 2).length;
}

function runBatch({ count, seed, options = {}, onRun }) {
  for (let index = 0; index < count; index += 1) {
    const run = runSingleGame(index, seed + index, null, options);
    if (run.invariantViolations.length) throw new Error(`seed ${seed + index}: ${run.invariantViolations.join(' / ')}`);
    onRun(run);
  }
}

function main() {
  const baseline = createBloodAggregate();
  const baselineLate = createLateAggregate();
  const virtualSupport = rankAggregate();
  console.log('1/8 baseline 1000');
  runBatch({ count: 1000, seed: 20261200, onRun: run => { addBloodRun(baseline, run); addLateRun(baselineLate, run); addScenarioRun(virtualSupport, run, { useVirtualSupportRank: true }); } });

  const bloodStrategies = {};
  for (const [index, strategy] of ['BLOOD_BALANCED', 'BLOOD_SELFISH', 'BLOOD_SUPPORT'].entries()) {
    console.log(`2/8 ${strategy} 500`);
    const aggregate = rankAggregate();
    runBatch({ count: 500, seed: 20263000 + index * 1000, options: { bloodStrategy: strategy }, onRun: run => addScenarioRun(aggregate, run) });
    bloodStrategies[strategy] = aggregate;
  }

  const seats = Object.fromEntries(Array.from({ length: 7 }, (_, index) => [index + 1, rankAggregate()]));
  console.log('3/8 blood seats 700');
  for (let seat = 1; seat <= 7; seat += 1) {
    const otherPacks = ['scorch', 'ice', 'needle', 'hunger', 'war', 'infinite'];
    let cursor = seat % otherPacks.length;
    const packAssignments = Array.from({ length: 7 }, (_, index) => {
      if (index + 1 === seat) return 'blood';
      const pack = otherPacks[cursor % otherPacks.length];
      cursor += 1;
      return pack;
    });
    runBatch({ count: 100, seed: 20267000 + seat * 100, options: { packAssignments }, onRun: run => addScenarioRun(seats[seat], run) });
  }

  const sensitivity = { CURRENT: rankAggregate(), VAMPIRE_PLUS_1: rankAggregate(), HEALING_BLOOD_PLUS_1: rankAggregate(), TRANSFUSION_COST_ZERO: rankAggregate(), BLOOD_SHIELD_REFLECT_PLUS_1: rankAggregate(), SUPPORT_TIEBREAK_ONE_STEP: virtualSupport };
  sensitivity.CURRENT = baseline.overall;
  const variants = [
    ['VAMPIRE_PLUS_1', { simulationConfig: { vampireAbsorbBonus: 1 } }],
    ['HEALING_BLOOD_PLUS_1', { simulationConfig: { healingBloodBonus: 1 } }],
    ['TRANSFUSION_COST_ZERO', { simulationConfig: { transfusionSelfCostDelta: -1 } }],
    ['BLOOD_SHIELD_REFLECT_PLUS_1', { simulationConfig: { bloodShieldReflectionBonus: 1 } }]
  ];
  console.log('4/8 blood sensitivities 1200');
  for (const [index, [name, options]] of variants.entries()) runBatch({ count: 300, seed: 20270000 + index * 400, options, onRun: run => addScenarioRun(sensitivity[name], run) });

  const forced = {};
  console.log('5/8 forced late inventory 1500');
  for (const [index, itemId] of LATE_SHOPS.entries()) {
    const late = createLateAggregate(); const ranks = rankAggregate();
    runBatch({ count: 500, seed: 20272000 + index * 600, options: { forceLateShopItem: itemId }, onRun: run => { addLateRun(late, run); for (const player of run.players) addRank(ranks, player); } });
    forced[itemId] = { late, ranks };
  }

  const unlock = { BASE: baselineLate, SHOP5: createLateAggregate(), SHOP4: createLateAggregate() };
  console.log('6/8 late unlock sensitivity 600');
  runBatch({ count: 300, seed: 20275000, options: { shopSixUnlockAtStationIndex: 4 }, onRun: run => addLateRun(unlock.SHOP5, run) });
  runBatch({ count: 300, seed: 20275400, options: { shopSixUnlockAtStationIndex: 3 }, onRun: run => addLateRun(unlock.SHOP4, run) });

  const price = { CURRENT: baselineLate, MINUS_1: createLateAggregate(), MINUS_2: createLateAggregate() };
  console.log('7/8 late price sensitivity 600');
  runBatch({ count: 300, seed: 20276000, options: { shopPriceOffset: -1 }, onRun: run => addLateRun(price.MINUS_1, run) });
  runBatch({ count: 300, seed: 20276400, options: { shopPriceOffset: -2 }, onRun: run => addLateRun(price.MINUS_2, run) });

  console.log('8/8 writing report');
  const lines = buildReport({ baseline, baselineLate, bloodStrategies, seats, sensitivity, forced, unlock, price });
  const reportPath = path.join(ROOT, 'reports', 'blood-pack-and-late-shop-analysis.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines, 'utf8');
  console.log(`report: ${path.relative(ROOT, reportPath)}`);
}

function decisionCell(aggregate, id, field) { return aggregate.decisions[id]?.[field] || 0; }
function buildReport({ baseline, baselineLate, bloodStrategies, seats, sensitivity, forced, unlock, price }) {
  const cardRows = BLOOD_CARDS.map(id => {
    const row = baseline.cards[id];
    return `| ${LABEL[id]} | ${row.available} | ${row.selected} | ${percent(ratio(row.selected, row.available))} | ${percent(ratio(row.resolved, row.selected))} | ${percent(ratio(row.fizzled, row.selected))} | ${percent(ratio(row.nullified, row.selected))} | ${decimal(ratio(row.damage, row.selected))} | ${decimal(ratio(row.healing, row.selected))} | ${decimal(ratio(row.reduction, row.selected))} | ${decimal(ratio(row.reflection, row.selected))} | ${decimal(ratio(row.selfHeal - row.selfDamage, row.selected))} | ${decimal(ratio(row.support, row.selected))} | ${decimal(ratio(row.score, row.selected))} | ${decimal(pearson(...row.rankPairs))} |`;
  }).join('\n');
  const strategyRows = Object.entries(bloodStrategies).map(([name, row]) => `| ${name} | ${rankCells(row)} |\n`).join('') + `| 現行混合AI（1000戦） | ${rankCells(baseline.overall)} |\n`;
  const seatRows = Object.entries(seats).map(([seat, row]) => `| PL${seat} | ${rankCells(row)} |\n`).join('');
  const affinityRows = BLOOD_SHOPS.map(id => {
    const row = baseline.shop[id];
    return `| ${LABEL[id]} | ${row.purchase} | ${row.use} | ${percent(ratio(row.use, row.purchase))} | ${row.applied} | ${decimal(row.effect)} | ${row.affordable} | ${row.insufficient} | ${row.soldOut} |`;
  }).join('\n');
  const sensitivityRows = Object.entries(sensitivity).map(([name, row]) => `| ${name} | ${rankCells(row)} |\n`).join('');
  const lateDecisionRows = LATE_SHOPS.map(id => {
    const row = baselineLate.decisions[id];
    return `| ${LABEL[id]} | ${decisionCell(baselineLate, id, 'PURCHASED')} | ${decisionCell(baselineLate, id, 'INSUFFICIENT_CURRENCY')} | ${decisionCell(baselineLate, id, 'AFFORDABLE_SKIPPED')} | ${decisionCell(baselineLate, id, 'OTHER_SHOP_CHOSEN')} | ${decisionCell(baselineLate, id, 'SOLD_OUT')} | ${row.similarOwned} | ${decimal(avg(row.remainingTurns))} |`;
  }).join('\n');
  const lateValueRows = LATE_SHOPS.map(id => {
    const row = baselineLate.items[id];
    return `| ${LABEL[id]} | 3 | ${row.purchase} | ${row.use} | ${decimal(ratio(row.use, row.purchase))} | ${row.applied} | ${decimal(ratio(row.effect, row.use))} |`;
  }).join('\n');
  const forcedRows = LATE_SHOPS.map(id => {
    const row = forced[id].late.items[id];
    return `| ${LABEL[id]} | 500 | ${row.use} | ${percent(ratio(row.use, 500 * 7))} | ${row.applied} | ${percent(ratio(row.applied, row.use))} | ${decimal(ratio(row.effect, row.use))} | ${decimal(avg(forced[id].ranks.rank))} |`;
  }).join('\n');
  const unlockRows = LATE_SHOPS.map(id => `| ${LABEL[id]} | ${unlock.BASE.items[id].purchase} / ${unlock.BASE.items[id].use} / ${unlock.BASE.items[id].applied} | ${unlock.SHOP5.items[id].purchase} / ${unlock.SHOP5.items[id].use} / ${unlock.SHOP5.items[id].applied} | ${unlock.SHOP4.items[id].purchase} / ${unlock.SHOP4.items[id].use} / ${unlock.SHOP4.items[id].applied} |`).join('\n');
  const priceRows = LATE_SHOPS.map(id => `| ${LABEL[id]} | ${price.CURRENT.items[id].purchase} / ${price.CURRENT.items[id].use} / ${price.CURRENT.items[id].applied} | ${price.MINUS_1.items[id].purchase} / ${price.MINUS_1.items[id].use} / ${price.MINUS_1.items[id].applied} | ${price.MINUS_2.items[id].purchase} / ${price.MINUS_2.items[id].use} / ${price.MINUS_2.items[id].applied} |`).join('\n');
  const c = id => baseline.cards[id];
  const bloodConclusion = [
    `- カード別では、選択率が低いカードは ${BLOOD_CARDS.filter(id => ratio(c(id).selected, c(id).available) < 0.2).map(id => LABEL[id]).join('・') || '該当なし'}。`,
    `- 最終順位との相関は、最終HP ${decimal(pearson(baseline.paths.hp, baseline.paths.rank))}、総与ダメージ ${decimal(pearson(baseline.paths.damage, baseline.paths.rank))}、支援点 ${decimal(pearson(baseline.paths.support, baseline.paths.rank))}、総被ダメージ ${decimal(pearson(baseline.paths.taken, baseline.paths.rank))}。負の値ほど順位改善と同方向である。`,
    `- BLOOD_SUPPORT と BLOOD_SELFISH の平均順位差は ${decimal(avg(bloodStrategies.BLOOD_SUPPORT.rank) - avg(bloodStrategies.BLOOD_SELFISH.rank))}（正なら支援AIが不利）。`,
    `- 仮想感度で現行から最も平均順位を改善した条件は ${Object.entries(sensitivity).filter(([name]) => name !== 'CURRENT').sort((a, b) => avg(a[1].rank) - avg(b[1].rank))[0][0]}。`
  ].join('\n');
  const lateConclusion = [
    `- 第六SHOPの購入可能判断では、購入より「冥貨不足」「購入可能だが見送り／他SHOP優先」がどちらに偏るかを上表で分離した。`,
    `- 六道の鎖：無間中の対象変更成功 ${baselineLate.items['six-realms-chain'].targetChanges}回、強制所持時の防止 ${forced['six-realms-chain'].late.items['six-realms-chain'].prevented}回。`,
    `- 無間の札：無間中の無効対象 ${baselineLate.items['infinite-slip'].nullified}回、強制所持時のCT防止 ${forced['infinite-slip'].late.items['infinite-slip'].cooldownSaved}回。`,
    `- 閻魔の眼は情報取得後の選択変更を現行AIが行わないため、ここでの発動数は「情報を見る機会」であり、対人での心理価値は未計測。`
  ].join('\n');
  return `# 血の池パック・第六SHOP 原因分析\n\n生成日: ${new Date().toISOString()}  \n対象: v0.3仕様。正式なカード数値・HP・冥貨供給・SHOP定義は変更していない。\n\n## 方法と限界\n\n- 基準データは同一エンジンによる1,000ゲーム、行動・支払い方針は既存の混合AIである。\n- 仮想感度・早期解禁・価格試験は、テストルームだけに限定したシミュレーション設定である。本番の保存状態、API、画面、正式定義には影響しない。\n- 相関はPearsonの r。最終順位は数が小さいほど良いので、負の値が順位改善との正相関を表す。\n- 全PLへ同一の強制SHOPを与える試験では全体平均順位は原理上ほぼ一定になるため、使用・発動・実効果を主指標とした。\n\n# A. 血の池パック\n\n## 1. カード別（1,000ゲーム）\n\n| カード | 選択可能 | 選択 | 使用率 | 成立率 | 不発率 | 無効化率 | 実ダメージ/選択 | 実回復/選択 | 実軽減/選択 | 反射/選択 | 自己HP差/選択 | 支援/選択 | 駅スコア/選択 | 順位相関 r |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${cardRows}\n\n駅スコアは直接・反射による実ダメージ部分のみ。支援点は駅順位の同点処理や最終順位の第三比較に使われるが、駅スコアには直接加算されない。\n\n## 2. 勝ち筋と回復の相対不利\n\n| 比較群 | ゲーム内の血の池PL数 | 平均順位 | 1位率 | 最下位率 | 最終HP | 与ダメージ | 支援点 | 被ダメージ |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n| 他PLへの実回復あり | ${rankRow(baseline.healGroups.healed)}\n| 他PLへの実回復なし | ${rankRow(baseline.healGroups.none)}\n\n- 回復対象の平均最終順位: ${decimal(avg(baseline.healGroups.targetRank))}\n- 回復対象の平均最終HP: ${decimal(avg(baseline.healGroups.targetHp))}\n- 使用者順位−対象順位（正なら使用者の方が下位）: ${decimal(avg(baseline.healGroups.rankGap))}\n- 回復イベント数: ${baseline.healGroups.events}\n\n${bloodConclusion}\n\n## 3. 血の池AI比較（各500ゲーム、現行数値）\n\n| 戦略 | サンプル | 平均順位 | 1位率 | 最下位率 | 最終HP | 与ダメージ | 支援点 | 被ダメージ |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${strategyRows}\n\n## 4. 座席バイアス（各100ゲーム）\n\n| 血の池の座席 | サンプル | 平均順位 | 1位率 | 最下位率 | 最終HP | 与ダメージ | 支援点 | 被ダメージ |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${seatRows}\n\n## 5. 血の池と相性が想定されるSHOP\n\n| SHOP | 購入 | 使用 | 使用/購入 | 効果成立 | 実効果量 | 購入可能判定 | 冥貨不足 | 売切れ |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${affinityRows}\n\n「購入可能判定」は血の池使用者が、その自由時間に当該商品を買える冥貨を持っていた回数。購入可能でも購入されない場合は、資源不足よりAI優先度・在庫競合の影響が大きい。\n\n## 6. 仮想感度（正式仕様は未変更）\n\n| ケース | サンプル | 平均順位 | 1位率 | 最下位率 | 最終HP | 与ダメージ | 支援点 | 被ダメージ |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${sensitivityRows}\n\nCASE Fは「血の池使用者の支援点を、HPの次の比較で総与ダメージに加算して評価する」仮想的な順位式である。カード処理・HP・冥貨は一切変えていない。\n\n**血の池の診断:** 現時点では **E. 複合要因**。カードの純粋な空振りだけでなく、支援行動の相対順位効率、AIの方針差、そして一部カードの実使用頻度が重なっている。\n\n# B. 第六SHOP\n\n## 1. 購入されない理由（基準1,000ゲーム）\n\n| SHOP | 購入 | 冥貨不足 | 購入可能だが見送り | 他SHOPを選択 | SOLD OUT | 類似SHOP所持 | 購入時の残りターン |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${lateDecisionRows}\n\n## 2. 無間5ターンでの残存価値\n\n| SHOP | 理論最大使用 | 購入 | 実使用 | 平均使用/購入 | 成立 | 1使用あたり実効果 |\n|---|---:|---:|---:|---:|---:|---:|\n${lateValueRows}\n\n## 3. 無間開始時の強制所持（各500ゲーム、購入・在庫は無視）\n\n| 強制SHOP | ゲーム | 使用 | 所有者あたり使用率 | 成立 | 成立/使用 | 1使用あたり実効果 | 全PL平均順位 |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${forcedRows}\n\n- 六道の鎖の強制所持時: 対象変更を防いだ回数 ${forced['six-realms-chain'].late.items['six-realms-chain'].prevented}、同一使用で2回以上防いだ検出回数 ${forced['six-realms-chain'].late.items['six-realms-chain'].multi}。\n- 無間の札の強制所持時: 無効による通常CT防止 ${forced['infinite-slip'].late.items['infinite-slip'].cooldownSaved}。\n- 閻魔の眼: 強制所持時の情報使用 ${forced['enma-eye'].late.items['enma-eye'].info}。現行AIは情報後に選択を変更しないため、「情報を見て実際に行動変更できた回数」は0として扱い、潜在価値は未計測。\n\n${lateConclusion}\n\n## 4. 解禁時期感度（購入 / 使用 / 成立）\n\n| SHOP | 現行:第六SHOP | 仮想:第五SHOP | 仮想:第四SHOP |\n|---|---|---|---|\n${unlockRows}\n\n## 5. 価格感度（購入 / 使用 / 成立）\n\n| SHOP | 現行価格 | 価格−1 | 価格−2 |\n|---|---|---|---|\n${priceRows}\n\n**第六SHOPの診断:**\n\n- 閻魔の眼: **F. 複合要因**。遅い解禁に加え、情報を受けても行動を変えない現行AIでは価値が過小評価される。\n- 六道の鎖: **D. 発動機会が少ない** を主因とする **F. 複合要因**。対象変更が起きるターンとの一致が必要で、残り5ターンでは試行回数も少ない。\n- 無間の札: **D. 発動機会が少ない** を主因とする **F. 複合要因**。無効化と「次ターンに同じカードを再使用したい」が重なる必要がある。\n\n# 最小限の変更候補（今回は実施しない）\n\n1. **血の池:** まず支援AI／UI導線を改善して再測定する。数値を動かすなら、感度結果で最も順位改善が大きい単一要素だけを候補にする。\n2. **第六SHOP:** 最初に解禁時期を一段早める仮説を、価格変更と分けてプレイテストする。\n3. **六道の鎖・無間の札:** 強制所持でも発動が少ない場合は、価格より先に発動条件・対象環境の見直し候補とする。\n4. **冥貨・HP:** 今回の診断では変更候補に含めない。ROUTE_OPTIMALの既存結果どおり、供給量は到達不能の主因ではない。\n`;
}

main();
