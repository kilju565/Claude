/**
 * executor.ts — runs the user's test command and captures everything it prints.
 *
 * The command is executed through a shell so that anything a developer would type works
 * (`npm run test:integration`, `FOO=1 vitest run`, `make test && ./check.sh`, ...).
 * It is never rejected on a non-zero exit code: failing tests are the *expected* input
 * of the healing loop, not an exceptional condition.
 */
import { execa } from 'execa';

export interface ExecuteOptions {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  /** Mirror the child's stdout/stderr to our stderr while still capturing them. */
  readonly stream?: boolean;
  /** Aborting kills the test process (SIGTERM, then SIGKILL after a grace period). */
  readonly signal?: AbortSignal;
  readonly env?: Readonly<Record<string, string>>;
}

export interface ExecutionResult {
  readonly command: string;
  readonly exitCode: number;
  readonly passed: boolean;
  readonly stdout: string;
  readonly stderr: string;
  /** stdout and stderr interleaved in arrival order — what a human would have seen. */
  readonly output: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly canceled: boolean;
  readonly signal?: string;
  /** Output exceeded the capture buffer and was cut off. */
  readonly outputTruncated: boolean;
  /**
   * The shell could not find or launch the command (POSIX exit 127, cmd.exe 9009, spawn error).
   * Editing source code cannot fix this, so the agent stops instead of burning retries.
   */
  readonly commandNotFound: boolean;
  readonly spawnError?: string;
}

const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const FORCE_KILL_AFTER_MS = 5_000;

export async function runTestCommand(options: ExecuteOptions): Promise<ExecutionResult> {
  // ['pipe', process.stderr] = capture the stream AND forward it live. Output is forwarded to
  // our *stderr* (not stdout) so DevMedic's own stdout stays reserved for the dry-run patch.
  const capture = options.stream ? (['pipe', process.stderr] as const) : 'pipe';

  const result = await execa(options.command, {
    shell: true,
    cwd: options.cwd,
    all: true,
    reject: false,
    stdin: 'ignore',
    stdout: capture,
    stderr: capture,
    timeout: options.timeoutMs,
    cancelSignal: options.signal,
    forceKillAfterDelay: FORCE_KILL_AFTER_MS,
    maxBuffer: MAX_BUFFER_BYTES,
    env: {
      // Keep runners out of interactive/watch mode (Jest, Vitest) unless the caller set CI already.
      CI: process.env['CI'] ?? 'true',
      // Ask for plain output; the analyzer strips any ANSI codes that slip through anyway.
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      ...options.env,
    },
  });

  const stdout = toText(result.stdout);
  const stderr = toText(result.stderr);
  const output = toText(result.all) || [stdout, stderr].filter(Boolean).join('\n');

  // A process killed by a signal/timeout has no exit code; treat it as a failure.
  const exitCode = result.exitCode ?? (result.failed ? 1 : 0);
  const spawnError =
    result.failed && result.exitCode === undefined && !result.timedOut && !result.isCanceled && !result.signal
      ? result.shortMessage
      : undefined;
  const commandNotFound =
    spawnError !== undefined || exitCode === 127 || (process.platform === 'win32' && exitCode === 9009);

  return {
    command: options.command,
    exitCode,
    passed: exitCode === 0 && !result.failed,
    stdout,
    stderr,
    output,
    durationMs: Math.round(result.durationMs),
    timedOut: result.timedOut,
    canceled: result.isCanceled,
    signal: result.signal ?? undefined,
    outputTruncated: result.isMaxBuffer,
    commandNotFound,
    spawnError,
  };
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join('\n');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return '';
}
