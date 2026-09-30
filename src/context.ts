/**
 * context.ts — reads the files the model needs to see.
 *
 * Stack traces alone are often not enough: an assertion failure only has frames inside the
 * *test* file, even though the bug lives in the module under test. So besides the files the
 * analyzer implicated, we follow the failing tests' relative imports (breadth-first, bounded
 * depth) to pull in the code they exercise.
 *
 * Every file read is recorded with a SHA-256 of its content; the patcher refuses to apply a
 * patch to a file that changed on disk after the model saw it.
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FailureAnalysis, RankedFile } from './analyzer.js';
import { isTestFilePath } from './analyzer.js';

export type ContextRole = 'source' | 'test';

/** A contiguous run of lines shown to the model (whole file, or an excerpt of a large one). */
export interface ContextSegment {
  /** 1-based line number of `lines[0]`. */
  readonly startLine: number;
  readonly lines: readonly string[];
}

export interface ContextFile {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly role: ContextRole;
  readonly segments: readonly ContextSegment[];
  readonly totalLines: number;
  /** True when only excerpts of the file are included. */
  readonly truncated: boolean;
  readonly implicatedLines: readonly number[];
  readonly reasons: readonly string[];
  /** SHA-256 of the full on-disk content at read time (staleness guard for the patcher). */
  readonly sha256: string;
}

export interface ContextBundle {
  readonly files: readonly ContextFile[];
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
  /** relativePath → sha256, handed to the patcher. */
  readonly hashes: ReadonlyMap<string, string>;
}

export interface GatherContextOptions {
  readonly projectRoot: string;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  /** Budget for all file content combined (characters). */
  readonly maxTotalChars?: number;
  /** How many levels of relative imports to follow from the failing tests. */
  readonly importDepth?: number;
  /** How many failing test files to include. */
  readonly maxTestFiles?: number;
}

interface Candidate {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly role: ContextRole;
  readonly lines: readonly number[];
  readonly reasons: readonly string[];
}

const DEFAULT_MAX_TOTAL_CHARS = 160_000;
const EXCERPT_RADIUS = 40;
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;

/**
 * Module specifiers of static imports, re-exports, dynamic imports and require() calls:
 *   import x from './a'          import type { T } from "../types.js"     import './side-effect'
 *   export * from './b'          export { y } from './c'                  const z = require('./d')
 *   await import('./e')
 * Group 1 captures the opening quote so the closing quote must match (\1).
 * `[\w*{}\s,$]+` spans default/named/namespace bindings, including multi-line `{ … }` lists.
 * Only *relative* specifiers are captured: bare specifiers resolve into node_modules, which
 * DevMedic never patches.
 */
const IMPORT_SPECIFIER =
  /(?:\bimport\s+(?:[\w*{}\s,$]+?\s+from\s+)?|\bexport\s+(?:[\w*{}\s,$]+?\s+)?from\s+|\brequire\s*\(\s*|\bimport\s*\(\s*)(['"])(?<spec>\.{1,2}\/[^'"\n]+)\1/g;

export async function gatherContext(analysis: FailureAnalysis, options: GatherContextOptions): Promise<ContextBundle> {
  const root = path.resolve(options.projectRoot);
  const maxTotalChars = options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  const importDepth = options.importDepth ?? 2;
  const maxTestFiles = options.maxTestFiles ?? 3;

  const skipped: { path: string; reason: string }[] = [];
  const contentCache = new Map<string, string | null>();
  const load = async (absolutePath: string): Promise<string | null> => {
    if (!contentCache.has(absolutePath)) {
      const result = await readTextFile(absolutePath);
      if (typeof result !== 'string') {
        skipped.push({ path: path.relative(root, absolutePath), reason: result.reason });
      }
      contentCache.set(absolutePath, typeof result === 'string' ? result : null);
    }
    return contentCache.get(absolutePath) ?? null;
  };

  // Priority order: implicated sources → failing tests → modules imported by the tests.
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: Candidate): void => {
    if (seen.has(candidate.relativePath)) return;
    seen.add(candidate.relativePath);
    candidates.push(candidate);
  };
  for (const file of analysis.sourceFiles) add(fromRanked(file, 'source'));
  const tests = analysis.testFiles.slice(0, maxTestFiles);
  for (const file of tests) add(fromRanked(file, 'test'));

  // Breadth-first walk over relative imports, starting at the failing tests.
  let frontier = tests.map((t) => t.absolutePath);
  for (let depth = 1; depth <= importDepth && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const importer of frontier) {
      const content = await load(importer);
      if (content === null) continue;
      for (const specifier of extractRelativeImports(content)) {
        const resolved = await resolveImport(importer, specifier, root);
        if (!resolved) continue;
        const relativePath = toPosix(path.relative(root, resolved));
        if (seen.has(relativePath)) continue;
        if (isTestFilePath(relativePath)) continue; // test helpers are not what we fix
        add({
          relativePath,
          absolutePath: resolved,
          role: 'source',
          lines: [],
          reasons: [`imported by ${toPosix(path.relative(root, importer))}${depth > 1 ? ` (depth ${depth})` : ''}`],
        });
        next.push(resolved);
      }
    }
    frontier = next;
  }

  // Read candidates in priority order until the file/char budgets run out.
  const files: ContextFile[] = [];
  const hashes = new Map<string, string>();
  let usedChars = 0;
  for (const candidate of candidates) {
    if (files.length >= options.maxFiles) {
      skipped.push({ path: candidate.relativePath, reason: `context limit of ${options.maxFiles} files reached` });
      continue;
    }
    const content = await load(candidate.absolutePath);
    if (content === null) continue;

    const allLines = splitLines(content);
    const byteLength = Buffer.byteLength(content, 'utf8');
    const segments =
      byteLength <= options.maxFileBytes
        ? [{ startLine: 1, lines: allLines }]
        : excerpt(allLines, candidate.lines, options.maxFileBytes);
    const chars = segments.reduce((sum, s) => sum + s.lines.reduce((n, l) => n + l.length + 1, 0), 0);
    if (usedChars + chars > maxTotalChars && files.length > 0) {
      skipped.push({ path: candidate.relativePath, reason: 'total context budget exhausted' });
      continue;
    }
    usedChars += chars;

    const sha256 = sha256Of(content);
    hashes.set(candidate.relativePath, sha256);
    files.push({
      relativePath: candidate.relativePath,
      absolutePath: candidate.absolutePath,
      role: candidate.role,
      segments,
      totalLines: allLines.length,
      truncated: segments.length !== 1 || segments[0]?.lines.length !== allLines.length,
      implicatedLines: candidate.lines,
      reasons: candidate.reasons,
      sha256,
    });
  }

  return { files, skipped, hashes };
}

export function extractRelativeImports(source: string): string[] {
  const specifiers = new Set<string>();
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const spec = match.groups?.['spec'];
    if (spec) specifiers.add(spec);
  }
  return [...specifiers];
}

/**
 * Node/TypeScript-style resolution for relative specifiers:
 *   './a.js' may refer to './a.ts' (TS "NodeNext" convention), './a' to './a.ts', './a/index.ts', …
 * Anything that resolves outside the project root or into node_modules is ignored.
 */
export async function resolveImport(importer: string, specifier: string, root: string): Promise<string | undefined> {
  const base = path.resolve(path.dirname(importer), specifier.split(/[?#]/)[0] ?? specifier);
  const ext = path.extname(base);
  const withoutJsExt = /^\.[cm]?jsx?$/.test(ext) ? base.slice(0, -ext.length) : undefined;

  const candidates = [
    base,
    ...(withoutJsExt ? RESOLVE_EXTENSIONS.map((e) => withoutJsExt + e) : []),
    ...RESOLVE_EXTENSIONS.map((e) => base + e),
    ...RESOLVE_EXTENSIONS.map((e) => path.join(base, `index${e}`)),
  ];
  for (const candidate of candidates) {
    const relative = path.relative(root, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).includes('node_modules')) {
      continue;
    }
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

async function readTextFile(absolutePath: string): Promise<string | { reason: string }> {
  try {
    const buffer = await readFile(absolutePath);
    // NUL bytes in the first 8 KiB: treat as binary, like git does.
    if (buffer.subarray(0, 8192).includes(0)) return { reason: 'binary file' };
    return buffer.toString('utf8');
  } catch (error) {
    return { reason: `unreadable: ${(error as NodeJS.ErrnoException).code ?? String(error)}` };
  }
}

/** Windows around the implicated lines (or the head of the file) that fit in `maxBytes`. */
function excerpt(allLines: readonly string[], implicated: readonly number[], maxBytes: number): ContextSegment[] {
  const anchors = implicated.length > 0 ? implicated : [1];
  const ranges = anchors
    .map((line) => [Math.max(1, line - EXCERPT_RADIUS), Math.min(allLines.length, line + EXCERPT_RADIUS)] as const)
    .sort((a, b) => a[0] - b[0]);

  const merged: [number, number][] = [];
  for (const [start, end] of ranges) {
    const last = merged.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }

  const segments: ContextSegment[] = [];
  let budget = maxBytes;
  for (const [start, end] of merged) {
    const lines: string[] = [];
    for (let n = start; n <= end && budget > 0; n += 1) {
      const text = allLines[n - 1] ?? '';
      budget -= Buffer.byteLength(text, 'utf8') + 1;
      lines.push(text);
    }
    if (lines.length > 0) segments.push({ startLine: start, lines });
    if (budget <= 0) break;
  }
  return segments;
}

function fromRanked(file: RankedFile, role: ContextRole): Candidate {
  return {
    relativePath: file.relativePath,
    absolutePath: file.absolutePath,
    role,
    lines: file.lines,
    reasons: file.reasons,
  };
}

function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === '') lines.pop(); // trailing newline is not an extra line
  return lines;
}

export function sha256Of(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}
