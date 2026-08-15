#!/usr/bin/env node
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { comparableRecord, createCloudflareClient, normalizeTxt } from '../scripts/lib/cloudflare.mjs';
import { describeFailure } from '../scripts/check.mjs';
import { parseArgs, printPlan, runPlan } from '../scripts/lib/cli.mjs';
import { ApiError } from '../scripts/lib/http.mjs';
import { assertStage1Config, normalizeConfig } from '../scripts/lib/config.mjs';
import { createStage1Executors, createStage2Executors } from '../scripts/lib/executors.mjs';
import { expandHome, parseEnvFile } from '../scripts/lib/credentials.mjs';
import { checkDkimPublished } from '../scripts/lib/dns-verify.mjs';
import { buildAssertion } from '../scripts/lib/google-auth.mjs';
import {
  buildGroupSettings, buildMailDnsRecords, buildSendAs, buildSpamFilter, checkGroupSettingsContract, createGoogleClient, externalAccess,
} from '../scripts/lib/google.mjs';
import { createMemoryLogger } from '../scripts/lib/logger.mjs';
import {
  applySteps, blockingManual, CREATE, DRIFT, MANUAL, SKIP,
} from '../scripts/lib/plan.mjs';
import { clearSecrets, redact, registerSecret } from '../scripts/lib/secrets.mjs';
import { observeStage1, planStage1 } from '../scripts/lib/stage1-plan.mjs';
import { groupSettingsAsymmetry, planStage2, stage2Complete } from '../scripts/lib/stage2-plan.mjs';
import { buildCreateProjectBody, createVercelClient, deriveDnsRecords, desiredEnv } from '../scripts/lib/vercel.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', `${name}.json`), 'utf8')).response;

const DOMAIN = 'sample-service.example';
const results = [];

function test(layer, name, fn) {
  try {
    fn();
    results.push({ layer, name, ok: true });
  } catch (error) {
    results.push({ layer, name, ok: false, error });
  }
}

async function testAsync(layer, name, fn) {
  try {
    await fn();
    results.push({ layer, name, ok: true });
  } catch (error) {
    results.push({ layer, name, ok: false, error });
  }
}

const baseConfig = normalizeConfig({
  service: 'sample-service',
  domain: DOMAIN,
  githubRepo: 'your-org/sample-service',
  vercel: {
    rootDirectory: 'web',
    framework: 'nextjs',
    env: [{ key: 'NEXT_PUBLIC_SITE_URL', value: `https://${DOMAIN}`, target: ['production', 'preview', 'development'] }],
  },
  mail: {
    localPart: 'info',
    groupName: 'sample-service 窓口',
    deliveryUser: 'owner@brand.example',
    dmarcRua: 'mailto:dmarc-reports@brand.example',
    records: {
      mx: [{ priority: 10, content: 'smtp.google.com' }],
      spf: 'v=spf1 include:_spf.google.com ~all',
    },
  },
});

// ---------------------------------------------------------------- 層1: 引数構築

test('層1', '設定ファイルの検証（dmarcRua が mailto でなければ拒否）', () => {
  throws(() => normalizeConfig({ ...JSON.parse(JSON.stringify({ service: 's', domain: DOMAIN })), mail: { deliveryUser: 'a@b.test', dmarcRua: 'dmarc@b.test' } }), /dmarcRua/);
});

test('層1', 'env ファイルの解釈と $HOME 展開', () => {
  deepStrictEqual(parseEnvFile('# c\nexport A=1\nB="two"\n'), { A: '1', B: 'two' });
  strictEqual(expandHome('$HOME/.config/x', '/home/u'), '/home/u/.config/x');
  strictEqual(expandHome('~/.config/x', '/home/u'), '/home/u/.config/x');
});

test('層1', 'Vercel プロジェクト作成ボディに repo と rootDirectory が入る', () => {
  deepStrictEqual(buildCreateProjectBody(baseConfig), {
    name: 'sample-service',
    gitRepository: { type: 'github', repo: 'your-org/sample-service' },
    rootDirectory: 'web',
    framework: 'nextjs',
  });
});

test('層1', '環境変数は値を照合できる plain で作る', () => {
  const built = desiredEnv(baseConfig.vercel.env[0]);
  strictEqual(built.type, 'plain');
  deepStrictEqual(built.target, ['production', 'preview', 'development']);
});

test('層1', 'apex の DNS は Vercel の recommendedIPv4 rank1 を使い proxied=false', () => {
  const config = fixture('vercel-domain-config');
  const records = deriveDnsRecords({ domain: DOMAIN, apexName: DOMAIN, config });
  deepStrictEqual(records.map((r) => r.content), config.recommendedIPv4[0].value);
  ok(records.every((r) => r.type === 'A' && r.proxied === false));
});

test('層1', 'サブドメインの DNS は recommendedCNAME rank1 を使う（末尾ドットを落とす）', () => {
  const config = fixture('vercel-domain-config');
  const records = deriveDnsRecords({ domain: `www.${DOMAIN}`, apexName: DOMAIN, config });
  strictEqual(records[0].type, 'CNAME');
  strictEqual(records[0].content, config.recommendedCNAME[0].value.replace(/\.$/, ''));
  strictEqual(records[0].proxied, false);
});

test('層1', '推奨レコードが無ければ決め打ちせず失敗する', () => {
  throws(() => deriveDnsRecords({ domain: DOMAIN, apexName: DOMAIN, config: {} }), /決め打ち/);
});

test('層1', 'ドメイン所有権確認の TXT チャレンジをレコード化する', () => {
  const records = deriveDnsRecords({
    domain: DOMAIN,
    apexName: DOMAIN,
    verification: [{ type: 'TXT', domain: `_vercel.${DOMAIN}`, value: 'vc-domain-verify=xyz' }],
    config: fixture('vercel-domain-config'),
  });
  const challenge = records.find((r) => r.purpose === 'vercel-verification');
  strictEqual(challenge.content, 'vc-domain-verify=xyz');
});

test('層1', 'グループ設定: 投稿は外部に開く', () => {
  strictEqual(groupSettingsAsymmetry(buildGroupSettings()).externalPost, true);
});

// 識別反証: 「外部に開く」だけを見る assert では対照実装も通るため、閲覧側を独立に assert する
test('層1', 'グループ設定: 閲覧は外部に開かない（非対称）', () => {
  strictEqual(groupSettingsAsymmetry(buildGroupSettings()).externalView, false);
  const mutant = { ...buildGroupSettings(), whoCanViewGroup: 'ANYONE_CAN_VIEW' };
  strictEqual(groupSettingsAsymmetry(mutant).externalView, true, '対照実装は非対称 assert で検出されるべき');
});

test('層1', '実応答のグループ設定に非対称判定を当てられる', () => {
  const real = fixture('google-group-settings');
  strictEqual(groupSettingsAsymmetry(real).externalPost, true);
  strictEqual(groupSettingsAsymmetry(real).externalView, false);
});

test('層1', 'DMARC は p=none で始まり rua に共通回収先を指定する', () => {
  const records = buildMailDnsRecords({ domain: DOMAIN, records: baseConfig.mail.records, dmarcRua: baseConfig.mail.dmarcRua });
  const dmarc = records.find((r) => r.purpose === 'mail-dmarc');
  strictEqual(dmarc.name, `_dmarc.${DOMAIN}`);
  ok(dmarc.content.includes('p=none'));
  ok(dmarc.content.includes('rua=mailto:dmarc-reports@brand.example'));
});

test('層1', 'MX は設定値をそのまま使い決め打ちしない', () => {
  const records = buildMailDnsRecords({
    domain: DOMAIN,
    records: { mx: [{ priority: 5, content: 'alt.smtp.google.com' }], spf: 'v=spf1 -all' },
    dmarcRua: 'mailto:x@brand.example',
  });
  const mx = records.filter((r) => r.type === 'MX');
  strictEqual(mx.length, 1);
  strictEqual(mx[0].content, 'alt.smtp.google.com');
  strictEqual(mx[0].priority, 5);
});

test('層1', 'MX / SPF が未設定なら停止する（管理コンソール提示値が正）', () => {
  throws(() => buildMailDnsRecords({ domain: DOMAIN, records: {}, dmarcRua: 'mailto:x@brand.example' }), /mail\.records\.mx/);
});

test('層1', 'メール DNS はすべて proxied=false', () => {
  const records = buildMailDnsRecords({ domain: DOMAIN, records: baseConfig.mail.records, dmarcRua: baseConfig.mail.dmarcRua });
  ok(records.every((r) => r.proxied === false));
});

test('層1', 'Gmail のフィルタと sendAs のボディ', () => {
  deepStrictEqual(buildSpamFilter('info@x.test'), { criteria: { to: 'info@x.test' }, action: { removeLabelIds: ['SPAM'] } });
  deepStrictEqual(buildSendAs('info@x.test', '窓口'), { sendAsEmail: 'info@x.test', displayName: '窓口', treatAsAlias: true });
});

test('層1', 'JWT アサーションは RS256・委任 sub・スペース区切り scope で署名される', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const { assertion, claim } = buildAssertion({
    clientEmail: 'sa@project.iam.gserviceaccount.com',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    tokenUri: 'https://oauth2.googleapis.com/token',
    scopes: ['https://a', 'https://b'],
    subject: 'admin@brand.example',
    iat: 1000,
  });
  strictEqual(claim.scope, 'https://a https://b');
  strictEqual(claim.sub, 'admin@brand.example');
  strictEqual(claim.exp, 4600);
  const [h, c, s] = assertion.split('.');
  deepStrictEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  ok(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url')));
});

test('層1', '委任 subject が無ければ署名しない', () => {
  throws(() => buildAssertion({ clientEmail: 'a', privateKey: 'b', tokenUri: 'c', scopes: ['d'] }), /subject/);
});

test('層1', 'Cloudflare の TXT 応答（引用符・分割）を正規化して比較する', () => {
  strictEqual(normalizeTxt('"v=spf1 include:_spf.google.com ~all"'), 'v=spf1 include:_spf.google.com ~all');
  strictEqual(normalizeTxt('"v=DKIM1;p=AAA" "BBB"'), 'v=DKIM1;p=AAABBB');
  const real = fixture('cf-dns-records').result.find((r) => String(r.content).includes('v=spf1'));
  strictEqual(comparableRecord(real).content, 'v=spf1 include:_spf.google.com ~all');
});

// ---------------------------------------------------------------- 秘密情報

test('層1', 'ログ出力に登録済みの秘密が出ない', () => {
  clearSecrets();
  registerSecret('cf-token-abcdefghijklmnop');
  const logger = createMemoryLogger();
  logger.line('Authorization: Bearer cf-token-abcdefghijklmnop');
  logger.record({ token: 'cf-token-abcdefghijklmnop', nested: { key: 'cf-token-abcdefghijklmnop' } });
  ok(!logger.text().includes('cf-token-abcdefghijklmnop'), `秘密が出力に含まれた: ${logger.text()}`);
  ok(logger.text().includes('[REDACTED]'));
  clearSecrets();
});

test('層1', '未登録でも Bearer / JWT / 秘密鍵の形は伏せる', () => {
  clearSecrets();
  ok(!redact('Bearer sk_live_0123456789abcdef').includes('sk_live'));
  ok(!redact('eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.SIGNATUREVALUE00').includes('SIGNATUREVALUE'));
  ok(!redact('-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----').includes('MIIabc'));
});

// ---------------------------------------------------------------- 層2: dry-run の出力

function stage1Observation({ project, envs = [], attached, dnsRecords = [] } = {}) {
  return {
    zone: fixture('cf-zones').result[0],
    dnsRecords,
    project: project ?? null,
    envs,
    domains: attached ? [attached] : [],
    attached: attached ?? null,
    domainConfig: attached ? fixture('vercel-domain-config') : null,
  };
}

const realProject = {
  id: 'prj_fixture', name: 'sample-service', rootDirectory: 'web', framework: 'nextjs', link: { org: 'your-org', repo: 'sample-service' },
};

test('層2', '既存が無ければ create を提示する', () => {
  const steps = planStage1({ config: baseConfig, observation: stage1Observation() });
  strictEqual(steps[0].action, CREATE);
  strictEqual(steps.find((s) => s.resource.startsWith('vercel env')).action, CREATE);
});

test('層2', '既存があり設定一致なら skip する', () => {
  const steps = planStage1({
    config: baseConfig,
    observation: stage1Observation({
      project: realProject,
      envs: [{ key: 'NEXT_PUBLIC_SITE_URL', value: `https://${DOMAIN}`, type: 'plain', target: ['development', 'preview', 'production'] }],
    }),
  });
  strictEqual(steps[0].action, SKIP);
  strictEqual(steps.find((s) => s.resource.startsWith('vercel env')).action, SKIP);
});

// 識別反証: 存在チェックだけで skip する対照実装は、この入力で skip を出して落ちる
test('層2', '既存があり設定乖離なら drift を報告して skip しない', () => {
  const steps = planStage1({
    config: baseConfig,
    observation: stage1Observation({
      project: { ...realProject, rootDirectory: 'apps/web' },
      envs: [{ key: 'NEXT_PUBLIC_SITE_URL', value: 'https://old.example', type: 'plain', target: ['production'] }],
    }),
  });
  strictEqual(steps[0].action, DRIFT);
  deepStrictEqual(steps[0].drift.map((d) => d.field), ['rootDirectory']);
  const env = steps.find((s) => s.resource.startsWith('vercel env'));
  strictEqual(env.action, DRIFT);
  ok(env.drift.some((d) => d.field === 'value'));
});

test('層2', '値を読み取れない環境変数は skip せず人へ渡す', () => {
  const realEnv = fixture('vercel-project-env').envs[0];
  const config = normalizeConfig({
    service: 'sample-service', domain: DOMAIN, vercel: { env: [{ key: realEnv.key, value: 'https://x.test' }] },
  });
  const steps = planStage1({ config, observation: stage1Observation({ project: realProject, envs: [realEnv] }) });
  strictEqual(steps.find((s) => s.resource.startsWith('vercel env')).action, MANUAL);
});

test('層2', 'DNS: 実応答のレコードと一致すれば skip、proxied が違えば drift', () => {
  const wwwConfig = normalizeConfig({ service: 'sample-service', domain: `www.${DOMAIN}`, vercel: { projectName: 'sample-service' } });
  const attached = { ...fixture('vercel-project-domains').domains[0], name: `www.${DOMAIN}`, apexName: DOMAIN };
  const cname = fixture('cf-dns-records').result.find((r) => r.type === 'CNAME');
  const matching = [{ ...cname, name: `www.${DOMAIN}`, content: 'aaaabbbbccccdddd.vercel-dns-016.com', proxied: false }];
  const skipSteps = planStage1({ config: wwwConfig, observation: stage1Observation({ project: realProject, attached, dnsRecords: matching }) });
  strictEqual(skipSteps.find((s) => s.resource.startsWith('dns CNAME')).action, SKIP);

  // 実応答の CNAME は proxied=true。プロキシ有効だと Vercel のドメイン検証が失敗するため契約は false
  const proxied = [{ ...matching[0], proxied: true }];
  const driftSteps = planStage1({ config: wwwConfig, observation: stage1Observation({ project: realProject, attached, dnsRecords: proxied }) });
  const step = driftSteps.find((s) => s.resource.startsWith('dns CNAME'));
  strictEqual(step.action, DRIFT);
  deepStrictEqual(step.drift.map((d) => d.field), ['proxied']);
});

test('層2', 'DNS: apex は Vercel 推奨 IPv4 と一致すれば skip する', () => {
  const attached = { ...fixture('vercel-project-domains').domains[0], name: DOMAIN, apexName: DOMAIN };
  const ips = fixture('vercel-domain-config').recommendedIPv4[0].value;
  const existing = ips.map((ip) => ({ type: 'A', name: DOMAIN, content: ip, proxied: false, ttl: 1 }));
  const steps = planStage1({ config: baseConfig, observation: stage1Observation({ project: realProject, attached, dnsRecords: existing }) });
  const dnsSteps = steps.filter((s) => s.resource.startsWith('dns A'));
  strictEqual(dnsSteps.length, ips.length);
  ok(dnsSteps.every((s) => s.action === SKIP));
});

// 実環境の dry-run で見つかった経路: apex に CNAME があると A は追加できない
test('層2', 'DNS: 同じ名前に CNAME があれば A の作成を提示せず drift にする', () => {
  const attached = { ...fixture('vercel-project-domains').domains[0], name: DOMAIN, apexName: DOMAIN };
  const existing = [fixture('cf-dns-records').result.find((r) => r.type === 'CNAME' && r.name === DOMAIN)];
  const steps = planStage1({ config: baseConfig, observation: stage1Observation({ project: realProject, attached, dnsRecords: existing }) });
  const dnsSteps = steps.filter((s) => s.resource.startsWith('dns A'));
  ok(dnsSteps.length > 0);
  ok(dnsSteps.every((s) => s.action === DRIFT), '共存できないレコードの作成を提示してはいけない');
  deepStrictEqual(dnsSteps[0].drift.map((d) => d.field), ['type']);
});

test('層2', 'ドメイン未追加なら DNS 値を確定させず人へ返す', () => {
  const steps = planStage1({ config: baseConfig, observation: stage1Observation({ project: realProject }) });
  const dns = steps.find((s) => s.resource.startsWith('dns '));
  strictEqual(dns.action, MANUAL);
});

function stage2Observation(overrides = {}) {
  return {
    zone: fixture('cf-zones').result[0],
    dnsRecords: [],
    workspaceDomain: null,
    group: null,
    groupSettings: null,
    members: [],
    filters: [],
    sendAs: [],
    verificationToken: null,
    verificationError: 'テストでは未取得',
    dkim: { name: `google._domainkey.${DOMAIN}`, published: false, values: [] },
    ...overrides,
  };
}

test('層2', 'Stage2: 何も無ければセカンダリドメインとグループを create する', () => {
  const steps = planStage2({ config: baseConfig, observation: stage2Observation() });
  strictEqual(steps.find((s) => s.resource.startsWith('workspace secondary domain')).action, CREATE);
  strictEqual(steps.find((s) => s.resource.startsWith('group ')).action, CREATE);
  strictEqual(steps.find((s) => s.resource.startsWith('group settings')).action, CREATE);
});

test('層2', 'Stage2: 実応答のメール DNS と一致すれば skip する', () => {
  const existing = fixture('cf-dns-records').result;
  const config = normalizeConfig({
    service: 'sample-service',
    domain: DOMAIN,
    mail: {
      deliveryUser: 'owner@brand.example',
      dmarcRua: 'mailto:dmarc-reports@brand.example',
      records: { mx: [{ priority: 10, content: 'smtp.google.com' }], spf: 'v=spf1 include:_spf.google.com ~all' },
    },
  });
  const steps = planStage2({ config, observation: stage2Observation({ dnsRecords: existing }) });
  for (const kind of ['dns MX', 'dns TXT _dmarc', 'dns TXT sample-service.example']) {
    const step = steps.find((s) => s.resource.startsWith(kind));
    strictEqual(step.action, SKIP, `${kind} は skip のはず: ${JSON.stringify(step.drift ?? null)}`);
  }
});

test('層2', 'Stage2: DMARC の値が乖離していれば drift を報告する', () => {
  const existing = fixture('cf-dns-records').result;
  const config = normalizeConfig({
    service: 'sample-service',
    domain: DOMAIN,
    mail: { deliveryUser: 'owner@brand.example', dmarcRua: 'mailto:other@brand.example', records: { mx: [{ priority: 10, content: 'smtp.google.com' }], spf: 'v=spf1 include:_spf.google.com ~all' } },
  });
  const steps = planStage2({ config, observation: stage2Observation({ dnsRecords: existing }) });
  const dmarc = steps.find((s) => s.resource.startsWith('dns TXT _dmarc'));
  strictEqual(dmarc.action, DRIFT);
});

test('層2', 'Stage2: 既存グループの閲覧設定が外部公開なら drift として停止する', () => {
  const settings = { ...buildGroupSettings(), whoCanViewGroup: 'ANYONE_CAN_VIEW' };
  const steps = planStage2({
    config: baseConfig,
    observation: stage2Observation({ group: { email: baseConfig.mail.address, name: baseConfig.mail.groupName }, groupSettings: settings }),
  });
  const step = steps.find((s) => s.resource.startsWith('group settings'));
  strictEqual(step.action, DRIFT);
  ok(step.drift.some((d) => d.field === 'whoCanViewGroup'));
});

test('層2', 'Stage2: DKIM 未公開なら停止工程を提示する', () => {
  const steps = planStage2({ config: baseConfig, observation: stage2Observation() });
  const dkim = steps.find((s) => s.resource.startsWith('dkim '));
  strictEqual(dkim.action, MANUAL);
});

// 識別反証: DKIM 未有効のまま完了を返す対照実装は、この assert で落ちる
test('層2', 'Stage2: 他がすべて skip でも DKIM 未公開なら完了にしない', () => {
  const steps = [{ resource: 'x', action: SKIP }];
  const notPublished = stage2Complete({ steps, observation: stage2Observation() });
  strictEqual(notPublished.complete, false);
  ok(notPublished.reason.includes('DKIM'));
  const published = stage2Complete({ steps, observation: stage2Observation({ dkim: { published: true, name: 'x', values: [] } }) });
  strictEqual(published.complete, true);
});

await testAsync('層2', 'DKIM 判定は権威サーバーの応答を根拠にする', async () => {
  const empty = await checkDkimPublished({ domain: DOMAIN, nameServers: ['1.1.1.1'], resolveTxt: async () => [] });
  strictEqual(empty.published, false);
  const stub = await checkDkimPublished({ domain: DOMAIN, nameServers: ['1.1.1.1'], resolveTxt: async () => ['v=DKIM1; k=rsa; p=short'] });
  strictEqual(stub.published, false, '鍵素材の無いレコードを公開済みと判定してはいけない');
  const real = await checkDkimPublished({
    domain: DOMAIN, nameServers: ['1.1.1.1'], resolveTxt: async () => [`v=DKIM1;k=rsa;p=${'A'.repeat(60)}`],
  });
  strictEqual(real.published, true);
});

await testAsync('層2', '権威ネームサーバーが不明なら検証せず失敗する', async () => {
  let failed = false;
  try {
    await checkDkimPublished({ domain: DOMAIN, nameServers: [] });
  } catch (error) {
    failed = /権威ネームサーバー/.test(error.message);
  }
  ok(failed, 'ローカルリゾルバへフォールバックしてはいけない');
});

await testAsync('層2', 'dry-run のクライアントは書き込みを送出しない', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push(init.method); return { ok: true, status: 200, text: async () => '{}' }; };
  const cf = createCloudflareClient({ token: 't', fetchImpl });
  const vercel = createVercelClient({ token: 't', fetchImpl });
  const google = createGoogleClient({ adminToken: 't', gmailToken: 't', fetchImpl });
  for (const call of [
    () => cf.createDnsRecord('zone', {}),
    () => vercel.createProject({}),
    () => google.createGroup({}),
    () => google.updateGroupSettings('a@b.test', {}),
  ]) {
    let blocked = false;
    try { await call(); } catch (error) { blocked = /読み取り専用/.test(error.message); }
    ok(blocked, '書き込みが dry-run で送出された');
  }
  ok(calls.every((method) => method === 'GET'), `GET 以外が送出された: ${calls.join(',')}`);
});

await testAsync('層2', '観測は読み取り専用クライアントで完結する', async () => {
  const methods = [];
  const routes = {
    '/zones': { result: [fixture('cf-zones').result[0]] },
    '/dns_records': { result: fixture('cf-dns-records').result },
    '/v9/projects/sample-service': realProject,
    '/env': fixture('vercel-project-env'),
    '/domains': fixture('vercel-project-domains'),
  };
  const fetchImpl = async (url, init) => {
    methods.push(init.method);
    const key = Object.keys(routes).find((path) => url.includes(path));
    return { ok: true, status: 200, text: async () => JSON.stringify(key ? routes[key] : {}) };
  };
  const observation = await observeStage1({
    config: baseConfig,
    cf: createCloudflareClient({ token: 't', fetchImpl }),
    vercel: createVercelClient({ token: 't', fetchImpl }),
  });
  strictEqual(observation.zone.name, DOMAIN);
  ok(methods.every((method) => method === 'GET'));
});

// ---------------------------------------------------------------- 契約の意味論（グループ設定）

test('層1', 'グループ設定: 3フィールドそれぞれの外部値を検出する', () => {
  const externals = { whoCanViewGroup: 'ANYONE_CAN_VIEW', whoCanViewMembership: 'ANYONE_CAN_VIEW', whoCanDiscoverGroup: 'ANYONE_CAN_DISCOVER' };
  for (const [field, value] of Object.entries(externals)) {
    const settings = { ...buildGroupSettings(), [field]: value };
    strictEqual(externalAccess(settings).externalView, true, `${field} の外部値を検出できていない`);
    ok(checkGroupSettingsContract(settings).some((v) => v.field === field));
  }
});

test('層1', 'グループ設定: 迷惑メールは保留してモデレーターに通知する', () => {
  strictEqual(buildGroupSettings().spamModerationLevel, 'MODERATE');
});

test('層2', 'Stage2: 契約外のフィールドが既定と違っても skip する', () => {
  const settings = {
    ...buildGroupSettings(), whoCanJoin: 'ALL_IN_DOMAIN_CAN_JOIN', whoCanViewGroup: 'ALL_IN_DOMAIN_CAN_VIEW', whoCanContactOwner: 'ALL_MANAGERS_CAN_CONTACT',
  };
  const steps = planStage2({
    config: baseConfig,
    observation: stage2Observation({ group: { email: baseConfig.mail.address, name: baseConfig.mail.groupName }, groupSettings: settings }),
  });
  strictEqual(steps.find((s) => s.resource.startsWith('group settings')).action, SKIP);
});

// ---------------------------------------------------------------- 完了状態機械

const PROVISIONED_DKIM = 'v=DKIM1;k=rsa;p=DKIMPUBLICKEYPLACEHOLDER';
const VERIFICATION_TOKEN = 'google-site-verification=SITEVERIFICATIONTOKENPLACEHOLDER';

const provisionedConfig = normalizeConfig({
  service: 'sample-service',
  domain: DOMAIN,
  mail: {
    localPart: 'info',
    groupName: 'sample-service 窓口',
    deliveryUser: 'owner@brand.example',
    dmarcRua: 'mailto:dmarc-reports@brand.example',
    records: {
      mx: [{ priority: 10, content: 'smtp.google.com' }],
      spf: 'v=spf1 include:_spf.google.com ~all',
      dkim: { selector: 'google', content: PROVISIONED_DKIM },
    },
  },
});

function provisionedObservation(overrides = {}) {
  const address = provisionedConfig.mail.address;
  return stage2Observation({
    dnsRecords: fixture('cf-dns-records').response ?? fixture('cf-dns-records').result,
    workspaceDomain: { domainName: DOMAIN, verified: true },
    verificationToken: VERIFICATION_TOKEN,
    verificationError: null,
    group: { email: address, name: provisionedConfig.mail.groupName },
    groupSettings: buildGroupSettings(),
    members: [{ email: provisionedConfig.mail.deliveryUser, role: 'OWNER' }],
    filters: [{ criteria: { to: address }, action: { removeLabelIds: ['SPAM'] } }],
    sendAs: [{
      sendAsEmail: address, treatAsAlias: true, displayName: provisionedConfig.mail.groupName, verificationStatus: 'accepted',
    }],
    dkim: { name: `google._domainkey.${DOMAIN}`, published: true, values: [PROVISIONED_DKIM] },
    ...overrides,
  });
}

await testAsync('層2', 'Stage2: 実際の計画出力で DKIM 公開済み・全 skip なら完了する', async () => {
  const observation = provisionedObservation();
  const steps = planStage2({ config: provisionedConfig, observation });
  const pending = steps.filter((s) => s.action === CREATE || s.action === DRIFT);
  deepStrictEqual(pending.map((s) => s.resource), [], '全工程が skip のはず');
  strictEqual(blockingManual(steps).length, 0, '恒久的な人手工程が工程を止めてはいけない');
  const completion = stage2Complete({ steps, observation });
  strictEqual(completion.complete, true, completion.reason);
  const logger = createMemoryLogger();
  const result = await applySteps(steps, logger);
  strictEqual(result.stopped, undefined, '非ブロッキング manual で停止してはいけない');
});

test('層2', 'Stage2: 未確認の送信元エイリアスは確認手順つきで停止する', () => {
  const address = provisionedConfig.mail.address;
  const observation = provisionedObservation({
    sendAs: [{ sendAsEmail: address, treatAsAlias: true, displayName: provisionedConfig.mail.groupName, verificationStatus: 'pending' }],
  });
  const steps = planStage2({ config: provisionedConfig, observation });
  const step = steps.find((s) => s.resource.startsWith('gmail sendAs'));
  strictEqual(step.action, MANUAL);
  strictEqual(step.blocking, true);
  ok(step.instructions.length > 0);
  strictEqual(stage2Complete({ steps, observation }).complete, false);
});

test('層2', 'Stage2: 所有権確認の TXT は既存と照合して二重作成しない', () => {
  const observation = provisionedObservation({ workspaceDomain: { domainName: DOMAIN, verified: false } });
  const steps = planStage2({ config: provisionedConfig, observation });
  const txt = steps.filter((s) => s.resource === `dns TXT ${DOMAIN}` && s.note === 'workspace-verification');
  strictEqual(txt.length, 1);
  strictEqual(txt[0].action, SKIP, 'TXT 投入済みで verify 失敗後の再実行が二重作成してはいけない');
  strictEqual(steps.find((s) => s.resource.startsWith('workspace domain verification')).action, DRIFT);
});

// ---------------------------------------------------------------- DNS の余剰

test('層2', 'DNS: 同じ用途の余剰レコードを乖離として報告する', () => {
  const existing = [
    { type: 'TXT', name: DOMAIN, content: '"v=spf1 include:_spf.google.com ~all"', proxied: false },
    { type: 'TXT', name: DOMAIN, content: '"v=spf1 include:legacy.example ~all"', proxied: false },
    { type: 'MX', name: DOMAIN, content: 'smtp.google.com', priority: 10, proxied: false },
    { type: 'TXT', name: `_dmarc.${DOMAIN}`, content: '"v=DMARC1; p=none; rua=mailto:dmarc-reports@brand.example"', proxied: false },
  ];
  const steps = planStage2({ config: provisionedConfig, observation: provisionedObservation({ dnsRecords: existing, verificationToken: null }) });
  const spf = steps.filter((s) => s.resource === `dns TXT ${DOMAIN}`);
  strictEqual(spf.filter((s) => s.action === SKIP).length, 1);
  const extra = spf.find((s) => s.action === DRIFT);
  ok(extra, '余剰の SPF が見逃されている');
  ok(String(extra.drift[0].actual).includes('legacy.example'));
});

test('層2', 'DNS: Vercel の A レコードに余剰があれば乖離として報告する', () => {
  const attached = { ...fixture('vercel-project-domains').domains[0], name: DOMAIN, apexName: DOMAIN };
  const ips = fixture('vercel-domain-config').recommendedIPv4[0].value;
  const existing = [
    ...ips.map((ip) => ({ type: 'A', name: DOMAIN, content: ip, proxied: false })),
    { type: 'A', name: DOMAIN, content: '198.51.100.9', proxied: false },
  ];
  const steps = planStage1({ config: baseConfig, observation: stage1Observation({ project: realProject, attached, dnsRecords: existing }) });
  const dns = steps.filter((s) => s.resource.startsWith('dns A'));
  strictEqual(dns.filter((s) => s.action === SKIP).length, ips.length);
  strictEqual(dns.filter((s) => s.action === DRIFT).length, 1);
});

// ---------------------------------------------------------------- 適用の抑止と入力検証

await testAsync('層2', '乖離があれば --execute でも executor を一切呼ばない', async () => {
  let called = 0;
  const steps = [
    { resource: 'a', action: CREATE, apply: async () => { called += 1; } },
    {
      resource: 'b', action: DRIFT, drift: [{ field: 'x', expected: '1', actual: '2' }], skipped: [], redactFields: [],
    },
  ];
  const logger = createMemoryLogger();
  const code = await runPlan({ steps, logger, execute: true });
  strictEqual(code, 2);
  strictEqual(called, 0, '後方の乖離が先行する create を抑止していない');
});

test('層1', 'githubRepo が無ければ Stage 1 は観測前に停止する', () => {
  const config = normalizeConfig({ service: 'sample-service', domain: DOMAIN, vercel: { rootDirectory: 'web' } });
  throws(() => assertStage1Config(config), /githubRepo/);
  assertStage1Config(baseConfig);
});

test('層2', '契約側が値を持たないフィールドは未照合として出力に出す', () => {
  const config = normalizeConfig({ service: 'sample-service', domain: DOMAIN, githubRepo: 'your-org/sample-service' });
  const steps = planStage1({ config, observation: stage1Observation({ project: realProject }) });
  const project = steps[0];
  strictEqual(project.action, SKIP);
  deepStrictEqual(project.skipped, ['rootDirectory', 'framework']);
  const logger = createMemoryLogger();
  printPlan([project], logger, { execute: false });
  ok(logger.text().includes('未照合: rootDirectory, framework'));
});

// ---------------------------------------------------------------- 秘密情報の非漏洩（設定値・API エラー）

test('層2', 'dry-run の乖離出力に環境変数の値を出さない', () => {
  clearSecrets();
  const desiredValue = 'https://preview.internal.example/deploy-abcdef123456';
  const actualValue = 'https://old.internal.example/deploy-zzzzzz999999';
  const config = normalizeConfig({
    service: 'sample-service',
    domain: DOMAIN,
    githubRepo: 'your-org/sample-service',
    vercel: { env: [{ key: 'NEXT_PUBLIC_SITE_URL', value: desiredValue }] },
  });
  const steps = planStage1({
    config,
    observation: stage1Observation({
      project: realProject,
      envs: [{ key: 'NEXT_PUBLIC_SITE_URL', value: actualValue, type: 'plain', target: ['development', 'preview', 'production'] }],
    }),
  });
  const logger = createMemoryLogger();
  printPlan(steps, logger, { execute: false });
  ok(!logger.text().includes(desiredValue), '契約側の値が出力に含まれた');
  ok(!logger.text().includes(actualValue), '実環境側の値が出力に含まれた');
  ok(logger.text().includes('値は表示しません'));
  clearSecrets();
});

await testAsync('層2', 'API エラーにトークンを出さない', async () => {
  clearSecrets();
  const token = 'cf-token-abcdefghijklmnop';
  registerSecret(token);
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => `invalid token ${token}` });
  const cf = createCloudflareClient({ token, fetchImpl });
  let message = '';
  try {
    await cf.getZone(DOMAIN);
  } catch (error) {
    message = error.message;
  }
  ok(message.includes('403'));
  ok(!message.includes(token), `エラーにトークンが含まれた: ${message}`);
  clearSecrets();
});

// ---------------------------------------------------------------- 層2.5: 書き込み経路の配線

function recordingFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, text: async () => JSON.stringify(responder(url) ?? {}) };
  };
  return { calls, fetchImpl };
}

await testAsync('層2.5', 'Stage1 の executor が正しい URL・メソッド・ボディで呼ばれる', async () => {
  const { calls, fetchImpl } = recordingFetch((url) => (url.includes('/v11/projects') ? { id: 'prj_new' } : { result: { id: 'rec_new' } }));
  const observation = stage1Observation();
  const { executors, state } = createStage1Executors({
    observation,
    cf: createCloudflareClient({ token: 't', allowWrite: true, fetchImpl }),
    vercel: createVercelClient({ token: 't', allowWrite: true, fetchImpl }),
  });
  const steps = planStage1({ config: baseConfig, observation, executors });
  const result = await applySteps(steps, createMemoryLogger());
  strictEqual(state.projectId, 'prj_new', '作成したプロジェクト ID が後続へ伝播していない');
  deepStrictEqual(result.applied.map((a) => a.resource), [
    'vercel project sample-service', 'vercel env NEXT_PUBLIC_SITE_URL', `vercel domain ${DOMAIN}`,
  ]);
  const [project, env, domain] = calls;
  strictEqual(project.method, 'POST');
  ok(project.url.includes('/v11/projects'));
  deepStrictEqual(project.body.gitRepository, { type: 'github', repo: 'your-org/sample-service' });
  ok(env.url.includes('/v10/projects/prj_new/env'));
  strictEqual(env.body[0].key, 'NEXT_PUBLIC_SITE_URL');
  strictEqual(env.body[0].type, 'plain');
  ok(domain.url.includes('/v10/projects/prj_new/domains'));
  deepStrictEqual(domain.body, { name: DOMAIN });
});

await testAsync('層2.5', 'Stage2 の executor が所有権確認を TXT 投入と確認の2段で適用する', async () => {
  const { calls, fetchImpl } = recordingFetch(() => ({ result: { id: 'rec_new' } }));
  const observation = stage2Observation({ verificationToken: VERIFICATION_TOKEN, dnsRecords: [] });
  const executors = createStage2Executors({
    observation,
    cf: createCloudflareClient({ token: 't', allowWrite: true, fetchImpl }),
    google: createGoogleClient({ adminToken: 't', gmailToken: 't', allowWrite: true, fetchImpl }),
  });
  const steps = planStage2({ config: baseConfig, observation, executors });
  await applySteps(steps, createMemoryLogger());
  const paths = calls.map((call) => `${call.method} ${new URL(call.url).pathname}`);
  deepStrictEqual(paths.slice(0, 3), [
    'POST /admin/directory/v1/customer/my_customer/domains',
    `POST /client/v4/zones/${observation.zone.id}/dns_records`,
    'POST /siteVerification/v1/webResource',
  ]);
  deepStrictEqual(calls[0].body, { domainName: DOMAIN });
  strictEqual(calls[1].body.content, VERIFICATION_TOKEN);
  strictEqual(calls[1].body.proxied, false);
  deepStrictEqual(calls[2].body, { site: { type: 'INET_DOMAIN', identifier: DOMAIN } });
  ok(calls.some((call) => call.body?.type === 'MX' && call.body.content === 'smtp.google.com'), 'メール DNS が適用されていない');
});

// ---------------------------------------------------------------- check の失敗の扱い

test('層1', 'check の失敗理由を例外種別で出し分ける', () => {
  const api = (status) => new ApiError('cloudflare', 'GET', '/registrar', status, '');
  ok(describeFailure(api(404)).includes('提供されていません'));
  ok(describeFailure(api(403)).includes('権限'));
  ok(describeFailure(api(401)).includes('権限'));
  ok(describeFailure(api(429)).includes('レート制限'));
  ok(describeFailure(api(500)).includes('HTTP 500'));
  ok(describeFailure(new TypeError('fetch failed')).includes('到達できませんでした'));
  ok(describeFailure(new Error('Cloudflare domain-check が失敗しました: 1003')).includes('エラーを返しました'));
});

test('層1', 'check の引数はフラグを取り込まない', () => {
  deepStrictEqual(parseArgs(['--config', 'a.json', '--execute']), { config: 'a.json', execute: true });
  deepStrictEqual(parseArgs(['b.json']), { config: 'b.json', execute: false });
});

// ---------------------------------------------------------------- 結果

const failed = results.filter((r) => !r.ok);
for (const result of results) {
  process.stdout.write(`${result.ok ? 'pass' : 'FAIL'} [${result.layer}] ${result.name}\n`);
  if (!result.ok) process.stdout.write(`     ${result.error.message.split('\n').join('\n     ')}\n`);
}
process.stdout.write(`\n合計 ${results.length} 件 / pass ${results.length - failed.length} / fail ${failed.length}\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
