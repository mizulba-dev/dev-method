#!/usr/bin/env node
import { createCloudflareClient } from './lib/cloudflare.mjs';
import { loadCredentials } from './lib/credentials.mjs';
import { createLogger } from './lib/logger.mjs';
import { main } from './lib/cli.mjs';
import { ApiError } from './lib/http.mjs';
import { registerSecret } from './lib/secrets.mjs';

export function formatPrice(entry) {
  const price = entry.price ?? entry.registration_price ?? entry.fee ?? null;
  const currency = entry.currency ?? 'USD';
  return price === null ? '価格不明' : `${price} ${currency}`;
}

export function renderResults(results) {
  return results.map((entry) => {
    const name = entry.name ?? entry.domain ?? '(不明)';
    const available = entry.available ?? entry.availability ?? null;
    const state = available === true ? '空き' : available === false ? '取得済み' : '判定不能';
    return `${name}\t${state}\t${formatPrice(entry)}`;
  });
}

export function describeFailure(error) {
  if (error instanceof ApiError) {
    if (error.status === 404) return 'このアカウントでは提供されていません（Registrar API はベータで、対応 TLD とエンドポイントが限られます）';
    if (error.status === 401 || error.status === 403) return 'API トークンの権限が足りません（Registrar の読み取り権限を確認してください）';
    if (error.status === 429) return 'レート制限に達しました。時間をおいて再実行してください';
    return `Cloudflare が HTTP ${error.status} を返しました`;
  }
  if (error?.message?.startsWith('Cloudflare ')) return `Cloudflare がエラーを返しました: ${error.message}`;
  return `Cloudflare へ到達できませんでした（ネットワークまたは DNS の問題）: ${error.message}`;
}

await main(async () => {
  const queries = process.argv.slice(2).filter((value) => !value.startsWith('-'));
  if (queries.length === 0) throw new Error('使い方: check.mjs <検索語またはドメイン> [...]');
  const creds = loadCredentials(['CLOUDFLARE_API_TOKEN']);
  const logger = createLogger();
  // 書き込みを持たない（allowWrite は既定の false のまま）。購入は人が Cloudflare ダッシュボードで行う
  const cf = createCloudflareClient({ token: creds.CLOUDFLARE_API_TOKEN });
  const accounts = await cf.listAccounts();
  if (accounts.length === 0) throw new Error('Cloudflare アカウントを取得できませんでした');
  const accountId = accounts[0].id;
  registerSecret(accountId);

  const domains = queries.filter((q) => q.includes('.'));
  const terms = queries.filter((q) => !q.includes('.'));
  const failures = [];

  for (const term of terms) {
    try {
      const result = await cf.registrarSearch(accountId, term);
      logger.line(`# 検索: ${term}`);
      for (const line of renderResults(result?.results ?? result ?? [])) logger.line(line);
    } catch (error) {
      failures.push(`検索: ${term}`);
      logger.line(`# 検索: ${term} — 確認できませんでした`);
      logger.line(`  ${describeFailure(error)}`);
    }
  }
  if (domains.length) {
    try {
      const result = await cf.registrarCheck(accountId, domains);
      logger.line('# 空き確認');
      for (const line of renderResults(result?.results ?? result ?? [])) logger.line(line);
    } catch (error) {
      failures.push(`空き確認: ${domains.join(', ')}`);
      logger.line('# 空き確認 — 確認できませんでした');
      logger.line(`  ${describeFailure(error)}`);
    }
  }
  logger.line('購入はこのツールでは行いません。Cloudflare ダッシュボードで人が実行してください。');
  if (failures.length) {
    logger.line(`確認できなかった問い合わせが ${failures.length} 件あります: ${failures.join(' / ')}`);
    return 2;
  }
  return 0;
});
