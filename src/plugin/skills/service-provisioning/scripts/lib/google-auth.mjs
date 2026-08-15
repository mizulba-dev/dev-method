import { createSign } from 'node:crypto';

import { registerSecret } from './secrets.mjs';

export const SCOPES = {
  directoryDomain: 'https://www.googleapis.com/auth/admin.directory.domain',
  directoryGroup: 'https://www.googleapis.com/auth/admin.directory.group',
  groupsSettings: 'https://www.googleapis.com/auth/apps.groups.settings',
  siteVerification: 'https://www.googleapis.com/auth/siteverification',
  gmailSettingsBasic: 'https://www.googleapis.com/auth/gmail.settings.basic',
  gmailSettingsSharing: 'https://www.googleapis.com/auth/gmail.settings.sharing',
};

const b64url = (input) => Buffer.from(input).toString('base64url');

export function buildAssertion({ clientEmail, privateKey, tokenUri, scopes, subject, iat = Math.floor(Date.now() / 1000), lifetime = 3600 }) {
  if (!Array.isArray(scopes) || scopes.length === 0) throw new Error('scopes が空です');
  if (!subject) throw new Error('subject（ドメイン全体委任の代理ユーザー）が必要です');
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: clientEmail,
    scope: scopes.join(' '),
    aud: tokenUri,
    sub: subject,
    iat,
    exp: iat + lifetime,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey).toString('base64url');
  return { assertion: `${signingInput}.${signature}`, header, claim };
}

export async function fetchAccessToken({ serviceAccount, scopes, subject, fetchImpl = globalThis.fetch, now }) {
  const tokenUri = serviceAccount.token_uri;
  const { assertion } = buildAssertion({
    clientEmail: serviceAccount.client_email,
    privateKey: serviceAccount.private_key,
    tokenUri,
    scopes,
    subject,
    iat: now,
  });
  registerSecret(assertion);
  const response = await fetchImpl(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Google トークン取得に失敗しました (HTTP ${response.status})。ドメイン全体委任のスコープ設定を確認してください: ${text.slice(0, 300)}`);
  }
  const parsed = JSON.parse(text);
  registerSecret(parsed.access_token);
  return parsed.access_token;
}
