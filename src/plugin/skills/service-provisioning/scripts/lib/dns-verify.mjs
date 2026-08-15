import { lookup, Resolver } from 'node:dns/promises';

const IP = /^[0-9.]+$|:/;

// 権威サーバーへ直接問い合わせる（ローカルキャッシュ・リゾルバの結果を信用しない）
export async function resolveTxtAuthoritative(name, nameServers, { createResolver = () => new Resolver(), resolveHost = lookup } = {}) {
  if (!Array.isArray(nameServers) || nameServers.length === 0) {
    throw new Error('権威ネームサーバーが不明なため DNS を検証できません');
  }
  const addresses = [];
  for (const server of nameServers) {
    addresses.push(IP.test(server) ? server : (await resolveHost(server)).address);
  }
  const resolver = createResolver();
  resolver.setServers(addresses);
  try {
    const chunks = await resolver.resolveTxt(name);
    return chunks.map((parts) => parts.join(''));
  } catch (error) {
    if (error.code === 'ENOTFOUND' || error.code === 'ENODATA') return [];
    throw error;
  }
}

export async function checkDkimPublished({ domain, selector = 'google', nameServers, resolveTxt = resolveTxtAuthoritative }) {
  const name = `${selector}._domainkey.${domain}`;
  const values = await resolveTxt(name, nameServers);
  const record = values.find((value) => value.includes('v=DKIM1'));
  return { name, published: Boolean(record && /p=[A-Za-z0-9+/=]{40,}/.test(record)), values };
}
