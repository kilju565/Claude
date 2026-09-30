/**
 * cli.ts — argument parsing, wiring, signal handling and exit codes.
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import pc from 'picocolors';
import { runAgent, type AgentResult, type AgentStatus } from './agent.js';
import { DEFAULTS, type DevMedicConfig } from './config.js';
import { MockLLMClient, type LLMClient } from './llm.js';
import { Logger } from './logger.js';

export const ExitCode = {
  /** Tests pass (already, or after healing), or a dry-run proposal was produced. */
  Success: 0,
  /** Tests still failing: retries exhausted, or no fix could be produced. */
  TestsFailing: 1,
  /** Bad arguments or a test command that cannot be started. */
  UsageError: 2,
  /** Interrupted by SIGINT/SIGTERM (files restored). */
  Interrupted: 130,
} as const;

const STATUS_EXIT_CODE: Readonly<Record<AgentStatus, number>> = {
  'already-passing': ExitCode.Success,
  fixed: ExitCode.Success,
  'dry-run': ExitCode.Success,
  exhausted: ExitCode.TestsFailing,
  unfixable: ExitCode.TestsFailing,
  'command-error': ExitCode.UsageError,
  interrupted: ExitCode.Interrupted,
};

interface CliOptions {
  readonly command: string;
  readonly cwd: string;
  readonly maxRetries: number;
  readonly dryRun: boolean;
  readonly timeout: number;
  readonly allowTestEdits: boolean;
  readonly keepPartial: boolean;
  readonly maxContextFiles: number;
  readonly maxFileKb: number;
  readonly maxChangedLines: number;
  readonly mockFixture?: string;
  readonly stream: boolean;
  readonly verbose: boolean;
  readonly quiet: boolean;
}

function integer(name: string, min: number, max: number): (value: string) => number {
  return (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw new InvalidArgumentError(`${name} must be an integer between ${min} and ${max}.`);
    }
    return parsed;
  };
}

export function createProgram(): Command {
  return new Command('devmedic')
    .description(
      'Self-healing test agent: runs your integration tests, diagnoses failures from the stack trace, ' +
        'patches the code, and re-runs until the suite is green.',
    )
    .version(readVersion())
    .addOption(
      new Option('-c, --command <cmd>', 'test command to run, e.g. "npm run test:integration"')
        .env('DEVMEDIC_TEST_COMMAND')
        .makeOptionMandatory(),
    )
    .addOption(new Option('-C, --cwd <dir>', 'project root (all reads/writes are confined to it)').default(process.cwd(), 'current directory'))
    .addOption(
      new Option('-r, --max-retries <n>', 'maximum patch attempts before aborting (MAX_RETRIES)')
        .env('DEVMEDIC_MAX_RETRIES')
        .argParser(integer('--max-retries', 1, 20))
        .default(DEFAULTS.maxRetries),
    )
    .addOption(new Option('--dry-run', 'print the proposed patch to stdout instead of writing it').default(false))
    .addOption(
      new Option('-t, --timeout <seconds>', 'timeout for each test run')
        .argParser(integer('--timeout', 1, 24 * 3600))
        .default(DEFAULTS.timeoutMs / 1000),
    )
    .addOption(new Option('--allow-test-edits', 'allow the model to modify test files (off: fix the code, not the tests)').default(false))
    .addOption(new Option('--keep-partial', 'on abort, keep patches that reduced the number of failing tests').default(false))
    .addOption(
      new Option('--max-context-files <n>', 'maximum files sent to the model')
        .argParser(integer('--max-context-files', 1, 50))
        .default(DEFAULTS.maxContextFiles),
    )
    .addOption(
      new Option('--max-file-kb <n>', 'files larger than this are sent as excerpts')
        .argParser(integer('--max-file-kb', 1, 10_240))
        .default(DEFAULTS.maxFileBytes / 1024),
    )
    .addOption(
      new Option('--max-changed-lines <n>', 'reject patches that add/remove more lines than this')
        .argParser(integer('--max-changed-lines', 1, 10_000))
        .default(DEFAULTS.maxChangedLines),
    )
    .addOption(
      new Option('--mock-fixture <file>', 'JSON file of scripted responses for the mock LLM client').env('DEVMEDIC_MOCK_FIXTURE'),
    )
    .addOption(new Option('--stream', 'mirror test output live (to stderr) while capturing it').default(false))
    .addOption(new Option('-v, --verbose', 'debug logging, including prompts and raw output').default(false).conflicts('quiet'))
    .addOption(new Option('-q, --quiet', 'only warnings and errors').default(false))
    .showHelpAfterError()
    .addHelpText(
      'after',
      `
Examples:
  $ devmedic -c "npm run test:integration"
  $ devmedic -c "npx vitest run" --dry-run > fix.patch
  $ devmedic -C ./service -c "npm test" -r 5 --stream

Exit codes:
  0    tests pass (or dry-run produced a proposal)
  1    tests still failing (MAX_RETRIES reached, or no fix could be produced)
  2    invalid usage, or the test command cannot be started
  130  interrupted (all changes rolled back)`,
    );
}

export async function main(argv: readonly string[] = process.argv): Promise<number> {
  const program = createProgram().exitOverride();
  try {
    program.parse([...argv]);
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? ExitCode.Success : ExitCode.UsageError;
    throw error;
  }

  const options = program.opts<CliOptions>();
  const logger = new Logger(options.quiet ? 'warn' : options.verbose ? 'debug' : 'info');

  const projectRoot = path.resolve(options.cwd);
  if (!isDirectory(projectRoot)) {
    logger.error(`--cwd ${projectRoot} is not a directory.`);
    return ExitCode.UsageError;
  }

  let llm: LLMClient;
  try {
    llm = options.mockFixture ? await MockLLMClient.fromFixture(path.resolve(options.mockFixture)) : new MockLLMClient();
  } catch (error) {
    logger.error(`Could not load mock fixture: ${(error as Error).message}`);
    return ExitCode.UsageError;
  }
  logger.warn(`LLM provider: ${llm.name} — responses are simulated. Implement LLMClient (src/llm.ts) to use a real model.`);

  const config: DevMedicConfig = {
    command: options.command,
    projectRoot,
    maxRetries: options.maxRetries,
    dryRun: options.dryRun,
    timeoutMs: options.timeout * 1000,
    allowTestEdits: options.allowTestEdits,
    keepPartial: options.keepPartial,
    maxContextFiles: options.maxContextFiles,
    maxFileBytes: options.maxFileKb * 1024,
    maxChangedLines: options.maxChangedLines,
    streamOutput: options.stream,
  };

  // First Ctrl-C: stop gracefully (kill the test run, roll back). Second Ctrl-C: exit immediately.
  const controller = new AbortController();
  const onSignal = (signal: NodeJS.Signals): void => {
    if (controller.signal.aborted) {
      logger.error('Forced exit — files may not have been restored.');
      process.exit(ExitCode.Interrupted);
    }
    logger.warn(`${signal} received — stopping and restoring files (press Ctrl-C again to force quit)…`);
    controller.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const result = await runAgent(config, { llm, logger }, controller.signal);
    printSummary(result, logger);
    return STATUS_EXIT_CODE[result.status];
  } catch (error) {
    logger.error(`DevMedic crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return ExitCode.UsageError;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

function printSummary(result: AgentResult, logger: Logger): void {
  logger.section('Summary');
  for (const record of result.history) {
    const files = record.files && record.files.length > 0 ? pc.dim(` [${record.files.join(', ')}]`) : '';
    logger.info(`#${record.attempt} ${record.outcome.padEnd(16)} ${record.summary}${files}`);
  }
  if (result.duplicatesRejected > 0) {
    logger.info(pc.dim(`memory: rejected ${result.duplicatesRejected} repeated proposal(s) without re-running them`));
  }
  const changed = [...new Set(result.appliedChanges.map((c) => c.relativePath))];
  if (changed.length > 0) logger.info(`modified: ${changed.join(', ')}`);

  switch (result.status) {
    case 'fixed':
    case 'already-passing':
    case 'dry-run':
      logger.success(result.message);
      break;
    case 'interrupted':
      logger.warn(result.message);
      break;
    default:
      logger.error(result.message);
  }
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
