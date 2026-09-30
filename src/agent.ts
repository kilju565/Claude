/**
 * agent.ts — the autonomous healing loop.
 *
 *   1. Execute     run the test command
 *   2. Intercept   exit code > 0 → keep stdout/stderr
 *   3. Analyze     stack traces → failing test file + originating source files
 *   4. Read        load implicated files (+ modules the failing tests import)
 *   5. Plan/Patch  prompt the model, validate the JSON patch, check memory, apply transactionally
 *   6. Verify      re-run the tests
 *   7. Halt        green → done; otherwise roll back and retry until MAX_RETRIES
 *
 * State between attempts:
 *   • AttemptMemory — every proposal/outcome, used for de-duplication and fed back into prompts.
 *   • Baseline      — failed attempts are rolled back, EXCEPT ones that reduce the number of failing
 *                     tests: those are kept as the new baseline ("ratchet"), so multi-bug suites can
 *                     be healed one bug per attempt. On abort, kept patches are reverted too unless
 *                     keepPartial is set, leaving the tree exactly as it was found.
 */
import pc from 'picocolors';
import { analyzeFailure, isTestFilePath, type FailureAnalysis } from './analyzer.js';
import { DEFAULTS, type DevMedicConfig } from './config.js';
import { gatherContext, type ContextBundle } from './context.js';
import { runTestCommand, type ExecuteOptions, type ExecutionResult } from './executor.js';
import { buildPatchPrompt, parsePatchProposal, type LLMClient, type PatchProposal } from './llm.js';
import type { Logger } from './logger.js';
import { AttemptMemory, type AttemptOutcome, type AttemptRecord } from './memory.js';
import {
  commitPatch,
  fingerprintDiffText,
  PatchError,
  POLICY_ERROR_CODES,
  preparePatch,
  renderPatchPreview,
  summarizeChanges,
  type FileChange,
  type PatchTransaction,
  type PreparedPatch,
} from './patcher.js';

export interface AgentDependencies {
  readonly llm: LLMClient;
  readonly logger: Logger;
  /** Injected for tests; defaults to the real executor. */
  readonly runTests?: (options: ExecuteOptions) => Promise<ExecutionResult>;
  /** Receives the dry-run patch. Defaults to stdout so it can be redirected into a .patch file. */
  readonly writeOutput?: (text: string) => void;
}

export type AgentStatus =
  | 'already-passing'
  | 'fixed'
  | 'dry-run'
  | 'exhausted'
  | 'unfixable'
  | 'command-error'
  | 'interrupted';

export interface AgentResult {
  readonly status: AgentStatus;
  readonly message: string;
  /** Patch attempts consumed (planning rounds that ended in an outcome). */
  readonly attemptsUsed: number;
  readonly history: readonly AttemptRecord[];
  readonly duplicatesRejected: number;
  /** Changes left on disk when the agent returned. */
  readonly appliedChanges: readonly FileChange[];
  /** The dry-run proposal, when status is 'dry-run'. */
  readonly proposal?: { readonly proposal: PatchProposal; readonly prepared: PreparedPatch };
}

export async function runAgent(config: DevMedicConfig, deps: AgentDependencies, signal?: AbortSignal): Promise<AgentResult> {
  return new HealingSession(config, deps, signal).run();
}

class InterruptedError extends Error {
  override readonly name = 'InterruptedError';
}

type Planned =
  | { readonly kind: 'ready'; readonly proposal: PatchProposal; readonly prepared: PreparedPatch }
  | { readonly kind: 'rejected'; readonly record: AttemptRecord };

class HealingSession {
  readonly #memory = new AttemptMemory();
  /** Patches kept on disk because they made progress (applied in order). */
  readonly #kept: PatchTransaction[] = [];
  /** The patch currently under verification. */
  #active: PatchTransaction | undefined;
  #attemptsUsed = 0;
  readonly #runTests: (options: ExecuteOptions) => Promise<ExecutionResult>;
  readonly #writeOutput: (text: string) => void;

  constructor(
    private readonly config: DevMedicConfig,
    private readonly deps: AgentDependencies,
    private readonly signal?: AbortSignal,
  ) {
    this.#runTests = deps.runTests ?? runTestCommand;
    this.#writeOutput = deps.writeOutput ?? ((text) => process.stdout.write(`${text}\n`));
  }

  async run(): Promise<AgentResult> {
    try {
      return await this.#loop();
    } catch (error) {
      const interrupted = error instanceof InterruptedError || this.signal?.aborted === true;
      // Whatever happened, never leave a half-verified patch on disk.
      await this.#restore({ includeKept: !this.config.keepPartial });
      if (interrupted) {
        return this.#result('interrupted', 'Interrupted — all in-flight changes were rolled back.');
      }
      throw error;
    }
  }

  async #loop(): Promise<AgentResult> {
    const { logger } = this.deps;
    const { config } = this;

    logger.section('DevMedic');
    logger.info(`project : ${config.projectRoot}`);
    logger.info(`command : ${config.command}`);
    logger.info(`model   : ${this.deps.llm.name}`);
    logger.info(`limits  : ${config.maxRetries} attempt(s)${config.dryRun ? ', DRY RUN (no files will be written)' : ''}`);

    const initial = await this.#execute('Initial run');
    if (initial.passed) return this.#result('already-passing', 'Tests already pass — nothing to heal.');
    if (initial.commandNotFound) {
      return this.#result(
        'command-error',
        `The test command could not be started (${initial.spawnError ?? `exit code ${initial.exitCode}`}). ` +
          'Check the command and that dependencies are installed — patching source code cannot fix this.',
      );
    }

    let baselineRun = initial;
    let baseline = this.#analyze(initial);

    for (let attempt = 1; attempt <= config.maxRetries; attempt += 1) {
      this.#checkInterrupted();
      this.#attemptsUsed = attempt;
      logger.section(`Attempt ${attempt}/${config.maxRetries}`);

      const context = await this.#readContext(baseline);
      if (context.files.length === 0) {
        return this.#result('unfixable', 'Could not map the failure to any readable project file; nothing to send to the model.');
      }

      const planned = await this.#plan(attempt, baseline, baselineRun, context);
      if (planned.kind === 'rejected') {
        this.#memory.record(planned.record);
        logger.warn(`Attempt ${attempt} failed before verification: ${planned.record.summary}`);
        continue;
      }
      const { proposal, prepared } = planned;

      if (config.dryRun) {
        logger.step('Dry run', 'proposed patch follows on stdout; nothing is written');
        for (const line of summarizeChanges(prepared)) logger.info(line);
        for (const warning of prepared.warnings) logger.warn(warning);
        this.#writeOutput(renderPatchPreview(prepared, { color: process.stdout.isTTY === true }));
        this.#memory.record(this.#recordFor(attempt, 'dry-run', 'Proposed patch printed (dry run).', proposal, prepared));
        return { ...this.#result('dry-run', 'Dry run complete — proposed patch printed, no files modified.'), proposal: { proposal, prepared } };
      }

      // ── Apply ──
      let transaction: PatchTransaction;
      try {
        transaction = await commitPatch(prepared);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#memory.record(this.#recordFor(attempt, 'apply-failed', `Writing the patch failed: ${message}`, proposal, prepared, { error: message }));
        logger.error(`Could not write the patch: ${message}`);
        continue;
      }
      this.#active = transaction;
      logger.step('Patch', `applied ${describeChanges(prepared.changes)}`);

      // ── Verify ──
      const verification = await this.#execute('Verify');
      if (verification.passed) {
        this.#kept.push(transaction);
        this.#active = undefined;
        this.#memory.record(this.#recordFor(attempt, 'tests-passed', 'Tests pass with this patch.', proposal, prepared));
        return this.#result('fixed', `Tests pass after ${attempt} attempt(s).`);
      }
      if (verification.commandNotFound) {
        // The patch broke the runner itself (e.g. deleted a script) — treat as a failed attempt.
        logger.warn('The test command could not start after patching.');
      }

      const after = this.#analyze(verification);
      const snapshot = { signature: after.signature, summary: after.summary, failedTestCount: after.failedTestCount };
      if (isProgress(baseline, after)) {
        this.#kept.push(transaction);
        this.#active = undefined;
        logger.success(
          `Progress: failing tests ${baseline.failedTestCount} → ${after.failedTestCount}; keeping this patch as the new baseline.`,
        );
        this.#memory.record(
          this.#recordFor(attempt, 'progress-kept', `Reduced failing tests to ${after.failedTestCount}.`, proposal, prepared, {
            failureAfter: snapshot,
          }),
        );
        baseline = after;
        baselineRun = verification;
      } else {
        await transaction.rollback();
        this.#active = undefined;
        const movement = after.signature === baseline.signature ? 'same failure' : 'failure changed';
        logger.warn(`Still failing (${movement}); patch rolled back.`);
        this.#memory.record(
          this.#recordFor(attempt, 'tests-failed', `Tests still failing (${movement}): ${after.summary}`, proposal, prepared, {
            failureAfter: snapshot,
          }),
        );
      }
    }

    if (this.#kept.length > 0 && !config.keepPartial) {
      logger.warn('Reverting partial-progress patches (use --keep-partial to keep them).');
      await this.#restore({ includeKept: true });
    }
    return this.#result('exhausted', `Tests still failing after ${config.maxRetries} attempt(s) (MAX_RETRIES reached) — aborting.`);
  }

  // ── Steps ────────────────────────────────────────────────────────────────────────────

  async #execute(label: string): Promise<ExecutionResult> {
    const { logger } = this.deps;
    logger.step('Execute', `${label}: ${pc.dim(this.config.command)}`);
    const result = await this.#runTests({
      command: this.config.command,
      cwd: this.config.projectRoot,
      timeoutMs: this.config.timeoutMs,
      stream: this.config.streamOutput,
      signal: this.signal,
    });
    this.#checkInterrupted();
    const seconds = (result.durationMs / 1000).toFixed(1);
    if (result.passed) {
      logger.success(`Tests passed (${seconds}s)`);
    } else {
      const reason = result.timedOut ? ', timed out' : result.signal ? `, killed by ${result.signal}` : '';
      logger.step('Intercept', `exit code ${result.exitCode}${reason} after ${seconds}s — captured ${result.output.length} chars of output`);
      logger.debugBlock('test output (tail)', result.output.split('\n').slice(-40).join('\n'));
    }
    return result;
  }

  #analyze(run: ExecutionResult): FailureAnalysis {
    const { logger } = this.deps;
    const analysis = analyzeFailure(run, { projectRoot: this.config.projectRoot });
    logger.step('Analyze', analysis.summary);
    if (analysis.failedTestCount !== undefined) logger.info(`failing tests : ${analysis.failedTestCount}`);
    if (analysis.failingTests.length > 0) logger.info(`test names    : ${analysis.failingTests.slice(0, 5).join('; ')}`);
    if (analysis.testFiles.length > 0) logger.info(`test files    : ${formatRanked(analysis.testFiles)}`);
    if (analysis.sourceFiles.length > 0) logger.info(`source files  : ${formatRanked(analysis.sourceFiles)}`);
    for (const note of analysis.notes) logger.info(pc.dim(`note: ${note}`));
    return analysis;
  }

  async #readContext(analysis: FailureAnalysis): Promise<ContextBundle> {
    const context = await gatherContext(analysis, {
      projectRoot: this.config.projectRoot,
      maxFiles: this.config.maxContextFiles,
      maxFileBytes: this.config.maxFileBytes,
    });
    const listing = context.files.map((f) => `${f.relativePath}${f.role === 'test' ? ' (test)' : ''}${f.truncated ? ' [excerpt]' : ''}`);
    this.deps.logger.step('Read', `${context.files.length} file(s): ${listing.join(', ') || '—'}`);
    for (const skipped of context.skipped) this.deps.logger.debug(`skipped ${skipped.path}: ${skipped.reason}`);
    return context;
  }

  /**
   * One attempt's planning round. The model is re-prompted (bounded) when it proposes a patch that
   * memory already knows failed; every other problem ends the attempt with a recorded outcome that
   * the next prompt will show.
   */
  async #plan(attempt: number, analysis: FailureAnalysis, run: ExecutionResult, context: ContextBundle): Promise<Planned> {
    const { logger, llm } = this.deps;
    let feedback: string | undefined;

    for (let round = 0; round <= DEFAULTS.maxDuplicateReprompts; round += 1) {
      this.#checkInterrupted();
      const prompt = buildPatchPrompt({
        command: this.config.command,
        exitCode: run.exitCode,
        attempt,
        maxAttempts: this.config.maxRetries,
        analysis,
        context,
        history: this.#memory.records,
        allowTestEdits: this.config.allowTestEdits,
        feedback,
      });
      logger.step('Plan', `asking ${llm.name} for a patch (${prompt.user.length.toLocaleString()} chars of context${round > 0 ? `, re-prompt ${round}` : ''})`);
      logger.debugBlock('prompt', prompt.user);

      let raw: string;
      try {
        raw = await llm.generatePatch({ prompt, attempt, analysis, context, history: this.#memory.records, signal: this.signal });
      } catch (error) {
        this.#checkInterrupted();
        const message = error instanceof Error ? error.message : String(error);
        return rejected({ attempt, outcome: 'llm-error', summary: `Model call failed: ${message}`, error: message });
      }

      let proposal: PatchProposal;
      try {
        proposal = parsePatchProposal(raw);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.debugBlock('raw response', raw);
        return rejected({ attempt, outcome: 'invalid-response', summary: message, error: message });
      }
      logger.info(`hypothesis : ${proposal.analysis}`);
      logger.info(`plan       : ${proposal.plan.join(' → ')}`);
      logger.info(`confidence : ${Math.round(proposal.confidence * 100)}%`);

      // Memory check #1 — the edit itself, before touching anything.
      const diffFingerprint = fingerprintDiffText(proposal.patch);
      const knownEdit = this.#memory.findDuplicate({ diffFingerprint });
      if (knownEdit) {
        feedback = this.#duplicateFeedback(knownEdit);
        continue;
      }

      let prepared: PreparedPatch;
      try {
        prepared = await preparePatch(proposal.patch, {
          projectRoot: this.config.projectRoot,
          allowTestEdits: this.config.allowTestEdits,
          isTestFile: isTestFilePath,
          maxChangedLines: this.config.maxChangedLines,
          maxFiles: DEFAULTS.maxPatchFiles,
          maxFuzz: DEFAULTS.maxFuzz,
          expectedHashes: context.hashes,
        });
      } catch (error) {
        if (!(error instanceof PatchError)) throw error;
        const outcome: AttemptOutcome =
          error.code === 'NO_OP' ? 'no-op' : POLICY_ERROR_CODES.has(error.code) ? 'policy-rejected' : 'apply-failed';
        return rejected({
          attempt,
          outcome,
          summary: `${error.code}: ${error.message}`,
          hypothesis: proposal.analysis,
          plan: proposal.plan,
          confidence: proposal.confidence,
          patch: proposal.patch,
          diffFingerprint,
          error: error.message,
        });
      }

      // Memory check #2 — the resulting code (a different diff can reproduce a failed state).
      const knownState = this.#memory.findDuplicate({ stateFingerprint: prepared.stateFingerprint });
      if (knownState) {
        feedback = this.#duplicateFeedback(knownState);
        continue;
      }
      for (const warning of prepared.warnings) logger.info(pc.dim(`note: ${warning}`));
      return { kind: 'ready', proposal, prepared };
    }

    return rejected({
      attempt,
      outcome: 'duplicate',
      summary: `The model repeated previously failed patches ${DEFAULTS.maxDuplicateReprompts + 1} times in a row.`,
    });
  }

  #duplicateFeedback(previous: AttemptRecord): string {
    this.#memory.noteDuplicateRejected();
    this.deps.logger.warn(`Memory: this patch was already tried in attempt #${previous.attempt} (${previous.outcome}) — re-prompting.`);
    return (
      `Your last proposal is identical to the patch from attempt ${previous.attempt}, which was already tried ` +
      `(outcome: ${previous.outcome}${previous.failureAfter ? `; result: ${previous.failureAfter.summary}` : ''}). ` +
      'It was NOT applied again. Re-examine the root cause and propose a materially different fix.'
    );
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────────────

  #recordFor(
    attempt: number,
    outcome: AttemptOutcome,
    summary: string,
    proposal: PatchProposal,
    prepared: PreparedPatch,
    extra: Partial<AttemptRecord> = {},
  ): AttemptRecord {
    return {
      attempt,
      outcome,
      summary,
      hypothesis: proposal.analysis,
      plan: proposal.plan,
      confidence: proposal.confidence,
      patch: prepared.diff,
      files: prepared.changes.map((c) => c.relativePath),
      diffFingerprint: prepared.diffFingerprint,
      stateFingerprint: prepared.stateFingerprint,
      ...extra,
    };
  }

  async #restore(options: { readonly includeKept: boolean }): Promise<void> {
    const transactions = [...(options.includeKept ? this.#kept : []), ...(this.#active ? [this.#active] : [])];
    this.#active = undefined;
    if (options.includeKept) this.#kept.length = 0;
    // Newest first, so each rollback restores exactly the state its patch was applied on.
    for (const transaction of transactions.reverse()) {
      try {
        await transaction.rollback();
      } catch (error) {
        this.deps.logger.error(`Rollback failed: ${(error as Error).message}`);
      }
    }
  }

  #checkInterrupted(): void {
    if (this.signal?.aborted) throw new InterruptedError('Interrupted');
  }

  #result(status: AgentStatus, message: string): AgentResult {
    return {
      status,
      message,
      attemptsUsed: this.#attemptsUsed,
      history: this.#memory.records,
      duplicatesRejected: this.#memory.duplicatesRejected,
      appliedChanges: this.#kept.filter((t) => !t.rolledBack).flatMap((t) => t.changes),
    };
  }
}

/**
 * The ratchet criterion: strictly fewer failing tests, as reported by the runner's summary.
 * Unknown counts never count as progress, and neither does "0 failing but still red" (usually a
 * patch that broke test discovery rather than one that fixed tests).
 */
export function isProgress(before: FailureAnalysis, after: FailureAnalysis): boolean {
  return (
    before.failedTestCount !== undefined &&
    after.failedTestCount !== undefined &&
    after.failedTestCount >= 1 &&
    after.failedTestCount < before.failedTestCount
  );
}

function rejected(record: AttemptRecord): Planned {
  return { kind: 'rejected', record };
}

function describeChanges(changes: readonly FileChange[]): string {
  return changes.map((c) => `${c.relativePath} (+${c.added} -${c.removed})`).join(', ');
}

function formatRanked(files: readonly { relativePath: string; lines: readonly number[] }[]): string {
  return files
    .slice(0, 4)
    .map((f) => `${f.relativePath}${f.lines.length > 0 ? `:${f.lines.slice(0, 3).join(',')}` : ''}`)
    .join(', ');
}
