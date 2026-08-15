import { createHttpClient } from './http.mjs';

const DIRECTORY = 'https://admin.googleapis.com';
const GROUPS_SETTINGS = 'https://www.googleapis.com';
const GMAIL = 'https://gmail.googleapis.com';

// 窓口グループの契約: 投稿は外部に開き、閲覧・発見は外部に開かない（アーカイブに第三者の個人情報が溜まるため）
export const EXTERNAL_POST = 'ANYONE_CAN_POST';
export const EXTERNAL_VIEW_VALUES = {
  whoCanViewGroup: 'ANYONE_CAN_VIEW',
  whoCanViewMembership: 'ANYONE_CAN_VIEW',
  whoCanDiscoverGroup: 'ANYONE_CAN_DISCOVER',
};
export const VIEW_FIELDS = Object.keys(EXTERNAL_VIEW_VALUES);

// 新規作成時の既定値。契約に属さないフィールドは既存グループとの照合対象にしない
export function buildGroupSettings() {
  return {
    whoCanPostMessage: EXTERNAL_POST,
    whoCanViewGroup: 'ALL_MEMBERS_CAN_VIEW',
    whoCanViewMembership: 'ALL_MANAGERS_CAN_VIEW',
    whoCanDiscoverGroup: 'ALL_MEMBERS_CAN_DISCOVER',
    whoCanJoin: 'INVITED_CAN_JOIN',
    allowExternalMembers: 'false',
    messageModerationLevel: 'MODERATE_NONE',
    spamModerationLevel: 'MODERATE',
    isArchived: 'true',
    archiveOnly: 'false',
    whoCanContactOwner: 'ANYONE_CAN_CONTACT',
    includeInGlobalAddressList: 'true',
    showInGroupDirectory: 'false',
  };
}

export function externalAccess(settings) {
  return {
    externalPost: settings?.whoCanPostMessage === EXTERNAL_POST,
    externalView: VIEW_FIELDS.some((field) => settings?.[field] === EXTERNAL_VIEW_VALUES[field]),
  };
}

// 照合するのは非対称の意味論だけ。既存グループの契約外フィールドは触らない
export function checkGroupSettingsContract(settings) {
  const violations = [];
  if (settings?.whoCanPostMessage !== EXTERNAL_POST) {
    violations.push({ field: 'whoCanPostMessage', expected: `${EXTERNAL_POST}（外部から投稿できる）`, actual: settings?.whoCanPostMessage ?? null });
  }
  for (const field of VIEW_FIELDS) {
    if (settings?.[field] === EXTERNAL_VIEW_VALUES[field]) {
      violations.push({ field, expected: `${EXTERNAL_VIEW_VALUES[field]} 以外（外部に開かない）`, actual: settings[field] });
    }
  }
  return violations;
}

export function dkimRecordName(domain, selector = 'google') {
  return `${selector}._domainkey.${domain}`;
}

export function buildMailDnsRecords({ domain, records, dmarcRua }) {
  const missing = [];
  if (!Array.isArray(records?.mx) || records.mx.length === 0) missing.push('mail.records.mx');
  if (!records?.spf) missing.push('mail.records.spf');
  if (missing.length) {
    throw new Error(`メール用 DNS の値が未設定です: ${missing.join(', ')}。Workspace 管理コンソールが提示する値を設定ファイルへ転記してください（決め打ちしません）`);
  }
  const dmarc = `v=DMARC1; p=none; rua=${dmarcRua}`;
  const out = records.mx.map((mx) => ({
    type: 'MX', name: domain, content: mx.content, priority: mx.priority, ttl: 1, proxied: false, purpose: 'mail-mx',
  }));
  out.push({ type: 'TXT', name: domain, content: records.spf, ttl: 1, proxied: false, purpose: 'mail-spf' });
  out.push({ type: 'TXT', name: `_dmarc.${domain}`, content: dmarc, ttl: 1, proxied: false, purpose: 'mail-dmarc' });
  if (records.dkim?.content) {
    out.push({
      type: 'TXT',
      name: dkimRecordName(domain, records.dkim.selector ?? 'google'),
      content: records.dkim.content,
      ttl: 1,
      proxied: false,
      purpose: 'mail-dkim',
    });
  }
  return out;
}

export function buildSpamFilter(address) {
  return { criteria: { to: address }, action: { removeLabelIds: ['SPAM'] } };
}

export function buildSendAs(address, displayName) {
  return { sendAsEmail: address, displayName, treatAsAlias: true };
}

function client(service, baseUrl, token, allowWrite, fetchImpl) {
  return createHttpClient({ service, baseUrl, headers: { authorization: `Bearer ${token}` }, allowWrite, fetchImpl });
}

export function createGoogleClient({ adminToken, gmailToken, allowWrite = false, fetchImpl }) {
  const directory = client('google-directory', DIRECTORY, adminToken, allowWrite, fetchImpl);
  const settings = client('google-groups-settings', GROUPS_SETTINGS, adminToken, allowWrite, fetchImpl);
  const gmail = gmailToken ? client('gmail', GMAIL, gmailToken, allowWrite, fetchImpl) : null;

  async function getOrNull(http, path, options) {
    try {
      return await http.get(path, options);
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  return {
    directory,
    settings,
    gmail,
    async listDomains() {
      const payload = await directory.get('/admin/directory/v1/customer/my_customer/domains');
      return payload?.domains ?? [];
    },
    addDomain: (domainName) => directory.post('/admin/directory/v1/customer/my_customer/domains', { domainName }),
    getVerificationToken: (domain) => settings.post('/siteVerification/v1/token', {
      site: { type: 'INET_DOMAIN', identifier: domain },
      verificationMethod: 'DNS_TXT',
    }, { readOnlySafe: true }),
    verifyDomain: (domain) => settings.post('/siteVerification/v1/webResource', {
      site: { type: 'INET_DOMAIN', identifier: domain },
    }, { query: { verificationMethod: 'DNS_TXT' } }),
    getGroup: (email) => getOrNull(directory, `/admin/directory/v1/groups/${encodeURIComponent(email)}`),
    createGroup: (body) => directory.post('/admin/directory/v1/groups', body),
    getGroupSettings: (email) => getOrNull(settings, `/groups/v1/groups/${encodeURIComponent(email)}`, { query: { alt: 'json' } }),
    updateGroupSettings: (email, body) => settings.put(`/groups/v1/groups/${encodeURIComponent(email)}`, body, { query: { alt: 'json' } }),
    async listMembers(email) {
      const payload = await getOrNull(directory, `/admin/directory/v1/groups/${encodeURIComponent(email)}/members`);
      return payload?.members ?? [];
    },
    addMember: (email, body) => directory.post(`/admin/directory/v1/groups/${encodeURIComponent(email)}/members`, body),
    async listFilters() {
      const payload = await gmail.get('/gmail/v1/users/me/settings/filters');
      return payload?.filter ?? [];
    },
    createFilter: (body) => gmail.post('/gmail/v1/users/me/settings/filters', body),
    async listSendAs() {
      const payload = await gmail.get('/gmail/v1/users/me/settings/sendAs');
      return payload?.sendAs ?? [];
    },
    createSendAs: (body) => gmail.post('/gmail/v1/users/me/settings/sendAs', body),
  };
}
