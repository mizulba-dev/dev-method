---
name: keel
description: サービステンプレート keel（GitHub template: mizulba-dev/keel）から新サービスを立ち上げる。リポジトリ生成 → bootstrap 置換 → 動作確認 → PaPut プロジェクト登録・CLI 設定まで一気通貫。「keel で新サービスを作って」「新サービスを立ち上げて」で起動
argument-hint: <新サービス名（kebab-case）。既存リポジトリへ展開する場合はその旨>
---

# keel: サービステンプレートからの新サービス立ち上げ

テンプレートの正本は [mizulba-dev/keel](https://github.com/mizulba-dev/keel)（private・GitHub template）。構成は api（Go 4層 + registry 手書き DI + errors 一元 + bun ORM（uptrace/bun）/Atlas 実動雛形）/ web（Next.js + oxlint/oxfmt + CSP + scenario-kit）/ mcp（3責務の薄いアダプタ）+ ルート共通基盤（mise・gitleaks・githooks・CI・release スキル・deploy 雛形）。

## 1. 名前の確定

- サービス名は `^[a-z][a-z0-9-]*$` に一致する kebab-case。bootstrap がこの形式以外を拒否する
- DB 名などの snake 用途はハイフンをアンダースコアへ自動変換する（例: `gaihi-navi` → `gaihi_navi_db`）
- リポジトリ名とサービスのブランド名は分離できる。公開前に決めればよいのはブランド名・ドメインだけで、リポジトリ名の違和感で立ち上げを止めない

## 2. リポジトリ生成

**経路1（新規・通常）**: `gh repo create mizulba-dev/<service-name> --private --template mizulba-dev/keel --clone`

**経路2（既存リポジトリへの展開）**: keel を clone し `git archive HEAD | tar -x -C <対象リポジトリ>` で展開。既存ファイル（README 等）との衝突は手動解決する

## 3. bootstrap 置換

```sh
./bootstrap.sh <service-name>
```

- リテラル `keel` がサービス名へ、`keel_` 始まりが snake 形へ一括置換される。完了時に bootstrap.sh は自己削除し、`.keel-service-name` マーカー（check-drift 用）が残る
- 置換確認: `grep -rIn keel . --exclude-dir=.git --exclude-dir=node_modules` が**マッチ 0 件**であること（check-drift・manifest も置換対象で、bootstrap.sh は自己削除済み。1件でも残れば置換漏れ）
- 置換結果をコミットして push

## 4. セットアップと動作確認

```sh
mise install && mise run setup-hooks
cd api && cp .env.example .env
make db-up && make install-tools && make migrate   # migrate は $(go env GOPATH)/bin が PATH にある前提
make run &                                          # バックグラウンド起動（または別ターミナル）
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/healthz   # 200 を確認したらプロセスを停止
cd ../web && cp .env.example .env.local && npm install && npm run build   # .env.local の URL 類は実値へ
cd ../mcp && npm install && npm run build
```

CI（gitleaks + build-test）が push で同じ検証を常設する。green を確認する。

## 5. PaPut プロジェクト登録・CLI 設定（1回だけ）

いずれもローカル設定（.gitignore 済み）でテンプレには含まれない。既存サービスの設定をコピーして alias / パスだけ変える:

1. `paput_upsert_skill_sheet_projects` で登録（`mcp_alias`: 3〜40字の小文字英数。ハイフン不可なので `gaihi-navi` なら `gaihinavi` のように詰める）
2. Claude Code: `~/.paput/projects` に `<alias>\t<リポジトリ絶対パス>` を1行追加。`.claude/settings.local.json` は既存サービスから流用
3. Codex: `.codex/config.toml` を既存サービスからコピーし `X-PaPut-Project-Alias` を新 alias へ変更（URL は `https://mcp.paput.io/mcp` 固定・header-only 契約）

## 6. 公開のプロビジョニング

ドメイン・Vercel・メール窓口の設定は `service-provisioning` スキルで実行する（購入と DKIM 有効化は人が行う）。ドメイン未取得なら `check.mjs` で空きを確認してから購入する。

## 7. 立ち上げ後

- example モデル一式（`api/domain/model/example.go` ほか）を最初の業務モデルで置き換える（keel の README「bootstrap 後にやること」参照）
- 生成された CLAUDE.md の「このサービス固有の設計」欄を埋める
- デプロイ整備は生成物の `docs/deploy.md` 雛形と `.agents/skills/release/SKILL.md` に従う（api=Dokploy 手動トリガー・web=Vercel 自動・**web 先行の順序制約**）
- 同型維持は advisory: keel 側の改善を取り込むときは keel リポジトリで `scripts/check-drift.sh <サービスのパス>` を実行し、差分を見て手動判断。keel を改善したら `template-manifest.txt` の更新も忘れない

## 注意

- テンプレをフル適用しないサービス（静的サイト・Next.js 一本構成など）にはこのスキルを使わず、必要な開発基盤ファイル（mise・gitleaks・oxlint/oxfmt・deploy 雛形）だけ個別にコピーする
- `make verify-schema` は keel に含まれない（実効する検知器としての整備は keel 側の follow-up）
