---
name: plugin-release
description: リポジトリのリリース（バージョンバンプ → タグ push → 配布 → 反映確認）をチャネル別の共通手順で一気通貫に行う。プラグイン・npm パッケージ・スキルの変更を配布して手元の CLI や利用者に届けるときに使う。リポジトリ固有の値は対象リポジトリの CLAUDE.md / AGENTS.md の「release プロファイル」を正本とする
argument-hint: [patch|minor と、コミット済みか未コミットかの状態メモ（省略可）]
---

# plugin-release: リポジトリ横断リリース

対象リポジトリの変更をリリースし、配布チャネルに応じて利用側へ反映する。手順の背骨は共通で、リポジトリごとの差分（バンプ判断・同期スクリプト・チャネル・後続フック）は各リポジトリの release プロファイルが持つ。

## プロファイルの解決

1. 対象リポジトリの CLAUDE.md / AGENTS.md から「release プロファイル」節を読む。項目: バンプ判断基準・バージョン同期の仕組み・remote / push 先・push 前ゲート・配布チャネル（複数可）・後続フック・固有の注意。
2. プロファイルが無ければ、package.json の scripts（`version` / `prepublishOnly` 等）と過去のタグ形式から推定したプロファイル案を提示し、ユーザーの確認を得てから進める。確認なしに bump 以降（version コミット・push・配布）へ進まない — 不可逆点は配布段ではなく push であり、push 後の巻き戻しは公開履歴の書き換えになる。

## 共通手順

1. **コミット**: 未コミット変更があればリポジトリ規約（言語・メッセージ方針）でコミットする。
2. **バンプ**: プロファイルの判断基準で patch / minor を決め、`npm version <bump>` を実行する。バージョンコミット（メッセージ＝番号）と annotated tag `vX.Y.Z` が作られる（プロファイルに同期の仕組みがあるリポジトリでは version スクリプトがマニフェスト同期も同時に行う）。version の手書き変更はしない。
3. **push 前ゲート**: プロファイルにゲートがあれば push 前に回す（例: `npm publish --dry-run` で全ゲート一括）。失敗したら `git reset --hard HEAD~1` と `git tag -d vX.Y.Z` で version コミットごと作り直す。push 後に落とすと公開済み履歴の巻き戻しになるため、必ず push 前に落とす。
4. **push**: `git push origin <既定ブランチ> --follow-tags`（既定ブランチはプロファイルまたはリポジトリの HEAD から確認。main とは限らない）。`--follow-tags` でも tag が漏れることがあるため、`git ls-remote --tags origin` で `vX.Y.Z` の到達を必ず確認する。
5. **配布チャネル**（プロファイル指定。複数あれば全部）:
   - **plugin-marketplace**: `claude plugin marketplace update <mp>` → 対象プラグイン全部を `claude plugin update <plugin>@<mp>`（`plugin@marketplace` 形式必須。素の名前は not found）。Codex は `codex plugin marketplace upgrade <mp>` → `codex plugin add <plugin>@<mp>`（update サブコマンドは無く、add が再インストール＝更新を兼ねる）。`plugin list` で新版を確認。適用は再起動後（Codex はアプリの完全再起動が必要。リロードでは不十分）。
   - **npm-registry**: `npm publish` は対話的認証（2FA OTP 等）が必要になり得るため AI は実行しない。タグ push まで済ませて publish コマンドを提示し、ユーザーに実行を依頼して完了とする。
   - **auto-deploy 副作用**: push が本番の自動デプロイを誘発するリポジトリでは、デプロイ完了とヘルスエンドポイントの 200 を確認する。
6. **後続フック**: プロファイルに下流同期（例: 上流リリース後に、それを vendor している別リポジトリのスキル同期とリリース）が定義されていれば、その要否をユーザーに確認する。
7. **報告**: 新バージョン・tag 到達・チャネルごとの反映結果・ユーザーに依頼した残作業（publish 等）をまとめる。

## 注意

- サードパーティ marketplace は auto-update されない（またはデフォルト無効）。リリースだけでは手元に反映されず、CLI 更新まで行って完了。
- 同一リポジトリから複数プラグインを配布している場合、内容が変わっていないプラグインもマニフェスト同期で版が上がるため、**全プラグインを更新して版を揃える**（揃えないと cache に旧版が残り紛らわしい）。
- npm publish の PUT 404（`is not in this registry`）は認証切れの典型。npm は認証・権限エラーを 404 で返すことがあるため、パッケージ消失を疑う前に `npm whoami`（E401 なら `npm login`）で切り分ける。
