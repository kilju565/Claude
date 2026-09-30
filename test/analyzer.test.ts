import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyzeFailure,
  extractFailedTestCount,
  isTestFilePath,
  normalizeOutput,
  resolveLocation,
  stripAnsi,
} from '../src/analyzer.js';

const ROOT = path.resolve('/repo');
/** Every path under /repo "exists" unless listed as missing. */
const existsUnder =
  (...missing: string[]) =>
  (absolutePath: string): boolean =>
    absolutePath.startsWith(ROOT + path.sep) && !missing.some((m) => absolutePath === path.join(ROOT, m));

function analyze(output: string, fileExists = existsUnder()) {
  return analyzeFailure({ output, exitCode: 1 }, { projectRoot: ROOT, fileExists });
}

// Captured from `node --test` (Node 22, non-TTY → TAP reporter).
const NODE_TAP = `TAP version 13
# Subtest: adds numbers
not ok 1 - adds numbers
  ---
  duration_ms: 1.097147
  type: 'test'
  location: '/repo/test/calc.test.js:5:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:

    -1 !== 5

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 5
  actual: -1
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///repo/test/calc.test.js:6:10)
    Test.runInAsyncScope (node:async_hooks:214:14)
    Test.run (node:internal/test_runner/test:1047:25)
  ...
# Subtest: explodes
not ok 2 - explodes
  ---
  duration_ms: 0.103947
  type: 'test'
  location: '/repo/test/calc.test.js:8:1'
  failureType: 'testCodeFailure'
  error: "Cannot read properties of undefined (reading 'length')"
  code: 'ERR_TEST_FAILURE'
  name: 'TypeError'
  stack: |-
    explode (file:///repo/src/calc.js:5:18)
    TestContext.<anonymous> (file:///repo/test/calc.test.js:9:3)
    Test.runInAsyncScope (node:async_hooks:214:14)
  ...
1..2
# tests 2
# pass 0
# fail 2
`;

// Captured from `node --test --test-reporter=spec`.
const NODE_SPEC = `✖ explodes (0.102559ms)
ℹ tests 1
ℹ fail 1

✖ failing tests:

test at test/calc.test.js:8:1
✖ explodes (0.102559ms)
  TypeError: Cannot read properties of undefined (reading 'length')
      at explode (file:///repo/src/calc.js:5:18)
      at TestContext.<anonymous> (file:///repo/test/calc.test.js:9:3)
      at Test.runInAsyncScope (node:async_hooks:214:14)
      at Test.run (node:internal/test_runner/test:1047:25)
`;

// Captured from `vitest run` (v5).
const VITEST = `
 ❯ test/calc.test.ts (2 tests | 2 failed) 7ms
   ❯ calc (2)
     × adds numbers 5ms
     × explodes 1ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/calc.test.ts > calc > adds numbers
AssertionError: expected -1 to be 5 // Object.is equality

- Expected
+ Received

- 5
+ -1

 ❯ test/calc.test.ts:6:23
      4| describe('calc', () => {
      5|   it('adds numbers', () => {
      6|     expect(add(2, 3)).toBe(5);
       |                       ^
      7|   });

 FAIL  test/calc.test.ts > calc > explodes
TypeError: Cannot read properties of undefined (reading 'length')
 ❯ explode src/calc.ts:5:19
      3| }
      4| export function explode(o: { value?: string }): number {
      5|   return o.value!.length;
       |                   ^
 ❯ test/calc.test.ts:9:5

 Test Files  1 failed (1)
      Tests  2 failed (2)
`;

const JEST = `FAIL test/orders.test.ts
  orders › totals
    ● orders › totals › sums line items

    expect(received).toBe(expected) // Object.is equality

    Expected: 30
    Received: 20

      10 |   it('sums line items', () => {
    > 11 |     expect(total(order)).toBe(30);
         |                          ^
      12 |   });

      at Object.<anonymous> (test/orders.test.ts:11:26)
      at Promise.then.completed (node_modules/jest-circus/build/utils.js:298:28)

Tests:       1 failed, 4 passed, 5 total
`;

describe('normalization', () => {
  it('strips ANSI colors and OSC-8 hyperlinks', () => {
    const colored = '\u001b[31mFAIL\u001b[39m \u001b]8;;file:///repo/a.ts\u0007a.ts\u001b]8;;\u0007 \u001b[2K';
    expect(stripAnsi(colored)).toBe('FAIL a.ts ');
  });

  it('keeps only the last carriage-return overwrite of a line', () => {
    expect(normalizeOutput('progress 10%\rprogress 100%\r\ndone\r\n')).toEqual(['progress 100%', 'done', '']);
  });
});

describe('node:test (TAP)', () => {
  const result = analyze(NODE_TAP);

  it('parses bare TAP stack frames and ranks the source file at the throw site', () => {
    expect(result.sourceFiles.map((f) => f.relativePath)).toEqual(['src/calc.js']);
    expect(result.sourceFiles[0]?.lines).toContain(5);
    expect(result.testFiles[0]?.relativePath).toBe('test/calc.test.js');
  });

  it('drops node internals', () => {
    expect(result.frames.every((f) => !f.relativePath.includes('internal'))).toBe(true);
  });

  it('extracts the YAML error block, type, names and count', () => {
    expect(result.errorType).toBe('AssertionError');
    expect(result.errorMessage).toContain('-1 !== 5');
    expect(result.summary).toContain('Expected values to be strictly equal: -1 !== 5');
    expect(result.failingTests).toEqual(['adds numbers', 'explodes']);
    expect(result.failedTestCount).toBe(2);
  });
});

describe('node:test (spec reporter)', () => {
  it('parses V8 frames with file:// URLs', () => {
    const result = analyze(NODE_SPEC);
    expect(result.errorType).toBe('TypeError');
    expect(result.sourceFiles[0]).toMatchObject({ relativePath: 'src/calc.js', lines: [5] });
    expect(result.frames[0]).toMatchObject({ source: 'node-test', relativePath: 'test/calc.test.js', line: 8 });
    expect(result.frames.find((f) => f.relativePath === 'src/calc.js')?.functionName).toBe('explode');
    expect(result.failingTests).toContain('explodes');
    expect(result.failedTestCount).toBe(1);
  });
});

describe('vitest', () => {
  const result = analyze(VITEST);

  it('parses ❯ pointers with and without function names', () => {
    expect(result.sourceFiles[0]).toMatchObject({ relativePath: 'src/calc.ts', lines: [5] });
    expect(result.testFiles[0]?.relativePath).toBe('test/calc.test.ts');
    expect(result.frames.find((f) => f.relativePath === 'src/calc.ts')?.functionName).toBe('explode');
  });

  it('reads the assertion, the FAIL headers and the Tests summary', () => {
    expect(result.errorType).toBe('AssertionError');
    expect(result.errorMessage).toBe('expected -1 to be 5 // Object.is equality');
    expect(result.errorExcerpt).toContain('+ -1');
    expect(result.failingTests).toContain('calc > adds numbers');
    expect(result.failedTestCount).toBe(2);
  });
});

describe('jest', () => {
  it('uses the matcher block as the error and skips node_modules frames', () => {
    const result = analyze(JEST);
    expect(result.errorType).toBe('AssertionError');
    expect(result.errorExcerpt).toContain('Expected: 30');
    expect(result.errorExcerpt).toContain('Received: 20');
    expect(result.testFiles[0]?.relativePath).toBe('test/orders.test.ts');
    expect(result.frames.some((f) => f.relativePath.includes('node_modules'))).toBe(false);
    expect(result.failingTests[0]).toBe('orders › totals › sums line items');
    expect(result.failedTestCount).toBe(1);
  });
});

describe('typescript diagnostics', () => {
  it('treats compile errors as the primary, highest-weighted evidence', () => {
    const output = [
      "src/api/user.ts(14,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/api/order.ts:3:1 - error TS2304: Cannot find name 'Foo'.",
      '    at Object.<anonymous> (/repo/src/other.ts:1:1)',
    ].join('\n');
    const result = analyze(output);
    expect(result.errorType).toBe('TypeScriptError');
    expect(result.errorMessage).toContain('TS2322');
    expect(result.sourceFiles.map((f) => f.relativePath).slice(0, 2)).toEqual(['src/api/user.ts', 'src/api/order.ts']);
    expect(result.sourceFiles[0]?.lines).toEqual([14]);
  });
});

describe('python tracebacks', () => {
  it('reverses outermost-first frames so the raise site ranks first', () => {
    const output = [
      'Traceback (most recent call last):',
      '  File "/repo/app/main.py", line 10, in <module>',
      '    run()',
      '  File "/repo/app/service.py", line 42, in run',
      '    raise ValueError("bad input")',
      'ValueError: bad input',
    ].join('\n');
    const result = analyze(output);
    expect(result.errorType).toBe('ValueError');
    expect(result.sourceFiles.map((f) => f.relativePath)).toEqual(['app/service.py', 'app/main.py']);
  });
});

describe('location resolution', () => {
  it('rejects internals, dependencies and paths outside the project', () => {
    const exists = existsUnder();
    expect(resolveLocation('node:internal/process/task_queues', ROOT, exists)).toBeUndefined();
    expect(resolveLocation('/repo/node_modules/lib/index.js', ROOT, exists)).toBeUndefined();
    expect(resolveLocation('/elsewhere/file.js', ROOT, exists)).toBeUndefined();
    expect(resolveLocation('<anonymous>', ROOT, exists)).toBeUndefined();
  });

  it('normalizes file:// URLs, webpack URLs and cache busters', () => {
    const exists = existsUnder();
    expect(resolveLocation('file:///repo/src/a.mjs', ROOT, exists)?.relativePath).toBe('src/a.mjs');
    expect(resolveLocation('webpack://my-app/./src/a.ts', ROOT, exists)?.relativePath).toBe('src/a.ts');
    expect(resolveLocation('/repo/src/a.ts?v=12ab', ROOT, exists)?.relativePath).toBe('src/a.ts');
  });

  it('maps compiled dist/ output back to TypeScript sources', () => {
    const resolved = resolveLocation('/repo/dist/services/user.js', ROOT, existsUnder('dist/services/user.js'));
    expect(resolved).toMatchObject({ relativePath: 'src/services/user.ts', mappedFrom: 'dist/services/user.js' });
  });

  it('keeps parentheses and spaces inside paths', () => {
    const result = analyze('    at Page (/repo/app/(auth)/my page.tsx:3:9)');
    expect(result.sourceFiles[0]?.relativePath).toBe('app/(auth)/my page.tsx');
  });
});

describe('signature and log excerpt', () => {
  it('ignores line shifts and timings but not assertion values', () => {
    const base = analyze('Error: expected 4 to be 5 (12ms)\n    at run (/repo/src/a.ts:10:3)');
    const shifted = analyze('Error: expected 4 to be 5 (40ms)\n    at run (/repo/src/a.ts:11:3)');
    const moved = analyze('Error: expected 3 to be 5 (12ms)\n    at run (/repo/src/a.ts:10:3)');
    expect(shifted.signature).toBe(base.signature);
    expect(moved.signature).not.toBe(base.signature);
  });

  it('collapses internal frames and bounds the size', () => {
    const internal = Array.from({ length: 50 }, (_, i) => `    at fn${i} (node:internal/mod:${i}:1)`).join('\n');
    const result = analyze(`Error: boom\n    at run (/repo/src/a.ts:1:1)\n${internal}`);
    expect(result.relevantLog).toContain('50 internal/dependency frame(s) omitted');

    const noisy = Array.from({ length: 5000 }, (_, i) => `log line ${i}`).join('\n');
    const big = analyzeFailure(
      { output: `${noisy}\nTypeError: late failure\n${noisy}`, exitCode: 1 },
      { projectRoot: ROOT, fileExists: existsUnder(), maxLogChars: 4000 },
    );
    expect(big.relevantLog.length).toBeLessThanOrEqual(4100);
    expect(big.relevantLog).toContain('TypeError: late failure');
  });

  it('falls back to the exit code when nothing is recognizable', () => {
    const result = analyzeFailure({ output: 'something went sideways', exitCode: 3 }, { projectRoot: ROOT, fileExists: existsUnder() });
    expect(result.errorType).toBe('TestFailure');
    expect(result.errorMessage).toBe('Test command exited with code 3');
    expect(result.notes).toContain('No stack frame pointed at a project file.');
  });
});

describe('helpers', () => {
  it('recognizes test files across conventions', () => {
    for (const p of ['test/a.js', 'src/__tests__/a.ts', 'a.test.ts', 'b.spec.tsx', 'c.integration.test.mjs', 'tests/test_api.py', 'x_test.go']) {
      expect(isTestFilePath(p), p).toBe(true);
    }
    for (const p of ['src/testing-utils.ts', 'src/contest.ts', 'lib/latest.js']) {
      expect(isTestFilePath(p), p).toBe(false);
    }
  });

  it('parses failure counts from all supported runners', () => {
    expect(extractFailedTestCount('Tests:       2 failed, 1 skipped, 3 passed, 6 total')).toBe(2);
    expect(extractFailedTestCount('      Tests  1 failed | 4 passed (5)')).toBe(1);
    expect(extractFailedTestCount('# fail 3')).toBe(3);
    expect(extractFailedTestCount('ℹ fail 4')).toBe(4);
    expect(extractFailedTestCount('  5 passing\n  2 failing')).toBe(2);
    expect(extractFailedTestCount('===== 1 failed, 2 passed in 0.10s =====')).toBe(1);
    expect(extractFailedTestCount('no summary here')).toBeUndefined();
  });
});
