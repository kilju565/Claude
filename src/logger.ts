/**
 * Minimal leveled logger. All diagnostics go to stderr so that stdout stays clean for
 * machine-consumable output (the dry-run patch can be redirected straight into a .patch file).
 */
import pc from 'picocolors';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export interface LogSink {
  write(chunk: string): unknown;
}

export class Logger {
  constructor(
    private readonly level: LogLevel = 'info',
    private readonly sink: LogSink = process.stderr,
  ) {}

  enabled(level: LogLevel): boolean {
    return LEVEL_RANK[this.level] >= LEVEL_RANK[level];
  }

  section(title: string): void {
    const rule = '─'.repeat(Math.max(4, 64 - title.length));
    this.emit('info', `\n${pc.bold(pc.magenta(`── ${title} ${rule}`))}`);
  }

  /** One of the named phases of the healing loop (Execute, Analyze, Patch, ...). */
  step(phase: string, message: string): void {
    this.emit('info', `${pc.cyan('▶')} ${pc.bold(phase.padEnd(9))} ${message}`);
  }

  info(message: string): void {
    this.emit('info', `  ${message}`);
  }

  success(message: string): void {
    this.emit('info', `${pc.green('✔')} ${message}`);
  }

  warn(message: string): void {
    this.emit('warn', `${pc.yellow('⚠')} ${message}`);
  }

  error(message: string): void {
    this.emit('error', `${pc.red('✖')} ${message}`);
  }

  debug(message: string): void {
    this.emit('debug', pc.dim(`  · ${message}`));
  }

  /** Multi-line text (logs, prompts) shown only in verbose mode. */
  debugBlock(title: string, text: string): void {
    if (!this.enabled('debug')) return;
    const body = text
      .split('\n')
      .map((line) => pc.dim(`    │ ${line}`))
      .join('\n');
    this.emit('debug', `${pc.dim(`  · ${title}`)}\n${body}`);
  }

  private emit(level: LogLevel, text: string): void {
    if (this.enabled(level)) this.sink.write(`${text}\n`);
  }
}

export const silentLogger = new Logger('silent');
