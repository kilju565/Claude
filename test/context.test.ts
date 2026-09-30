import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeFailure } from '../src/analyzer.js';
import { extractRelativeImports, gatherContext, resolveImport, sha256Of } from '../src/context.js';
import { makeProject } from './helpers.js';

describe('extractRelativeImports', () => {
  it('finds static, type-only, multi-line, re-export, dynamic and require specifiers', () => {
    const source = `
      import def from './a';
      import type { T } from "../types.js";
      import {
        x,
        y,
      } from './multi';
      import './side-effect.js';
      export * from './re';
      export { z } from './named';
      const r = require('./cjs');
      const d = await import('./dyn.js');
      import pkg from 'lodash';
      import fs from 'node:fs';
    `;
    expect(extractRelativeImports(source).sort()).toEqual(
      ['../types.js', './a', './cjs', './dyn.js', './multi', './named', './re', './side-effect.js'].sort(),
    );
  });
});

describe('resolveImport', () => {
  it('maps TS NodeNext ".js" specifiers to ".ts" sources and resolves index files', async () => {
    const root = await makeProject({ 'src/a.ts': '', 'src/lib/index.ts': '', 'src/main.ts': '' });
    const importer = path.join(root, 'src/main.ts');
    expect(await resolveImport(importer, './a.js', root)).toBe(path.join(root, 'src/a.ts'));
    expect(await resolveImport(importer, './lib', root)).toBe(path.join(root, 'src/lib/index.ts'));
    expect(await resolveImport(importer, './missing', root)).toBeUndefined();
    expect(await resolveImport(importer, '../../outside', root)).toBeUndefined();
  });
});

describe('gatherContext', () => {
  const failingOutput = (root: string) =>
    [
      'AssertionError [ERR_ASSERTION]: expected 3 to equal 4',
      `    at TestContext.<anonymous> (${path.join(root, 'test/app.test.ts')}:5:10)`,
      '# fail 1',
    ].join('\n');

  it('follows the failing test’s imports transitively and records content hashes', async () => {
    const root = await makeProject({
      'test/app.test.ts': "import { run } from '../src/app.js';\nimport { helper } from './helpers.js';\n",
      'test/helpers.ts': 'export const helper = 1;\n',
      'src/app.ts': "import { add } from './math.js';\nexport const run = () => add(1, 2);\n",
      'src/math.ts': "import { deep } from './deep.js';\nexport const add = (a: number, b: number) => a + b + deep;\n",
      'src/deep.ts': 'export const deep = 0;\n',
    });
    const analysis = analyzeFailure({ output: failingOutput(root), exitCode: 1 }, { projectRoot: root });
    const context = await gatherContext(analysis, { projectRoot: root, maxFiles: 10, maxFileBytes: 10_000 });

    expect(context.files.map((f) => [f.relativePath, f.role])).toEqual([
      ['test/app.test.ts', 'test'],
      ['src/app.ts', 'source'],
      ['src/math.ts', 'source'],
    ]); // depth 2 by default: src/deep.ts (depth 3) and test helpers are excluded
    expect(context.files[1]?.reasons[0]).toBe('imported by test/app.test.ts');
    expect(context.hashes.get('src/app.ts')).toBe(sha256Of("import { add } from './math.js';\nexport const run = () => add(1, 2);\n"));
  });

  it('respects the file limit and excerpts large files around implicated lines', async () => {
    const big = Array.from({ length: 2000 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n');
    const root = await makeProject({ 'src/big.ts': big, 'src/other.ts': 'x\n' });
    const output = [
      'TypeError: boom',
      `    at explode (${path.join(root, 'src/big.ts')}:1500:3)`,
      `    at caller (${path.join(root, 'src/other.ts')}:1:1)`,
    ].join('\n');
    const analysis = analyzeFailure({ output, exitCode: 1 }, { projectRoot: root });
    const context = await gatherContext(analysis, { projectRoot: root, maxFiles: 1, maxFileBytes: 4_000 });

    expect(context.files).toHaveLength(1);
    const file = context.files[0];
    expect(file?.truncated).toBe(true);
    expect(file?.segments[0]?.startLine).toBeLessThanOrEqual(1500);
    expect(file?.segments.flatMap((s) => s.lines)).toContain('const line1500 = 1500;');
    expect(context.skipped).toContainEqual({ path: 'src/other.ts', reason: 'context limit of 1 files reached' });
  });

  it('skips binary files', async () => {
    const root = await makeProject();
    await writeFile(path.join(root, 'blob.js'), Buffer.from([1, 0, 2]));
    const analysis = analyzeFailure(
      { output: `Error: x\n    at f (${path.join(root, 'blob.js')}:1:1)`, exitCode: 1 },
      { projectRoot: root },
    );
    const context = await gatherContext(analysis, { projectRoot: root, maxFiles: 5, maxFileBytes: 1000 });
    expect(context.files).toHaveLength(0);
    expect(context.skipped[0]?.reason).toBe('binary file');
  });
});
