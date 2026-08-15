import { createHttpClient } from './http.mjs';

const BASE = 'https://api.cloudflare.com/client/v4';

function unwrap(payload, context) {
  if (payload && payload.success === false) {
    const messages = (payload.errors ?? []).map((e) => `${e.code}: ${e.message}`).join(' / ');
    throw new Error(`Cloudflare ${context} が失敗しました: ${messages || 'unknown error'}`);
  }
  return payload?.result ?? null;
}

// Cloudflare は TXT を引用符付き・長い値は分割して返すため、比較前に正規化する
export function normalizeTxt(value) {
  return String(value).replace(/"\s+"/g, '').replace(/^"|"$/g, '');
}

export function recordDiffFields(desired) {
  const fields = ['type', 'name', 'content'];
  if (desired.priority !== undefined) fields.push('priority');
  if (desired.proxied !== undefined) fields.push('proxied');
  return fields;
}

export function comparableRecord(record) {
  return {
    type: record.type,
    name: String(record.name).toLowerCase(),
    content: record.type === 'TXT' ? normalizeTxt(record.content) : record.content,
    priority: record.priority,
    proxied: record.proxied,
  };
}

export function createCloudflareClient({ token, allowWrite = false, fetchImpl }) {
  const http = createHttpClient({
    service: 'cloudflare',
    baseUrl: BASE,
    headers: { authorization: `Bearer ${token}` },
    allowWrite,
    fetchImpl,
  });

  return {
    http,
    async listAccounts() {
      return unwrap(await http.get('/accounts'), 'accounts 取得') ?? [];
    },
    async getZone(domain) {
      const zones = unwrap(await http.get('/zones', { query: { name: domain } }), 'zones 取得') ?? [];
      return zones.find((zone) => zone.name === domain) ?? null;
    },
    async listDnsRecords(zoneId) {
      return unwrap(await http.get(`/zones/${zoneId}/dns_records`, { query: { per_page: 100 } }), 'dns_records 取得') ?? [];
    },
    async createDnsRecord(zoneId, record) {
      return unwrap(await http.post(`/zones/${zoneId}/dns_records`, record), 'dns_record 作成');
    },
    async registrarSearch(accountId, query) {
      return unwrap(await http.get(`/accounts/${accountId}/registrar/domains/domain-search`, { query: { query } }), 'domain-search');
    },
    async registrarCheck(accountId, domains) {
      return unwrap(await http.get(`/accounts/${accountId}/registrar/domains/domain-check`, { query: { domain: domains.join(',') } }), 'domain-check');
    },
  };
}
