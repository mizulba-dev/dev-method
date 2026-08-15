#!/usr/bin/env node
import { createCloudflareClient } from './lib/cloudflare.mjs';
import { loadCredentials } from './lib/credentials.mjs';
import { createLogger } from './lib/logger.mjs';
import { main } from './lib/cli.mjs';
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

  for (const term of terms) {
    try {
      const result = await cf.registrarSearch(accountId, term);
      logger.line(`# 検索: ${term}`);
      for (const line of renderResults(result?.results ?? result ?? [])) logger.line(line);
    } catch (error) {
      logger.line(`# 検索: ${term} — 利用できません（Registrar API はベータで、対応 TLD・エンドポイントが変わりえます）`);
      logger.line(`  ${error.message}`);
    }
  }
  if (domains.length) {
    try {
      const result = await cf.registrarCheck(accountId, domains);
      logger.line('# 空き確認');
      for (const line of renderResults(result?.results ?? result ?? [])) logger.line(line);
    } catch (error) {
      logger.line('# 空き確認 — 利用できません（Registrar API はベータで、対応 TLD・エンドポイントが変わりえます）');
      logger.line(`  ${error.message}`);
    }
  }
  logger.line('購入はこのツールでは行いません。Cloudflare ダッシュボードで人が実行してください。');
  return 0;
});
