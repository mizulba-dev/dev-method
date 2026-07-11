---
name: prepare-qa-data
description: "{{DESCRIPTION}}"
---

# prepare-qa-data: {{PROJECT_NAME}} のQAデータ準備

既存の `{{SELECTED_MECHANISM}}` を薄く包み、QAシナリオが必要とする状態だけを安全に準備・検証・cleanupする。未確認のコマンドや環境条件は推測せず `BLOCKED` とする。

## 対応環境と禁止環境

- 対応環境: {{SUPPORTED_ENVIRONMENTS}}
- 禁止環境: {{FORBIDDEN_ENVIRONMENTS}}
- 共有環境への影響: {{SHARED_RESOURCE_IMPACT}}

本番環境へのデータ作成・削除、既存共有データの全消去、対象を限定できないcleanupを禁止する。共有環境では、ユーザーまたはdirectionの明示指定と、この節の許可が両方ある場合だけ実行する。

## 前提条件

- 必要なサービス・ツール: {{PREREQUISITES}}
- 必要な環境変数名: {{ENVIRONMENT_VARIABLE_NAMES}}
- 実行前状態の確認: {{PREPARE_PREFLIGHT}}

環境変数の値、認証情報、顧客データをskill、scenario、report、動画、端末出力へ記録しない。

## Prepare

環境ごとの確認済み手順だけを実行する。ローカルの手順を共有環境へ流用しない。

{{ENVIRONMENT_SPECIFIC_PREPARE_STEPS}}

実行コマンドを特定できない環境: {{BLOCKED_PREPARE}}

## 準備完了の検証

{{PREPARE_VERIFICATION}}

検証に失敗した場合はQAシナリオを開始せず、失敗時の復旧へ進む。

## 安定識別子

- run識別子の規則: {{RUN_IDENTIFIER_RULE}}
- シナリオが参照する識別子: {{SCENARIO_STABLE_IDENTIFIERS}}
- 作成物とrun識別子の対応確認: {{IDENTIFIER_VERIFICATION}}

秘密値や不安定な自動採番値をscenarioへ直接埋め込まない。

## 冪等性

{{IDEMPOTENCY_BEHAVIOR}}

同じrun識別子で再実行した場合の確認済み挙動: {{RERUN_BEHAVIOR}}

## Cleanup

このskillが現在のrunで作成した、安定識別子で限定できる対象だけを削除する。

{{CLEANUP_STEPS}}

固定fixtureのためcleanup不要の場合の理由: {{CLEANUP_NOT_REQUIRED_REASON}}

### Cleanup後の検証

{{CLEANUP_VERIFICATION}}

範囲を限定できない場合はcleanupコマンドを実行せず `BLOCKED` とする。cleanup失敗はQAシナリオの成否と併記し、最終結果を `BLOCKED` とする。

## 失敗時の停止と復旧

{{FAILURE_RECOVERY}}

復旧手順を特定できない状態: {{BLOCKED_RECOVERY}}

失敗時もmigration作成、共有DB初期化、未確認のSQL・API実行で回避しない。
