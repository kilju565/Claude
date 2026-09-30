/**
 * patcher.ts — parses unified diffs and applies them to the working tree, safely.
 *
 *   parseUnifiedDiff()   text → FilePatch[]            (tolerant of common LLM diff mistakes)
 *   preparePatch()       FilePatch[] → PreparedPatch   (pure: validates + computes new contents in memory)
 *   commitPatch()        PreparedPatch → transaction   (atomic writes, rollback handle)
 *   renderPatchPreview() PreparedPatch → string        (dry-run output)
 *
 * Safeguards (each one is enforced before a single byte is written):
 *   • Path confinement   — no absolute paths, no "..", no symlink escapes, never .git/ or node_modules/.
 *   • Protected files    — lockfiles, .env files, key material; test files unless explicitly allowed.
 *   • Blast radius       — caps on files touched and lines changed per patch.
 *   • Content integrity  — refuses binary / non-UTF-8 files; every hunk must match the file
 *                          (with bounded offset/fuzz/whitespace tolerance), never applied blindly.
 *   • Staleness          — refuses files that changed since the model saw them, and re-checks right
 *                          before writing (TOCTOU).
 *   • All-or-nothing     — all new contents are computed first; writes are atomic (temp file + rename)
 *                          and a failed write rolls back the files already written.
 *   • Fidelity           — preserves each line's original line ending (LF/CRLF), the trailing-newline
 *                          state and file permissions.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';
import { DEFAULTS } from './config.js';

// ─────────────────────────────────────────────────────────────────────────────────────────
// Errors & types
// ─────────────────────────────────────────────────────────────────────────────────────────

export type PatchErrorCode =
  | 'PARSE'
  | 'UNSAFE_PATH'
  | 'PROTECTED_PATH'
  | 'LIMIT_EXCEEDED'
  | 'HUNK_MISMATCH'
  | 'FILE_NOT_FOUND'
  | 'FILE_EXISTS'
  | 'STALE_FILE'
  | 'BINARY'
  | 'UNSUPPORTED'
  | 'NO_OP'
  | 'WRITE_FAILED'
  | 'ROLLBACK_FAILED';

/** Codes meaning "the patch is not allowed", as opposed to "the patch does not fit". */
export const POLICY_ERROR_CODES: ReadonlySet<PatchErrorCode> = new Set(['UNSAFE_PATH', 'PROTECTED_PATH', 'LIMIT_EXCEEDED']);

export class PatchError extends Error {
  override readonly name = 'PatchError';
  constructor(
    readonly code: PatchErrorCode,
    message: string,
    readonly file?: string,
  ) {
    super(message);
  }
}

export type HunkOp = ' ' | '-' | '+';

export interface HunkLine {
  readonly op: HunkOp;
  readonly text: string;
  /** Followed by "\ No newline at end of file". */
  readonly noNewlineAtEof?: boolean;
}

export interface Hunk {
  /** 1-based start in the old file; undefined when the header had no line numbers ("@@ @@"). */
  readonly oldStart: number | undefined;
  readonly newStart: number | undefined;
  readonly lines: readonly HunkLine[];
  /** The header's line counts disagreed with the body (typical of hand/LLM-written diffs). */
  readonly countMismatch: boolean;
}

export interface FilePatch {
  /** null = /dev/null (file creation). */
  readonly oldPath: string | null;
  /** null = /dev/null (file deletion). */
  readonly newPath: string | null;
  readonly hunks: readonly Hunk[];
  readonly binary: boolean;
}

export type ChangeKind = 'modify' | 'create' | 'delete';

export interface FileChange {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly kind: ChangeKind;
  /** null when the file does not exist yet. */
  readonly before: string | null;
  /** null when the file is deleted. */
  readonly after: string | null;
  /** Permission bits to restore/preserve. */
  readonly mode?: number;
  readonly added: number;
  readonly removed: number;
  /** Canonical diff of what is actually applied (real positions, real context). */
  readonly diff: string;
  readonly warnings: readonly string[];
}

export interface PreparedPatch {
  readonly changes: readonly FileChange[];
  readonly diff: string;
  /** Hash of the semantic change (+/- lines per file, no positions/context). */
  readonly diffFingerprint: string;
  /** Hash of the resulting contents of every touched file. */
  readonly stateFingerprint: string;
  readonly added: number;
  readonly removed: number;
  readonly warnings: readonly string[];
}

export interface PatchPolicy {
  readonly projectRoot: string;
  readonly allowTestEdits: boolean;
  readonly isTestFile: (relativePath: string) => boolean;
  readonly allowCreate?: boolean;
  readonly allowDelete?: boolean;
  readonly maxFiles?: number;
  readonly maxChangedLines?: number;
  readonly maxFuzz?: number;
  /** relativePath → sha256 of the content the model was shown. */
  readonly expectedHashes?: ReadonlyMap<string, string>;
}

export interface PatchTransaction {
  readonly changes: readonly FileChange[];
  readonly rolledBack: boolean;
  /** Restores every file to its pre-patch state. Idempotent. */
  rollback(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Hunk header "@@ -<oldStart>[,<oldCount>] +<newStart>[,<newCount>] @@ [section]".
 * Split into two regexes: HUNK_HEADER recognizes the line (also the degenerate "@@ @@" / "@@"
 * forms LLMs sometimes emit), HUNK_RANGE extracts numbers when present. Counts are optional
 * and default to 1 per the GNU diff format.
 */
const HUNK_HEADER = /^@@+(?:(?<range>.*?)@@+(?<section>.*))?\s*$/;
const HUNK_RANGE = /^\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*$/;
/** git extended header lines that may sit between "diff --git" and "---". */
const GIT_EXTENDED_HEADER =
  /^(?:index |old mode |new mode |new file mode |deleted file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to )/;

interface MutableFilePatch {
  oldPath: string | null;
  newPath: string | null;
  hunks: Hunk[];
  binary: boolean;
  hasHeader: boolean;
  gitPaths?: readonly [string, string];
}

export function parseUnifiedDiff(input: string): FilePatch[] {
  const lines = stripCodeFences(input).replace(/\r\n?/g, '\n').split('\n');
  const patches: MutableFilePatch[] = [];
  let current: MutableFilePatch | undefined;

  const startPatch = (): MutableFilePatch => {
    current = { oldPath: null, newPath: null, hunks: [], binary: false, hasHeader: false };
    patches.push(current);
    return current;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (line.startsWith('diff --git ')) {
      const patch = startPatch();
      // "diff --git a/x b/x" — only a fallback; ambiguous when paths contain spaces.
      const m = /^diff --git (?:"?a\/)?(.+?)"? (?:"?b\/)?(.+?)"?$/.exec(line);
      if (m?.[1] && m[2]) patch.gitPaths = [m[1], m[2]];
      i += 1;
      continue;
    }

    // File header pair. At top level a "---" line followed by "+++" is always a header.
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const patch = current && !current.hasHeader && current.hunks.length === 0 ? current : startPatch();
      const [oldPath, newPath] = stripGitPrefixes(
        cleanHeaderPath(line.slice(4)),
        cleanHeaderPath((lines[i + 1] ?? '').slice(4)),
      );
      patch.oldPath = oldPath;
      patch.newPath = newPath;
      patch.hasHeader = true;
      i += 2;
      continue;
    }

    if (current && GIT_EXTENDED_HEADER.test(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      if (current) current.binary = true;
      i += 1;
      continue;
    }

    const header = HUNK_HEADER.exec(line);
    if (header) {
      const patch = current;
      if (!patch) throw new PatchError('PARSE', `Hunk header on diff line ${i + 1} has no preceding "---"/"+++" file header.`);
      if (!patch.hasHeader) {
        if (!patch.gitPaths) throw new PatchError('PARSE', `Hunk header on diff line ${i + 1} has no file header.`);
        patch.oldPath = patch.gitPaths[0];
        patch.newPath = patch.gitPaths[1];
        patch.hasHeader = true;
      }
      const range = HUNK_RANGE.exec(header.groups?.['range'] ?? '');
      const body = parseHunkBody(lines, i + 1);
      const oldCount = body.lines.filter((l) => l.op !== '+').length;
      const newCount = body.lines.filter((l) => l.op !== '-').length;
      const declaredOld = range ? Number(range[2] ?? 1) : undefined;
      const declaredNew = range ? Number(range[4] ?? 1) : undefined;
      patch.hunks.push({
        oldStart: range ? Number(range[1]) : undefined,
        newStart: range ? Number(range[3]) : undefined,
        lines: body.lines,
        countMismatch: range !== null && (declaredOld !== oldCount || declaredNew !== newCount),
      });
      i = body.next;
      continue;
    }

    // Anything else — LLM commentary, blank lines between files — is ignored.
    i += 1;
  }

  const result = patches.filter((p) => p.hasHeader || p.hunks.length > 0 || p.binary);
  if (result.length === 0) {
    throw new PatchError('PARSE', 'No unified diff found: expected "--- a/<path>" / "+++ b/<path>" headers followed by "@@" hunks.');
  }
  for (const p of result) {
    const name = p.newPath ?? p.oldPath ?? '<unknown>';
    if (p.oldPath === null && p.newPath === null) throw new PatchError('PARSE', 'A file header has /dev/null on both sides.');
    if (!p.binary && p.hunks.length === 0) throw new PatchError('PARSE', `No hunks for ${name}.`, name);
    if (p.hunks.some((h) => h.lines.length === 0)) throw new PatchError('PARSE', `Empty hunk in ${name}.`, name);
  }
  return result.map(({ oldPath, newPath, hunks, binary }) => ({ oldPath, newPath, hunks, binary }));
}

/**
 * Hunk bodies are delimited by *content*, not by the header's line counts: LLMs routinely get the
 * counts wrong, so a body runs over every consecutive " ", "+", "-", "\" line and stops at the next
 * hunk header, "diff --git", a file header, or any other line. Header counts are only used to flag
 * a mismatch.
 */
function parseHunkBody(lines: readonly string[], start: number): { lines: HunkLine[]; next: number } {
  const out: HunkLine[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.startsWith('diff --git ') || HUNK_HEADER.test(line) || isFileHeaderInBody(lines, i)) break;

    if (line === '') {
      // A blank line is a context line whose single leading space was stripped (editors and
      // LLMs do this) — but only if more hunk body follows; a trailing blank line ends the hunk.
      if (moreBodyFollows(lines, i + 1)) {
        out.push({ op: ' ', text: '' });
        i += 1;
        continue;
      }
      break;
    }

    const marker = line[0];
    if (marker === '\\') {
      // "\ No newline at end of file" qualifies the line right before it.
      const previous = out.at(-1);
      if (previous) out[out.length - 1] = { ...previous, noNewlineAtEof: true };
      i += 1;
      continue;
    }
    if (marker === ' ' || marker === '+' || marker === '-') {
      out.push({ op: marker, text: line.slice(1) });
      i += 1;
      continue;
    }
    break;
  }
  return { lines: out, next: i };
}

/**
 * Inside a hunk, "--- x" could legitimately be a removed line whose text starts with "-- ".
 * Only treat it as the next file's header when the full 3-line signature is present:
 * "--- …", "+++ …", then a hunk header.
 */
function isFileHeaderInBody(lines: readonly string[], i: number): boolean {
  return (
    (lines[i] ?? '').startsWith('--- ') &&
    (lines[i + 1] ?? '').startsWith('+++ ') &&
    HUNK_HEADER.test(lines[i + 2] ?? '')
  );
}

function moreBodyFollows(lines: readonly string[], from: number): boolean {
  let j = from;
  while (j < lines.length && lines[j] === '') j += 1;
  const line = lines[j];
  if (line === undefined || line.startsWith('diff --git ') || isFileHeaderInBody(lines, j)) return false;
  return /^[ +\-\\]/.test(line);
}

/** Removes the "--- a/x.ts\t2024-01-01 10:00:00" timestamp, git C-quoting, and maps /dev/null → null. */
function cleanHeaderPath(raw: string): string | null {
  let p = (raw.split('\t')[0] ?? '').trim();
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1).replace(/\\(["\\])/g, '$1');
  if (p === '/dev/null' || p === 'dev/null') return null;
  return p;
}

/**
 * git prefixes old/new paths with "a/" and "b/" — both sides or neither (--no-prefix). Stripping
 * only when *both* sides carry their prefix avoids mangling a real top-level directory "a/".
 */
function stripGitPrefixes(oldPath: string | null, newPath: string | null): [string | null, string | null] {
  const oldPrefixed = oldPath === null || oldPath.startsWith('a/');
  const newPrefixed = newPath === null || newPath.startsWith('b/');
  if (oldPrefixed && newPrefixed) return [oldPath?.slice(2) ?? null, newPath?.slice(2) ?? null];
  return [oldPath, newPath];
}

/**
 * Models like to wrap diffs in ```diff fences. Only unwrap when the fence encloses the whole text:
 * a diff of a Markdown file may legitimately contain ``` lines of its own.
 */
function stripCodeFences(text: string): string {
  const fenced = /^\s*```(?:diff|patch|udiff)?[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(text);
  return fenced?.[1] ?? text;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Applying hunks (pure, in-memory)
// ─────────────────────────────────────────────────────────────────────────────────────────

interface FileLine {
  readonly text: string;
  /** The line's own terminator: "\n", "\r\n", or "" for a last line without newline. */
  readonly eol: string;
}

type MatchMode = 'exact' | 'trailing-whitespace' | 'whitespace-insensitive';
const MATCH_MODES: readonly MatchMode[] = ['exact', 'trailing-whitespace', 'whitespace-insensitive'];

export interface AppliedHunk {
  /** Unified-diff start positions in the original / resulting file. */
  readonly oldStart: number;
  readonly newStart: number;
  /** Hunk lines with context/removed text taken from the actual file. */
  readonly lines: readonly HunkLine[];
  /** Lines between the declared position and where the hunk actually matched. */
  readonly offset: number;
  /** Context lines ignored at each end to make it match. */
  readonly fuzz: number;
  readonly mode: MatchMode;
}

export interface ApplyResult {
  readonly content: string;
  readonly hunks: readonly AppliedHunk[];
  readonly warnings: readonly string[];
}

export function applyHunks(
  original: string,
  hunks: readonly Hunk[],
  options: { readonly maxFuzz: number; readonly filePath: string },
): ApplyResult {
  const { lines, eol } = splitLines(original);
  const warnings: string[] = [];
  const applied: AppliedHunk[] = [];

  // Apply in file order when positions are known (models occasionally emit hunks out of order).
  const ordered = hunks.every((h) => h.oldStart !== undefined)
    ? [...hunks].sort((a, b) => (a.oldStart ?? 0) - (b.oldStart ?? 0))
    : [...hunks];

  let delta = 0; // net lines added by hunks applied so far
  let carriedOffset = 0; // like GNU patch, reuse the last hunk's drift as a hint for the next one
  let minIndex = 0; // hunks may neither overlap nor go backwards
  let eofState: 'untouched' | 'newline' | 'no-newline' = 'untouched';

  ordered.forEach((hunk, index) => {
    const label = `hunk #${index + 1} of ${options.filePath}`;
    if (hunk.countMismatch) warnings.push(`${label}: header line counts did not match the body (recomputed)`);

    const hasOldLines = hunk.lines.some((l) => l.op !== '+');
    // Unified diff convention: for a range with 0 old lines, oldStart is the line *after which* to insert.
    const declared =
      hunk.oldStart === undefined ? undefined : (hasOldLines ? hunk.oldStart - 1 : hunk.oldStart) + delta;
    const expected = declared === undefined ? minIndex : Math.max(0, declared + carriedOffset);

    const location = locateHunk(lines, hunk.lines, expected, minIndex, options.maxFuzz);
    if (!location) {
      throw new PatchError('HUNK_MISMATCH', describeMismatch(label, hunk, lines, expected, options.maxFuzz), options.filePath);
    }

    const { index: position, used, fuzz, mode, leadingTrim } = location;
    const replacement: FileLine[] = [];
    const appliedLines: HunkLine[] = [];
    let cursor = position;
    for (const hunkLine of used) {
      if (hunkLine.op === '+') {
        replacement.push({ text: hunkLine.text, eol });
        appliedLines.push({ op: '+', text: hunkLine.text });
        continue;
      }
      // Context and removed lines come from the FILE, not the patch: under whitespace-tolerant
      // matching this guarantees untouched lines keep their exact original bytes.
      const fileLine = lines[cursor] ?? { text: '', eol };
      cursor += 1;
      if (hunkLine.op === ' ') replacement.push(fileLine);
      appliedLines.push({ op: hunkLine.op, text: fileLine.text });
    }
    const oldLength = cursor - position;
    const reachesEof = position + oldLength === lines.length;
    lines.splice(position, oldLength, ...replacement);

    const originalIndex = position - delta;
    applied.push({
      oldStart: oldLength === 0 ? originalIndex : originalIndex + 1,
      newStart: replacement.length === 0 ? position : position + 1,
      lines: appliedLines,
      offset: declared === undefined ? 0 : position - leadingTrim - declared,
      fuzz,
      mode,
    });
    if (declared !== undefined && position - leadingTrim !== declared) {
      warnings.push(`${label}: applied at offset ${position - leadingTrim - declared} line(s)`);
    }
    if (fuzz > 0) warnings.push(`${label}: applied with fuzz ${fuzz}`);
    if (mode !== 'exact') warnings.push(`${label}: context matched with ${mode} comparison`);

    if (reachesEof) {
      const lastNewSide = [...used].reverse().find((l) => l.op !== '-');
      eofState = lastNewSide?.noNewlineAtEof ? 'no-newline' : 'newline';
    }
    delta += replacement.length - oldLength;
    if (declared !== undefined) carriedOffset = position - leadingTrim - declared;
    minIndex = position + replacement.length;
  });

  // A former last line that now has lines after it needs a terminator.
  const fixed = lines.map((line, i) => (i < lines.length - 1 && line.eol === '' ? { ...line, eol } : line));
  const last = fixed.at(-1);
  if (last && eofState !== 'untouched') {
    fixed[fixed.length - 1] = { ...last, eol: eofState === 'no-newline' ? '' : last.eol || eol };
  }
  return { content: fixed.map((l) => l.text + l.eol).join(''), hunks: applied, warnings };
}

interface HunkLocation {
  readonly index: number;
  readonly used: readonly HunkLine[];
  readonly fuzz: number;
  readonly mode: MatchMode;
  readonly leadingTrim: number;
}

/**
 * Finds where a hunk applies. Strategy, from strictest to loosest:
 *   for fuzz = 0..maxFuzz      (drop up to `fuzz` context lines at each end, like GNU patch)
 *     for mode = exact → trailing-whitespace → whitespace-insensitive
 *       scan outward from the expected position (forward first), nearest match wins.
 * Guards: positions before `minIndex` are never considered (no overlap, no reordering), and a
 * "low-information" block (only braces/blank lines) may only match at exactly the expected
 * position — otherwise a lone "}" would match half the file.
 */
function locateHunk(
  lines: readonly FileLine[],
  hunkLines: readonly HunkLine[],
  expected: number,
  minIndex: number,
  maxFuzz: number,
): HunkLocation | undefined {
  for (let fuzz = 0; fuzz <= maxFuzz; fuzz += 1) {
    const trimmed = trimContext(hunkLines, fuzz);
    if (!trimmed) continue;
    const { used, leadingTrim } = trimmed;
    const oldBlock = used.filter((l) => l.op !== '+').map((l) => l.text);

    if (oldBlock.length === 0) {
      // Pure insertion with no context: only safe into an empty file. Refuse blind insertion.
      if (lines.length === 0 && fuzz === 0) return { index: 0, used, fuzz, mode: 'exact', leadingTrim };
      continue;
    }
    const lowInformation = oldBlock.every((l) => /^[\s{}()[\];,]*$/.test(l));
    const target = expected + leadingTrim;
    for (const mode of MATCH_MODES) {
      const index = searchNearest(lines, oldBlock, target, minIndex, mode, lowInformation);
      if (index !== undefined) return { index, used, fuzz, mode, leadingTrim };
    }
  }
  return undefined;
}

function trimContext(
  hunkLines: readonly HunkLine[],
  fuzz: number,
): { used: readonly HunkLine[]; leadingTrim: number } | undefined {
  if (fuzz === 0) return { used: hunkLines, leadingTrim: 0 };
  let start = 0;
  let end = hunkLines.length;
  while (start < fuzz && hunkLines[start]?.op === ' ') start += 1;
  while (hunkLines.length - end < fuzz && end > start && hunkLines[end - 1]?.op === ' ') end -= 1;
  if (start === 0 && end === hunkLines.length) return undefined; // nothing to trim → same as fuzz 0
  const used = hunkLines.slice(start, end);
  // Never trim a hunk down to nothing but additions: it would lose its anchor.
  if (!used.some((l) => l.op !== '+')) return undefined;
  return { used, leadingTrim: start };
}

function searchNearest(
  lines: readonly FileLine[],
  block: readonly string[],
  target: number,
  minIndex: number,
  mode: MatchMode,
  exactPositionOnly: boolean,
): number | undefined {
  const maxStart = lines.length - block.length;
  if (maxStart < minIndex) return undefined;
  const wanted = block.map((l) => normalizeLine(l, mode));
  const matchesAt = (pos: number): boolean => wanted.every((w, k) => normalizeLine(lines[pos + k]?.text ?? '', mode) === w);

  if (exactPositionOnly) return target >= minIndex && target <= maxStart && matchesAt(target) ? target : undefined;

  const center = Math.min(Math.max(target, minIndex), maxStart);
  const span = Math.max(center - minIndex, maxStart - center);
  for (let distance = 0; distance <= span; distance += 1) {
    for (const pos of distance === 0 ? [center] : [center + distance, center - distance]) {
      if (pos >= minIndex && pos <= maxStart && matchesAt(pos)) return pos;
    }
  }
  return undefined;
}

function normalizeLine(text: string, mode: MatchMode): string {
  switch (mode) {
    case 'exact':
      return text;
    case 'trailing-whitespace':
      return text.trimEnd();
    case 'whitespace-insensitive':
      return text.replace(/\s+/g, ' ').trim();
  }
}

/** Precise feedback for the model: which line at the expected position did not match. */
function describeMismatch(label: string, hunk: Hunk, lines: readonly FileLine[], expected: number, maxFuzz: number): string {
  const oldBlock = hunk.lines.filter((l) => l.op !== '+');
  let detail = 'the expected position is beyond the end of the file';
  for (let k = 0; k < oldBlock.length; k += 1) {
    const actual = lines[expected + k]?.text;
    const wanted = oldBlock[k]?.text ?? '';
    if (actual === undefined || actual.trimEnd() !== wanted.trimEnd()) {
      detail = `at line ${expected + k + 1} the patch expects ${JSON.stringify(wanted)} but the file has ${
        actual === undefined ? 'end-of-file' : JSON.stringify(actual)
      }`;
      break;
    }
  }
  return (
    `${label} does not match the file (searched the whole file with offsets, fuzz ≤ ${maxFuzz} ` +
    `and whitespace-tolerant comparison): ${detail}. Copy context lines verbatim from the current file.`
  );
}

function splitLines(content: string): { lines: FileLine[]; eol: string } {
  const lines: FileLine[] = [];
  let crlf = 0;
  let lf = 0;
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf('\n', start);
    if (newline === -1) {
      lines.push({ text: content.slice(start), eol: '' });
      break;
    }
    const isCrlf = newline > start && content[newline - 1] === '\r';
    lines.push({ text: content.slice(start, isCrlf ? newline - 1 : newline), eol: isCrlf ? '\r\n' : '\n' });
    if (isCrlf) crlf += 1;
    else lf += 1;
    start = newline + 1;
  }
  // New lines get the file's dominant line ending; existing lines keep their own.
  return { lines, eol: crlf > lf ? '\r\n' : '\n' };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Preparing (validation + in-memory application)
// ─────────────────────────────────────────────────────────────────────────────────────────

/** Path segments that are never writable. */
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(['.git', '.hg', '.svn', 'node_modules']);
/** Lockfiles, secrets and key material. */
const PROTECTED_BASENAME =
  /^(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|\.npmrc|\.env(?:\..+)?|.+\.(?:pem|key|p12|pfx|crt))$/i;

export async function preparePatch(diffText: string, policy: PatchPolicy): Promise<PreparedPatch> {
  const root = path.resolve(policy.projectRoot);
  const maxFiles = policy.maxFiles ?? DEFAULTS.maxPatchFiles;
  const maxChangedLines = policy.maxChangedLines ?? DEFAULTS.maxChangedLines;
  const maxFuzz = policy.maxFuzz ?? DEFAULTS.maxFuzz;

  const filePatches = mergeSameTarget(parseUnifiedDiff(diffText));
  if (filePatches.length > maxFiles) {
    throw new PatchError('LIMIT_EXCEEDED', `Patch touches ${filePatches.length} files; the limit is ${maxFiles}.`);
  }
  const declaredChanges = filePatches.reduce(
    (sum, fp) => sum + fp.hunks.reduce((n, h) => n + h.lines.filter((l) => l.op !== ' ').length, 0),
    0,
  );
  if (declaredChanges > maxChangedLines) {
    throw new PatchError('LIMIT_EXCEEDED', `Patch changes ${declaredChanges} lines; the limit is ${maxChangedLines}.`);
  }

  const changes: FileChange[] = [];
  for (const filePatch of filePatches) {
    changes.push(await prepareFile(filePatch, root, policy, maxFuzz));
  }
  if (changes.every((c) => c.before === c.after)) {
    throw new PatchError('NO_OP', 'The patch does not change any file content.');
  }

  const diff = changes.map((c) => c.diff).join('');
  return {
    changes,
    diff,
    diffFingerprint: semanticFingerprint(filePatches),
    stateFingerprint: stateFingerprint(changes),
    added: changes.reduce((n, c) => n + c.added, 0),
    removed: changes.reduce((n, c) => n + c.removed, 0),
    warnings: changes.flatMap((c) => c.warnings),
  };
}

async function prepareFile(filePatch: FilePatch, root: string, policy: PatchPolicy, maxFuzz: number): Promise<FileChange> {
  const displayName = filePatch.newPath ?? filePatch.oldPath ?? '<unknown>';
  if (filePatch.binary) throw new PatchError('UNSUPPORTED', `Binary patches are not supported (${displayName}).`, displayName);
  if (filePatch.oldPath !== null && filePatch.newPath !== null && filePatch.oldPath !== filePatch.newPath) {
    throw new PatchError('UNSUPPORTED', `Renames are not supported (${filePatch.oldPath} → ${filePatch.newPath}).`, displayName);
  }

  const kind: ChangeKind = filePatch.oldPath === null ? 'create' : filePatch.newPath === null ? 'delete' : 'modify';
  const { absolutePath, relativePath } = resolveSafePath(root, displayName);
  assertAllowedTarget(relativePath, kind, policy);
  await assertInsideRealRoot(root, absolutePath, relativePath);

  const current = await readCurrent(absolutePath, relativePath);
  let after: string | null;
  let applied: readonly AppliedHunk[];
  let warnings: readonly string[] = [];

  if (kind === 'create') {
    if (current) {
      throw new PatchError('FILE_EXISTS', `${relativePath} already exists; use "--- a/${relativePath}" to modify it.`, relativePath);
    }
    const lines = filePatch.hunks.flatMap((h) => h.lines);
    if (lines.some((l) => l.op !== '+')) {
      throw new PatchError('PARSE', `New file ${relativePath} may only contain "+" lines.`, relativePath);
    }
    after = lines.length === 0 ? '' : lines.map((l) => l.text).join('\n') + (lines.at(-1)?.noNewlineAtEof ? '' : '\n');
    applied = [{ oldStart: 0, newStart: 1, lines, offset: 0, fuzz: 0, mode: 'exact' }];
  } else {
    if (!current) {
      throw new PatchError('FILE_NOT_FOUND', `${relativePath} does not exist; use "--- /dev/null" to create a file.`, relativePath);
    }
    const expectedHash = policy.expectedHashes?.get(relativePath);
    if (expectedHash !== undefined && sha256(current.content) !== expectedHash) {
      throw new PatchError('STALE_FILE', `${relativePath} changed on disk after it was read; refusing to patch a stale view.`, relativePath);
    }
    if (kind === 'delete') {
      const removed = filePatch.hunks.flatMap((h) => h.lines).filter((l) => l.op === '-').map((l) => l.text.trimEnd());
      const actual = splitLines(current.content).lines.map((l) => l.text.trimEnd());
      if (removed.length !== actual.length || removed.some((l, k) => l !== actual[k])) {
        throw new PatchError('HUNK_MISMATCH', `Deletion hunk for ${relativePath} does not match the file's content.`, relativePath);
      }
      after = null;
      applied = [{ oldStart: 1, newStart: 0, lines: actual.map((text) => ({ op: '-' as const, text })), offset: 0, fuzz: 0, mode: 'exact' }];
    } else {
      const result = applyHunks(current.content, filePatch.hunks, { maxFuzz, filePath: relativePath });
      after = result.content;
      applied = result.hunks;
      warnings = result.warnings;
    }
  }

  const added = applied.reduce((n, h) => n + h.lines.filter((l) => l.op === '+').length, 0);
  const removed = applied.reduce((n, h) => n + h.lines.filter((l) => l.op === '-').length, 0);
  return {
    relativePath,
    absolutePath,
    kind,
    before: current?.content ?? null,
    after,
    mode: current?.mode,
    added,
    removed,
    diff: formatFileDiff(relativePath, kind, applied),
    warnings,
  };
}

/**
 * Confines a patch path to the project root. Returns the absolute path and the normalized
 * POSIX relative path, or throws.
 */
export function resolveSafePath(root: string, candidate: string): { absolutePath: string; relativePath: string } {
  if (candidate.trim() === '' || candidate.includes('\0')) {
    throw new PatchError('UNSAFE_PATH', `Invalid path ${JSON.stringify(candidate)}.`, candidate);
  }
  const unified = candidate.replace(/\\/g, '/');
  // Absolute paths — POSIX "/etc/passwd", Windows "C:\x" or "C:x", UNC "\\host\share" — are never
  // accepted: the model must address files relative to the project root.
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified) || path.isAbsolute(candidate)) {
    throw new PatchError('UNSAFE_PATH', `Absolute path ${JSON.stringify(candidate)} is not allowed; use a path relative to the project root.`, candidate);
  }
  const absolutePath = path.resolve(root, unified);
  const relative = path.relative(root, absolutePath);
  // path.relative() yields ".." / "../x" (or, on Windows, an absolute path on another drive) when
  // the target escapes the root, e.g. "src/../../etc/passwd". Checked on the *resolved* path so
  // that "a/../../x" style traversal can't sneak through.
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new PatchError('UNSAFE_PATH', `Path ${JSON.stringify(candidate)} escapes the project root.`, candidate);
  }
  const segments = relative.split(path.sep);
  const forbidden = segments.find((s) => FORBIDDEN_SEGMENTS.has(s));
  if (forbidden) {
    throw new PatchError('PROTECTED_PATH', `Refusing to modify files inside ${forbidden}/ (${candidate}).`, candidate);
  }
  return { absolutePath, relativePath: segments.join('/') };
}

function assertAllowedTarget(relativePath: string, kind: ChangeKind, policy: PatchPolicy): void {
  if (PROTECTED_BASENAME.test(path.posix.basename(relativePath))) {
    throw new PatchError('PROTECTED_PATH', `${relativePath} is a protected file (lockfile/secret/key material).`, relativePath);
  }
  if (!policy.allowTestEdits && policy.isTestFile(relativePath)) {
    // Anti-"cheating" guard: an agent that may edit tests can make any suite pass by weakening it.
    throw new PatchError(
      'PROTECTED_PATH',
      `${relativePath} is a test file; fix the implementation instead (test edits require --allow-test-edits).`,
      relativePath,
    );
  }
  if (kind === 'create' && policy.allowCreate === false) {
    throw new PatchError('PROTECTED_PATH', `Creating new files is disabled (${relativePath}).`, relativePath);
  }
  if (kind === 'delete' && policy.allowDelete !== true) {
    throw new PatchError('PROTECTED_PATH', `Deleting files is disabled (${relativePath}).`, relativePath);
  }
}

/**
 * Lexical checks can be defeated by symlinks (e.g. "src/link → /etc"). Resolve the real path of
 * the target — or of its nearest existing ancestor, for files that don't exist yet — and require
 * it to live under the real project root. The target itself must not be a symlink either:
 * the atomic rename would silently replace the link with a regular file.
 */
async function assertInsideRealRoot(root: string, absolutePath: string, relativePath: string): Promise<void> {
  const realRoot = await realpath(root);
  try {
    if ((await lstat(absolutePath)).isSymbolicLink()) {
      throw new PatchError('UNSAFE_PATH', `${relativePath} is a symbolic link; refusing to patch through it.`, relativePath);
    }
  } catch (error) {
    if (error instanceof PatchError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  let probe = absolutePath;
  for (;;) {
    try {
      const real = await realpath(probe);
      const relative = path.relative(realRoot, real);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new PatchError('UNSAFE_PATH', `${relativePath} resolves outside the project root via a symlink.`, relativePath);
      }
      return;
    } catch (error) {
      if (error instanceof PatchError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(probe);
      if (parent === probe) return;
      probe = parent;
    }
  }
}

async function readCurrent(absolutePath: string, relativePath: string): Promise<{ content: string; mode: number } | null> {
  let info;
  try {
    info = await stat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile()) throw new PatchError('UNSUPPORTED', `${relativePath} is not a regular file.`, relativePath);
  const raw = await readFile(absolutePath);
  if (raw.subarray(0, 8192).includes(0)) throw new PatchError('BINARY', `${relativePath} looks binary.`, relativePath);
  const content = raw.toString('utf8');
  // Decoding invalid UTF-8 replaces bytes with U+FFFD; writing that back would corrupt the file.
  if (!Buffer.from(content, 'utf8').equals(raw)) {
    throw new PatchError('BINARY', `${relativePath} is not valid UTF-8.`, relativePath);
  }
  return { content, mode: info.mode & 0o7777 };
}

/** Models sometimes split one file's changes across several "---/+++" sections. */
function mergeSameTarget(patches: readonly FilePatch[]): FilePatch[] {
  const merged = new Map<string, FilePatch>();
  for (const patch of patches) {
    const key = `${patch.oldPath ?? '/dev/null'}\u0000${patch.newPath ?? '/dev/null'}`;
    const existing = merged.get(key);
    merged.set(key, existing ? { ...existing, hunks: [...existing.hunks, ...patch.hunks] } : patch);
  }
  return [...merged.values()];
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Committing (atomic writes + rollback)
// ─────────────────────────────────────────────────────────────────────────────────────────

export async function commitPatch(prepared: PreparedPatch): Promise<PatchTransaction> {
  // TOCTOU guard: the tree must still be exactly what preparePatch() computed against.
  for (const change of prepared.changes) {
    const current = await readCurrent(change.absolutePath, change.relativePath);
    if ((current?.content ?? null) !== change.before) {
      throw new PatchError('STALE_FILE', `${change.relativePath} changed on disk while the patch was being prepared.`, change.relativePath);
    }
  }

  const written: FileChange[] = [];
  const createdDirs: string[] = [];
  try {
    for (const change of prepared.changes) {
      if (change.after === null) {
        await unlink(change.absolutePath);
      } else {
        if (change.kind === 'create') createdDirs.push(...(await ensureDirectory(path.dirname(change.absolutePath))));
        await atomicWrite(change.absolutePath, change.after, change.mode);
      }
      written.push(change);
    }
  } catch (error) {
    let rollbackNote = '';
    try {
      await restore(written, createdDirs);
    } catch (rollbackError) {
      rollbackNote = ` Rollback ALSO failed: ${(rollbackError as Error).message}`;
    }
    throw new PatchError('WRITE_FAILED', `Writing the patch failed: ${(error as Error).message}.${rollbackNote}`);
  }

  let rolledBack = false;
  return {
    changes: prepared.changes,
    get rolledBack() {
      return rolledBack;
    },
    async rollback() {
      if (rolledBack) return;
      rolledBack = true;
      await restore(written, createdDirs);
    },
  };
}

async function restore(changes: readonly FileChange[], createdDirs: readonly string[]): Promise<void> {
  const failures: string[] = [];
  for (const change of [...changes].reverse()) {
    try {
      if (change.before === null) {
        await unlink(change.absolutePath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      } else {
        await atomicWrite(change.absolutePath, change.before, change.mode);
      }
    } catch (error) {
      failures.push(`${change.relativePath}: ${(error as Error).message}`);
    }
  }
  // Remove directories we created (deepest first); rmdir only succeeds when they are empty.
  for (const dir of [...createdDirs].reverse()) await rmdir(dir).catch(() => undefined);
  if (failures.length > 0) throw new PatchError('ROLLBACK_FAILED', `Could not restore: ${failures.join('; ')}`);
}

/**
 * Write-to-temp + rename: readers (and a crash mid-write) never observe a half-written file,
 * because rename() atomically swaps the directory entry on POSIX and NTFS.
 */
async function atomicWrite(target: string, content: string, mode?: number): Promise<void> {
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.devmedic-${process.pid}-${randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    await writeFile(temp, content, { encoding: 'utf8', flag: 'wx' }); // 'wx': never clobber an existing file
    if (mode !== undefined) await chmod(temp, mode); // preserve permissions (e.g. executable scripts)
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/** mkdir -p that reports which directories it actually created (so rollback can remove them). */
async function ensureDirectory(dir: string): Promise<string[]> {
  const missing: string[] = [];
  let probe = dir;
  for (;;) {
    try {
      await stat(probe);
      break;
    } catch {
      missing.unshift(probe);
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  if (missing.length > 0) await mkdir(dir, { recursive: true });
  return missing;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Rendering & fingerprints
// ─────────────────────────────────────────────────────────────────────────────────────────

function formatFileDiff(relativePath: string, kind: ChangeKind, hunks: readonly AppliedHunk[]): string {
  const out = [
    `--- ${kind === 'create' ? '/dev/null' : `a/${relativePath}`}`,
    `+++ ${kind === 'delete' ? '/dev/null' : `b/${relativePath}`}`,
  ];
  for (const hunk of hunks) {
    const oldCount = hunk.lines.filter((l) => l.op !== '+').length;
    const newCount = hunk.lines.filter((l) => l.op !== '-').length;
    out.push(`@@ -${formatRange(hunk.oldStart, oldCount)} +${formatRange(hunk.newStart, newCount)} @@`);
    for (const line of hunk.lines) out.push(`${line.op}${line.text}`);
  }
  return `${out.join('\n')}\n`;
}

/** One line per file: "M src/a.ts +3 -1". */
export function summarizeChanges(prepared: PreparedPatch): string[] {
  const symbol: Record<ChangeKind, string> = { modify: 'M', create: 'A', delete: 'D' };
  return prepared.changes.map((c) => `${symbol[c.kind]} ${c.relativePath} +${c.added} -${c.removed}`);
}

function formatRange(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
}

/**
 * The canonical diff, optionally colorized. Contains nothing but the diff, so dry-run output
 * redirected to a file is directly usable with `git apply` / `patch -p1`.
 */
export function renderPatchPreview(prepared: PreparedPatch, options: { readonly color: boolean }): string {
  const c = pc.createColors(options.color);
  const out: string[] = [];
  for (const line of prepared.diff.replace(/\n$/, '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) out.push(c.bold(line));
    else if (line.startsWith('@@')) out.push(c.cyan(line));
    else if (line.startsWith('+')) out.push(c.green(line));
    else if (line.startsWith('-')) out.push(c.red(line));
    else out.push(line);
  }
  return out.join('\n');
}

/**
 * Identity of a patch *as proposed*: per file, the ordered removed/added lines (trailing
 * whitespace ignored), without positions or context. Two diffs that make the same edit with
 * different hunk headers or context therefore collide — which is exactly what the agent's
 * memory needs to recognize a repeated proposal.
 */
export function semanticFingerprint(patches: readonly FilePatch[]): string {
  const hash = createHash('sha256');
  const entries = patches
    .map((p) => ({ key: `${p.oldPath ?? '/dev/null'} → ${p.newPath ?? '/dev/null'}`, lines: p.hunks.flatMap((h) => h.lines) }))
    .sort((a, b) => a.key.localeCompare(b.key));
  for (const entry of entries) {
    hash.update(`F ${entry.key}\n`);
    for (const line of entry.lines) if (line.op !== ' ') hash.update(`${line.op}${line.text.trimEnd()}\n`);
  }
  return hash.digest('hex').slice(0, 16);
}

/** Fingerprint of raw diff text, or undefined if it does not parse. */
export function fingerprintDiffText(diffText: string): string | undefined {
  try {
    return semanticFingerprint(mergeSameTarget(parseUnifiedDiff(diffText)));
  } catch {
    return undefined;
  }
}

/** Identity of the resulting tree state: touched paths and their new contents. */
function stateFingerprint(changes: readonly FileChange[]): string {
  const hash = createHash('sha256');
  for (const change of [...changes].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    hash.update(`${change.relativePath}\u0000${change.after ?? '\u0000<deleted>'}\u0000`);
  }
  return hash.digest('hex').slice(0, 16);
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
