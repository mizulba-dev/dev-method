#!/usr/bin/env node
import { createCloudflareClient } from './lib/cloudflare.mjs';
import { loadConfig } from './lib/config.mjs';
import { loadCredentials, loadServiceAccount } from './lib/credentials.mjs';
import { createStage2Executors } from './lib/executors.mjs';
import { createGoogleClient } from './lib/google.mjs';
import { fetchAccessToken, SCOPES } from './lib/google-auth.mjs';
import { createLogger } from './lib/logger.mjs';
import { main, parseArgs, runPlan } from './lib/cli.mjs';
import { observeStage2, planStage2, stage2Complete } from './lib/stage2-plan.mjs';

const ADMIN_SCOPES = [
  SCOPES.directoryDomain, SCOPES.directoryGroup, SCOPES.groupsSettings, SCOPES.siteVerification,
];
const GMAIL_SCOPES = [SCOPES.gmailSettingsBasic, SCOPES.gmailSettingsSharing];

await main(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config) throw new Error('使い方: stage2.mjs --config <設定ファイル> [--execute]');
  const config = loadConfig(args.config);
  if (!config.mail.enabled) throw new Error('設定に mail セクションがありません（Stage 2 はメール窓口の工程です）');
  const creds = loadCredentials(['CLOUDFLARE_API_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_ADMIN_EMAIL']);
  const serviceAccount = loadServiceAccount(creds.GOOGLE_APPLICATION_CREDENTIALS);
  const logger = createLogger({ json: args.json });

  const adminToken = await fetchAccessToken({ serviceAccount, scopes: ADMIN_SCOPES, subject: creds.GOOGLE_ADMIN_EMAIL });
  const gmailToken = await fetchAccessToken({ serviceAccount, scopes: GMAIL_SCOPES, subject: config.mail.deliveryUser });

  const readCf = createCloudflareClient({ token: creds.CLOUDFLARE_API_TOKEN });
  const readGoogle = createGoogleClient({ adminToken, gmailToken });
  const observation = await observeStage2({ config, cf: readCf, google: readGoogle });

  const executors = createStage2Executors({
    observation,
    cf: createCloudflareClient({ token: creds.CLOUDFLARE_API_TOKEN, allowWrite: args.execute }),
    google: createGoogleClient({ adminToken, gmailToken, allowWrite: args.execute }),
  });

  const steps = planStage2({ config, observation, executors });
  logger.line(`Stage 2: ${config.service} / ${config.mail.address}`);
  const code = await runPlan({ steps, logger, execute: args.execute });
  const completion = stage2Complete({ steps, observation });
  logger.line(completion.complete ? '完了条件を満たしました（DKIM レコードの実在を権威サーバーで確認済み）' : `未完了: ${completion.reason}`);
  return code;
});
