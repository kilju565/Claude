import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExitCode, main } from '../src/cli.js';
import { copyExample, EXAMPLE_PROJECT, read } from './helpers.js';

const argv = (...args: string[]) => ['node', 'devmedic', ...args];

describe('cli', () => {
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (stdout.push(String(chunk)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => (stderr.push(String(chunk)), true));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints help and exits 0', async () => {
    expect(await main(argv('--help'))).toBe(ExitCode.Success);
    expect(stdout.join('')).toContain('--dry-run');
  });

  it('rejects missing or invalid arguments with exit code 2', async () => {
    expect(await main(argv())).toBe(ExitCode.UsageError);
    expect(stderr.join('')).toContain("required option '-c, --command <cmd>' not specified");
    expect(await main(argv('-c', 'npm test', '--max-retries', '0'))).toBe(ExitCode.UsageError);
    expect(await main(argv('-c', 'npm test', '--cwd', '/definitely/not/here'))).toBe(ExitCode.UsageError);
  });

  it('heals the example project end-to-end and exits 0', async () => {
    const root = await copyExample();
    const code = await main(
      argv('-C', root, '-c', 'node --test', '--mock-fixture', path.join(EXAMPLE_PROJECT, 'devmedic.mock.json'), '--quiet'),
    );
    expect(code).toBe(ExitCode.Success);
    expect(await read(root, 'src/discounts.js')).toContain('amount * (1 - rate)');
  });

  it('writes a pure, applicable patch to stdout in dry-run mode', async () => {
    const root = await copyExample();
    const code = await main(
      argv('-C', root, '-c', 'node --test', '--mock-fixture', path.join(EXAMPLE_PROJECT, 'devmedic.mock.json'), '--dry-run', '-q'),
    );
    expect(code).toBe(ExitCode.Success);
    expect(stdout.join('')).toMatch(/^--- a\/src\/pricing\.js\n\+\+\+ b\/src\/pricing\.js\n@@ -1,4 \+1,4 @@\n/);
    expect(await read(root, 'src/pricing.js')).toContain('sum + item.price, 0');
  });
});
