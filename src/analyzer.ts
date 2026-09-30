/**
 * analyzer.ts — turns raw test-runner output into a structured diagnosis.
 *
 * Responsibilities:
 *   1. Normalize output (strip ANSI escapes, resolve carriage-return overwrites).
 *   2. Extract stack frames / file locations from every format we know (V8, node:test TAP,
 *      Vitest, Jest, tsc, Python) and keep only frames that point at real project files.
 *   3. Rank implicated files: failing test files vs. originating source files.
 *   4. Extract the primary error, failing test names and the failing-test count.
 *   5. Produce a stable failure signature (used by the agent's memory to detect progress)
 *      and a size-bounded excerpt of the log for the LLM prompt.
 *
 * Everything here is a pure function of (output text, project root, file-existence check),
 * which keeps the parser unit-testable against captured fixtures.
 */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecutionResult } from './executor.js';

// ─────────────────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────────────────

export type FrameSource = 'v8' | 'tap' | 'vitest' | 'node-test' | 'tsc' | 'python' | 'generic';

export interface StackFrame {
  /** POSIX-style path relative to the project root. */
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly line: number;
  readonly column?: number;
  readonly functionName?: string;
  readonly source: FrameSource;
  readonly isTestFile: boolean;
  /** Which stack trace (block of consecutive frames) the frame belongs to. */
  readonly traceIndex: number;
  /** Position among the *project* frames of its trace; 0 = closest to the throw site. */
  readonly depth: number;
  /** Set when a compiled-output path (dist/…) was mapped back to its TypeScript source. */
  readonly mappedFrom?: string;
}

export interface RankedFile {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly score: number;
  /** Implicated line numbers, most relevant first. */
  readonly lines: readonly number[];
  readonly reasons: readonly string[];
}

export interface FailureAnalysis {
  readonly errorType: string;
  readonly errorMessage: string;
  /** The error header plus the assertion diff / details that follow it. */
  readonly errorExcerpt: string;
  readonly failingTests: readonly string[];
  /** Parsed from the runner's summary line; undefined when no known summary was found. */
  readonly failedTestCount?: number;
  readonly testFiles: readonly RankedFile[];
  readonly sourceFiles: readonly RankedFile[];
  readonly frames: readonly StackFrame[];
  /** Stable fingerprint of *what* is failing (not where exactly), e.g. to detect progress. */
  readonly signature: string;
  /** One-line human-readable description. */
  readonly summary: string;
  /** ANSI-free, noise-reduced, size-bounded log excerpt for the LLM. */
  readonly relevantLog: string;
  readonly notes: readonly string[];
}

export interface AnalyzeOptions {
  readonly projectRoot: string;
  /** Injected for tests; defaults to a synchronous "is a regular file" check. */
  readonly fileExists?: (absolutePath: string) => boolean;
  readonly maxLogChars?: number;
}

type AnalyzableRun = Pick<ExecutionResult, 'output' | 'exitCode'> &
  Partial<Pick<ExecutionResult, 'timedOut' | 'outputTruncated'>>;

// ─────────────────────────────────────────────────────────────────────────────────────────
// Patterns
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * ANSI escape sequences. Test runners colorize output even when asked not to, and Vitest
 * emits OSC-8 terminal hyperlinks around file paths.
 *   (?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]       CSI: ESC[ (or 8-bit CSI) + parameter bytes 0x30–0x3F
 *                                              + intermediate bytes 0x20–0x2F + one final byte 0x40–0x7E
 *                                              e.g. "\x1b[31m", "\x1b[2K", "\x1b[?25l"
 *   \u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\) OSC: ESC] … terminated by BEL or ST (ESC \), e.g. hyperlinks
 *   \u001B[@-Z\\-_]                            Two-byte Fe escapes (ESC M, ESC 7, …)
 */
const ANSI_PATTERN =
  /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]/g;

/**
 * V8 frame WITH a function name:
 *   "    at Object.<anonymous> (/repo/src/a.ts:12:5)"
 *   "    at async handler (file:///repo/src/a.mjs:3:9)"
 *   "    at new Service (C:\\repo\\src\\service.ts:40:11)"
 * `fn` is lazy so it stops at the FIRST " (" that lets the rest match; `loc` is greedy so it
 * runs up to the LAST ":<line>:<col>)". That keeps Windows drive colons ("C:\") and parentheses
 * inside paths (Next.js route groups like "app/(auth)/page.tsx") inside the location.
 */
const V8_NAMED_FRAME = /^\s*at\s+(?<fn>.+?)\s+\((?<loc>.+):(?<line>\d+):(?<col>\d+)\)\s*$/;

/**
 * V8 frame WITHOUT a function name (top-level module code, anonymous callbacks):
 *   "    at /repo/src/a.ts:12:5"      "    at async file:///repo/a.mjs:3:1"
 * The lazy `loc` + end anchor means the location ends at the last ":<line>:<col>".
 */
const V8_ANON_FRAME = /^\s*at\s+(?:async\s+)?(?<loc>\S.*?):(?<line>\d+):(?<col>\d+)\s*$/;

/**
 * node:test TAP reporter prints stacks inside a YAML block scalar and drops the "at " prefix:
 *     stack: |-
 *       TestContext.<anonymous> (file:///repo/test/a.test.js:6:10)
 * This pattern is only applied to lines *inside* such a "stack:" block (see extractFrames),
 * otherwise "word (something:1:2)" prose would be mistaken for a frame.
 */
const TAP_STACK_FRAME = /^\s*(?<fn>[^\s(][^(]*?)\s+\((?<loc>.+):(?<line>\d+):(?<col>\d+)\)\s*$/;
const TAP_STACK_START = /^(?<indent>\s*)stack:\s*[|>][-+]?\s*$/;

/**
 * Vitest code-frame pointer, optionally preceded by the function name:
 *   " ❯ test/calc.test.ts:6:23"          " ❯ explode src/calc.ts:5:19"
 * The optional `fn` group is tried first; when the token is actually the location it fails
 * (nothing follows) and the regex backtracks to treat it as `loc`.
 */
const VITEST_FRAME = /^\s*(?:❯|→)\s+(?:(?<fn>\S+)\s+)?(?<loc>\S+?):(?<line>\d+):(?<col>\d+)\s*$/;

/**
 * node:test test-declaration locations:
 *   TAP  : "  location: '/repo/test/a.test.js:5:1'"
 *   spec : "test at test/a.test.js:5:1"
 */
const NODE_TEST_LOCATION = /^\s*(?:location:\s*['"]?|test at\s+)(?<loc>.+?):(?<line>\d+):(?<col>\d+)['"]?\s*$/;

/**
 * TypeScript compiler diagnostics (tsc, ts-jest, ts-node), classic and --pretty styles:
 *   "src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'."
 *   "src/a.ts:12:5 - error TS2322: Type 'string' is not assignable to type 'number'."
 * Two alternative (line, col) group pairs because JS forbids duplicate group names here.
 */
const TSC_DIAGNOSTIC =
  /^\s*(?<loc>(?:[A-Za-z]:)?[^\s:()][^:()]*?\.[cm]?[jt]sx?)(?:\((?<line>\d+),(?<col>\d+)\)|:(?<line2>\d+):(?<col2>\d+))\s*[:-]\s*error\s+(?<code>TS\d+):\s*(?<message>.*)$/;

/**
 * Python traceback frame: '  File "/repo/app/x.py", line 12, in handler'.
 * Python prints frames outermost-first ("most recent call last") — the opposite of V8 —
 * so each traceback's frames are buffered and reversed before ranking.
 */
const PYTHON_FRAME = /^\s*File\s+"(?<loc>[^"]+)",\s+line\s+(?<line>\d+)(?:,\s+in\s+(?<fn>.+?))?\s*$/;

/**
 * Last-resort "path/to/file.ext:line[:col]" anywhere in a line (custom reporters, lint-style
 * output). Only used when no structured frame was found at all.
 */
const GENERIC_LOCATION =
  /(?<loc>(?:[A-Za-z]:[\\/]|\/)?(?:[\w.@$~-]+[\\/])*[\w@$.-]+\.(?:[cm]?[jt]sx?|vue|svelte|py|rb|go|rs|java|kt)):(?<line>\d+)(?::(?<col>\d+))?/g;

/**
 * Error headers:
 *   "TypeError: Cannot read properties of undefined (reading 'x')"
 *   "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:"
 *   "Uncaught Error: boom"          "ValueError: invalid literal" (Python)
 * Requires a capitalized *Error/*Exception identifier immediately followed by ":" (optionally
 * with a bracketed Node error code), which rules out npm's lowercase "npm error …" noise.
 */
const ERROR_HEADER =
  /^\s*(?:Uncaught\s+)?(?<type>[A-Z][\w$]*(?:Error|Exception)|Error)(?:\s*\[(?<code>[\w-]+)\])?:\s*(?<message>.*\S)?\s*$/;

/** Jest matcher header: "expect(received).toBe(expected) // Object.is equality". */
const JEST_MATCHER = /^\s*expect\((?:received|jest\.fn\(\)|spy)\)\.(?:(?:not|resolves|rejects)\.)*\w+\(.*\)/;

/** node:test TAP YAML "error:" key, either inline ('msg') or a block scalar (|-). */
const TAP_ERROR = /^(?<indent>\s*)error:\s*(?<value>.*)$/;
const TAP_ERROR_NAME = /^\s*name:\s*['"]?(?<name>[\w$]+)['"]?\s*$/;

/** Jest/Vitest code frames ("  > 6 |   expect(…)", "    |   ^") — they don't end a stack trace. */
const CODE_FRAME_LINE = /^\s*(?:>?\s*\d+\s*\||\|)/;

/** Test-runner "this file failed" headers: Jest "FAIL src/a.test.ts", Vitest " FAIL  test/a.test.ts > suite". */
const FAIL_HEADER = /^\s*FAIL\s+(?<file>[^\s>]+\.[cm]?[jt]sx?)\b/;
/** pytest short summary: "FAILED tests/test_api.py::test_create - AssertionError". */
const PYTEST_FAILED = /^FAILED\s+(?<file>[^\s:]+\.py)::(?<name>\S+)/;

/** Failing test names across runners. */
const FAILING_TEST_PATTERNS: readonly RegExp[] = [
  /^\s*●\s+(?!Test suite failed to run|Console\b)(?<name>.+?)\s*$/, // Jest "● Suite › test"
  /^\s*FAIL\s+\S+\s+>\s+(?<name>.+?)\s*$/, // Vitest "FAIL  file > suite > test"
  /^\s*not ok \d+ - (?<name>.+?)(?:\s+#.*)?$/, // TAP
  /^\s*[✖×✕]\s+(?!failing tests)(?<name>.+?)(?:\s+\(?\d+(?:\.\d+)?\s?m?s\)?)?\s*$/, // node spec / Vitest "× test 5ms"
  /^\s{2,}\d+\)\s+(?<name>.+?)\s*$/, // Mocha "  1) suite"
];

/**
 * Failing-test counts from summary lines. Every match of the first pattern that matches is
 * summed (multi-project runs print several summaries).
 *   Jest   : "Tests:       1 failed, 3 passed, 4 total"
 *   Vitest : "      Tests  2 failed | 5 passed (7)"
 *   node   : "# fail 2" (TAP) / "ℹ fail 2" (spec)
 *   Mocha  : "  2 failing"
 *   pytest : "===== 2 failed, 3 passed in 0.12s ====="
 */
const FAILED_COUNT_PATTERNS: readonly RegExp[] = [
  /^\s*Tests:?\s+(?:\d+\s+\w+\s*[,|]\s*)*?(\d+)\s+failed\b/gm,
  /^\s*(?:#|ℹ)\s*fail\s+(\d+)\s*$/gm,
  /^\s*(\d+)\s+failing\b/gm,
  /^=+ .*?\b(\d+)\s+failed\b.* =+\s*$/gm,
];

/** Frames that never point at user code. */
const NON_PROJECT_LOCATION = /^(?:node:|internal\/|native\b|<anonymous>|eval at|wasm:)|<anonymous>|\[native code\]/;

/** Test-file naming conventions across ecosystems. */
const TEST_FILE_PATTERN =
  /(?:^|\/)(?:__tests__|__test__|tests?|specs?|e2e|integration-tests?)\/|\.(?:test|spec|e2e|integration|int|itest)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|_test\.(?:py|go)$|-test\.[cm]?[jt]s$/;

/** Weight of a frame by the kind of evidence it represents. */
const SOURCE_WEIGHT: Readonly<Record<FrameSource, number>> = {
  tsc: 3, // a compile error is definitive
  v8: 1,
  tap: 1,
  vitest: 1,
  python: 1,
  'node-test': 0.5, // where the test is declared, not where it failed
  generic: 0.3,
};

const DEFAULT_MAX_LOG_CHARS = 12_000;

// ─────────────────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────────────────

export function analyzeFailure(run: AnalyzableRun, options: AnalyzeOptions): FailureAnalysis {
  const root = path.resolve(options.projectRoot);
  const fileExists = options.fileExists ?? isRegularFile;
  const lines = normalizeOutput(run.output);

  const frames = extractFrames(lines, root, fileExists);
  const failHeaders = extractFailHeaderFiles(lines, root, fileExists);
  const { testFiles, sourceFiles } = rankFiles(frames, failHeaders);
  const error = extractPrimaryError(lines, run.exitCode);
  const failingTests = extractFailingTestNames(lines);
  const failedTestCount = extractFailedTestCount(lines.join('\n'));

  const notes: string[] = [];
  if (run.timedOut) notes.push('The test command timed out and was killed.');
  if (run.outputTruncated) notes.push('Output exceeded the capture buffer and was truncated.');
  if (frames.length === 0) notes.push('No stack frame pointed at a project file.');

  const topSource = sourceFiles[0];
  const topTest = testFiles[0];
  const anchor = topSource ?? topTest;
  const summary =
    `${error.type}: ${truncate(headline(error.message), 160)}` +
    (anchor ? ` @ ${anchor.relativePath}${anchor.lines[0] ? `:${anchor.lines[0]}` : ''}` : '');

  return {
    errorType: error.type,
    errorMessage: error.message,
    errorExcerpt: error.excerpt,
    failingTests,
    failedTestCount,
    testFiles,
    sourceFiles,
    frames,
    signature: computeSignature(error.type, error.message, anchor?.relativePath, failingTests, root),
    summary,
    relevantLog: buildRelevantLog(lines, options.maxLogChars ?? DEFAULT_MAX_LOG_CHARS),
    notes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Normalization
// ─────────────────────────────────────────────────────────────────────────────────────────

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

export function normalizeOutput(raw: string): string[] {
  return stripAnsi(raw)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      // A bare "\r" means the terminal overwrote the line in place (spinners, progress bars):
      // keep only the text that was visible last, i.e. what follows the final "\r".
      const trimmed = line.replace(/\r+$/, '');
      const cr = trimmed.lastIndexOf('\r');
      return cr === -1 ? trimmed : trimmed.slice(cr + 1);
    });
}

export function isTestFilePath(relativePath: string): boolean {
  return TEST_FILE_PATTERN.test(relativePath.replace(/\\/g, '/'));
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Frame extraction
// ─────────────────────────────────────────────────────────────────────────────────────────

interface RawFrame {
  readonly location: string;
  readonly line: number;
  readonly column?: number;
  readonly functionName?: string;
  readonly source: FrameSource;
}

export function extractFrames(
  lines: readonly string[],
  root: string,
  fileExists: (absolutePath: string) => boolean,
): StackFrame[] {
  const frames: StackFrame[] = [];
  let traceIndex = -1;
  let depth = 0;
  let inTrace = false;
  let tapStackIndent = -1; // indentation of an open "stack: |-" key; -1 = not inside one
  let pythonBuffer: RawFrame[] = [];

  const startTrace = (): void => {
    traceIndex += 1;
    depth = 0;
  };
  const push = (raw: RawFrame): void => {
    const resolved = resolveLocation(raw.location, root, fileExists);
    if (!resolved) return; // node internals, node_modules, files outside the project, …
    frames.push({
      relativePath: resolved.relativePath,
      absolutePath: resolved.absolutePath,
      mappedFrom: resolved.mappedFrom,
      line: raw.line,
      column: raw.column,
      functionName: cleanFunctionName(raw.functionName),
      source: raw.source,
      isTestFile: isTestFilePath(resolved.relativePath),
      traceIndex,
      depth: depth++,
    });
  };
  const flushPython = (): void => {
    if (pythonBuffer.length === 0) return;
    startTrace();
    for (const raw of pythonBuffer.reverse()) push(raw);
    pythonBuffer = [];
  };

  for (const line of lines) {
    const indent = line.length - line.trimStart().length;

    // A YAML block scalar ends at the first non-empty line indented at or left of its key.
    if (tapStackIndent >= 0 && line.trim() !== '' && indent <= tapStackIndent) tapStackIndent = -1;
    const tapStart = TAP_STACK_START.exec(line);
    if (tapStart) {
      tapStackIndent = tapStart.groups?.['indent']?.length ?? 0;
      inTrace = false;
      continue;
    }

    const py = PYTHON_FRAME.exec(line);
    if (py?.groups) {
      pythonBuffer.push({
        location: py.groups['loc'] ?? '',
        line: Number(py.groups['line']),
        functionName: py.groups['fn'],
        source: 'python',
      });
      continue;
    }
    // Python code lines are indented; the next column-0 line ("ValueError: …") ends the traceback.
    if (pythonBuffer.length > 0 && /^\S/.test(line)) flushPython();

    const raw = matchFrame(line, tapStackIndent >= 0);
    if (raw) {
      // tsc diagnostics are independent locations, not frames of one stack.
      if (!inTrace || raw.source === 'tsc') startTrace();
      inTrace = raw.source !== 'tsc';
      push(raw);
    } else if (line.trim() !== '' && !CODE_FRAME_LINE.test(line)) {
      inTrace = false;
    }
  }
  flushPython();

  // Fallback: nothing structured matched — scan for bare "file.ext:line" references.
  if (frames.length === 0) {
    for (const line of lines) {
      for (const match of line.matchAll(GENERIC_LOCATION)) {
        if (!match.groups) continue;
        startTrace();
        push({
          location: match.groups['loc'] ?? '',
          line: Number(match.groups['line']),
          column: match.groups['col'] ? Number(match.groups['col']) : undefined,
          source: 'generic',
        });
      }
    }
  }
  return frames;
}

function matchFrame(line: string, insideTapStack: boolean): RawFrame | undefined {
  const named = V8_NAMED_FRAME.exec(line);
  if (named?.groups) return fromGroups(named.groups, 'v8');
  const anon = V8_ANON_FRAME.exec(line);
  if (anon?.groups) return fromGroups(anon.groups, 'v8');
  const vitest = VITEST_FRAME.exec(line);
  if (vitest?.groups) return fromGroups(vitest.groups, 'vitest');
  const nodeTest = NODE_TEST_LOCATION.exec(line);
  if (nodeTest?.groups) return fromGroups(nodeTest.groups, 'node-test');
  const tsc = TSC_DIAGNOSTIC.exec(line);
  if (tsc?.groups) {
    const g = tsc.groups;
    return {
      location: g['loc'] ?? '',
      line: Number(g['line'] ?? g['line2']),
      column: Number(g['col'] ?? g['col2']),
      source: 'tsc',
    };
  }
  if (insideTapStack) {
    const tap = TAP_STACK_FRAME.exec(line);
    if (tap?.groups) return fromGroups(tap.groups, 'tap');
  }
  return undefined;
}

function fromGroups(groups: Record<string, string | undefined>, source: FrameSource): RawFrame {
  return {
    location: groups['loc'] ?? '',
    line: Number(groups['line']),
    column: groups['col'] ? Number(groups['col']) : undefined,
    functionName: groups['fn'],
    source,
  };
}

function cleanFunctionName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const cleaned = name.replace(/^async\s+/, '').trim();
  return cleaned === '' || cleaned === '<anonymous>' ? undefined : cleaned;
}

interface ResolvedLocation {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly mappedFrom?: string;
}

/**
 * Maps a location string from a stack trace to a project file, or undefined when the frame
 * does not belong to the project (runtime internals, dependencies, files outside the root).
 */
export function resolveLocation(
  location: string,
  root: string,
  fileExists: (absolutePath: string) => boolean,
): ResolvedLocation | undefined {
  let loc = location.trim().replace(/^['"]|['"]$/g, '');
  if (loc === '' || NON_PROJECT_LOCATION.test(loc)) return undefined;

  // Bundler URLs: "webpack://my-app/./src/a.ts" → "./src/a.ts".
  loc = loc.replace(/^webpack(?:-internal)?:\/\/\/?[^/]*\//, '');
  // Dev-server cache busters: "/src/a.ts?v=123abc" → "/src/a.ts".
  loc = loc.replace(/\?[^/\\]*$/, '');
  if (loc.startsWith('file://')) {
    try {
      loc = fileURLToPath(loc);
    } catch {
      return undefined;
    }
  }

  const absolutePath = path.isAbsolute(loc) ? path.normalize(loc) : path.resolve(root, loc);
  const relative = path.relative(root, absolutePath);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return undefined; // outside the project
  }
  const relativePath = relative.split(path.sep).join('/');
  if (/(?:^|\/)node_modules\//.test(relativePath)) return undefined; // never patch dependencies

  if (fileExists(absolutePath)) return { absolutePath, relativePath };

  // Heuristic for compiled output without source maps: dist/foo/bar.js → src/foo/bar.ts.
  const compiled = /^(?:dist|build|out|lib)\/(?<rest>.+)\.(?:c|m)?js$/.exec(relativePath);
  const rest = compiled?.groups?.['rest'];
  if (rest) {
    for (const ext of ['.ts', '.tsx', '.mts', '.cts', '.js']) {
      const candidate = path.join(root, 'src', `${rest}${ext}`);
      if (fileExists(candidate)) {
        return { absolutePath: candidate, relativePath: `src/${rest}${ext}`, mappedFrom: relativePath };
      }
    }
  }
  return undefined;
}

function extractFailHeaderFiles(
  lines: readonly string[],
  root: string,
  fileExists: (absolutePath: string) => boolean,
): ResolvedLocation[] {
  const found = new Map<string, ResolvedLocation>();
  for (const line of lines) {
    const file = FAIL_HEADER.exec(line)?.groups?.['file'] ?? PYTEST_FAILED.exec(line)?.groups?.['file'];
    if (!file) continue;
    const resolved = resolveLocation(file, root, fileExists);
    if (resolved) found.set(resolved.relativePath, resolved);
  }
  return [...found.values()];
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Ranking
// ─────────────────────────────────────────────────────────────────────────────────────────

interface Bucket {
  readonly absolutePath: string;
  readonly isTest: boolean;
  readonly order: number;
  score: number;
  readonly lines: Map<number, number>; // line → accumulated weight
  readonly reasons: Set<string>;
}

function rankFiles(
  frames: readonly StackFrame[],
  failHeaders: readonly ResolvedLocation[],
): { testFiles: RankedFile[]; sourceFiles: RankedFile[] } {
  const buckets = new Map<string, Bucket>();
  const bucketFor = (relativePath: string, absolutePath: string): Bucket => {
    let bucket = buckets.get(relativePath);
    if (!bucket) {
      bucket = {
        absolutePath,
        isTest: isTestFilePath(relativePath),
        order: buckets.size,
        score: 0,
        lines: new Map(),
        reasons: new Set(),
      };
      buckets.set(relativePath, bucket);
    }
    return bucket;
  };

  for (const frame of frames) {
    // Frames closer to the throw site weigh more: 1, 1/2, 1/3, … within each trace.
    const weight = SOURCE_WEIGHT[frame.source] / (1 + frame.depth);
    const bucket = bucketFor(frame.relativePath, frame.absolutePath);
    bucket.score += weight;
    bucket.lines.set(frame.line, (bucket.lines.get(frame.line) ?? 0) + weight);
    if (bucket.reasons.size < 5) {
      const where = frame.functionName ? ` in ${frame.functionName}()` : '';
      const mapped = frame.mappedFrom ? ` (mapped from ${frame.mappedFrom})` : '';
      bucket.reasons.add(`${describeSource(frame.source)}${where} at line ${frame.line}${mapped}`);
    }
  }
  for (const header of failHeaders) {
    const bucket = bucketFor(header.relativePath, header.absolutePath);
    bucket.score += 2;
    bucket.reasons.add('reported as FAIL by the test runner');
  }

  const ranked = [...buckets.entries()]
    .sort(([, a], [, b]) => b.score - a.score || a.order - b.order)
    .map(([relativePath, bucket]) => ({
      isTest: bucket.isTest,
      file: {
        relativePath,
        absolutePath: bucket.absolutePath,
        score: Math.round(bucket.score * 1000) / 1000,
        lines: [...bucket.lines.entries()].sort(([, a], [, b]) => b - a).map(([line]) => line),
        reasons: [...bucket.reasons],
      } satisfies RankedFile,
    }));

  return {
    testFiles: ranked.filter((r) => r.isTest).map((r) => r.file),
    sourceFiles: ranked.filter((r) => !r.isTest).map((r) => r.file),
  };
}

function describeSource(source: FrameSource): string {
  switch (source) {
    case 'tsc':
      return 'TypeScript compile error';
    case 'node-test':
      return 'test declared';
    case 'generic':
      return 'referenced';
    case 'python':
      return 'Python frame';
    default:
      return 'stack frame';
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Error / test-name / count extraction
// ─────────────────────────────────────────────────────────────────────────────────────────

interface PrimaryError {
  readonly type: string;
  readonly message: string;
  readonly excerpt: string;
}

function extractPrimaryError(lines: readonly string[], exitCode: number): PrimaryError {
  // 1. Compile errors win: nothing else is meaningful until the code type-checks.
  const tscLines = lines.filter((line) => TSC_DIAGNOSTIC.test(line));
  if (tscLines.length > 0) {
    const groups = TSC_DIAGNOSTIC.exec(tscLines[0] ?? '')?.groups ?? {};
    return {
      type: 'TypeScriptError',
      message: `${groups['code'] ?? 'TS'}: ${groups['message'] ?? ''}`.trim(),
      excerpt: tscLines.slice(0, 10).map((l) => l.trim()).join('\n'),
    };
  }

  // 2. Earliest runtime error header, Jest matcher header or node:test TAP "error:" key.
  let sawTapFailure = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^\s*not ok \d+/.test(line)) sawTapFailure = true;

    const header = ERROR_HEADER.exec(line);
    if (header?.groups && !isFrameLine(line)) {
      const type = header.groups['type'] ?? 'Error';
      const message = header.groups['message'] ?? '';
      return { type, message: message || type, excerpt: collectExcerpt(lines, i) };
    }
    if (JEST_MATCHER.test(line)) {
      const excerpt = collectExcerpt(lines, i);
      return { type: 'AssertionError', message: excerpt.split('\n').filter(Boolean).join(' | '), excerpt };
    }
    const tap = sawTapFailure ? TAP_ERROR.exec(line) : null;
    if (tap?.groups) {
      const parsed = parseTapError(lines, i, tap.groups['indent']?.length ?? 0, tap.groups['value'] ?? '');
      if (parsed) return parsed;
    }
  }

  // 3. Anything that smells like a failure; otherwise just report the exit code.
  const fallback = lines.find((line) => /\b(?:fail(?:ed|ure)?|error)\b/i.test(line) && line.trim().length > 0);
  const message = fallback?.trim() ?? `Test command exited with code ${exitCode}`;
  return { type: 'TestFailure', message, excerpt: message };
}

/** node:test TAP: `error: |-` block (or inline value) + the `name: 'TypeError'` key that follows. */
function parseTapError(lines: readonly string[], index: number, indent: number, value: string): PrimaryError | undefined {
  let messageLines: string[];
  if (/^[|>][-+]?$/.test(value.trim())) {
    messageLines = [];
    for (let j = index + 1; j < lines.length; j += 1) {
      const next = lines[j] ?? '';
      const nextIndent = next.length - next.trimStart().length;
      if (next.trim() !== '' && nextIndent <= indent) break;
      messageLines.push(next.trim());
    }
  } else {
    messageLines = [value.trim().replace(/^(['"])(.*)\1$/, '$2')];
  }
  const message = messageLines.join('\n').trim();
  if (message === '') return undefined;

  let type = 'Error';
  for (let j = index + 1; j < Math.min(lines.length, index + 40); j += 1) {
    const name = TAP_ERROR_NAME.exec(lines[j] ?? '')?.groups?.['name'];
    if (name) {
      type = name;
      break;
    }
    if (/^\s*\.\.\.\s*$/.test(lines[j] ?? '')) break; // end of the YAML diagnostic block
  }
  return { type, message, excerpt: `${type}: ${message}` };
}

/** The header line plus the details that follow it, up to the first stack frame / code frame. */
function collectExcerpt(lines: readonly string[], start: number, maxLines = 15): string {
  const out: string[] = [];
  for (let i = start; i < lines.length && out.length < maxLines; i += 1) {
    const line = lines[i] ?? '';
    if (i > start && (isFrameLine(line) || CODE_FRAME_LINE.test(line))) break;
    out.push(line);
  }
  while (out.length > 0 && (out.at(-1) ?? '').trim() === '') out.pop();
  return dedent(out).join('\n');
}

function isFrameLine(line: string): boolean {
  return /^\s*at\s+\S/.test(line) || /^\s*(?:❯|→)\s/.test(line);
}

export function extractFailingTestNames(lines: readonly string[]): string[] {
  const names = new Set<string>();
  for (const line of lines) {
    const pytest = PYTEST_FAILED.exec(line)?.groups;
    if (pytest) {
      names.add(`${pytest['file']}::${pytest['name']}`);
      continue;
    }
    for (const pattern of FAILING_TEST_PATTERNS) {
      const name = pattern.exec(line)?.groups?.['name']?.trim();
      if (name) {
        names.add(name);
        break;
      }
    }
    if (names.size >= 20) break;
  }
  return [...names];
}

export function extractFailedTestCount(text: string): number | undefined {
  for (const pattern of FAILED_COUNT_PATTERNS) {
    const counts = [...text.matchAll(pattern)].map((m) => Number(m[1]));
    if (counts.length > 0) return counts.reduce((sum, n) => sum + n, 0);
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Signature & log excerpt
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Fingerprint of *what* is failing. Deliberately excludes line numbers (a patch that shifts
 * code by one line has not changed the failure) and volatile noise (paths, timings, addresses),
 * but keeps assertion values: "expected 4 to be 5" vs "expected -1 to be 5" is real movement.
 */
function computeSignature(
  type: string,
  message: string,
  anchorFile: string | undefined,
  failingTests: readonly string[],
  root: string,
): string {
  const normalized = message
    .split(root)
    .join('<root>')
    .replace(/\b0x[0-9a-f]+\b/gi, '0x?')
    .replace(/\(\d+(?:\.\d+)?\s?m?s\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
  return createHash('sha256')
    .update([type, normalized, anchorFile ?? '', [...failingTests].sort().join('\u0000')].join('\u0001'))
    .digest('hex')
    .slice(0, 16);
}

/** Lines that are worth keeping even when the log has to be cut down. */
function isInterestingLine(line: string): boolean {
  return (
    ERROR_HEADER.test(line) ||
    JEST_MATCHER.test(line) ||
    TSC_DIAGNOSTIC.test(line) ||
    FAIL_HEADER.test(line) ||
    /^\s*(?:●|not ok \d+|[✖×✕]\s|FAILED\s|Traceback|\d+\)\s)/.test(line) ||
    /^\s*error:\s/.test(line)
  );
}

function buildRelevantLog(lines: readonly string[], maxChars: number): string {
  // 1. Collapse runs of frames that can never be patched (node internals, node_modules).
  const compact: string[] = [];
  let hidden = 0;
  const flushHidden = (): void => {
    if (hidden > 0) compact.push(`    … ${hidden} internal/dependency frame(s) omitted`);
    hidden = 0;
  };
  for (const line of lines) {
    const isInternalFrame =
      (/^\s*at\s/.test(line) || /^\s+\S.*\((?:node:|internal\/)/.test(line)) &&
      /(?:node:|internal\/|node_modules[\\/]|<anonymous>)/.test(line);
    if (isInternalFrame) {
      hidden += 1;
      continue;
    }
    flushHidden();
    compact.push(line);
  }
  flushHidden();
  while (compact.length > 0 && (compact.at(-1) ?? '').trim() === '') compact.pop();

  const full = compact.join('\n');
  if (full.length <= maxChars) return full;

  // 2. Too long: keep windows around interesting lines plus the final summary.
  const keep = new Set<number>();
  compact.forEach((line, index) => {
    if (!isInterestingLine(line)) return;
    for (let k = Math.max(0, index - 3); k <= Math.min(compact.length - 1, index + 15); k += 1) keep.add(k);
  });
  for (let k = Math.max(0, compact.length - 25); k < compact.length; k += 1) keep.add(k);

  const out: string[] = [];
  let previous = -1;
  for (const index of [...keep].sort((a, b) => a - b)) {
    if (index > previous + 1) out.push(`… [${index - previous - 1} line(s) omitted] …`);
    out.push(compact[index] ?? '');
    previous = index;
  }
  const windowed = out.join('\n');
  if (windowed.length <= maxChars) return windowed;
  // 3. Still too long: keep the head (first failures) and the tail (summary).
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return `${windowed.slice(0, head)}\n… [truncated] …\n${windowed.slice(-tail)}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────────────────

function isRegularFile(absolutePath: string): boolean {
  try {
    return statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

function dedent(lines: readonly string[]): string[] {
  const indents = lines.filter((l) => l.trim() !== '').map((l) => l.length - l.trimStart().length);
  const min = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(Math.min(min, l.length - l.trimStart().length)));
}

/**
 * First meaningful line of a message. Node's assertion messages start with a generic lead-in
 * ("Expected values to be strictly equal:") followed by the informative part ("-1 !== 5"),
 * so a line ending in ":" is joined with the next non-empty line.
 */
function headline(message: string): string {
  const lines = message.split('\n').map((l) => l.trim()).filter(Boolean);
  const [first = '', second] = lines;
  return first.endsWith(':') && second ? `${first} ${second}` : first;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
