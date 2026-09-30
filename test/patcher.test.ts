import { chmod, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isTestFilePath } from '../src/analyzer.js';
import { sha256Of } from '../src/context.js';
import {
  applyHunks,
  commitPatch,
  fingerprintDiffText,
  parseUnifiedDiff,
  PatchError,
  preparePatch,
  renderPatchPreview,
  resolveSafePath,
  type PatchPolicy,
} from '../src/patcher.js';
import { makeProject, read, snapshotTree } from './helpers.js';

const SOURCE = ['function add(a, b) {', '  return a - b;', '}', '', 'function sub(a, b) {', '  return a - b;', '}', ''].join('\n');

const FIX_ADD = `--- a/src/math.js
+++ b/src/math.js
@@ -1,3 +1,3 @@
 function add(a, b) {
-  return a - b;
+  return a + b;
 }
`;

function policy(root: string, overrides: Partial<PatchPolicy> = {}): PatchPolicy {
  return { projectRoot: root, allowTestEdits: false, isTestFile: isTestFilePath, ...overrides };
}

async function expectPatchError(promise: Promise<unknown>, code: string): Promise<PatchError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PatchError);
  expect((error as PatchError).code).toBe(code);
  return error as PatchError;
}

describe('parseUnifiedDiff', () => {
  it('parses git-style headers and strips a/ b/ prefixes', () => {
    const [file] = parseUnifiedDiff(`diff --git a/src/math.js b/src/math.js\nindex 1..2 100644\n${FIX_ADD}`);
    expect(file).toMatchObject({ oldPath: 'src/math.js', newPath: 'src/math.js', binary: false });
    expect(file?.hunks[0]).toMatchObject({ oldStart: 1, newStart: 1, countMismatch: false });
    expect(file?.hunks[0]?.lines.map((l) => l.op).join('')).toBe(' -+ ');
  });

  it('keeps prefix-less paths intact and drops GNU timestamps', () => {
    const [file] = parseUnifiedDiff('--- a.txt\t2024-01-01 10:00\n+++ a.txt\t2024-01-02 10:00\n@@ -1 +1 @@\n-x\n+y\n');
    expect(file).toMatchObject({ oldPath: 'a.txt', newPath: 'a.txt' });
  });

  it('unwraps a fully fenced diff and ignores surrounding blank lines', () => {
    expect(parseUnifiedDiff(`\`\`\`diff\n${FIX_ADD}\`\`\`\n`)).toHaveLength(1);
  });

  it('tolerates wrong counts, bare "@@ @@" headers and blank context lines', () => {
    const [file] = parseUnifiedDiff('--- a/x.js\n+++ b/x.js\n@@ -1,99 +1,99 @@\n a\n\n-b\n+c\n@@ @@\n d\n-e\n+f\n');
    expect(file?.hunks).toHaveLength(2);
    expect(file?.hunks[0]).toMatchObject({ countMismatch: true });
    expect(file?.hunks[0]?.lines).toEqual([
      { op: ' ', text: 'a' },
      { op: ' ', text: '' },
      { op: '-', text: 'b' },
      { op: '+', text: 'c' },
    ]);
    expect(file?.hunks[1]?.oldStart).toBeUndefined();
  });

  it('treats "--- x" inside a hunk as content unless a full file header follows', () => {
    const files = parseUnifiedDiff('--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1,1 @@\n--- old comment\n select 1;\n--- a/r.sql\n+++ b/r.sql\n@@ -1 +1 @@\n-a\n+b\n');
    expect(files.map((f) => f.newPath)).toEqual(['q.sql', 'r.sql']);
    expect(files[0]?.hunks[0]?.lines[0]).toEqual({ op: '-', text: '-- old comment' });
  });

  it('records "\\ No newline at end of file" on the preceding line', () => {
    const [file] = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n');
    expect(file?.hunks[0]?.lines).toEqual([
      { op: '-', text: 'a', noNewlineAtEof: true },
      { op: '+', text: 'b', noNewlineAtEof: true },
    ]);
  });

  it('rejects text without a diff', () => {
    expect(() => parseUnifiedDiff('I think you should change line 3.')).toThrowError(PatchError);
  });
});

describe('applyHunks', () => {
  const apply = (content: string, diff: string, maxFuzz = 2) =>
    applyHunks(content, parseUnifiedDiff(diff)[0]?.hunks ?? [], { maxFuzz, filePath: 'f' });

  it('applies an exact hunk', () => {
    expect(apply(SOURCE, FIX_ADD).content).toBe(SOURCE.replace('return a - b', 'return a + b'));
  });

  it('finds hunks whose line numbers are off (offset)', () => {
    const shifted = `// header\n// header\n${SOURCE}`;
    const result = apply(shifted, FIX_ADD);
    expect(result.content).toContain('return a + b');
    expect(result.hunks[0]?.offset).toBe(2);
    expect(result.warnings.join()).toContain('offset 2');
  });

  it('uses the nearest match for repeated code', () => {
    const diff = FIX_ADD.replace('@@ -1,3 +1,3 @@', '@@ -5,3 +5,3 @@').replace(/add/g, 'sub');
    const result = apply(SOURCE, diff);
    expect(result.content).toBe(SOURCE.replace(/(function sub\(a, b\) \{\n {2}return a )-/, '$1+'));
  });

  it('applies with fuzz when outer context lines are wrong', () => {
    const diff = '--- a/f\n+++ b/f\n@@ -1,4 +1,4 @@\n WRONG CONTEXT\n   return a - b;\n-}\n+};\n';
    const result = apply('function add(a, b) {\n  return a - b;\n}\n', diff);
    expect(result.content).toBe('function add(a, b) {\n  return a - b;\n};\n');
    expect(result.hunks[0]?.fuzz).toBe(1);
  });

  it('matches whitespace-damaged context but preserves the original bytes', () => {
    const diff = '--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n function add(a,  b) {\n-    return a - b;\n+  return a + b;\n }\n';
    const result = apply('function add(a, b) {\n\treturn a - b;\n}\n', diff);
    expect(result.content).toBe('function add(a, b) {\n  return a + b;\n}\n');
    expect(result.hunks[0]?.mode).toBe('whitespace-insensitive');
  });

  it('preserves CRLF line endings and a missing final newline', () => {
    const crlf = 'a\r\nb\r\nc';
    const result = apply(crlf, '--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n');
    expect(result.content).toBe('a\r\nB\r\nc');
  });

  it('honors "\\ No newline at end of file" on the new side', () => {
    const result = apply('a\nb\n', '--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n\\ No newline at end of file\n');
    expect(result.content).toBe('a\nc');
  });

  it('applies out-of-order hunks in file order', () => {
    const diff = '--- a/f\n+++ b/f\n@@ -5,3 +5,3 @@\n e\n-f\n+F\n g\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n';
    expect(apply('a\nb\nc\nd\ne\nf\ng\n', diff).content).toBe('a\nB\nc\nd\ne\nF\ng\n');
  });

  it('refuses to relocate low-information hunks (only braces)', () => {
    const content = 'x\n}\n}\n}\n';
    expect(() => apply(content, '--- a/f\n+++ b/f\n@@ -1,1 +1,2 @@\n }\n+// added\n')).toThrowError(/does not match/);
  });

  it('refuses context-less insertions into non-empty files', () => {
    expect(() => apply('a\n', '--- a/f\n+++ b/f\n@@ -1,0 +2 @@\n+b\n')).toThrowError(PatchError);
  });

  it('explains mismatches precisely', () => {
    const diff = FIX_ADD.replace(' function add(a, b) {', ' function plus(a, b) {');
    expect(() => apply('something else entirely\n', diff)).toThrowError(/expects "function plus\(a, b\) \{" but the file has "something else entirely"/);
  });
});

describe('preparePatch — safety policy', () => {
  it('computes a canonical diff, stats and fingerprints without writing', async () => {
    const root = await makeProject({ 'src/math.js': SOURCE });
    const prepared = await preparePatch(FIX_ADD, policy(root));
    expect(prepared).toMatchObject({ added: 1, removed: 1 });
    expect(prepared.diff).toContain('@@ -1,3 +1,3 @@');
    expect(await read(root, 'src/math.js')).toBe(SOURCE);
    expect(renderPatchPreview(prepared, { color: false })).toBe(prepared.diff.trimEnd());
  });

  it.each([
    ['absolute paths', '/etc/passwd', 'UNSAFE_PATH'],
    ['windows drive paths', 'C:\\Windows\\win.ini', 'UNSAFE_PATH'],
    ['traversal', 'src/../../outside.js', 'UNSAFE_PATH'],
    ['.git internals', '.git/config', 'PROTECTED_PATH'],
    ['dependencies', 'node_modules/lib/index.js', 'PROTECTED_PATH'],
  ])('rejects %s', (_label, target, code) => {
    expect(() => resolveSafePath('/repo', target)).toThrowError(expect.objectContaining({ code }));
  });

  it.each(['package-lock.json', '.env', '.env.production', 'certs/server.key'])('protects %s', async (file) => {
    const root = await makeProject({ [file]: 'x\n' });
    await expectPatchError(preparePatch(`--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-x\n+y\n`, policy(root)), 'PROTECTED_PATH');
  });

  it('protects test files unless test edits are allowed', async () => {
    const root = await makeProject({ 'test/a.test.js': 'x\n' });
    const diff = '--- a/test/a.test.js\n+++ b/test/a.test.js\n@@ -1 +1 @@\n-x\n+y\n';
    await expectPatchError(preparePatch(diff, policy(root)), 'PROTECTED_PATH');
    await expect(preparePatch(diff, policy(root, { allowTestEdits: true }))).resolves.toMatchObject({ added: 1 });
  });

  it('enforces file and line limits', async () => {
    const root = await makeProject({ 'a.js': 'x\n', 'b.js': 'x\n' });
    const two = '--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-x\n+y\n--- a/b.js\n+++ b/b.js\n@@ -1 +1 @@\n-x\n+y\n';
    await expectPatchError(preparePatch(two, policy(root, { maxFiles: 1 })), 'LIMIT_EXCEEDED');
    await expectPatchError(preparePatch(two, policy(root, { maxChangedLines: 3 })), 'LIMIT_EXCEEDED');
  });

  it('refuses files that changed since the model read them', async () => {
    const root = await makeProject({ 'src/math.js': SOURCE });
    const hashes = new Map([['src/math.js', sha256Of('stale view')]]);
    await expectPatchError(preparePatch(FIX_ADD, policy(root, { expectedHashes: hashes })), 'STALE_FILE');
  });

  it('refuses to follow symlinks out of the project', async () => {
    const outside = await makeProject({ 'secret.js': 'x\n' });
    const root = await makeProject();
    await symlink(outside, path.join(root, 'linked'));
    await expectPatchError(preparePatch('--- a/linked/secret.js\n+++ b/linked/secret.js\n@@ -1 +1 @@\n-x\n+y\n', policy(root)), 'UNSAFE_PATH');
  });

  it('handles creation, and rejects deletes, renames and no-ops', async () => {
    const root = await makeProject({ 'src/math.js': SOURCE });
    const created = await preparePatch('--- /dev/null\n+++ b/src/new/util.js\n@@ -0,0 +1,2 @@\n+export const x = 1;\n+export const y = 2;\n', policy(root));
    expect(created.changes[0]).toMatchObject({ kind: 'create', after: 'export const x = 1;\nexport const y = 2;\n' });

    await expectPatchError(preparePatch('--- /dev/null\n+++ b/src/math.js\n@@ -0,0 +1 @@\n+x\n', policy(root)), 'FILE_EXISTS');
    await expectPatchError(preparePatch('--- a/src/missing.js\n+++ b/src/missing.js\n@@ -1 +1 @@\n-x\n+y\n', policy(root)), 'FILE_NOT_FOUND');
    await expectPatchError(preparePatch('--- a/src/math.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n', policy(root)), 'PROTECTED_PATH');
    await expectPatchError(preparePatch('--- a/src/math.js\n+++ b/src/other.js\n@@ -1 +1 @@\n-x\n+y\n', policy(root)), 'UNSUPPORTED');
    await expectPatchError(preparePatch('--- a/src/math.js\n+++ b/src/math.js\n@@ -1,2 +1,2 @@\n function add(a, b) {\n-  return a - b;\n+  return a - b;\n', policy(root)), 'NO_OP');
  });

  it('rejects binary and non-UTF-8 files', async () => {
    const root = await makeProject();
    await writeFile(path.join(root, 'img.js'), Buffer.from([0x61, 0x00, 0x62, 0x0a]));
    await writeFile(path.join(root, 'latin1.js'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    await expectPatchError(preparePatch('--- a/img.js\n+++ b/img.js\n@@ -1 +1 @@\n-a\n+b\n', policy(root)), 'BINARY');
    await expectPatchError(preparePatch('--- a/latin1.js\n+++ b/latin1.js\n@@ -1 +1 @@\n-x\n+y\n', policy(root)), 'BINARY');
  });
});

describe('commitPatch', () => {
  it('writes atomically, preserves permissions, and rolls back', async () => {
    const root = await makeProject({ 'src/math.js': SOURCE });
    const file = path.join(root, 'src/math.js');
    await chmod(file, 0o755);
    const before = await snapshotTree(root);

    const diff = `${FIX_ADD}--- /dev/null\n+++ b/src/deep/new/helper.js\n@@ -0,0 +1 @@\n+export const helper = true;\n`;
    const transaction = await commitPatch(await preparePatch(diff, policy(root)));
    expect(await read(root, 'src/math.js')).toContain('return a + b');
    expect(await read(root, 'src/deep/new/helper.js')).toBe('export const helper = true;\n');
    expect((await stat(file)).mode & 0o777).toBe(0o755);

    await transaction.rollback();
    await transaction.rollback(); // idempotent
    expect(await snapshotTree(root)).toEqual(before);
    await expect(stat(path.join(root, 'src/deep'))).rejects.toThrow(); // created dirs removed
    expect((await stat(file)).mode & 0o777).toBe(0o755);
  });

  it('detects modifications between prepare and commit (TOCTOU)', async () => {
    const root = await makeProject({ 'src/math.js': SOURCE });
    const prepared = await preparePatch(FIX_ADD, policy(root));
    await writeFile(path.join(root, 'src/math.js'), `${SOURCE}// edited by a human\n`);
    await expectPatchError(commitPatch(prepared), 'STALE_FILE');
    expect(await read(root, 'src/math.js')).toContain('edited by a human');
  });

  it('rolls back already-written files when a later write fails', async () => {
    // A 245-char basename is a legal file name, but the patcher's temp file for it
    // (".<name>.devmedic-<pid>-<rand>.tmp") exceeds NAME_MAX (255), so the second write fails
    // with ENAMETOOLONG — for every user, including root.
    const longName = `${'x'.repeat(242)}.js`;
    const root = await makeProject({ 'a.js': 'x\n', [longName]: 'x\n' });
    const prepared = await preparePatch(
      `--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-x\n+y\n--- a/${longName}\n+++ b/${longName}\n@@ -1 +1 @@\n-x\n+y\n`,
      policy(root),
    );
    const error = await expectPatchError(commitPatch(prepared), 'WRITE_FAILED');
    expect(error.message).toMatch(/ENAMETOOLONG|name too long/i);
    expect(await readFile(path.join(root, 'a.js'), 'utf8')).toBe('x\n');
    expect(await readFile(path.join(root, longName), 'utf8')).toBe('x\n');
  });
});

describe('fingerprints', () => {
  it('identifies the same edit regardless of hunk headers and context', () => {
    const terse = '--- a/src/math.js\n+++ b/src/math.js\n@@ -2 +2 @@\n-  return a - b;\n+  return a + b;\n';
    expect(fingerprintDiffText(terse)).toBe(fingerprintDiffText(FIX_ADD));
    expect(fingerprintDiffText(FIX_ADD.replace('a + b', 'b + a'))).not.toBe(fingerprintDiffText(FIX_ADD));
    expect(fingerprintDiffText('not a diff')).toBeUndefined();
  });

  it('gives identical resulting states the same state fingerprint', async () => {
    const root = await makeProject({ 'src/math.js': SOURCE });
    const terse = '--- a/src/math.js\n+++ b/src/math.js\n@@ -2 +2 @@\n-  return a - b;\n+  return a + b;\n';
    const [a, b] = await Promise.all([preparePatch(FIX_ADD, policy(root)), preparePatch(terse, policy(root))]);
    expect(a.stateFingerprint).toBe(b.stateFingerprint);
  });
});

describe('path helper', () => {
  it('normalizes to POSIX relative paths', async () => {
    const root = await makeProject();
    await mkdir(path.join(root, 'src'), { recursive: true });
    expect(resolveSafePath(root, 'src/./x/../math.js').relativePath).toBe('src/math.js');
  });
});
