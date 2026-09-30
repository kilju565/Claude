/**
 * llm.ts — the "Plan & Patch" step: prompt construction, response validation, and the model client.
 *
 * The model is behind the small `LLMClient` interface. This build ships `MockLLMClient`, which
 * returns simulated JSON patch objects (scripted from a fixture file, or synthesized from the
 * failure context). A production client implements the same interface, e.g. with the official
 * `@anthropic-ai/sdk` (model `claude-opus-5-5`) using structured outputs driven by
 * `PatchProposalJsonSchema` below — everything downstream (validation, memory, patching,
 * verification) stays unchanged.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { FailureAnalysis } from './analyzer.js';
import type { ContextBundle, ContextFile } from './context.js';
import type { AttemptRecord } from './memory.js';

// ─────────────────────────────────────────────────────────────────────────────────────────
// Response contract
// ─────────────────────────────────────────────────────────────────────────────────────────

export const PatchProposalSchema = z.object({
  analysis: z.string().min(1).describe('Root cause in 1-3 sentences, citing file:line evidence.'),
  plan: z.array(z.string().min(1)).min(1).max(20).describe('Ordered, concrete steps the patch performs.'),
  confidence: z.number().min(0).max(1).describe('Calibrated probability (0..1) that the patch makes the tests pass.'),
  patch: z
    .string()
    .min(1)
    .regex(/^@@/m, 'patch must be a unified diff with at least one "@@" hunk')
    .describe('Unified diff (git style) with paths relative to the project root.'),
});

export type PatchProposal = z.infer<typeof PatchProposalSchema>;

/** JSON Schema of the response, for providers that support schema-constrained output. */
export const PatchProposalJsonSchema = z.toJSONSchema(PatchProposalSchema);

export class ProposalParseError extends Error {
  override readonly name = 'ProposalParseError';
}

/** Validates raw model output into a PatchProposal. Tolerates code fences and chatty wrappers. */
export function parsePatchProposal(raw: string): PatchProposal {
  let data: unknown;
  try {
    data = JSON.parse(extractJson(raw));
  } catch (error) {
    throw new ProposalParseError(`Response is not valid JSON: ${(error as Error).message}`);
  }
  const result = PatchProposalSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
    throw new ProposalParseError(`Response does not match the patch schema: ${issues}`);
  }
  return result.data;
}

function extractJson(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return trimmed;
  // ```json … ``` fenced block
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(trimmed);
  if (fenced?.[1]) return fenced[1];
  // Prose around the object: take the outermost braces.
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  return first !== -1 && last > first ? trimmed.slice(first, last + 1) : trimmed;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Client interface
// ─────────────────────────────────────────────────────────────────────────────────────────

export interface PromptPayload {
  readonly system: string;
  readonly user: string;
}

export interface PatchRequest {
  readonly prompt: PromptPayload;
  readonly attempt: number;
  /** Structured inputs the prompt was built from (a real client only needs `prompt`). */
  readonly analysis: FailureAnalysis;
  readonly context: ContextBundle;
  readonly history: readonly AttemptRecord[];
  readonly signal?: AbortSignal;
}

export interface LLMClient {
  readonly name: string;
  /** Returns the model's raw text response (expected: one JSON PatchProposal). */
  generatePatch(request: PatchRequest): Promise<string>;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Prompt construction
// ─────────────────────────────────────────────────────────────────────────────────────────

export interface PromptInput {
  readonly command: string;
  readonly exitCode: number;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly analysis: FailureAnalysis;
  readonly context: ContextBundle;
  readonly history: readonly AttemptRecord[];
  readonly allowTestEdits: boolean;
  /** Corrective feedback on the previous response in this attempt (e.g. "that patch already failed"). */
  readonly feedback?: string;
}

const MAX_HISTORY_ENTRIES = 6;
const MAX_HISTORY_PATCH_CHARS = 4_000;

export function buildSystemPrompt(allowTestEdits: boolean): string {
  return [
    'You are DevMedic, an autonomous senior software engineer that repairs failing integration tests by fixing the code under test.',
    '',
    'Respond with exactly ONE JSON object and nothing else (no prose, no code fences):',
    '{',
    '  "analysis": string,    // root cause in 1-3 sentences, citing file:line evidence',
    '  "plan": string[],      // ordered, concrete steps the patch performs',
    '  "confidence": number,  // 0..1, calibrated probability that the patch makes the tests pass',
    '  "patch": string        // unified diff; newlines escaped as \\n inside the JSON string',
    '}',
    '',
    'Patch rules:',
    '- Git-style unified diff: "--- a/<path>" and "+++ b/<path>" headers, "@@ -start,count +start,count @@" hunks, paths relative to the project root.',
    '- Copy context and removed lines VERBATIM from the files provided, without the "NN | " line-number gutter. Include 3 lines of context around each change.',
    '- Use "--- /dev/null" only to create a genuinely new file. Do not rename or delete files.',
    '- Make the smallest change that fixes the root cause. Do not reformat or refactor unrelated code.',
    allowTestEdits
      ? '- Test files may be edited only when the test itself is demonstrably wrong; prefer fixing the implementation.'
      : '- Do NOT modify, skip, or weaken tests: test files are read-only. Fix the implementation so the existing tests pass.',
    '- Never repeat a patch listed under "Previous attempts": each of them was applied and did not work.',
  ].join('\n');
}

export function buildPatchPrompt(input: PromptInput): PromptPayload {
  const { analysis, context } = input;
  const sections: string[] = [];

  sections.push(
    `# Failing test run — attempt ${input.attempt} of ${input.maxAttempts}`,
    `Command: \`${input.command}\` → exit code ${input.exitCode}`,
  );

  const facts = [
    `- Primary error: ${analysis.errorType}: ${firstLine(analysis.errorMessage)}`,
    analysis.failedTestCount !== undefined ? `- Failing tests reported by the runner: ${analysis.failedTestCount}` : undefined,
    analysis.failingTests.length > 0 ? `- Failing tests: ${analysis.failingTests.slice(0, 10).join('; ')}` : undefined,
    ...analysis.sourceFiles.slice(0, 5).map((f) => `- Implicated source: ${f.relativePath}${linesSuffix(f.lines)} — ${f.reasons.join(', ')}`),
    ...analysis.testFiles.slice(0, 3).map((f) => `- Failing test file: ${f.relativePath}${linesSuffix(f.lines)}`),
    ...analysis.notes.map((n) => `- Note: ${n}`),
  ].filter((line): line is string => line !== undefined);
  sections.push(`## Failure summary\n${facts.join('\n')}`);

  sections.push(`## Error details\n${fence(analysis.errorExcerpt, 'text')}`);
  sections.push(`## Test output (ANSI stripped, internal frames collapsed)\n${fence(analysis.relevantLog, 'text')}`);

  const fileSections = context.files.map(renderContextFile);
  if (context.skipped.length > 0) {
    fileSections.push(`Not included: ${context.skipped.map((s) => `${s.path} (${s.reason})`).join('; ')}`);
  }
  sections.push(`## Project files (line numbers are a reading aid — never copy them into the diff)\n\n${fileSections.join('\n\n')}`);

  if (input.history.length > 0) {
    const shown = input.history.slice(-MAX_HISTORY_ENTRIES);
    const omitted = input.history.length - shown.length;
    sections.push(
      `## Previous attempts in this session — none of them fixed the tests; do NOT repeat them\n` +
        (omitted > 0 ? `(${omitted} older attempt(s) omitted)\n\n` : '') +
        shown.map(renderAttempt).join('\n\n'),
    );
  }

  if (input.feedback) sections.push(`## Feedback on your previous response\n${input.feedback}`);

  sections.push(
    [
      '## Task',
      '1. Identify the root cause from the error, the stack frames and the code above.',
      '2. Propose the minimal fix as a unified diff that applies cleanly to the files exactly as shown.',
      '3. Reply with the JSON object described in the system prompt — nothing else.',
    ].join('\n'),
  );

  return { system: buildSystemPrompt(input.allowTestEdits), user: sections.join('\n\n') };
}

function renderContextFile(file: ContextFile): string {
  const role = file.role === 'test' ? 'test (read-only unless test edits are allowed)' : 'source';
  const meta = [
    role,
    file.implicatedLines.length > 0 ? `implicated lines ${file.implicatedLines.slice(0, 8).join(', ')}` : undefined,
    file.truncated ? `excerpt of ${file.totalLines} lines` : `${file.totalLines} lines`,
  ].filter(Boolean);
  const width = String(file.totalLines).length;
  const body = file.segments
    .map((segment, index) => {
      const numbered = segment.lines.map((text, k) => `${String(segment.startLine + k).padStart(width)} | ${text}`);
      const previous = file.segments[index - 1];
      const gap = previous ? `… (lines ${previous.startLine + previous.lines.length}–${segment.startLine - 1} omitted) …\n` : '';
      return gap + numbered.join('\n');
    })
    .join('\n');
  const reasons = file.reasons.length > 0 ? `\nWhy included: ${file.reasons.join('; ')}` : '';
  return `### ${file.relativePath} — ${meta.join(', ')}${reasons}\n${fence(body, languageOf(file.relativePath))}`;
}

function renderAttempt(record: AttemptRecord): string {
  const lines = [`### Attempt ${record.attempt} — ${OUTCOME_LABEL[record.outcome]}`];
  if (record.hypothesis) lines.push(`Hypothesis: ${record.hypothesis}`);
  if (record.plan && record.plan.length > 0) lines.push(`Plan: ${record.plan.join(' → ')}`);
  if (record.patch) {
    const patch =
      record.patch.length > MAX_HISTORY_PATCH_CHARS ? `${record.patch.slice(0, MAX_HISTORY_PATCH_CHARS)}\n… (truncated)` : record.patch;
    lines.push(`Patch:\n${fence(patch, 'diff')}`);
  }
  if (record.failureAfter) {
    const count = record.failureAfter.failedTestCount !== undefined ? ` (${record.failureAfter.failedTestCount} failing)` : '';
    lines.push(`Result after applying it: ${record.failureAfter.summary}${count}`);
  }
  if (record.error) lines.push(`Error: ${record.error}`);
  return lines.join('\n');
}

const OUTCOME_LABEL: Readonly<Record<AttemptRecord['outcome'], string>> = {
  'tests-passed': 'tests passed',
  'progress-kept': 'partial progress (fewer failing tests); this change is ALREADY APPLIED in the files above',
  'tests-failed': 'applied, tests still failing, rolled back',
  'apply-failed': 'patch did not apply to the files',
  'policy-rejected': 'patch rejected by safety policy',
  'no-op': 'patch changed nothing',
  'invalid-response': 'response was not a valid patch proposal',
  'llm-error': 'model call failed',
  duplicate: 'repeated an earlier failed patch',
  'dry-run': 'proposed (dry run)',
};

/** Fence long enough that backticks inside the content cannot terminate it. */
function fence(content: string, language: string): string {
  const longestRun = Math.max(0, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(Math.max(3, longestRun + 1));
  return `${ticks}${language}\n${content}\n${ticks}`;
}

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.ts': 'ts', '.tsx': 'tsx', '.mts': 'ts', '.cts': 'ts',
  '.js': 'js', '.jsx': 'jsx', '.mjs': 'js', '.cjs': 'js',
  '.json': 'json', '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
  '.java': 'java', '.kt': 'kotlin', '.vue': 'vue', '.svelte': 'svelte',
};

function languageOf(file: string): string {
  return LANGUAGE_BY_EXTENSION[path.extname(file).toLowerCase()] ?? '';
}

function linesSuffix(lines: readonly number[]): string {
  return lines.length > 0 ? `:${lines.slice(0, 3).join(',')}` : '';
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim() !== '')?.trim() ?? text;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Mock client
// ─────────────────────────────────────────────────────────────────────────────────────────

/** A scripted response: a proposal object (serialized to JSON) or raw text returned verbatim. */
export type ScriptedResponse = Readonly<Record<string, unknown>> | string;

/**
 * Stand-in for a real model. Responses come from, in order:
 *   1. a script (fixture file: a JSON array, or `{ "responses": [...] }`), one entry per call —
 *      entries may be proposal objects or raw strings (to simulate malformed output);
 *   2. once the script is exhausted, a synthesized proposal derived from the failure context.
 * The synthesized patch is a real, applicable diff against the implicated source file, but it
 * only inserts an investigation marker — it exercises the whole pipeline without pretending to
 * be intelligent. Plug in a real LLMClient to get real fixes.
 */
export class MockLLMClient implements LLMClient {
  readonly name: string;
  readonly #script: ScriptedResponse[];
  #calls = 0;

  constructor(script: readonly ScriptedResponse[] = [], name = 'mock') {
    this.#script = [...script];
    this.name = name;
  }

  static async fromFixture(fixturePath: string): Promise<MockLLMClient> {
    const parsed: unknown = JSON.parse(await readFile(fixturePath, 'utf8'));
    const list = Array.isArray(parsed)
      ? parsed
      : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { responses?: unknown }).responses)
        ? (parsed as { responses: unknown[] }).responses
        : undefined;
    if (!list || !list.every((r) => typeof r === 'string' || (typeof r === 'object' && r !== null && !Array.isArray(r)))) {
      throw new Error(`Mock fixture ${fixturePath} must be an array (or {"responses": [...]}) of objects or strings.`);
    }
    return new MockLLMClient(list as ScriptedResponse[], `mock (${path.basename(fixturePath)})`);
  }

  get callCount(): number {
    return this.#calls;
  }

  async generatePatch(request: PatchRequest): Promise<string> {
    request.signal?.throwIfAborted();
    this.#calls += 1;
    const scripted = this.#script.shift();
    if (scripted !== undefined) return typeof scripted === 'string' ? scripted : JSON.stringify(scripted, null, 2);
    return JSON.stringify(synthesizeProposal(request, this.#calls), null, 2);
  }
}

function synthesizeProposal(request: PatchRequest, variant: number): PatchProposal {
  const { analysis, context } = request;
  const target =
    context.files.find((f) => f.role === 'source' && f.implicatedLines.length > 0) ??
    context.files.find((f) => f.role === 'source') ??
    context.files[0];
  if (!target) {
    return { analysis: 'No project files were available to reason about.', plan: ['Nothing to patch'], confidence: 0, patch: '' };
  }

  const segment = target.segments[0] ?? { startLine: 1, lines: [] };
  const lastLine = segment.startLine + segment.lines.length - 1;
  const anchor = Math.min(Math.max(target.implicatedLines[0] ?? segment.startLine, segment.startLine), Math.max(lastLine, segment.startLine));
  const lineAt = (n: number): string => segment.lines[n - segment.startLine] ?? '';
  const indent = /^\s*/.exec(lineAt(anchor))?.[0] ?? '';
  const commentPrefix = /\.(?:py|rb|sh|ya?ml|toml)$/.test(target.relativePath) ? '#' : '//';
  const note = `${analysis.errorType}: ${firstLine(analysis.errorMessage)}`.replace(/\s+/g, ' ').slice(0, 100);
  const marker = `${indent}${commentPrefix} devmedic(simulated fix #${variant}): investigate ${note}`;

  let patch: string;
  if (segment.lines.length === 0) {
    patch = `--- a/${target.relativePath}\n+++ b/${target.relativePath}\n@@ -0,0 +1 @@\n+${marker}\n`;
  } else {
    const start = Math.max(segment.startLine, anchor - 3);
    const end = Math.min(lastLine, anchor + 2);
    const before = [];
    const after = [];
    for (let n = start; n < anchor; n += 1) before.push(` ${lineAt(n)}`);
    for (let n = anchor; n <= end; n += 1) after.push(` ${lineAt(n)}`);
    const oldCount = end - start + 1;
    patch = [
      `--- a/${target.relativePath}`,
      `+++ b/${target.relativePath}`,
      `@@ -${start},${oldCount} +${start},${oldCount + 1} @@`,
      ...before,
      `+${marker}`,
      ...after,
      '',
    ].join('\n');
  }

  return {
    analysis: `[simulated] ${analysis.summary}`,
    plan: [`Annotate ${target.relativePath}:${anchor} where the failure originates (mock client — no real reasoning).`],
    confidence: 0.05,
    patch,
  };
}
