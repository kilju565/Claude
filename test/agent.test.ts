/**
 * Integration tests: the real executor runs the example project's real `node --test` suite;
 * only the model is scripted.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAgent, type AgentDependencies } from '../src/agent.js';
import { DEFAULTS, type DevMedicConfig } from '../src/config.js';
import { runTestCommand, type ExecuteOptions } from '../src/executor.js';
import { MockLLMClient, type ScriptedResponse } from '../src/llm.js';
import { silentLogger } from '../src/logger.js';
import { copyExample, EXAMPLE_PROJECT, makeProject, read, snapshotTree } from './helpers.js';

interface Fixture {
  responses: ScriptedResponse[];
}
const fixture = JSON.parse(await readFile(path.join(EXAMPLE_PROJECT, 'devmedic.mock.json'), 'utf8')) as Fixture;
const [WRONG_PRICING, WRONG_PRICING_REFORMATTED, PRICING_FIX, DISCOUNT_FIX] = fixture.responses as [
  ScriptedResponse,
  ScriptedResponse,
  ScriptedResponse,
  ScriptedResponse,
];

const WRONG_DISCOUNT = {
  analysis: 'Discount should divide.',
  plan: ['divide by 1 + rate'],
  confidence: 0.3,
  patch: [
    '--- a/src/discounts.js',
    '+++ b/src/discounts.js',
    '@@ -8,3 +8,3 @@',
    '   const rate = DISCOUNT_RATES[code] ?? 0;',
    '-  return amount * rate;',
    '+  return amount / (1 + rate);',
    ' }',
    '',
  ].join('\n'),
};

function config(projectRoot: string, overrides: Partial<DevMedicConfig> = {}): DevMedicConfig {
  return {
    command: 'node --test',
    projectRoot,
    maxRetries: 3,
    dryRun: false,
    timeoutMs: 60_000,
    allowTestEdits: false,
    keepPartial: false,
    maxContextFiles: DEFAULTS.maxContextFiles,
    maxFileBytes: DEFAULTS.maxFileBytes,
    maxChangedLines: DEFAULTS.maxChangedLines,
    streamOutput: false,
    ...overrides,
  };
}

function deps(script: ScriptedResponse[], extra: Partial<AgentDependencies> = {}): AgentDependencies {
  return { llm: new MockLLMClient(script), logger: silentLogger, writeOutput: () => undefined, ...extra };
}

describe('runAgent', () => {
  it('heals the example: rollback, memory de-duplication, ratchet, success', async () => {
    const root = await copyExample();
    const result = await runAgent(config(root), deps([WRONG_PRICING, WRONG_PRICING_REFORMATTED, PRICING_FIX, DISCOUNT_FIX]));

    expect(result.status).toBe('fixed');
    expect(result.attemptsUsed).toBe(3);
    expect(result.history.map((r) => r.outcome)).toEqual(['tests-failed', 'progress-kept', 'tests-passed']);
    expect(result.history[1]?.failureAfter?.failedTestCount).toBe(1);
    expect(result.duplicatesRejected).toBe(1);
    expect(result.appliedChanges.map((c) => c.relativePath)).toEqual(['src/pricing.js', 'src/discounts.js']);
    expect(await read(root, 'src/pricing.js')).toContain('item.price * item.quantity');
    expect(await read(root, 'src/discounts.js')).toContain('amount * (1 - rate)');
  });

  it('aborts at MAX_RETRIES and restores the original tree (including kept progress)', async () => {
    const root = await copyExample();
    const before = await snapshotTree(root);
    const result = await runAgent(config(root), deps([PRICING_FIX, WRONG_DISCOUNT, { ...WRONG_DISCOUNT, patch: WRONG_DISCOUNT.patch.replace('/ (1 + rate)', '- rate') }]));

    expect(result.status).toBe('exhausted');
    expect(result.history.map((r) => r.outcome)).toEqual(['progress-kept', 'tests-failed', 'tests-failed']);
    expect(result.appliedChanges).toEqual([]);
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('keeps partial progress on abort when asked to', async () => {
    const root = await copyExample();
    const result = await runAgent(config(root, { maxRetries: 2, keepPartial: true }), deps([PRICING_FIX, WRONG_DISCOUNT]));
    expect(result.status).toBe('exhausted');
    expect(result.appliedChanges.map((c) => c.relativePath)).toEqual(['src/pricing.js']);
    expect(await read(root, 'src/pricing.js')).toContain('item.price * item.quantity');
  });

  it('dry run prints the patch and writes nothing', async () => {
    const root = await copyExample();
    const before = await snapshotTree(root);
    const printed: string[] = [];
    const result = await runAgent(config(root, { dryRun: true }), deps([PRICING_FIX], { writeOutput: (t) => printed.push(t) }));

    expect(result.status).toBe('dry-run');
    expect(printed.join('\n')).toContain('+  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);');
    expect(result.proposal?.prepared.changes[0]?.relativePath).toBe('src/pricing.js');
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('refuses patches to test files and records invalid responses, then continues', async () => {
    const root = await copyExample();
    const cheat = {
      analysis: 'Just change the expectation.',
      plan: ['edit the test'],
      confidence: 0.99,
      patch: [
        '--- a/test/checkout.integration.test.js',
        '+++ b/test/checkout.integration.test.js',
        '@@ -12,1 +12,1 @@',
        '-  assert.equal(receipt.subtotal, 29);',
        '+  assert.equal(receipt.subtotal, 17);',
        '',
      ].join('\n'),
    };
    const result = await runAgent(config(root), deps([cheat, 'I am not JSON', PRICING_FIX]));
    expect(result.history.map((r) => r.outcome)).toEqual(['policy-rejected', 'invalid-response', 'progress-kept']);
    expect(result.history[0]?.summary).toContain('is a test file');
    expect(await read(root, 'test/checkout.integration.test.js')).toContain('receipt.subtotal, 29');
  });

  it('stops after repeated duplicates without re-running them', async () => {
    const root = await copyExample();
    const result = await runAgent(
      config(root, { maxRetries: 2 }),
      deps([WRONG_PRICING, WRONG_PRICING, WRONG_PRICING_REFORMATTED, WRONG_PRICING]),
    );
    expect(result.history.map((r) => r.outcome)).toEqual(['tests-failed', 'duplicate']);
    expect(result.duplicatesRejected).toBe(DEFAULTS.maxDuplicateReprompts + 1);
  });

  it('reports already-passing suites without calling the model', async () => {
    const root = await makeProject({ 'test/ok.test.js': "import { test } from 'node:test';\ntest('ok', () => {});\n" });
    const llm = new MockLLMClient();
    const result = await runAgent(config(root), { llm, logger: silentLogger });
    expect(result.status).toBe('already-passing');
    expect(llm.callCount).toBe(0);
  });

  it('does not burn retries on a command that cannot start', async () => {
    const root = await makeProject();
    const result = await runAgent(config(root, { command: 'definitely-not-a-real-command-xyz' }), deps([]));
    expect(result.status).toBe('command-error');
    expect(result.attemptsUsed).toBe(0);
  });

  it('gives up when the failure cannot be mapped to any project file', async () => {
    const root = await makeProject();
    const result = await runAgent(config(root, { command: 'node -e "process.exit(3)"' }), deps([]));
    expect(result.status).toBe('unfixable');
  });

  it('rolls back the in-flight patch when interrupted during verification', async () => {
    const root = await copyExample();
    const before = await snapshotTree(root);
    const controller = new AbortController();
    let runs = 0;
    const runTests = async (options: ExecuteOptions) => {
      runs += 1;
      const result = await runTestCommand(options);
      if (runs === 2) controller.abort(); // Ctrl-C arrives while the patched code is being verified
      return result;
    };
    const result = await runAgent(config(root), deps([PRICING_FIX], { runTests }), controller.signal);

    expect(result.status).toBe('interrupted');
    expect(await snapshotTree(root)).toEqual(before);
  });
});
