---
name: plugin-release
description: dev-method の patch リリースと3プラグイン（dev-method / dev-method-claude / dev-method-codex）の Claude Code / Codex 両 CLI への反映を一気通貫で行う。スキル・マニフェスト変更を配布して手元のクライアントに適用するときに使う
argument-hint: [コミット済みか未コミットかの状態メモ（省略可）]
---

# plugin-release: dev-method リリース → 両 CLI 反映

dev-method（このリポジトリ）の変更を patch リリースし、3プラグインを Claude Code / Codex に反映する。

## 前提

- 対象変更（`src/plugin*/skills/` など）はコミット済み、または本スキル内で日本語メッセージでコミットする。
- remote は SSH（git@github.com:mizulba-dev/dev-method.git）。https は認証に失敗する。
- サードパーティ marketplace は auto-update されないため、リリースだけでは手元に反映されない。CLI 更新まで行って完了。

## 手順

1. **リリース**: `npm version patch`。version スクリプトが全6 plugin.json（3プラグイン × claude/codex マニフェスト）を自動同期して同一コミット（メッセージ＝バージョン番号）+ annotated tag `vX.Y.Z` を作る。
2. **push**: `git push origin main --follow-tags`。`git ls-remote --tags origin` で `vX.Y.Z` の到達を必ず確認する。
3. **Claude Code 反映**（`plugin@marketplace` 形式必須）:
   - `claude plugin marketplace update dev-method`
   - `claude plugin update dev-method@dev-method`
   - `claude plugin update dev-method-claude@dev-method`
   - 適用は再起動後。
4. **Codex 反映**（add が再インストール＝更新を兼ねる）:
   - `codex plugin marketplace upgrade dev-method`
   - `codex plugin add dev-method@dev-method`
   - `codex plugin add dev-method-codex@dev-method`
   - 適用はアプリ完全再起動後。
5. **報告**: 新バージョン番号・tag の到達・両 CLI の反映結果をまとめる。

## 注意

- 内容が変わっていないプラグインも version スクリプトがマニフェストを同期するため、**3プラグインすべて更新してバージョンを揃える**（揃えないと cache に旧版が残り紛らわしい）。
- dev-method-claude は Codex に、dev-method-codex は Claude Code にインストールしない。
