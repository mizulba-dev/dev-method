import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { registerSecret } from './secrets.mjs';

const SOURCES = {
  CLOUDFLARE_API_TOKEN: 'cloudflare',
  VERCEL_TOKEN: 'vercel',
  GOOGLE_APPLICATION_CREDENTIALS: 'google',
  GOOGLE_ADMIN_EMAIL: 'google',
};

export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7) : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function expandHome(value, home) {
  if (value.startsWith('~/')) return join(home, value.slice(2));
  return value.replace(/^\$\{?HOME\}?(?=\/|$)/, home);
}

function fileEnv(source, { home, readFile }) {
  const path = join(home, '.config', source, 'env');
  try {
    return parseEnvFile(readFile(path));
  } catch {
    return {};
  }
}

export function loadCredentials(keys, { env = process.env, home = homedir(), readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  const cache = new Map();
  const out = {};
  const missing = [];
  for (const key of keys) {
    const source = SOURCES[key];
    if (!source) throw new Error(`unknown credential key: ${key}`);
    let value = env[key];
    if (!value) {
      if (!cache.has(source)) cache.set(source, fileEnv(source, { home, readFile }));
      value = cache.get(source)[key];
    }
    if (!value) {
      missing.push(`${key}（環境変数、または ~/.config/${source}/env）`);
      continue;
    }
    out[key] = key === 'GOOGLE_APPLICATION_CREDENTIALS' ? expandHome(value, home) : value;
    if (key !== 'GOOGLE_ADMIN_EMAIL' && key !== 'GOOGLE_APPLICATION_CREDENTIALS') registerSecret(value);
  }
  if (missing.length) {
    throw new Error(`資格情報が見つかりません:\n  - ${missing.join('\n  - ')}`);
  }
  return out;
}

export function loadServiceAccount(path, { readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  const parsed = JSON.parse(readFile(path));
  for (const field of ['client_email', 'private_key', 'token_uri']) {
    if (!parsed[field]) throw new Error(`サービスアカウント JSON に ${field} がありません`);
  }
  registerSecret(parsed.private_key);
  if (parsed.private_key_id) registerSecret(parsed.private_key_id);
  return parsed;
}
