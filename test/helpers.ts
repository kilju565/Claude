import { mkdtemp, mkdir, rm, writeFile, cp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXAMPLE_PROJECT = path.join(REPO_ROOT, 'examples', 'checkout-service');

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Creates a temp project from a { relativePath: content } map; removed after each test. */
export async function makeProject(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'devmedic-test-'));
  created.push(dir);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return dir;
}

/** Copies the example project into a temp dir so tests can mutate it. */
export async function copyExample(): Promise<string> {
  const dir = await makeProject();
  await cp(EXAMPLE_PROJECT, dir, { recursive: true });
  return dir;
}

/** Snapshot of every file (relative path → content) for "tree unchanged" assertions. */
export async function snapshotTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir)) {
      const full = path.join(dir, entry);
      if ((await stat(full)).isDirectory()) await walk(full);
      else out[path.relative(root, full).split(path.sep).join('/')] = await readFile(full, 'utf8');
    }
  };
  await walk(root);
  return out;
}

export function read(root: string, relative: string): Promise<string> {
  return readFile(path.join(root, relative), 'utf8');
}
