import { checkDkimPublished } from './dns-verify.mjs';
import { planDnsRecords } from './dns-plan.mjs';
import {
  buildGroupSettings, buildMailDnsRecords, buildSendAs, buildSpamFilter, checkGroupSettingsContract, externalAccess,
} from './google.mjs';
import {
  blockingManual, CREATE, DRIFT, manualStep, planResource, SKIP,
} from './plan.mjs';

export async function observeStage2({ config, cf, google, resolveTxt }) {
  const zone = await cf.getZone(config.domain);
  if (!zone) throw new Error(`Cloudflare に ${config.domain} のゾーンがありません`);
  const dnsRecords = await cf.listDnsRecords(zone.id);
  const domains = await google.listDomains();
  const workspaceDomain = domains.find((d) => d.domainName === config.domain) ?? null;
  // 所有権確認トークンは計画段階で取得し、既存レコードと照合してから投入する（二重作成を避ける）
  let verificationToken = null;
  let verificationError = null;
  try {
    const payload = await google.getVerificationToken(config.domain);
    verificationToken = payload?.token ?? null;
  } catch (error) {
    verificationError = error.message;
  }
  const group = await google.getGroup(config.mail.address);
  const groupSettings = group ? await google.getGroupSettings(config.mail.address) : null;
  const members = group ? await google.listMembers(config.mail.address) : [];
  const filters = google.gmail ? await google.listFilters() : [];
  const sendAs = google.gmail ? await google.listSendAs() : [];
  const dkim = await checkDkimPublished({
    domain: config.domain,
    selector: config.mail.records.dkim?.selector ?? 'google',
    nameServers: zone.name_servers,
    resolveTxt,
  });
  return {
    zone, dnsRecords, workspaceDomain, verificationToken, verificationError, group, groupSettings, members, filters, sendAs, dkim,
  };
}

export function planStage2({ config, observation, executors = {} }) {
  const steps = [];
  const address = config.mail.address;

  steps.push(planResource({
    resource: `workspace secondary domain ${config.domain}`,
    desired: { domainName: config.domain },
    actual: observation.workspaceDomain ? { domainName: observation.workspaceDomain.domainName } : null,
    fields: ['domainName'],
    note: 'ドメインエイリアスではなくセカンダリドメインとして追加する',
    apply: executors.addDomain ? () => executors.addDomain(config.domain) : undefined,
  }));

  if (observation.verificationToken) {
    steps.push(...planDnsRecords({
      desired: [{
        type: 'TXT',
        name: config.domain,
        content: observation.verificationToken,
        ttl: 3600,
        proxied: false,
        purpose: 'workspace-verification',
        exclusive: false,
      }],
      existing: observation.dnsRecords,
      createRecord: executors.createDnsRecord,
    }));
  } else {
    steps.push(manualStep({
      resource: `workspace verification token ${config.domain}`,
      note: `所有権確認トークンを取得できませんでした: ${observation.verificationError ?? '不明'}`,
      instructions: ['サービスアカウントに siteverification スコープが委任されているか確認してください'],
    }));
  }

  steps.push(planResource({
    resource: `workspace domain verification ${config.domain}`,
    desired: { verified: true },
    actual: observation.workspaceDomain ? { verified: Boolean(observation.workspaceDomain.verified) } : null,
    fields: ['verified'],
    note: '所有権確認の実行（TXT レコードは前工程で投入済み）',
    apply: executors.verifyDomain ? () => executors.verifyDomain(config.domain) : undefined,
  }));

  const mailRecords = buildMailDnsRecords({
    domain: config.domain,
    records: config.mail.records,
    dmarcRua: config.mail.dmarcRua,
  });
  steps.push(...planDnsRecords({
    desired: mailRecords,
    existing: observation.dnsRecords,
    createRecord: executors.createDnsRecord,
  }));

  if (!observation.dkim.published) {
    steps.push(manualStep({
      resource: `dkim ${observation.dkim.name}`,
      note: 'DKIM は API で有効化できません。人が管理コンソールで有効化してください',
      instructions: [
        '管理コンソール > アプリ > Gmail > メールの認証 で該当ドメインを選び、鍵を生成する',
        '生成された TXT 値を設定ファイルの mail.records.dkim に転記し、このコマンドを再実行してレコードを投入する',
        'レコード反映後、管理コンソールで「認証を開始」を押す',
        '再実行すると権威サーバーへ直接問い合わせて DKIM レコードの実在を確認します',
      ],
    }));
  }

  const groupExists = Boolean(observation.group);
  steps.push(planResource({
    resource: `group ${address}`,
    desired: { email: address, name: config.mail.groupName },
    actual: observation.group ? { email: observation.group.email, name: observation.group.name } : null,
    fields: ['email', 'name'],
    note: 'ユーザーアカウントではなくグループ（ライセンスを消費しない）',
    apply: executors.createGroup ? () => executors.createGroup({ email: address, name: config.mail.groupName }) : undefined,
  }));

  const desiredSettings = buildGroupSettings();
  const settingsResource = `group settings ${address}`;
  const settingsNote = '投稿は外部に開き、閲覧・発見は外部に開かない';
  if (!groupExists) {
    steps.push({
      resource: settingsResource,
      action: CREATE,
      desired: desiredSettings,
      note: settingsNote,
      skipped: [],
      redactFields: [],
      apply: executors.updateGroupSettings ? () => executors.updateGroupSettings(address, desiredSettings) : undefined,
    });
  } else {
    // 照合するのは非対称の意味論だけ。契約外のフィールドは既存の運用に任せる
    const violations = checkGroupSettingsContract(observation.groupSettings);
    steps.push(violations.length === 0
      ? {
        resource: settingsResource, action: SKIP, actual: observation.groupSettings, note: settingsNote, skipped: [], redactFields: [],
      }
      : {
        resource: settingsResource, action: DRIFT, actual: observation.groupSettings, drift: violations, note: settingsNote, skipped: [], redactFields: [],
      });
  }

  const member = observation.members.find((m) => m.email === config.mail.deliveryUser) ?? null;
  steps.push(planResource({
    resource: `group member ${config.mail.deliveryUser}`,
    desired: { email: config.mail.deliveryUser, role: 'OWNER' },
    actual: member ? { email: member.email, role: member.role } : null,
    fields: ['email', 'role'],
    note: '登録は「メッセージごと」（delivery_settings=ALL_MAIL。API では読み出せないため作成時にのみ設定する）',
    apply: executors.addMember
      ? () => executors.addMember(address, { email: config.mail.deliveryUser, role: 'OWNER', delivery_settings: 'ALL_MAIL' })
      : undefined,
  }));

  const filter = observation.filters.find((f) => f.criteria?.to === address) ?? null;
  steps.push(planResource({
    resource: `gmail filter ${address}`,
    desired: { to: address, removeLabelIds: ['SPAM'] },
    actual: filter ? { to: filter.criteria?.to, removeLabelIds: filter.action?.removeLabelIds ?? [] } : null,
    fields: ['to', 'removeLabelIds'],
    note: '受信の迷惑メール回避（SPF/DMARC は受信判定に効かない）',
    apply: executors.createFilter ? () => executors.createFilter(buildSpamFilter(address)) : undefined,
  }));

  const alias = observation.sendAs.find((s) => s.sendAsEmail === address) ?? null;
  if (alias && alias.verificationStatus && alias.verificationStatus !== 'accepted') {
    steps.push(manualStep({
      resource: `gmail sendAs ${address}`,
      note: `送信元エイリアスが未確認です（verificationStatus=${alias.verificationStatus}）`,
      instructions: [
        `${address} 宛に届いた確認メールのリンクを開く（窓口グループのメンバーに配信されます）`,
        '確認後にこのコマンドを再実行すると accepted を確認します',
      ],
    }));
  } else {
    steps.push(planResource({
      resource: `gmail sendAs ${address}`,
      desired: {
        sendAsEmail: address, treatAsAlias: true, displayName: config.mail.groupName, verificationStatus: 'accepted',
      },
      actual: alias ? {
        sendAsEmail: alias.sendAsEmail, treatAsAlias: alias.treatAsAlias, displayName: alias.displayName, verificationStatus: alias.verificationStatus,
      } : null,
      fields: ['sendAsEmail', 'treatAsAlias', 'displayName', 'verificationStatus'],
      note: 'グループにはパスワードが無いため SMTP 認証経路は使えない（Workspace ユーザーの sendAs として作る）',
      apply: executors.createSendAs ? () => executors.createSendAs(buildSendAs(address, config.mail.groupName)) : undefined,
    }));
  }

  // 恒久的に人の手に残る工程。工程は止めず、完了判定にも数えない
  steps.push(manualStep({
    resource: 'gmail 返信で使用するアドレス',
    note: 'Gmail API に該当フィールドが無いため人が設定する（初回のみ）',
    instructions: ['Gmail 設定 > アカウント で「メールを受信したアドレスから返信する」を選ぶ'],
    blocking: false,
  }));

  return steps;
}

// 完了判定には DKIM レコードの実在を必ず含める（「レコードを入れた」を完了条件にしない）
export function stage2Complete({ steps, observation }) {
  if (!observation.dkim.published) return { complete: false, reason: 'DKIM レコードが権威サーバー上に見つかりません' };
  const pending = steps.filter((step) => step.action === CREATE || step.action === DRIFT);
  if (pending.length) return { complete: false, reason: `未適用の工程があります: ${pending.map((s) => s.resource).join(', ')}` };
  const manual = blockingManual(steps);
  if (manual.length) return { complete: false, reason: `人の作業が残っています: ${manual.map((s) => s.resource).join(', ')}` };
  return { complete: true };
}

export function groupSettingsAsymmetry(settings) {
  return externalAccess(settings);
}
