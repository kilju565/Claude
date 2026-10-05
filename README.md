# DevMedic

A self-healing CLI agent for failing integration tests. DevMedic runs your test command, reads
the failure, finds the failing test and the source code behind it, asks a model for a fix as a
unified diff, applies the diff transactionally, and re-runs the tests. It repeats until the suite
passes or `MAX_RETRIES` is reached.

```text
$ devmedic -c "npm run test:integration"

▶ Execute   Initial run: npm run test:integration
▶ Intercept exit code 1 after 0.4s — captured 2120 chars of output
▶ Analyze   AssertionError: Expected values to be strictly equal: 17 !== 29 @ test/checkout.integration.test.js:12
── Attempt 1/3 ──────────────────────────────────────
▶ Read      4 file(s): test/checkout.integration.test.js (test), src/checkout.js, src/discounts.js, src/pricing.js
▶ Plan      asking the model for a patch
▶ Patch     applied src/pricing.js (+1 -1)
▶ Execute   Verify: npm run test:integration
⚠ Still failing (failure changed); patch rolled back.
── Attempt 2/3 ──────────────────────────────────────
⚠ Memory: this patch was already tried in attempt #1 (tests-failed) — re-prompting.
▶ Patch     applied src/pricing.js (+1 -1)
✔ Progress: failing tests 2 → 1; keeping this patch as the new baseline.
── Attempt 3/3 ──────────────────────────────────────
▶ Patch     applied src/discounts.js (+1 -1)
✔ Tests passed (0.2s)
✔ Tests pass after 3 attempt(s).
```

> **Model status:** the LLM call is mocked. `MockLLMClient` returns simulated JSON patch objects,
> either scripted from a fixture file or generated from the failure context. Everything else is
> real: process execution, stack-trace analysis, file I/O, patch application, verification,
> rollback, and memory. See [Plugging in a real model](#plugging-in-a-real-model).

## Quick start

```bash
npm install
npm run demo                     # builds, copies examples/checkout-service to a temp dir, and heals it
npm run demo -- user-directory   # the same for the TypeScript example
npm test                         # unit + integration tests
```

Each example is a small project with a real failing `node --test` suite and a scripted mock
fixture. The demo runs on a temporary copy, so the examples in the repository stay broken.

| Example | Failure | What the run shows |
| --- | --- | --- |
| [`checkout-service`](examples/checkout-service) (JavaScript) | Two assertion failures from two bugs | Attempt 1 is a wrong fix and is rolled back. In attempt 2 the model first repeats that fix with different formatting, which memory rejects, and then fixes one bug, which is kept. Attempt 3 fixes the second bug using a hunk header that is off by one line, and the suite goes green. |
| [`user-directory`](examples/user-directory) (TypeScript) | A `TypeError` thrown inside the source code | The stack trace points straight at `src/users.ts:14`. Attempt 1's patch quotes code that isn't in the file, so the patcher refuses it and reports the exact mismatch. Attempt 2 adds the missing guard, and the suite goes green. |

## Architecture

```text
cli.ts ─ flags → DevMedicConfig · SIGINT → AbortSignal · AgentStatus → exit code
  │
  ▼
agent.ts (HealingSession)
  1 Execute     executor.ts   run the test command (execa, shell, timeout, cancellation)
  2 Intercept   exit code > 0 → keep stdout, stderr, and the interleaved output
  3 Analyze     analyzer.ts   stack frames → failing test file + originating source files
  4 Read        context.ts    implicated files + modules the failing tests import
  5 Plan/Patch  llm.ts        structured prompt → JSON {analysis, plan, confidence, patch}
                memory.ts     reject patches (or resulting states) already tried
                patcher.ts    parse diff → policy checks → apply in memory → atomic commit
  6 Verify      executor.ts   re-run the tests
  7 Halt        green → done · fewer failures → keep as baseline · otherwise roll back
                MAX_RETRIES reached → restore the tree, exit 1
```

| Module | Responsibility |
| --- | --- |
| [`src/cli.ts`](src/cli.ts) | Parses arguments with commander (with env-var fallbacks), builds the config, handles SIGINT/SIGTERM (first signal stops and rolls back, second forces exit), maps results to exit codes. |
| [`src/executor.ts`](src/executor.ts) | Runs the test command with execa through a shell. Captures stdout, stderr, and an interleaved stream, and enforces timeout, cancellation, and buffer limits. Detects commands that can't start (exit 127 or 9009, or a spawn error) so no retries are spent on them. |
| [`src/analyzer.ts`](src/analyzer.ts) | Strips ANSI codes and resolves `\r` overwrites. Parses frames in V8, node:test TAP, Vitest, Jest, tsc, and Python formats. Filters out runtime internals, `node_modules`, and files outside the project. Ranks test files and source files separately, and extracts the primary error, test names, and the failing-test count. Produces a stable failure signature and a size-bounded log excerpt. |
| [`src/context.ts`](src/context.ts) | Reads the implicated files and follows the failing test's relative imports breadth-first (an assertion failure's stack only points at the test file). Enforces file-count, file-size, and character budgets, and records a SHA-256 of each file. |
| [`src/llm.ts`](src/llm.ts) | Holds the `LLMClient` interface, the structured prompt, a zod schema for the JSON response (also exported as JSON Schema), a tolerant response parser, and `MockLLMClient`. |
| [`src/patcher.ts`](src/patcher.ts) | Parses unified diffs, locates hunks with bounded tolerance, and applies them in memory. Commits atomically, returns a rollback handle, and renders dry-run output. |
| [`src/memory.ts`](src/memory.ts) | Stores the attempt history and fingerprints used to detect duplicate patches. |
| [`src/agent.ts`](src/agent.ts) | Orchestrates the loop: the ratchet, re-prompting on duplicates, and cleanup on every exit path. |

### Design decisions

- **The model returns a diff, and DevMedic applies it.** The response is untrusted input. It is
  validated with zod, then the diff is parsed, checked against policy, and applied in memory
  before any byte is written.
- **Failed attempts are rolled back.** Every attempt starts from a known state, and the prompt
  describes what was tried and what happened.
- **The ratchet.** If a patch reduces the number of failing tests (read from the runner's summary
  line), it is kept as the new baseline instead of being rolled back. A suite with several bugs
  can then be fixed one bug per attempt. On abort, kept patches are reverted too (unless
  `--keep-partial` is set), so the tree is left as it was found.
- **Memory keys on meaning, not text.** Each attempt gets two fingerprints:
  - The *diff fingerprint* hashes the removed and added lines for each file, ignoring positions
    and context. The same edit with different hunk headers or context still matches.
  - The *state fingerprint* hashes the resulting contents of the touched files, so two different
    diffs that produce the same code also match.

  Duplicates are rejected before anything runs, and the model is re-prompted (a bounded number of
  times) with the reason.

- **Termination is guaranteed.** At most `maxRetries × (1 + maxDuplicateReprompts)` model calls
  and `1 + maxRetries` test runs.

## Usage

```bash
devmedic -c "npm run test:integration"                 # heal in place
devmedic -c "npx vitest run" --dry-run > fix.patch      # preview only; stdout is a pure, git-applicable patch
devmedic -C ./service -c "npm test" -r 5 --stream       # other project, 5 attempts, live test output
```

| Option | Default | Description |
| --- | --- | --- |
| `-c, --command <cmd>` | required (env `DEVMEDIC_TEST_COMMAND`) | Test command, run through a shell. |
| `-C, --cwd <dir>` | current directory | Project root. All reads and writes are confined to it. |
| `-r, --max-retries <n>` | `3` (env `DEVMEDIC_MAX_RETRIES`) | Maximum patch attempts (`MAX_RETRIES`). |
| `--dry-run` | off | Print the proposed patch to stdout instead of writing it. |
| `-t, --timeout <s>` | `600` | Timeout for each test run. |
| `--allow-test-edits` | off | Let the model modify test files. |
| `--keep-partial` | off | On abort, keep patches that reduced the number of failing tests. |
| `--max-context-files <n>` | `8` | Maximum number of files sent to the model. |
| `--max-file-kb <n>` | `256` | Larger files are sent as excerpts around the implicated lines. |
| `--max-changed-lines <n>` | `400` | Reject patches that change more lines than this. |
| `--mock-fixture <file>` | — (env `DEVMEDIC_MOCK_FIXTURE`) | Scripted responses for the mock model. |
| `--stream` | off | Mirror test output to stderr while it is captured. |
| `-v, --verbose` / `-q, --quiet` | — | Debug output (including prompts), or warnings and errors only. |

**Exit codes:**

| Code | Meaning |
| --- | --- |
| `0` | Tests pass, or `--dry-run` produced a proposal. |
| `1` | Tests still failing (retries exhausted, or no fix could be produced). |
| `2` | Invalid usage, or the test command can't be started. |
| `130` | Interrupted (changes rolled back). |

All diagnostics go to **stderr**, so stdout carries only the dry-run patch.

## Safety model

`preparePatch()` enforces every check below before `commitPatch()` writes anything:

| Guard | What it prevents |
| --- | --- |
| Path confinement | Absolute paths, `..` traversal (checked on the resolved path), writes into `.git/` or `node_modules/`, symlinks that resolve outside the root, and patching through a symlink. |
| Protected files | Lockfiles, `.env*`, `.npmrc`, and key material. Test files are also protected unless `--allow-test-edits` is set, so the agent can't make a suite pass by weakening it. |
| Blast radius | More than 10 files, or more than `--max-changed-lines` changed lines, in one patch. Deletes and renames are refused. |
| Content integrity | Binary or non-UTF-8 files, which could be corrupted. Hunks must match the file. Tolerance is bounded (offset search, GNU-style fuzz ≤ 2, whitespace-insensitive comparison), and a block of only braces may match only at its exact position. A context-less insertion into a non-empty file is refused. |
| Staleness | A file that changed after the model read it (SHA-256 check), or changed between prepare and commit (TOCTOU check). |
| Atomicity | New content goes to a temp file that is then renamed into place. If a write fails partway, files already written are restored. File permissions and each line's own line ending (LF or CRLF) are preserved, and so is a missing final newline. |
| Rollback on every exit path | A patch that fails verification, a crash, or Ctrl-C restores the files. |
| Dry run | `--dry-run` computes and validates everything but writes nothing. |

## Stack-trace support

| Source | Example | Notes |
| --- | --- | --- |
| V8 (Node, Jest, Mocha) | `at fn (/repo/src/a.ts:12:5)`, `at file:///repo/a.mjs:3:1` | Windows drive letters and parentheses inside paths are handled. |
| node:test TAP | `TestContext.<anonymous> (file:///repo/t.js:6:10)` inside `stack: \|-` | These frames have no `at ` prefix, so they are only matched inside YAML stack blocks. |
| Vitest | `❯ explode src/calc.ts:5:19` | The function name is optional. |
| tsc | `src/a.ts(12,5): error TS2322` / `src/a.ts:12:5 - error TS2322` | Treated as the strongest evidence. |
| Python | `File "/repo/app.py", line 12, in fn` | Frames are reversed, because Python prints the innermost call last. |
| Fallback | `path/to/file.ts:12` | Used only when nothing structured matched. |

Compiled paths such as `dist/x.js` are mapped back to `src/x.ts` when no source maps are available.
Failing-test counts are parsed from Jest, Vitest, node:test (TAP and spec), Mocha, and pytest
summaries.

## Plugging in a real model

Implement the single-method interface in [`src/llm.ts`](src/llm.ts):

```ts
export interface LLMClient {
  readonly name: string;
  /** Returns the model's raw text response (expected: one JSON PatchProposal). */
  generatePatch(request: PatchRequest): Promise<string>;
}
```

`request.prompt` contains the `system` and `user` strings built by `buildPatchPrompt()`.
`PatchProposalJsonSchema` is the response schema, ready to pass to a provider's structured-output
feature. With the Anthropic SDK (`@anthropic-ai/sdk`) and a model such as `claude-opus-5-5`,
`generatePatch` sends those two strings and returns the text. Validation, memory, patching, and
verification don't change. Then pass your client to `runAgent()` instead of the mock (see
`main()` in [`src/cli.ts`](src/cli.ts)).

### Mock fixture format

```json
{
  "responses": [
    { "analysis": "…", "plan": ["…"], "confidence": 0.8, "patch": "--- a/src/x.js\n+++ b/src/x.js\n@@ …" },
    "raw strings are returned verbatim (useful to simulate malformed output)"
  ]
}
```

The mock uses one entry per model call. When the script runs out, it generates a real, applicable
diff that only inserts an investigation comment. That exercises the whole pipeline without
claiming to fix anything.

## Development

```bash
npm run build       # tsc → dist/
npm run typecheck   # strict type-check of src/ and test/
npm test            # vitest: analyzer/patcher/context/llm/memory unit tests + agent & CLI integration tests
```

This requires Node.js 22.12 or later (the TypeScript example also relies on Node's built-in type
stripping, which is on by default from 22.18). The integration tests run the real `node --test`
suites of both examples in temporary directories; only the model is scripted.
