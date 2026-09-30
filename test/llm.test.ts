import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeFailure, isTestFilePath } from '../src/analyzer.js';
import { gatherContext } from '../src/context.js';
import {
  buildPatchPrompt,
  MockLLMClient,
  parsePatchProposal,
  PatchProposalJsonSchema,
  ProposalParseError,
  type PromptInput,
} from '../src/llm.js';
import { preparePatch } from '../src/patcher.js';
import { makeProject } from './helpers.js';

const PROPOSAL = {
  analysis: 'add() subtracts',
  plan: ['use +'],
  confidence: 0.9,
  patch: '--- a/src/math.js\n+++ b/src/math.js\n@@ -1 +1 @@\n-a - b\n+a + b\n',
};

describe('parsePatchProposal', () => {
  it('accepts raw JSON, fenced JSON and JSON wrapped in prose', () => {
    const json = JSON.stringify(PROPOSAL);
    expect(parsePatchProposal(json)).toEqual(PROPOSAL);
    expect(parsePatchProposal(`\`\`\`json\n${json}\n\`\`\``)).toEqual(PROPOSAL);
    expect(parsePatchProposal(`Here is my fix:\n${json}\nHope it helps!`)).toEqual(PROPOSAL);
  });

  it('reports invalid JSON and schema violations precisely', () => {
    expect(() => parsePatchProposal('{"analysis": ')).toThrowError(ProposalParseError);
    expect(() => parsePatchProposal(JSON.stringify({ ...PROPOSAL, confidence: 7 }))).toThrowError(/confidence/);
    expect(() => parsePatchProposal(JSON.stringify({ ...PROPOSAL, patch: 'just edit line 1' }))).toThrowError(/@@/);
    expect(() => parsePatchProposal(JSON.stringify({ ...PROPOSAL, plan: [] }))).toThrowError(/plan/);
  });

  it('exposes a JSON Schema for structured-output providers', () => {
    expect(PatchProposalJsonSchema).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['analysis', 'plan', 'confidence', 'patch']),
    });
  });
});

async function fixture() {
  const root = await makeProject({
    'src/math.js': 'export function add(a, b) {\n  return a - b;\n}\n',
    'test/math.test.js': "import { add } from '../src/math.js';\n",
  });
  const output = [
    'TypeError: add is broken',
    `    at add (${path.join(root, 'src/math.js')}:2:3)`,
    `    at t (${path.join(root, 'test/math.test.js')}:4:1)`,
    '# fail 1',
  ].join('\n');
  const analysis = analyzeFailure({ output, exitCode: 1 }, { projectRoot: root });
  const context = await gatherContext(analysis, { projectRoot: root, maxFiles: 5, maxFileBytes: 10_000 });
  const input: PromptInput = {
    command: 'npm test',
    exitCode: 1,
    attempt: 2,
    maxAttempts: 3,
    analysis,
    context,
    history: [],
    allowTestEdits: false,
  };
  return { root, analysis, context, input };
}

describe('buildPatchPrompt', () => {
  it('includes the failure, numbered files, and the test-edit policy', async () => {
    const { input } = await fixture();
    const prompt = buildPatchPrompt(input);
    expect(prompt.user).toContain('attempt 2 of 3');
    expect(prompt.user).toContain('TypeError: add is broken');
    expect(prompt.user).toContain('### src/math.js — source, implicated lines 2');
    expect(prompt.user).toContain('2 |   return a - b;');
    expect(prompt.system).toContain('test files are read-only');
    expect(buildPatchPrompt({ ...input, allowTestEdits: true }).system).toContain('Test files may be edited only');
  });

  it('renders previous attempts and feedback so the model does not repeat itself', async () => {
    const { input } = await fixture();
    const prompt = buildPatchPrompt({
      ...input,
      history: [
        {
          attempt: 1,
          outcome: 'tests-failed',
          summary: 'still failing',
          hypothesis: 'off by one',
          plan: ['increment'],
          patch: '--- a/src/math.js\n+++ b/src/math.js\n@@ -2 +2 @@\n-  return a - b;\n+  return a - b + 1;\n',
          failureAfter: { signature: 'x', summary: 'TypeError: still broken', failedTestCount: 1 },
        },
      ],
      feedback: 'Your last proposal is identical to attempt 1.',
    });
    expect(prompt.user).toContain('### Attempt 1 — applied, tests still failing, rolled back');
    expect(prompt.user).toContain('+  return a - b + 1;');
    expect(prompt.user).toContain('Result after applying it: TypeError: still broken (1 failing)');
    expect(prompt.user).toContain('## Feedback on your previous response');
  });

  it('uses a fence longer than any backtick run in the content', async () => {
    const { input } = await fixture();
    const withTicks = { ...input.analysis, relevantLog: 'output with ```` four ticks' };
    expect(buildPatchPrompt({ ...input, analysis: withTicks }).user).toContain('`````text');
  });
});

describe('MockLLMClient', () => {
  it('replays scripted responses in order, then synthesizes an applicable patch', async () => {
    const { root, analysis, context, input } = await fixture();
    const client = new MockLLMClient([PROPOSAL, 'not json at all']);
    const request = { prompt: buildPatchPrompt(input), attempt: 1, analysis, context, history: [] };

    expect(parsePatchProposal(await client.generatePatch(request))).toEqual(PROPOSAL);
    expect(await client.generatePatch(request)).toBe('not json at all');

    const synthesized = parsePatchProposal(await client.generatePatch(request));
    expect(synthesized.analysis).toMatch(/^\[simulated\]/);
    const prepared = await preparePatch(synthesized.patch, { projectRoot: root, allowTestEdits: false, isTestFile: isTestFilePath });
    expect(prepared.changes[0]?.relativePath).toBe('src/math.js');
    expect(prepared.changes[0]?.after).toContain('devmedic(simulated fix #3)');
    expect(client.callCount).toBe(3);
  });

  it('rejects malformed fixture files', async () => {
    const root = await makeProject({ 'bad.json': '{"responses": 42}' });
    await expect(MockLLMClient.fromFixture(path.join(root, 'bad.json'))).rejects.toThrow(/must be an array/);
  });
});
