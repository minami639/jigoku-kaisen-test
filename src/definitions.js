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
  { id: 'scorch', name: '第一・焦熱地獄', turnCount: 3, turnSeconds: 180, effect: '主分類「攻撃」の直接ダメージ＋1' },
  { id: 'ice', name: '第二・氷結地獄', turnCount: 3, turnSeconds: 180, effect: 'すべての直接ダメージ−1' },
  { id: 'needle', name: '第三・針山地獄', turnCount: 3, turnSeconds: 180, effect: '集中攻撃成立時、対象へ駅ダメージ1' },
  { id: 'blood', name: '第四・血の池地獄', turnCount: 3, turnSeconds: 180, effect: '回復・吸収・反撃・反射＋1' },
  { id: 'hunger', name: '第五・餓鬼地獄', turnCount: 4, turnSeconds: 210, effect: '各PL1回、通常CT中カードを再使用可能' },
  { id: 'war', name: '第六・修羅地獄', turnCount: 4, turnSeconds: 210, effect: '攻撃・防御・反撃・反射＋1' },
  { id: 'infinite', name: '第七・無間地獄', turnCount: 5, turnSeconds: 210, effect: '過去6駅から2効果を再演' }
];

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

export const CARDS = cards.map(([id, packId, name, category, targetType, damage, description]) => ({
  id, packId, name, category, targetType, damage, description
}));

export const CARD_BY_ID = Object.fromEntries(CARDS.map(card => [card.id, card]));
export const PACK_BY_ID = Object.fromEntries(PACKS.map(pack => [pack.id, pack]));
