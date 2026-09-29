# ものがたりっち AIエージェント（Cloudflare Worker）

ホーム画面（`home.html`）の裏側で動くサーバーです。

- **今日のプラン**：Addness の月ゴールと案件の状況から、今日のTODOと手順（秒単位）と時間割を Claude が提案
- **巻き返し**：見積もりを超えたら、進捗%から残り時間を見積もり直して時間割を引き直す
- **相談**：詰まりを言語化 → Claude が一次回答 → 必要ならディレクターの LINE へ。LINE でリプライするとホームに回答が届く
- **納品 → 請求**：納品報告を LINE に［OK］［差し戻し］付きで送り、OK で請求明細に追加。月末に請求書 PDF をドライブへ保存
- **Addness**：確定したTODOと手順を「月ゴール › 案件 › TODO › 手順」として Addness に作成し、「今やるべきToDo」に入れる。チェックすると Addness でも完了
- **工程予算と実績**：作業時間を工程（粗カット・本編集…）ごとに記録し、予算の超過を残す。見積もりとの差は編集者ごとの補正係数として次回のプランに使う

## セットアップ

```bash
cd worker/agent
npm install
npx wrangler login
```

### 1. `wrangler.toml` の vars

| 変数 | 内容 |
|---|---|
| `FIREBASE_PROJECT_ID` | `birdstraike`（index.html と同じ Firebase） |
| `DIRECTOR_EMAILS` | ディレクターの Google アカウント（カンマ区切り） |
| `BILL_TO_NAME` | 請求書の宛名（例：株式会社〇〇） |
| `APP_URL` | LINE に載せるホーム画面の URL（任意） |
| `ALLOWED_ORIGIN` | ホーム画面のオリジン（例：`https://akidori.github.io`） |
| `ADDNESS_MCP_URL` | Addness の MCP サーバーの URL（Addness の設定画面で確認） |

### 2. secrets（`npx wrangler secret put <NAME>`）

| 名前 | 取得方法 |
|---|---|
| `ANTHROPIC_API_KEY` | Claude Console で発行 |
| `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_SECRET` | LINE Developers で Messaging API チャネルを作成（公式アカウント） |
| `DIRECTOR_LINE_USER_ID` | 下の「LINE の設定」を参照 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Firebase コンソール → プロジェクトの設定 → サービスアカウント → 新しい秘密鍵（JSON をそのまま） |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REFRESH_TOKEN` | 下の「ドライブの設定」を参照 |
| `DRIVE_ROOT_FOLDER_ID`（任意） | 請求書を入れるフォルダ。未設定なら「ものがたりっち請求書」を自動作成 |

Addness のトークンは Worker ではなく、**各編集者がホームの設定画面で入力**します（`mt_secrets` に保存され、画面からは読めません）。

### 3. デプロイ

```bash
npx wrangler deploy
```

出力された URL（`https://monogataricchi-agent.xxx.workers.dev`）を、ホーム画面の「設定 → エージェントURL」に入れます。

## LINE の設定

1. LINE Developers で Messaging API チャネルを作り、Webhook URL に `https://<worker>/line/webhook` を設定して「Webhook の利用」をオンにする（応答メッセージはオフ）。
2. ディレクターが公式アカウントを友だち追加し、`ID` と送る → 返ってきた userId を `DIRECTOR_LINE_USER_ID` に設定。
3. 使い方
   - 相談・納品報告のメッセージを長押し →「リプライ」で返信すると、その相談・案件に紐づいて編集者のホームに届きます。
   - 納品報告の［OK］で納品完了＆請求明細に追加、［差し戻し］→ 案内メッセージにリプライで修正点を送ります。

## ドライブの設定（請求書 PDF）

個人の Google アカウントのドライブに保存するため、OAuth のリフレッシュトークンを使います。

1. Google Cloud コンソールで Drive API を有効化し、OAuth クライアント（ウェブアプリ）を作成。承認済みリダイレクト URI に `https://developers.google.com/oauthplayground` を追加。
2. [OAuth 2.0 Playground](https://developers.google.com/oauthplayground) の設定（歯車）で「Use your own OAuth credentials」に上のクライアントを入れる。
3. スコープ `https://www.googleapis.com/auth/drive.file` を承認 → 「Exchange authorization code for tokens」で出た refresh token を `GOOGLE_OAUTH_REFRESH_TOKEN` に設定。

請求書は毎月最終日の 23:00（JST）に自動で確定します（`wrangler.toml` の cron）。ディレクターはホームの「今すぐ発行する」でも発行できます。

## Firestore のルール

既存の `samune_cases` のルールはそのままにして、以下を**追記**してください（`DIRECTOR_EMAIL` はディレクターのアドレスに置き換え）。Worker はサービスアカウントで読み書きするので、ルールの影響を受けません。

```
function isDirector() { return request.auth != null && request.auth.token.email in ['DIRECTOR_EMAIL']; }
function isSelf(uid) { return request.auth != null && request.auth.uid == uid; }

match /mt_editors/{uid} {
  allow read: if isSelf(uid) || isDirector();
  // 実績（stats）・連携情報は Worker だけが書く
  allow create, update: if isSelf(uid) && !request.resource.data.diff(resource == null ? {} : resource.data).affectedKeys().hasAny(['stats', 'pluginTokenHash', 'addnessGoal']);
}
match /mt_projects/{id} {
  allow read: if isDirector() || (request.auth != null && resource.data.editorId == request.auth.uid);
  allow create, update, delete: if isDirector();
}
match /mt_plans/{id} {
  allow read, write: if request.auth != null && id.matches(request.auth.uid + '_.*');
}
match /mt_questions/{id} {
  allow read: if request.auth != null && resource.data.editorId == request.auth.uid;
}
match /mt_invoices/{id} {
  allow read: if isDirector() || (request.auth != null && resource.data.editorId == request.auth.uid);
}
// mt_secrets / mt_worklogs / mt_line_messages / mt_meta / mt_plugin_tokens は Worker 専用（クライアントからは読み書き不可）
```

## テスト

```bash
npm test   # Claude・LINE・Firestore・ドライブ・Addness(MCP) をすべて偽物に差し替えて、流れを通しで確認
```
