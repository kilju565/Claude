#!/usr/bin/env node
/**
 * Runs DevMedic against a throwaway copy of examples/checkout-service using the scripted mock
 * fixture, so the example in the repository stays buggy. Requires `npm run build` first
 * (`npm run demo` does both).
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const example = path.join(repo, 'examples', 'checkout-service');
const workdir = mkdtempSync(path.join(tmpdir(), 'devmedic-demo-'));
cpSync(example, workdir, { recursive: true });

console.error(`Demo project copied to ${workdir}\n`);
const { status } = spawnSync(
  process.execPath,
  [
    path.join(repo, 'dist', 'index.js'),
    '--cwd', workdir,
    '--command', 'npm run test:integration',
    '--mock-fixture', path.join(example, 'devmedic.mock.json'),
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' },
);

for (const file of ['src/pricing.js', 'src/discounts.js']) {
  console.error(`\n── ${file} after the run ──\n${readFileSync(path.join(workdir, file), 'utf8')}`);
}
process.exitCode = status ?? 1;
