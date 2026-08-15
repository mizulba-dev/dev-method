---
name: service-provisioning
description: 新サービスの公開までのプロビジョニング（DNS・Vercel・Google Workspace のメール窓口）を API で実行する。ドメイン購入は対象外で、検索・空き確認のみ支援する。「ドメインを設定して」「サイトを公開できる状態にして」「窓口メールを作って」で起動
argument-hint: <設定ファイルのパス。無ければ設定例から起こす>
---

# service-provisioning: 公開までのプロビジョニング

リポジトリ生成（`keel` スキル）のあと、サイト公開とメール窓口の開設までに残る工程を実行可能にしたもの。

**入口は3つ**。すべて既定 dry-run で、実行は `--execute` を明示する。

| 入口 | 対象 | 書き込み |
| --- | --- | --- |
| `check.mjs <検索語 or ドメイン>` | ドメインの検索・空き確認・価格提示 | 一切しない |
| `stage1.mjs --config <file>` | Vercel プロジェクト・環境変数・カスタムドメイン・DNS | `--execute` 時のみ |
| `stage2.mjs --config <file>` | Workspace セカンダリドメイン・メール DNS・窓口グループ・Gmail | `--execute` 時のみ |

Stage 1 だけでサイト公開は完結する。メールを持たないサービスは Stage 2 を実行しなくてよい。

## 前提

- ドメインは購入済みで、Cloudflare にゾーンがあること（購入はこのツールの対象外。決定として持たない）
- 資格情報は環境変数優先、無ければ `~/.config/{cloudflare,vercel,google}/env` から読む
  - `CLOUDFLARE_API_TOKEN`（DNS edit + Zone read）
  - `VERCEL_TOKEN`（project 作成とドメイン）
  - `GOOGLE_APPLICATION_CREDENTIALS`（サービスアカウント JSON のパス）と `GOOGLE_ADMIN_EMAIL`（委任先の管理者）
- Google はドメイン全体委任で次のスコープを許可しておく:
  `admin.directory.domain` / `admin.directory.group`（メンバー操作もこれで足りる） / `apps.groups.settings` / `siteverification` / `gmail.settings.basic` / `gmail.settings.sharing`

## 使い方

```sh
SKILL=<このスキルのディレクトリ>
node $SKILL/scripts/check.mjs sample-service sample-service.com  # 購入前。読み取りのみ
cp $SKILL/references/config.example.json ./provisioning.json  # 設定を起こす
node $SKILL/scripts/stage1.mjs --config ./provisioning.json             # dry-run
node $SKILL/scripts/stage1.mjs --config ./provisioning.json --execute   # 実行
node $SKILL/scripts/stage2.mjs --config ./provisioning.json --execute
```

終了コード: `0` 完了 / `1` 失敗（部分適用のまま停止し、どこまで適用したかを出力する） / `2` 設定乖離で停止 / `3` 人の作業待ちで停止。

## 出力の読み方

- `create` — これから作る
- `skip` — 既存が契約と**設定値まで一致**している（存在チェックだけの skip はしない）
- `DRIFT` — 既存が契約と食い違う。**自動で上書きせず停止する**。設定ファイルと実環境のどちらを正とするか決めてから再実行する
- `manual` — 人が実行する工程。ここで停止する

## 人が実行する工程

1. **ドメインの購入** — Cloudflare ダッシュボードで行う（不可逆・課金のため、ツールは購入を持たない）
2. **DKIM の有効化** — API が無い。管理コンソール > アプリ > Gmail > メールの認証 で鍵を生成し、値を設定ファイルの `mail.records.dkim` に転記して再実行（レコード投入）、そのうえで管理コンソールの「認証を開始」を押す。**完了判定は「レコードを入れたこと」ではなく、権威ネームサーバーへ直接問い合わせて DKIM レコードが実在すること**
3. **Gmail「返信で使用するアドレス」** — Gmail API に該当フィールドが無い。設定 > アカウント で「メールを受信したアドレスから返信する」を選ぶ
4. **MX / SPF / DKIM の値の転記** — Workspace 管理コンソールが提示する値を設定ファイルへ書く。ツールは決め打ちしない（提示形式は変わる）

## 設計上の契約（変更するときはここを壊さない）

- **冪等**は設定値の照合で行う。一致すれば skip、乖離すれば差分を報告して停止。存在チェックだけの skip は「設定があるのに機能しない」失敗を温存するため採らない
- **DNS は proxied=false**。Cloudflare のプロキシを有効にすると Vercel のドメイン検証・証明書発行が失敗する
- **Vercel の環境変数はドメイン紐付けより先**。未設定だと本番ビルドが fail-closed で落ちるサービスがある
- **DNS レコードの値は Vercel / Workspace の応答を正とする**。推奨値が取れなければ決め打ちせず失敗する
- **窓口グループは投稿を外部に開き、閲覧・発見は外部に開かない**（照合するのはこの非対称の意味論だけで、契約外の設定は既存の運用に任せる）。既定プリセット「公開」は組織内の意味で、外部からのメールは弾かれ送信者にだけエラーが返る（窓口が無言で死ぬ）。一方アーカイブには第三者の個人情報が溜まるため閲覧は開かない
- **窓口はユーザーではなくグループ**（ユーザーはライセンスを1席消費する）。メンバー0のグループは配信されずアーカイブに残るだけなので、メンバー追加までを1工程に含める
- **DMARC は `p=none` から**、`rua` はブランドドメインの共通回収グループへ（窓口に機械宛レポートを混ぜない）
- **受信の迷惑メール対策は Gmail のフィルタ**。SPF / DMARC は受信判定には効かない。グループ側の `spamModerationLevel` は `MODERATE`（疑わしいものは保留してモデレーターに通知）のままにし、二重に外さない
- **秘密情報は出力しない**。ログ・エラー・dry-run 出力はマスクを通す
- **dry-run では書き込み API を送出しない**（クライアントが GET 以外を拒否する。例外は状態を変えない所有権確認トークンの取得のみ）
- **DRIFT が1件でもあれば `--execute` でも一切適用しない**。後方の乖離が先行する作成を抑止する
- **同じ用途の DNS レコードは余剰も乖離**として報告する（古い SPF や A が残っていると機能しないため）
- **ロールバックは実装しない**。全操作が可逆で、失敗時は部分適用のまま停止して適用状況を報告する

## テスト

```sh
node <このスキル>/tests/run-tests.mjs
```

層1（引数構築）と層2（dry-run の提示内容）を実 API なしで検証する。fixture は読み取り専用 API の実応答を採取して匿名化したもので、`_source` に採取元のエンドポイントと採取日を持つ。

## 未検証

- Cloudflare Registrar API（`check.mjs`）はベータ。2026-08-15 の実測では `registrar/domains/domain-check` が HTTP 404（このアカウントでは未提供）で、空き確認は使えなかった。対応 TLD もエンドポイントも変わりうるため、失敗時は「ダッシュボードで確認する」旨を出して続行する設計にしてある
- `--execute` の書き込み経路は実走未了（層3）。dry-run（読み取りのみ）は Cloudflare・Vercel・Workspace の実環境で確認済み
