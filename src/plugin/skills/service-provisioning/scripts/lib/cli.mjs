import { applySteps, hasDrift, renderStep, summarize } from './plan.mjs';
import { redact } from './secrets.mjs';

export function parseArgs(argv) {
  const args = { config: null, execute: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--execute') args.execute = true;
    else if (value === '--json') args.json = true;
    else if (value === '--config') { args.config = argv[i + 1]; i += 1; } else if (value.startsWith('--config=')) args.config = value.slice(9);
    else if (!args.config && !value.startsWith('-')) args.config = value;
  }
  return args;
}

export function printPlan(steps, logger, { execute }) {
  logger.line(execute ? '=== 実行計画（--execute）===' : '=== dry-run（既定。--execute で実行）===');
  for (const step of steps) logger.line(renderStep(step));
  const counts = summarize(steps);
  logger.line(`合計: create=${counts.create} skip=${counts.skip} drift=${counts.drift} manual=${counts.manual}`);
  return counts;
}

export async function runPlan({ steps, logger, execute }) {
  printPlan(steps, logger, { execute });
  // 乖離があれば --execute でも一切適用しない（後方の乖離が先行の作成を抑止する）
  if (hasDrift(steps)) {
    logger.line('乖離があります。設定ファイルか実環境のどちらを正とするか決めてから再実行してください。適用は行いません。');
    return 2;
  }
  if (!execute) return 0;
  const result = await applySteps(steps, logger);
  if (result.failed) return 1;
  if (result.stopped) return result.stopped.action === 'drift' ? 2 : 3;
  logger.line('すべての工程を適用しました。');
  return 0;
}

export async function main(runner) {
  try {
    process.exitCode = await runner();
  } catch (error) {
    process.stderr.write(`${redact(error.message)}\n`);
    process.exitCode = 1;
  }
}
