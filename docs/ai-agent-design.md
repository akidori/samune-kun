# ものがたりっち AIエージェント 設計メモ

## 目的

編集者（外注）がホームを開くと、迷わず手が動く状態をつくる。

1. 今月なにを達成するかが分かっている（**月ゴールは Addness で設定**）
2. 今日やることが **TODO › 手順のチェックリスト**になっていて、次にやる1手順と時間が決まっている
3. 着手すると砂時計が落ち、見積もりを超えたら進捗%を聞いて **AIが巻き返しの時間割を引き直す**（ゴールシーク）
4. 詰まったら言語化 → AIが回答。解決しなければディレクターの LINE に届き、リプライがホームに戻る
5. 納品がディレクターに OK されるたびに請求明細が積み上がり、月末に請求書 PDF がドライブに保存される
6. 作業時間は工程（粗カット・本編集…）ごとに記録し、予算の超過や見積もりとのズレを次回の見積もりに活かす

## 登場人物

| 役割 | 使うもの | やること |
|---|---|---|
| 編集者（外注） | ホーム画面・Addness | Addness で月ゴールを決める／今日のTODOをチェックしながら進める／詰まりを相談／納品報告 |
| ディレクター | LINE（＋ホーム・Addness） | 案件作成（金額・工程予算）／相談への返信／納品の OK・差し戻し／Addness で全体を見る |
| AIエージェント | Cloudflare Worker + Claude | TODO・手順・時間割の提案／巻き返し／相談の一次回答 |

## 画面（home.html）

```
┌ 🎯 9月のゴール ・ Addness ────────────────────────────┐
│ 9月：担当案件をすべて締切内に納品する                     │
│ 納品 1/2本 ・ 請求 ¥30,000 ・ 残り2日 ・ 必要ペース 3.5本/週 │
└───────────────────────────────────────────┘
✅ 今日のプラン   やや遅れ・ボトルネック：「11月新作Vlog」の差し戻し
┌──────────────────────────────────────────┐
│ ☐ 10:00–11:00 差し戻し対応：11月新作Vlog   ⌛残り 52:10 [▶][詰まった] │
│    次 該当箇所にマーカーを打つ 5分                                   │
│    ☑ 指摘事項を1行ずつ書き出す        3分                            │
│    ☐ 該当箇所にマーカーを打つ          5分  ← 着手中のTODOは開いて表示 │
│    ☐ 指摘の修正                       30分                            │
│ ☐ 11:10–12:25 福岡ロケ：本編集        次 粗カットを通しで見直す 10分  │
└──────────────────────────────────────────┘
🎬 案件カード：⌛ 粗カット 8.5/30h ・ 本編集 0.0/12h（超過したら琥珀色＋記録）
右カラム：確認待ち・🙋 相談・💴 今月の請求
```

- 着手中（計測中、なければ次の時間帯）のTODOだけ自動で開き、手順のチェックリストを表示する。
- 手順は編集ソフト上の操作レベルで、秒単位の目安つき（例：素材をシーケンスにインポート 10秒 → 00のファイルを並べる 10秒 → 音声を同期 5分 → 00セクションの粗カット 30分）。
- 見積もり超過：TODOの下に「いま何%？」のスライダー →［AIに巻き返しプラン］で、実績ペースから残り時間を見積もり直し、今からの時間割と「明日に回すもの」を提案。
- 過去の実績から工程ごとの補正係数（例：粗カット×1.3）を出し、手順の秒数に反映する。

## Addness 連携（ものがたりっち → Addness）

```
Addness の月ゴール（編集者が Addness で設定し、ホームの設定で URL を貼る）
  └ 案件ゴール（案件ごとに自動作成・期限＝締切）
      └ 今日のTODO（プラン確定時に作成し、編集者の「今やるべきToDo」に入れる）
          └ 手順（ものがたりっちでチェック → Addness でも完了）
```

- Worker は Addness の MCP サーバーに標準の MCP プロトコルで接続し、`get_goal` / `create_goal` / `create_today_todo` / `complete_goal` だけを使う。
- トークンは編集者ごと（Addness の「今やるべきToDo」が本人のものになるように）。`mt_secrets` に保存し、画面からは読めない。
- ディレクターが納品を OK すると、案件ゴールも完了にする（未完了の子が残っていれば Addness 側の制約でそのまま）。

## 詰まり → 相談 → LINE

- 言語化フォーム：何をしようとしているか（自動）／どこで止まっているか／試したこと／何が分かれば進めるか
- AI回答：原因の一言・答え・次の一手・自信度。方針・尺・納期・金額・素材不足などはディレクター送信を勧める。
- 「ディレクターに送る」：AIの下書きを編集して送信 → 公式アカウントからディレクターに届く → リプライが「🙋 相談」に表示される。

## 納品 → 承認 → 請求

1. ディレクターが案件作成時に**金額（税抜）と工程予算**を入力（編集者の過去の超過率をヒント表示）。
2. 編集者が「納品する」→ ディレクターの LINE に［OK］［差し戻し］。
3. OK → 納品完了・その月の請求書（下書き）に1行追加・工程予算と実績を編集者の実績に記録。差し戻し → 案内メッセージへのリプライが修正点としてホームに出る。
4. 月末（最終日 23:00 JST）に確定 → 請求書 PDF（消費税10%外税）を `ものがたりっち請求書/{編集者名}/` に保存し、ディレクターに LINE で通知。

## アーキテクチャ

```
home.html（Firebase Auth + Firestore）
   │ ゴール表示・プラン・相談・案件・請求の読み書き
   ▼
Cloudflare Worker「agent」（Claude / LINE / Firestore / Drive / Addness MCP）
   ├ /plan  /replan  /ask  /escalate  /delivery  /worklog
   ├ /addness/connect  /addness/sync
   ├ /invoices/issue（ディレクター）・cron（月末）
   ├ /plugin/token  /plugin/today（Premiere パネル用・次のPRで使う）
   └ /line/webhook（リプライ＝回答・差し戻し理由／postback＝OK・差し戻し）
```

- Claude：`claude-opus-5-5`、構造化出力（JSON Schema）で返す。APIキーは Worker の secret。
- LINE：Messaging API（LINE Notify は 2025年3月に終了）。
- ドライブ：OAuth リフレッシュトークン（個人アカウントのドライブに保存するため）。HTML → Googleドキュメント変換 → PDF 書き出し。

## Firestore コレクション（`mt_` 接頭辞で既存の `samune_cases` と分ける）

| コレクション | 主なフィールド |
|---|---|
| `mt_editors/{uid}` | name, workHours, invoiceProfile, addnessGoal{goalId,title,ideal,due,url}, stats{todos,budgets}（Worker が書く） |
| `mt_projects/{id}` | name, channelName, editorId, phase, deadline, fee, status, budgetsH{工程:時間}, actualSec{工程:秒}, overruns{工程}, addnessGoalId |
| `mt_plans/{uid_YYYY-MM-DD}` | todos[{title, phaseKey, minutes, start, end, steps[{title, seconds, done, actualSec}], elapsedSec, …}], progress, deferred, replans, addnessIds（Worker） |
| `mt_worklogs/{id}` | editorId, projectId, todoId, phaseKey, seconds, source(web/premiere) |
| `mt_questions/{id}` | editorId, todo, stuckPoint, tried, needToKnow, ai, status(ai/sent/answered), answer |
| `mt_invoices/{uid_YYYY-MM}` | lines[], subtotal, tax, total, status(draft/issued), driveUrl |
| `mt_secrets/{uid}` | addnessToken（Worker 専用） |

## 次のPR：Premiere Pro パネル（UXP）

- 連携コードを1回貼るだけ。Premiere で操作している間だけ自動で計測し（5分操作がなければ停止）、`/worklog` に送る → 砂時計・工程実績に反映。
- パネルに今日のTODOと「次の手順」を表示。
- 終了直前の割り込みは UXP では確実にできないため、進捗チェック（何%まで進んだか）は ①終業10分前 ②プロジェクトを閉じた・切り替えたとき ③答えずに閉じた場合は次の起動時、の3段で出す。
- Worker 側の受け口（`/plugin/token`・`/plugin/today`・`/worklog`）は今回のPRで実装済み。
