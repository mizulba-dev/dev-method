import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const outputArg = process.argv[2];
if (!outputArg) {
  console.error('使い方: node scripts/check-final-report-hook.mjs <fixture出力先>');
  process.exit(1);
}

const outputDir = resolve(outputArg);
const hookPath = resolve('src/plugin-claude/hooks/check-final-report.mjs');
mkdirSync(outputDir, { recursive: true });

const IMPLEMENTER_REPORT = [
  '完了報告: 変更ファイル一覧と概要',
  '検証証跡: command exit 0, pass 1 / fail 0',
  '逸脱: なし',
  '未達事項: なし',
].join('\n');

const REVIEWER_REPORT = [
  'レビュー完了報告: 静的レビュー完了',
  `diff指紋: ${'a'.repeat(64)}`,
  '指摘: なし',
  '承認可否: 承認可',
].join('\n');

const SHOW_REVIEWER_REPORT = [
  'レビュー完了報告: Showプレレビュー完了',
  'diff指紋: 対象外（Show）',
  '指摘: なし',
  '承認可否: 承認可',
].join('\n');

function userString(text, { isMeta = false, origin } = {}) {
  const entry = { type: 'user', isMeta, message: { role: 'user', content: text } };
  if (origin !== undefined) entry.origin = origin;
  return entry;
}

function userTextBlocks(text, { isMeta = false, origin } = {}) {
  const entry = {
    type: 'user',
    isMeta,
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
  if (origin !== undefined) entry.origin = origin;
  return entry;
}

function toolResult(text) {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: text }] },
  };
}

function assistantText(text) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
}

function sendMessage(input) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'send-1', name: 'SendMessage', input }],
    },
  };
}

const classes = [
  {
    id: '01-old-report-before-followup',
    title: '初回完全報告後の差し戻し指示に未報告',
    cases: [
      {
        name: 'blocked',
        transcript: [userString('初回指示'), sendMessage({ message: IMPLEMENTER_REPORT }), userString('差し戻しを修正してください')],
        expectedStatus: 2,
      },
    ],
  },
  {
    id: '02-progress-only-after-followup',
    title: '差し戻し後が進捗SendMessageだけ',
    cases: [
      {
        name: 'blocked',
        transcript: [
          userString('初回指示'),
          sendMessage({ message: IMPLEMENTER_REPORT }),
          userString('差し戻しを修正してください'),
          sendMessage({ message: '進捗: 修正中です' }),
        ],
        expectedStatus: 2,
      },
    ],
  },
  {
    id: '03-missing-required-label',
    title: '差し戻し後の完了報告が必須マーカー欠落',
    cases: [
      {
        name: 'blocked',
        transcript: [
          userString('初回指示'),
          userString('差し戻しを修正してください'),
          sendMessage({ message: ['完了報告: 完了', '検証証跡: pass', '逸脱: なし'].join('\n') }),
        ],
        expectedStatus: 2,
      },
    ],
  },
  {
    id: '04-labels-only-in-prose',
    title: '必須ラベル語を散文中へ列挙',
    cases: [
      {
        name: 'blocked',
        transcript: [
          userString('作業してください'),
          sendMessage({ message: '進捗報告です。完了報告:・検証証跡:・逸脱:・未達事項: は後でまとめます。' }),
        ],
        expectedStatus: 2,
      },
    ],
  },
  {
    id: '05-complete-implementer-report',
    title: 'implementerの4行頭ラベルを含む最新報告',
    cases: [
      {
        name: 'allowed',
        transcript: [userString('作業してください'), sendMessage({ message: IMPLEMENTER_REPORT })],
        expectedStatus: 0,
      },
    ],
  },
  {
    id: '06-reviewer-role-markers',
    title: 'reviewerのrole別マーカー',
    cases: [
      {
        name: 'reviewer-allowed',
        agentType: 'dev-method-claude:reviewer',
        transcript: [userString('レビューしてください'), sendMessage({ message: REVIEWER_REPORT })],
        expectedStatus: 0,
      },
      {
        name: 'implementer-markers-blocked',
        agentType: 'dev-method-claude:reviewer',
        transcript: [userString('レビューしてください'), sendMessage({ message: IMPLEMENTER_REPORT })],
        expectedStatus: 2,
      },
    ],
  },
  {
    id: '07-show-reviewer-fingerprint',
    title: 'Show reviewerの対象外指紋',
    cases: [
      {
        name: 'allowed',
        agentType: 'dev-method-claude:reviewer',
        transcript: [userString('Showプレレビューをしてください'), sendMessage({ message: SHOW_REVIEWER_REPORT })],
        expectedStatus: 0,
      },
    ],
  },
  {
    id: '08-missing-agent-type',
    title: 'agent_type欠損はimplementerへ倒す',
    cases: [
      {
        name: 'implementer-allowed',
        transcript: [userString('作業してください'), sendMessage({ message: IMPLEMENTER_REPORT })],
        expectedStatus: 0,
      },
      {
        name: 'reviewer-only-blocked',
        transcript: [userString('作業してください'), sendMessage({ message: REVIEWER_REPORT })],
        expectedStatus: 2,
      },
    ],
  },
  {
    id: '09-tool-result-and-meta-do-not-move-boundary',
    title: 'meta coordinatorは実指示、tool_resultと通常metaは境界外',
    cases: [
      {
        name: 'allowed',
        transcript: [
          userString('作業してください'),
          sendMessage({ message: IMPLEMENTER_REPORT }),
          toolResult('tool output'),
          userString('<system-reminder>remember string</system-reminder>', { isMeta: true }),
          userTextBlocks('<system-reminder>remember</system-reminder>', { isMeta: true }),
        ],
        expectedStatus: 0,
      },
      {
        name: 'meta-coordinator-followup-blocked',
        transcript: [
          userString('初回指示'),
          sendMessage({ message: IMPLEMENTER_REPORT }),
          userString('The coordinator sent a message while you were working: 差し戻しを修正してください', {
            isMeta: true,
            origin: { kind: 'coordinator' },
          }),
        ],
        expectedStatus: 2,
      },
      {
        name: 'meta-coordinator-text-block-followup-blocked',
        transcript: [
          userString('初回指示'),
          sendMessage({ message: IMPLEMENTER_REPORT }),
          userTextBlocks('差し戻しを修正してください', {
            isMeta: true,
            origin: { kind: 'coordinator' },
          }),
        ],
        expectedStatus: 2,
      },
    ],
  },
  {
    id: '10-text-block-user-instruction',
    title: 'text blockだけの配列user指示が新しい境界',
    cases: [
      {
        name: 'blocked',
        transcript: [
          userString('初回指示'),
          sendMessage({ message: IMPLEMENTER_REPORT }),
          userTextBlocks('追加修正してください'),
        ],
        expectedStatus: 2,
      },
    ],
  },
  {
    id: '11-send-message-content-fallback',
    title: 'SendMessage.input.contentだけをfallbackに使う',
    cases: [
      {
        name: 'content-allowed',
        transcript: [userString('作業してください'), sendMessage({ content: IMPLEMENTER_REPORT, to: 'leader' })],
        expectedStatus: 0,
      },
      {
        name: 'summary-only-blocked',
        transcript: [userString('作業してください'), sendMessage({ summary: IMPLEMENTER_REPORT, to: 'leader' })],
        expectedStatus: 2,
      },
    ],
  },
  {
    id: '12-unrecognized-content-fail-open',
    title: 'JSON parse可能だが認識可能content無しはfail-open',
    cases: [
      {
        name: 'diagnosed',
        transcript: [{ type: 'assistant', message: { role: 'assistant', content: { type: 'text', text: 'unknown schema' } } }],
        expectedStatus: 0,
        expectedDiagnostic: 'transcriptに解釈可能な行がありませんでした',
      },
    ],
  },
  {
    id: '13-fail-open-conditions',
    title: '壊れたJSON・transcript欠損/読込不能・stop_hook_active再入はfail-open',
    cases: [
      {
        name: 'broken-json-diagnosed',
        rawTranscript: '{broken json only\n',
        expectedStatus: 0,
        expectedDiagnostic: 'transcriptに解釈可能な行がありませんでした',
      },
      {
        name: 'missing-transcript-diagnosed',
        omitTranscriptPath: true,
        expectedStatus: 0,
        expectedDiagnostic: 'agent_transcript_path がありません',
      },
      {
        name: 'unreadable-transcript-diagnosed',
        missingTranscriptFile: true,
        expectedStatus: 0,
        expectedDiagnostic: 'transcriptを読み込めませんでした',
      },
      {
        name: 'stop-hook-active-allowed',
        stopHookActive: true,
        transcript: [userString('完全報告なしで終了を試みます')],
        expectedStatus: 0,
        expectedPlainContinue: true,
      },
    ],
  },
];

function transcriptText(testCase) {
  if (typeof testCase.rawTranscript === 'string') return testCase.rawTranscript;
  return `${(testCase.transcript ?? [assistantText('fixture')]).map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

function runCase(classId, testCase) {
  const caseDir = resolve(outputDir, classId, testCase.name);
  mkdirSync(caseDir, { recursive: true });
  const transcriptPath = resolve(
    caseDir,
    testCase.missingTranscriptFile ? 'intentionally-absent-transcript.jsonl' : 'transcript.jsonl',
  );
  if (!testCase.missingTranscriptFile) writeFileSync(transcriptPath, transcriptText(testCase));

  const input = {
    hook_event_name: 'SubagentStop',
    stop_hook_active: testCase.stopHookActive === true,
  };
  if (testCase.agentType !== undefined) input.agent_type = testCase.agentType;
  if (!testCase.omitTranscriptPath) input.agent_transcript_path = transcriptPath;

  writeFileSync(resolve(caseDir, 'hook-input.json'), `${JSON.stringify(input, null, 2)}\n`);
  writeFileSync(
    resolve(caseDir, 'expected.json'),
    `${JSON.stringify(
      {
        exitCode: testCase.expectedStatus,
        diagnosticIncludes: testCase.expectedDiagnostic ?? null,
        plainContinueOnly: testCase.expectedPlainContinue === true,
      },
      null,
      2,
    )}\n`,
  );

  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  const actual = { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
  writeFileSync(resolve(caseDir, 'actual.json'), `${JSON.stringify(actual, null, 2)}\n`);

  let continueTrue = false;
  if (result.status === 0) {
    try {
      continueTrue = JSON.parse(result.stdout).continue === true;
    } catch {
      continueTrue = false;
    }
  }
  const diagnosticFound =
    testCase.expectedDiagnostic === undefined || `${result.stdout}\n${result.stderr}`.includes(testCase.expectedDiagnostic);
  const plainContinueMatched =
    testCase.expectedPlainContinue !== true ||
    (result.stdout.trim() === JSON.stringify({ continue: true }) && result.stderr.length === 0);
  const passed =
    result.status === testCase.expectedStatus &&
    (testCase.expectedStatus !== 0 || continueTrue) &&
    diagnosticFound &&
    plainContinueMatched;
  return { ...actual, name: testCase.name, passed };
}

let passedClasses = 0;
let passedCases = 0;
let totalCases = 0;
let expectedBlocks = 0;
let observedBlocks = 0;

for (const fixtureClass of classes) {
  const results = fixtureClass.cases.map((testCase) => {
    const result = runCase(fixtureClass.id, testCase);
    totalCases += 1;
    if (result.passed) passedCases += 1;
    if (testCase.expectedStatus === 2) {
      expectedBlocks += 1;
      if (result.exitCode === 2) observedBlocks += 1;
    }
    return result;
  });
  const passed = results.every((result) => result.passed);
  if (passed) passedClasses += 1;
  console.log(`${passed ? 'PASS' : 'FAIL'} ${fixtureClass.id}: ${fixtureClass.title}`);
  for (const result of results) {
    if (!result.passed) {
      console.log(`  - ${result.name}: exit=${result.exitCode}, stdout=${result.stdout.trim()}, stderr=${result.stderr.trim()}`);
    }
  }
}

console.log(`\nクラス: PASS ${passedClasses} / FAIL ${classes.length - passedClasses}（全${classes.length}）`);
console.log(`ケース: PASS ${passedCases} / FAIL ${totalCases - passedCases}（全${totalCases}）`);
console.log(`故意ずれ: 期待ブロック ${observedBlocks}/${expectedBlocks} が exit 2`);
console.log(`fixture: ${outputDir}`);

if (passedClasses !== classes.length) process.exit(1);
