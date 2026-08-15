function dnsRecordBody(record) {
  return {
    type: record.type,
    name: record.name,
    content: record.content,
    ttl: record.ttl,
    proxied: record.proxied,
    priority: record.priority,
  };
}

export function createStage1Executors({ observation, cf, vercel }) {
  const state = { projectId: observation.project?.id ?? null };
  const projectId = () => {
    if (!state.projectId) throw new Error('Vercel プロジェクトが未作成のため後続の工程を適用できません');
    return state.projectId;
  };
  const executors = {
    createProject: async (body) => {
      const created = await vercel.createProject(body);
      state.projectId = created?.id ?? null;
      return created;
    },
    createEnv: (entries) => vercel.createEnv(projectId(), entries),
    addDomain: (domain) => vercel.addDomain(projectId(), domain),
    createDnsRecord: (record) => cf.createDnsRecord(observation.zone.id, dnsRecordBody(record)),
    createDeployment: (body) => vercel.createDeployment(body),
  };
  return { executors, state };
}

export function createStage2Executors({ observation, cf, google }) {
  return {
    addDomain: (domain) => google.addDomain(domain),
    createDnsRecord: (record) => cf.createDnsRecord(observation.zone.id, dnsRecordBody(record)),
    createGroup: (body) => google.createGroup(body),
    updateGroupSettings: (email, body) => google.updateGroupSettings(email, body),
    addMember: (email, body) => google.addMember(email, body),
    createFilter: (body) => google.createFilter(body),
    createSendAs: (body) => google.createSendAs(body),
  };
}
