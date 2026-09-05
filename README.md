# 地獄廻線・七獄パック統一カードゲーム版

`docs/game-spec.md` を仕様の正本とするWebアプリです。現在はPhase 1として、GMルーム作成から第一・焦熱地獄のターン進行までを実装しています。

## 起動

Node.js 22以降を使用します。外部パッケージのインストールは不要です。

```powershell
npm.cmd start
```

ブラウザで `http://localhost:3000` を開きます。GMが表示されたルームコードをPLへ共有し、合計7人が参加するとパック選択へ進めます。別ブラウザまたはプライベートウィンドウを使うと、同じ端末でも複数参加者を確認できます。サーバーは `PORT`（既定値3000）と `HOST`（既定値 `0.0.0.0`）を利用します。

一人で確認する場合は、乗車口の「テストルームを作成（PL7人自動参加）」を押します。「他のユーザー画面」からPL1～PL7へ切り替え、そのPLの画面上で重複しないパックを選べます。「第一・焦熱地獄を開始」後は「全PLを自動選択・確定」→「一斉公開して処理」でターンを進められます。公開テスト環境では `ENABLE_TEST_ROOMS=true` のため、URLを知る人は誰でも互いに分離されたテストルームを作成できます。

## 確認

```powershell
npm.cmd run check
npm.cmd test
```

ゲーム状態は `data/rooms.json` に保存されます。このディレクトリはGit管理対象外です。再接続識別情報はブラウザへ保存しますが、権限判定と秘密情報の投影はサーバー側で行います。

## Renderへの公開

リポジトリ直下の `render.yaml` は、`unified-card-game` ブランチをNode.js Web Serviceとして起動する設定です。Render Dashboardで **New + → Blueprint** を選び、このGitHubリポジトリを接続してください。以後は対象ブランチへのpushから自動デプロイされます。

設定値は次のとおりです。

- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/healthz`
- `NODE_ENV=production`
- `ENABLE_TEST_ROOMS=true`（公開テスト期間のみ）
- `DATA_FILE=/tmp/jigoku-kaisen/rooms.json`

`PORT` はRenderが自動設定するため、手動設定しません。秘密値は `render.yaml` やGitへ記録せず、必要になった時点でRender DashboardのEnvironmentへ登録してください。

### Phase 1公開の保存上の制限

現在はサーバー側JSONファイルが状態の正本です。Renderの無料Web Serviceではローカルファイルが永続化されないため、再起動・再デプロイ・スピンダウンでルームが消える可能性があります。`DATA_FILE` を `/tmp` にしているのは、この制限を明示するためです。Phase 1の短時間テスト用途に限って使用してください。

本運用では、有料Persistent Diskへ `DATA_FILE` の保存先を移すか、複数インスタンスや将来の拡張も考慮してPostgreSQL等の永続データベースへ置き換える必要があります。保存方式を変更する際も、ゲーム状態の正本と権限判定はサーバー側に維持します。

## Phase 1の範囲

- GMルーム作成、ルームコード、PL7人参加、再接続
- GM／PL権限分離と権限別状態投影
- パック紹介、選択、確定、重複検証
- 第一・焦熱地獄の開始、タイマー、カード・対象選択、最終確認
- GMによる解除、一斉公開、効果解決、HP・統計・亡者・通常CT更新
- Server-Sent Eventsによるリアルタイム更新
- JSONファイルへのサーバー側永続化

全35枚の完全な効果処理、全25ターン、駅結果、ショップ、冥貨、最終整線、エンディングは後続Phaseで実装します。ココフォリアをWebから自動操作する機能は実装しません。
