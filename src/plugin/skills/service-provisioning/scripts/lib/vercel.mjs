import { createHttpClient } from './http.mjs';

const BASE = 'https://api.vercel.com';

function pickRecommended(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  return sorted[0];
}

// レコード値は Vercel の応答（verification / recommended*）を正とし、こちらで決め打ちしない
export function deriveDnsRecords({ domain, apexName, verification = [], config = {} }) {
  const records = [];
  for (const challenge of verification) {
    if (challenge.type?.toUpperCase() !== 'TXT') continue;
    records.push({
      type: 'TXT', name: challenge.domain, content: challenge.value, ttl: 1, proxied: false, purpose: 'vercel-verification', exclusive: false,
    });
  }
  const isApex = !apexName || domain === apexName;
  if (isApex) {
    const recommended = pickRecommended(config.recommendedIPv4);
    for (const ip of recommended?.value ?? []) {
      records.push({ type: 'A', name: domain, content: ip, ttl: 1, proxied: false, purpose: 'vercel-apex' });
    }
  } else {
    const recommended = pickRecommended(config.recommendedCNAME);
    if (recommended?.value) {
      records.push({
        type: 'CNAME', name: domain, content: String(recommended.value).replace(/\.$/, ''), ttl: 1, proxied: false, purpose: 'vercel-cname',
      });
    }
  }
  if (records.filter((r) => r.purpose !== 'vercel-verification').length === 0) {
    throw new Error('Vercel が推奨 DNS レコードを返しませんでした。決め打ちの値は投入しません（Vercel のドメイン設定を確認してください）');
  }
  return records;
}

export function desiredEnv(entry) {
  return {
    key: entry.key,
    value: entry.value,
    type: entry.sensitive ? 'sensitive' : 'plain',
    target: entry.target ?? ['production', 'preview', 'development'],
  };
}

export function createVercelClient({ token, teamId, allowWrite = false, fetchImpl }) {
  const http = createHttpClient({
    service: 'vercel',
    baseUrl: BASE,
    headers: { authorization: `Bearer ${token}` },
    allowWrite,
    fetchImpl,
  });
  const scope = teamId ? { teamId } : {};

  async function getOrNull(path, options) {
    try {
      return await http.get(path, { ...options, query: { ...scope, ...(options?.query ?? {}) } });
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  return {
    http,
    getProject: (name) => getOrNull(`/v9/projects/${encodeURIComponent(name)}`),
    createProject: (body) => http.post('/v11/projects', body, { query: scope }),
    async listEnv(projectId) {
      const payload = await getOrNull(`/v10/projects/${projectId}/env`);
      return payload?.envs ?? [];
    },
    createEnv: (projectId, entries) => http.post(`/v10/projects/${projectId}/env`, entries, { query: scope }),
    async listDomains(projectId) {
      const payload = await getOrNull(`/v9/projects/${projectId}/domains`);
      return payload?.domains ?? [];
    },
    getDomain: (projectId, domain) => getOrNull(`/v9/projects/${projectId}/domains/${domain}`),
    addDomain: (projectId, name) => http.post(`/v10/projects/${projectId}/domains`, { name }, { query: scope }),
    domainConfig: (domain) => getOrNull(`/v6/domains/${domain}/config`),
  };
}

export function buildCreateProjectBody(config) {
  const body = { name: config.vercel.projectName };
  if (config.githubRepo) body.gitRepository = { type: 'github', repo: config.githubRepo };
  if (config.vercel.rootDirectory) body.rootDirectory = config.vercel.rootDirectory;
  if (config.vercel.framework) body.framework = config.vercel.framework;
  return body;
}
