/**
 * Runtime configuration shared by the CLI and the agent loop.
 */

export interface DevMedicConfig {
  /** Shell command that runs the test suite, e.g. `npm run test:integration`. */
  readonly command: string;
  /** Absolute path of the project being healed. Every file access is confined to it. */
  readonly projectRoot: string;
  /** Maximum number of patch attempts before aborting. */
  readonly maxRetries: number;
  /** Print the proposed patch instead of writing it to disk. */
  readonly dryRun: boolean;
  /** Per test-run timeout. */
  readonly timeoutMs: number;
  /** Allow the model to edit test files (off by default: fix the code, not the assertions). */
  readonly allowTestEdits: boolean;
  /** On abort, keep patches that reduced the number of failing tests instead of restoring the originals. */
  readonly keepPartial: boolean;
  /** Maximum number of files sent to the model as context. */
  readonly maxContextFiles: number;
  /** Files larger than this are sent as excerpts around the implicated lines. */
  readonly maxFileBytes: number;
  /** Upper bound on added + removed lines in a single patch. */
  readonly maxChangedLines: number;
  /** Mirror the test runner's output to stderr while it is being captured. */
  readonly streamOutput: boolean;
}

export const DEFAULTS = {
  maxRetries: 3,
  timeoutMs: 10 * 60 * 1000,
  maxContextFiles: 8,
  maxFileBytes: 256 * 1024,
  maxChangedLines: 400,
  /** Hard cap on files touched by one patch. */
  maxPatchFiles: 10,
  /** How many times one attempt may re-prompt the model after it repeats a failed patch. */
  maxDuplicateReprompts: 2,
  /** Context lines the patcher may ignore at each end of a hunk (GNU patch "fuzz"). */
  maxFuzz: 2,
} as const;
