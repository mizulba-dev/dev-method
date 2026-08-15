const registry = new Set();

const PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

export const MASK = '[REDACTED]';

export function registerSecret(value) {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed.length < 8) return;
  registry.add(trimmed);
}

export function clearSecrets() {
  registry.clear();
}

export function redact(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const secret of registry) out = out.split(secret).join(MASK);
  for (const pattern of PATTERNS) out = out.replace(pattern, MASK);
  return out;
}

export function redactDeep(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, seen));
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = redactDeep(item, seen);
  return out;
}

export function print(stream, text) {
  stream.write(`${redact(text)}\n`);
}
