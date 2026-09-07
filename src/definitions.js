export const PACKS = [
  { id: 'scorch', name: '焦熱', specialty: '高火力・自傷' },
  { id: 'ice', name: '氷結', specialty: '妨害・軽減' },
  { id: 'needle', name: '針山', specialty: '集中攻撃・追撃' },
  { id: 'blood', name: '血の池', specialty: '回復・吸収' },
  { id: 'hunger', name: '餓鬼', specialty: '強奪・再利用' },
  { id: 'war', name: '修羅', specialty: '正面戦闘' },
  { id: 'infinite', name: '無間', specialty: '特殊操作' }
];

export const STATIONS = [
  {
    id: 'scorch', name: '第一・焦熱地獄', turnCount: 3, turnSeconds: 180, effect: '主分類「攻撃」の直接ダメージ＋1', effectId: 'scorch',
    rewardFlow: {
      supportAward: { minimum: 1, amount: 1 },
      specialBonus: { id: 'scorch-damage-3', condition: 'この駅で他人へ実ダメージ合計3以上', amount: 1, evaluator: 'DAMAGE_DEALT_AT_LEAST', minimum: 3 },
      freeTimeLines: [
        '「は〜い！ 冥貨もちゃんと配り終わりましたねぇ！」',
        '「それでは、次の地獄へ向かう前に――」',
        '「ここで初めて、第一ショップが開きま〜す！」',
        '「ショップでは冥貨を払って、SHOPカードが買えますよぉ！」',
        '「お支払いに使う冥貨の種類と枚数は、好きに選んでください！」',
        '「払った価値が商品の値段以上なら、お買い上げ。払いすぎた分はおつりでお返しします！」',
        '「ただし、払いすぎは値段より7まで。おつりの冥貨はGMさんがココフォリアへ反映します！」',
        '「買ったSHOPカードはWebで持ち続けます。ココフォリアで動かすのは冥貨だけですよぉ！」',
        '「ゲーム中では、七獄カードを選ぶ画面でSHOPカードも一緒に選べます！」',
        '「1ターンに使えるSHOPカードは1枚まで。使ったカードは、次の1ターンだけお休みです！」',
        '「でもその次のターンからは、何度でもまた使えますからねぇ！」',
        '「商品はひとつにつき在庫1。売り切れた商品を、もう一度買うことはできません！」',
        '「誰が買ったかは、使うまでは秘密。じっくり悩んでくださいねぇ！」',
        '「5分間の自由時間で〜す！」',
        '「お手洗いに行くもよし！ 誰かとお話しするもよし！ 冥貨を渡したり、お買い物したりするのもよし！」',
        '「好きに過ごしてくださいねぇ！」'
      ]
    }
  },
  { id: 'ice', name: '第二・氷結地獄', turnCount: 3, turnSeconds: 180, effect: 'すべての直接ダメージ−1', effectId: 'ice', rewardFlow: { supportAward: { minimum: 1, amount: 1 } } },
  { id: 'needle', name: '第三・針山地獄', turnCount: 3, turnSeconds: 180, effect: '集中攻撃成立時、対象へ駅ダメージ1', effectId: 'needle', rewardFlow: { supportAward: { minimum: 1, amount: 1 } } },
  { id: 'blood', name: '第四・血の池地獄', turnCount: 3, turnSeconds: 180, effect: '回復・吸収・反撃・反射＋1', effectId: 'blood', rewardFlow: { supportAward: { minimum: 1, amount: 1 } } },
  { id: 'hunger', name: '第五・餓鬼地獄', turnCount: 4, turnSeconds: 210, effect: '各PL1回、通常CT中カードを再使用可能', effectId: 'hunger', rewardFlow: { supportAward: { minimum: 1, amount: 1 } } },
  { id: 'war', name: '第六・修羅地獄', turnCount: 4, turnSeconds: 210, effect: '攻撃・防御・反撃・反射＋1', effectId: 'war', rewardFlow: { supportAward: { minimum: 1, amount: 1 } } },
  {
    id: 'infinite', name: '第七・無間地獄', turnCount: 5, turnSeconds: 210, effect: '過去6駅から2効果を再演', effectId: 'infinite',
    rewardFlow: {
      noCurrencyRewards: true,
      supportAward: { minimum: 1, amount: 0 },
      specialBonus: { id: 'infinite-third-use', condition: '同じカードをゲーム中3回目として無間地獄で使用し、効果を発生させる', amount: 0, evaluator: 'THIRD_CARD_EFFECT' }
    }
  }
];

// 駅名ではなく、処理パイプラインが参照する効果定義。
export const STATION_EFFECTS = {
  scorch: { id: 'scorch', attackBonus: 1, scorchCostAt: 4 },
  ice: { id: 'ice', directDamagePenalty: 1 },
  needle: { id: 'needle', concentrationDamage: 1 },
  blood: { id: 'blood', healBonus: 1, absorbBonus: 1, reactionBonus: 1 },
  hunger: { id: 'hunger', normalCooldownReuse: true },
  war: { id: 'war', attackBonus: 1, defenseBonus: 1, reactionBonus: 1 }
};

const cards = [
  ['flame-strike','scorch','炎撃','attack','player',2,'対象HP−2。公開時に自分HP7以下なら−3。'],
  ['immolation','scorch','焼身','attack','player',3,'対象HP−3。自分HPが対象未満なら−4。使用者HP−1。'],
  ['flame-wall','scorch','炎壁','defense','player',0,'対象が受ける直接ダメージを合計2軽減。'],
  ['fire-seed','scorch','火種','support','player',0,'指定PLの有効な攻撃カードの直接ダメージ＋1。使用者HP−1。'],
  ['embers','scorch','燃え残り','support','ownAttackCard',0,'自分の攻撃カード1枚へ残火を付与。'],
  ['ice-spear','ice','氷槍','attack','player',1,'対象HP−1。命中時、次駅の攻撃ダメージ−1。'],
  ['freeze','ice','凍結','interference','player',0,'対象の次駅の攻撃ダメージ−2。'],
  ['blizzard','ice','吹雪','interference','player',0,'指定PLのカード対象をランダムに変更。'],
  ['ice-wall','ice','氷壁','defense','player',0,'対象が受ける直接ダメージを合計2軽減。'],
  ['thaw','ice','雪解け','support','player',0,'持越状態1つを解除し、直接ダメージを合計1軽減。'],
  ['follow-needle','needle','追い針','attack','player',2,'対象HP−2。前駅と同じ最終対象なら−3。'],
  ['thousand-needles','needle','針千本','attack','player',1,'対象HP−1。集中攻撃成立時、追加HP−2。'],
  ['poison-needle','needle','毒針','interference','player',1,'対象HP−1。命中時、次駅開始時HP−1。'],
  ['needle-guard','needle','針避け','defense','player',0,'直接ダメージを1、集中攻撃時は3軽減。'],
  ['target-stitch','needle','標的縫い','support','player',0,'指定PLの攻撃先へ向かう攻撃を最大2枚強化。'],
  ['vampire','blood','吸血','attack','player',2,'対象HP−2。命中時、自分HP＋1。'],
  ['blood-murk','blood','血濁','interference','player',0,'対象が受ける全回復を合計2減らす。'],
  ['blood-shield','blood','血の盾','defense','player',0,'直接ダメージを合計2軽減し、条件成立時に反射。'],
  ['healing-blood','blood','治癒血','heal','player',0,'対象HP＋2。'],
  ['transfusion','blood','輸血','heal','player',0,'対象HP＋3。使用者HP−1。'],
  ['gluttony','hunger','暴食','attack','player',2,'対象HP−2。条件成立時、自分HP＋1。'],
  ['plunder','hunger','強奪','interference','player',0,'対象の使用カードへCOOLDOWN_EXTENSIONを付与。'],
  ['leftover-shield','hunger','残飯の盾','defense','player',0,'対象が受ける直接ダメージを合計2軽減。'],
  ['alms','hunger','施し','heal','player',0,'対象HP＋2。公開時HP0なら＋3。'],
  ['greed','hunger','強欲','support','ownNonAttackCard',0,'自分の攻撃以外のカードへ欲印を付与。'],
  ['heavy-slash','war','強斬','attack','player',2,'対象に有効な防御がなければ対象HP−3。'],
  ['desperation','war','捨て身','attack','player',3,'対象HP−3。被弾条件で追加HP−1。使用者HP−1。'],
  ['guard','war','防御','defense','player',0,'対象が受ける直接ダメージを合計2軽減。'],
  ['counter-stance','war','反撃の構え','support','player',0,'指定PLの攻撃を監視し、被弾時HP−2で反撃。'],
  ['morale','war','気勢','support','player',0,'指定PLの攻撃値または防御値＋1。'],
  ['severance','infinite','断絶','attack','player',2,'対象HP−2。数値軽減と完全防御を無視。'],
  ['nullify','infinite','無効','interference','player',0,'指定PLの攻撃部分等を無効化。'],
  ['reversal','infinite','反転','defense','player',0,'対象への最大基本直接攻撃1件を0にして反射。'],
  ['regression','infinite','回帰','heal','player',0,'対象HP＋2。持越状態1つを解除。'],
  ['encore','infinite','再演','support','player',0,'3駅以上前の基本数値効果1つを最大2でコピー。']
];

// 基本数値とコンポーネントはカードエンジンが共通で処理する。
export const CARD_EFFECTS = {
  'flame-strike': { kind: 'attack', baseDamage: 2, condition: 'ownerHpAtMost7', conditionDamage: 1 },
  immolation: { kind: 'attack', baseDamage: 3, condition: 'ownerHpLessThanTarget', conditionDamage: 1, selfCost: 1 },
  'flame-wall': { kind: 'defense', reduction: 2 },
  'fire-seed': { kind: 'cardAttackBoost', amount: 1, selfCost: 1 },
  embers: { kind: 'markEmbers' },
  'ice-spear': { kind: 'attack', baseDamage: 1, onHitState: { stackKey: 'ATTACK_DAMAGE_DOWN', value: 1 } },
  freeze: { kind: 'carryState', state: { stackKey: 'ATTACK_DAMAGE_DOWN', value: 2 } },
  blizzard: { kind: 'targetChange' },
  'ice-wall': { kind: 'defense', reduction: 2 },
  thaw: { kind: 'defenseAndRemoveState', reduction: 1 },
  'follow-needle': { kind: 'attack', baseDamage: 2, condition: 'samePreviousStationTarget', conditionDamage: 1 },
  'thousand-needles': { kind: 'attack', baseDamage: 1, condition: 'needleConcentration', conditionExtraDamage: 2 },
  'poison-needle': { kind: 'attack', baseDamage: 1, onHitState: { stackKey: 'POISON', value: 1, startOfStationDamage: 1 } },
  'needle-guard': { kind: 'needleDefense', reduction: 1, concentrationReduction: 3 },
  'target-stitch': { kind: 'focusAttackBoost', amount: 1, maxTargets: 2 },
  vampire: { kind: 'attack', baseDamage: 2, absorb: 1 },
  'blood-murk': { kind: 'healReduction', reduction: 2 },
  'blood-shield': { kind: 'bloodShield', reduction: 2, reflection: 1 },
  'healing-blood': { kind: 'heal', amount: 2 },
  transfusion: { kind: 'heal', amount: 3, selfCost: 1 },
  gluttony: { kind: 'attack', baseDamage: 2, absorb: 1, condition: 'targetHpGreaterThanOwner' },
  plunder: { kind: 'cooldownExtension', turns: 2 },
  'leftover-shield': { kind: 'defense', reduction: 2 },
  alms: { kind: 'heal', amount: 2, condition: 'targetHpZero', conditionHeal: 1 },
  greed: { kind: 'markDesire' },
  'heavy-slash': { kind: 'attack', baseDamage: 2, condition: 'targetHasNoDefense', conditionDamage: 1 },
  desperation: { kind: 'attack', baseDamage: 3, condition: 'ownerDamagedByOtherBasicAttack', conditionExtraDamage: 1, selfCost: 1 },
  guard: { kind: 'defense', reduction: 2 },
  'counter-stance': { kind: 'counterStance', damage: 2 },
  morale: { kind: 'cardNumericBoost', amount: 1 },
  severance: { kind: 'attack', baseDamage: 2, ignoresDefense: true },
  nullify: { kind: 'nullify' },
  reversal: { kind: 'reversal' },
  regression: { kind: 'healAndRemoveState', amount: 2 },
  encore: { kind: 'encore' }
};

export const CARDS = cards.map(([id, packId, name, category, targetType, damage, description]) => ({
  id, packId, name, category, targetType, damage, description, effect: CARD_EFFECTS[id]
}));

export const CARD_BY_ID = Object.fromEntries(CARDS.map(card => [card.id, card]));
export const PACK_BY_ID = Object.fromEntries(PACKS.map(pack => [pack.id, pack]));

export const SHOP_DEFINITIONS = [
  { id: 1, unlockAfterStation: 'scorch', name: '第一ショップ' },
  { id: 2, unlockAfterStation: 'ice', name: '第二ショップ「氷獄売店」' },
  { id: 3, unlockAfterStation: 'needle', name: '第三ショップ「血池売店」' },
  { id: 4, unlockAfterStation: 'blood', name: '第四ショップ「餓鬼商店」' },
  { id: 5, unlockAfterStation: 'hunger', name: '第五ショップ「修羅売店」' },
  { id: 6, unlockAfterStation: 'war', name: '第六ショップ「無間売店」' }
];

export const SHOP_BY_STATION_ID = Object.fromEntries(SHOP_DEFINITIONS.map(shop => [shop.unlockAfterStation, shop]));
const SHOP_UNLOCK_AFTER_STATION_BY_ID = Object.fromEntries(SHOP_DEFINITIONS.map(shop => [shop.id, shop.unlockAfterStation]));

export const SHOP_ITEMS = [
  { id: 'will-o-wisp-amulet', shop: 1, name: '鬼火のお守り', price: 3, effect: '自分が選んだ七獄カードの直接ダメージ＋1。加算効果は最大2個まで。', effectType: 'ATTACK_BONUS', stock: 1 },
  { id: 'protective-rosary', shop: 1, name: '護りの数珠', price: 2, effect: 'このターン、指定した自分以外のPL1人が受ける直接ダメージを合計1軽減。', effectType: 'ALLY_DIRECT_REDUCTION', stock: 1 },
  { id: 'red-bandage', shop: 1, name: '赤い包帯', price: 3, effect: 'カード処理終了後、自分HP＋1。', effectType: 'POST_HEAL', stock: 1 },
  { id: 'needle-ward', shop: 2, name: '針除けの護符', price: 3, effect: 'このターン、自分が受ける直接ダメージを合計1軽減。', effectType: 'DIRECT_REDUCTION', stock: 1 },
  { id: 'decoy-doll', shop: 2, name: '囮人形', price: 2, effect: '自分を対象とした最初の対象変更を無効化。', effectType: 'PREVENT_TARGET_CHANGE_ONCE', stock: 1 },
  { id: 'demon-eye', shop: 2, name: '鬼の眼', price: 3, effect: '最終確認前、指定PL1人の仮選択カードの主分類を見る。', effectType: 'INFO_CATEGORY', timing: 'info', stock: 1 },
  { id: 'accomplice-thread', shop: 2, name: '共犯の糸', price: 2, effect: '自分の攻撃対象を指定PL1人へ秘密に通知。', effectType: 'SECRET_TARGET_NOTICE', stock: 1 },
  { id: 'bloodstop-charm', shop: 3, name: '血止めの護符', price: 5, effect: 'このターン、自分が受ける反撃・反射ダメージを合計2軽減。', effectType: 'REACTION_REDUCTION', stock: 1 },
  { id: 'shared-life-cup', shop: 3, name: '共命の杯', price: 7, effect: '自分の七獄カードによる他PLへの回復量＋1。', effectType: 'ALLY_HEAL_BONUS', stock: 1 },
  { id: 'blood-divination-needle', shop: 3, name: '血占いの針', price: 8, effect: '最終確認前、指定PLの仮選択カードが攻撃か、それ以外かを確認。攻撃なら現在の仮対象が自分かどうかも確認。', effectType: 'INFO_ATTACK_OR_OTHER', timing: 'info', stock: 1 },
  { id: 'grudge-slip', shop: 3, name: '怨返しの札', price: 2, effect: '秘密指定したPLから直接実ダメージを受けた場合、カード処理後にHP−1。', effectType: 'GRUDGE', stock: 1 },
  { id: 'leftover-bag', shop: 4, name: '食い残し袋', price: 8, effect: '完全不発または攻撃部分を無効化された場合、処理終了後HP＋1。', effectType: 'FIZZLE_HEAL', stock: 1 },
  { id: 'hunger-lock', shop: 4, name: '餓鬼の錠前', price: 7, effect: 'このターン、選択カードは新たなCOOLDOWN_EXTENSIONを受けない。', effectType: 'PREVENT_EXTENSION', stock: 1 },
  { id: 'greedy-ticket', shop: 4, name: '欲張り札', price: 5, effect: '指定カードの次回使用後に発生する通常CTを1回だけ無視。', effectType: 'GREEDY_TICKET', stock: 1 },
  { id: 'hell-key', shop: 4, name: '地獄の鍵', price: 3, effect: 'そのターン、七獄カード1枚の通常CTを無視。', effectType: 'NORMAL_CT_BYPASS', stock: 1 },
  { id: 'war-mask', shop: 5, name: '修羅の面', price: 7, effect: 'このターン、自分が最初に受ける反撃・反射ダメージを0にする。', effectType: 'FIRST_REACTION_ZERO', stock: 1 },
  { id: 'hell-chain', shop: 5, name: '地獄の鎖', price: 5, effect: 'このターン、自分が使用した主分類「攻撃」の七獄カードが最初に受ける対象変更1回を無効化。', effectType: 'PREVENT_TARGET_CHANGE_ONCE_ATTACK', stock: 1 },
  { id: 'battle-medicine', shop: 5, name: '戦傷薬', price: 3, effect: '他PLから直接実ダメージを合計2以上受けた場合、処理終了後HP＋2。', effectType: 'DIRECT_DAMAGE_THRESHOLD_HEAL', stock: 1 },
  { id: 'scapegoat-slip', shop: 5, name: '身代わり札', price: 3, effect: '自分が最初に受ける直接攻撃を2軽減。', effectType: 'FIRST_DIRECT_REDUCTION', stock: 1 },
  { id: 'enma-eye', shop: 6, name: '閻魔の眼', price: 3, effect: '最終確認前、指定PL1人の仮選択カード名だけを見る。', effectType: 'INFO_CARD_NAME', timing: 'info', stock: 1 },
  { id: 'six-realms-chain', shop: 6, name: '六道の鎖', price: 5, effect: 'このターン、自分が使用した七獄カードはすべての対象変更を受けない。', effectType: 'PREVENT_TARGET_CHANGE', stock: 1 },
  { id: 'infinite-slip', shop: 6, name: '無間の札', price: 7, effect: '無効で効果を失った場合、その使用による通常CTを発生させない。', effectType: 'NO_NORMAL_CT_ON_NULLIFY', stock: 1 }
].map(item => ({ ...item, unlockAfterStation: SHOP_UNLOCK_AFTER_STATION_BY_ID[item.shop] }));
export const SHOP_ITEM_BY_ID = Object.fromEntries(SHOP_ITEMS.map(item => [item.id, item]));
