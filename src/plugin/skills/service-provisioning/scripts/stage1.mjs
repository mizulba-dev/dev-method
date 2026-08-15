#!/usr/bin/env node
import { createCloudflareClient } from './lib/cloudflare.mjs';
import { assertStage1Config, loadConfig } from './lib/config.mjs';
import { loadCredentials } from './lib/credentials.mjs';
import { createStage1Executors } from './lib/executors.mjs';
import { createLogger } from './lib/logger.mjs';
import { main, parseArgs, runPlan } from './lib/cli.mjs';
import { observeStage1, planStage1 } from './lib/stage1-plan.mjs';
import { createVercelClient } from './lib/vercel.mjs';

await main(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config) throw new Error('使い方: stage1.mjs --config <設定ファイル> [--execute]');
  const config = loadConfig(args.config);
  assertStage1Config(config);
  const creds = loadCredentials(['CLOUDFLARE_API_TOKEN', 'VERCEL_TOKEN']);
  const logger = createLogger();

  const readCf = createCloudflareClient({ token: creds.CLOUDFLARE_API_TOKEN });
  const readVercel = createVercelClient({ token: creds.VERCEL_TOKEN });
  const observation = await observeStage1({ config, cf: readCf, vercel: readVercel });

  const { executors } = createStage1Executors({
    observation,
    cf: createCloudflareClient({ token: creds.CLOUDFLARE_API_TOKEN, allowWrite: args.execute }),
    vercel: createVercelClient({ token: creds.VERCEL_TOKEN, allowWrite: args.execute }),
  });

  const steps = planStage1({ config, observation, executors });
  logger.line(`Stage 1: ${config.service} / ${config.domain}`);
  return runPlan({ steps, logger, execute: args.execute });
});
