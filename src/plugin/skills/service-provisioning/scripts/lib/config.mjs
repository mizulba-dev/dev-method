import { readFileSync } from 'node:fs';

import { registerSecret } from './secrets.mjs';

const SERVICE_RE = /^[a-z][a-z0-9-]*$/;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function req(errors, condition, message) {
  if (!condition) errors.push(message);
}

export function normalizeConfig(input) {
  const errors = [];
  const c = input ?? {};
  req(errors, typeof c.service === 'string' && SERVICE_RE.test(c.service), 'service: kebab-case の英小文字で指定してください');
  req(errors, typeof c.domain === 'string' && DOMAIN_RE.test(c.domain), 'domain: 取得済みドメインを指定してください');

  const vercel = c.vercel ?? {};
  const mail = c.mail ?? {};
  const records = mail.records ?? {};

  const out = {
    service: c.service,
    domain: c.domain,
    githubRepo: c.githubRepo,
    vercel: {
      projectName: vercel.projectName ?? c.service,
      rootDirectory: vercel.rootDirectory ?? null,
      framework: vercel.framework ?? null,
      productionBranch: vercel.productionBranch ?? 'main',
      env: Array.isArray(vercel.env) ? vercel.env : [],
    },
    mail: {
      enabled: c.mail !== undefined,
      localPart: mail.localPart ?? 'info',
      groupName: mail.groupName ?? `${c.service} 窓口`,
      deliveryUser: mail.deliveryUser,
      dmarcRua: mail.dmarcRua,
      records: {
        mx: Array.isArray(records.mx) ? records.mx : null,
        spf: records.spf ?? null,
        dkim: records.dkim ?? null,
      },
    },
  };

  if (c.githubRepo !== undefined) {
    req(errors, REPO_RE.test(String(c.githubRepo)), 'githubRepo: owner/name 形式で指定してください');
  }
  for (const entry of out.vercel.env) {
    req(errors, typeof entry.key === 'string' && entry.key.length > 0, 'vercel.env[].key が必要です');
    req(errors, typeof entry.value === 'string', `vercel.env[${entry.key}].value が必要です`);
  }
  if (out.mail.enabled) {
    req(errors, typeof out.mail.deliveryUser === 'string' && out.mail.deliveryUser.includes('@'), 'mail.deliveryUser: 配送先ユーザーのアドレスが必要です');
    req(errors, typeof out.mail.dmarcRua === 'string' && out.mail.dmarcRua.startsWith('mailto:'), 'mail.dmarcRua: mailto: で始まる共通回収先が必要です');
    req(errors, /^[a-z0-9._-]+$/.test(out.mail.localPart), 'mail.localPart: 英小文字・数字・._- のみ');
  }
  if (errors.length) {
    const error = new Error(`設定が不正です:\n  - ${errors.join('\n  - ')}`);
    error.errors = errors;
    throw error;
  }
  // 環境変数の値は秘密かどうかを区別できないため、一律で出力マスクの対象にする
  for (const entry of out.vercel.env) registerSecret(entry.value);
  out.mail.address = `${out.mail.localPart}@${out.domain}`;
  return out;
}

// Stage 1 はプロジェクトを GitHub に接続した状態で作る。未接続のプロジェクトを作らない
export function assertStage1Config(config) {
  if (!config.githubRepo) {
    throw new Error('githubRepo が未指定です。GitHub に接続しない Vercel プロジェクトは作成しません（owner/name 形式で指定してください）');
  }
}

export function loadConfig(path, { readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(readFile(path));
  } catch (error) {
    throw new Error(`設定ファイルを読めません (${path}): ${error.message}`);
  }
  return normalizeConfig(parsed);
}
