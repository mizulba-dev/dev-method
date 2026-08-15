import { planDnsRecords } from './dns-plan.mjs';
import { manualStep, planResource } from './plan.mjs';
import { buildCreateProjectBody, deriveDnsRecords, desiredEnv } from './vercel.mjs';

function comparableProject(project) {
  const link = project.link ?? {};
  return {
    name: project.name,
    rootDirectory: project.rootDirectory ?? null,
    framework: project.framework ?? null,
    githubRepo: link.org && link.repo ? `${link.org}/${link.repo}` : null,
  };
}

function comparableEnv(entry) {
  return {
    key: entry.key,
    value: entry.value,
    type: entry.type,
    target: [...(entry.target ?? [])].sort(),
  };
}

export async function observeStage1({ config, cf, vercel }) {
  const zone = await cf.getZone(config.domain);
  if (!zone) throw new Error(`Cloudflare に ${config.domain} のゾーンがありません（ドメイン購入とネームサーバー移管が先です）`);
  const dnsRecords = await cf.listDnsRecords(zone.id);
  const project = await vercel.getProject(config.vercel.projectName);
  const envs = project ? await vercel.listEnv(project.id) : [];
  const domains = project ? await vercel.listDomains(project.id) : [];
  const attached = domains.find((d) => d.name === config.domain) ?? null;
  const domainConfig = attached ? await vercel.domainConfig(config.domain) : null;
  return { zone, dnsRecords, project, envs, domains, attached, domainConfig };
}

export function planStage1({ config, observation, executors = {} }) {
  const steps = [];
  const { project, attached, domainConfig } = observation;

  const desiredProject = {
    name: config.vercel.projectName,
    rootDirectory: config.vercel.rootDirectory,
    framework: config.vercel.framework,
    githubRepo: config.githubRepo,
  };
  steps.push(planResource({
    resource: `vercel project ${config.vercel.projectName}`,
    desired: desiredProject,
    actual: project ? comparableProject(project) : null,
    fields: ['name', 'rootDirectory', 'framework', 'githubRepo'],
    apply: executors.createProject ? () => executors.createProject(buildCreateProjectBody(config)) : undefined,
  }));

  // 環境変数はドメイン紐付けより前に置く（未設定だと本番ビルドが fail-closed で落ちるサービスがあるため）
  for (const entry of config.vercel.env) {
    const desired = desiredEnv(entry);
    const actual = observation.envs.find((e) => e.key === entry.key) ?? null;
    if (actual && (actual.type === 'sensitive' || actual.type === 'encrypted' || actual.decrypted === false)) {
      steps.push(manualStep({
        resource: `vercel env ${entry.key}`,
        note: '既存の値が読み取れない種別（sensitive/encrypted）のため契約と照合できません',
        instructions: ['Vercel ダッシュボードで値を確認し、契約と一致するなら設定から外す（または plain へ置き換える）'],
        blocking: false,
      }));
      continue;
    }
    steps.push(planResource({
      resource: `vercel env ${entry.key}`,
      desired: comparableEnv(desired),
      actual: actual ? comparableEnv(actual) : null,
      fields: ['key', 'value', 'type', 'target'],
      redactFields: ['value'],
      apply: executors.createEnv ? () => executors.createEnv([desired]) : undefined,
    }));
  }

  steps.push(planResource({
    resource: `vercel domain ${config.domain}`,
    desired: { name: config.domain },
    actual: attached ? { name: attached.name } : null,
    fields: ['name'],
    apply: executors.addDomain ? () => executors.addDomain(config.domain) : undefined,
  }));

  if (!attached || !domainConfig) {
    steps.push(manualStep({
      resource: `dns ${config.domain}`,
      note: 'Vercel へのドメイン追加後に、Vercel が提示するレコードを取得して投入します（値を決め打ちしないため、この時点では確定しません）',
      instructions: [`ドメイン追加を実行したあと、同じコマンドを再実行してください`],
    }));
    return steps;
  }

  const desiredRecords = deriveDnsRecords({
    domain: config.domain,
    apexName: attached.apexName,
    verification: attached.verification ?? [],
    config: domainConfig,
  });
  steps.push(...planDnsRecords({
    desired: desiredRecords,
    existing: observation.dnsRecords,
    createRecord: executors.createDnsRecord,
  }));
  return steps;
}
