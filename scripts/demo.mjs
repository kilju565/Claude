#!/usr/bin/env node
/**
 * Runs DevMedic against a throwaway copy of an example project using its scripted mock fixture,
 * so the examples in the repository stay buggy. Requires `npm run build` first
 * (`npm run demo` does both).
 *
 *   npm run demo                         # examples/checkout-service
 *   npm run demo -- user-directory       # examples/user-directory
 *   npm run demo -- user-directory -v    # extra arguments are passed to devmedic
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const name = args[0] && !args[0].startsWith('-') ? args.shift() : 'checkout-service';
const example = path.join(repo, 'examples', name);
if (!existsSync(path.join(example, 'devmedic.mock.json'))) {
  console.error(`Unknown example "${name}". Available: ${readdirSync(path.join(repo, 'examples')).join(', ')}`);
  process.exit(2);
}

const workdir = mkdtempSync(path.join(tmpdir(), `devmedic-demo-${name}-`));
cpSync(example, workdir, { recursive: true });
console.error(`Demo project copied to ${workdir}\n`);

const { status } = spawnSync(
  process.execPath,
  [
    path.join(repo, 'dist', 'index.js'),
    '--cwd', workdir,
    '--command', 'npm run test:integration',
    '--mock-fixture', path.join(example, 'devmedic.mock.json'),
    ...args,
  ],
  { stdio: 'inherit' },
);

// Show every source file the run changed.
const srcDir = path.join(example, 'src');
for (const file of readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
  if (!file.isFile()) continue;
  const relative = path.relative(example, path.join(file.parentPath, file.name));
  const after = readFileSync(path.join(workdir, relative), 'utf8');
  if (after !== readFileSync(path.join(example, relative), 'utf8')) {
    console.error(`\n── ${relative} after the run ──\n${after}`);
  }
}
process.exitCode = status ?? 1;
