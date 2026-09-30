/**
 * memory.ts — what the agent remembers during one healing session.
 *
 * Every attempt is recorded with two fingerprints computed by the patcher:
 *   • diffFingerprint  — the semantic edit (+/- lines per file, no positions or context), so the
 *                        same change re-proposed with different hunk headers is still recognized;
 *   • stateFingerprint — the resulting contents of the touched files, so two *different* diffs that
 *                        produce the same code are recognized too.
 * Before any patch is applied, the agent asks memory whether either fingerprint was already tried;
 * if so the model is re-prompted with that fact instead of re-running a known-bad patch.
 * The history is also rendered into every prompt so the model can learn from its failures.
 */

export type AttemptOutcome =
  | 'tests-passed' // the patch made the suite green
  | 'progress-kept' // still failing, but fewer failing tests → kept as the new baseline
  | 'tests-failed' // applied, verified, no progress → rolled back
  | 'apply-failed' // diff did not fit the files
  | 'policy-rejected' // diff touched forbidden paths or exceeded limits
  | 'no-op' // diff changed nothing
  | 'invalid-response' // model output was not a valid patch proposal
  | 'llm-error' // the model call itself failed
  | 'duplicate' // the model kept repeating previously failed patches
  | 'dry-run'; // proposal shown, not applied

export interface FailureSnapshot {
  readonly signature: string;
  readonly summary: string;
  readonly failedTestCount?: number;
}

export interface AttemptRecord {
  readonly attempt: number;
  readonly outcome: AttemptOutcome;
  /** One line for humans and prompts. */
  readonly summary: string;
  readonly hypothesis?: string;
  readonly plan?: readonly string[];
  readonly confidence?: number;
  /** The canonical diff that was applied, or the raw proposal when it could not be applied. */
  readonly patch?: string;
  readonly files?: readonly string[];
  readonly diffFingerprint?: string;
  readonly stateFingerprint?: string;
  /** Failure observed after applying the patch. */
  readonly failureAfter?: FailureSnapshot;
  readonly error?: string;
}

export interface FingerprintQuery {
  readonly diffFingerprint?: string;
  readonly stateFingerprint?: string;
}

export class AttemptMemory {
  readonly #records: AttemptRecord[] = [];
  readonly #byDiff = new Map<string, AttemptRecord>();
  readonly #byState = new Map<string, AttemptRecord>();
  #duplicatesRejected = 0;

  record(record: AttemptRecord): void {
    this.#records.push(record);
    // Keep the *first* attempt that produced a fingerprint: that is the one to cite.
    if (record.diffFingerprint && !this.#byDiff.has(record.diffFingerprint)) {
      this.#byDiff.set(record.diffFingerprint, record);
    }
    if (record.stateFingerprint && !this.#byState.has(record.stateFingerprint)) {
      this.#byState.set(record.stateFingerprint, record);
    }
  }

  /** The earlier attempt that already tried this edit or reached this state, if any. */
  findDuplicate(query: FingerprintQuery): AttemptRecord | undefined {
    return (
      (query.diffFingerprint ? this.#byDiff.get(query.diffFingerprint) : undefined) ??
      (query.stateFingerprint ? this.#byState.get(query.stateFingerprint) : undefined)
    );
  }

  noteDuplicateRejected(): void {
    this.#duplicatesRejected += 1;
  }

  get records(): readonly AttemptRecord[] {
    return this.#records;
  }

  get duplicatesRejected(): number {
    return this.#duplicatesRejected;
  }
}
