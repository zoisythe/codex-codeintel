# 0.6.0 automatic diagnostics acceptance

Executed locally on 2026-09-30, Linux x86_64 / WSL2, Node.js 26.10.0 and npm 12.1.0. Windows and macOS were not executed; workflow configuration is not platform acceptance evidence.

## Delivered identity

- Package/plugin/MCP version: `0.6.0`.
- Bundle SHA-256: `2a5a4cae6b972c167ba1981899888236c16cae8a656733600cdf778f9096a29f`.
- Upstream submodule: `9cc6f753d04834c148d08bbca72e3b483d6301b2` (unchanged).
- Findings stay in memory. Session metadata is v6; prepared Ruff path metadata retains its existing v5 cache for reuse.
- Source and delivered bundle passed strict TypeScript, Biome and build verification. These validation runs preceded repository delivery; they did not publish a package or rewrite Git history.

## Commands and results

```sh
npm run check
npm test
npm run typecheck
CODEX_LSP_REAL_TOOLS=1 npm run test:real
git diff --check
```

`npm test`: 32 Vitest tests, 21 delivered-bundle subprocess tests and 1 actual native TypeScript MCP test. Real-tool acceptance: 5 tests, including automatic ty, traditional/native TypeScript, clangd C/C++ and rust-analyzer, plus the existing three-language navigation/write/tool-resolution acceptance and temporary/offline preparation tests. No final acceptance test was skipped on this platform.

`test/automatic-e2e.test.mjs` verifies actual delivered Hook/MCP subprocesses for:

- Lazy status/cached reads and baselines; automatic delta findings shared with two MCP connections and channel-specific cached queries.
- Error repair confirmation once, feedback deduplication, new/deleted/moved files, missing-baseline full fallback and full Stop output without a block decision.
- A 73-file full task completing both batches, including the last file; identical installed bundle copies sharing one service.
- Concurrent cold startup with one LSP, short wait returning pending, background completion retrieved on a later Hook, session cancellation without deleting another session, and restart.
- Request environment changes invalidating cache/client identity without returning inherited environment values in status.
- Continuous edits preventing older findings from being delivered; trust revocation cancelling cold automatic work.
- SIGKILL recovery with unchanged service identity and a fresh PID; durable pending scope reconstructing the job.
- Startup failure and 1 MiB inventory-limit feedback remaining partial; an accelerated five-minute deadline preserving pending and never blocking Stop.
- Local-only automatic resolution: an available uvx trap is never invoked, including an explicitly configured temporary launcher.
- Incorrect IPC authentication token/protocol rejected before a formatting write; the authenticated client remains usable.

Existing bundle suites retain cursor pagination/invalidation, lazy failure refresh/expiry, idle shutdown/restart, navigation, sequential rename/format, cancellation, complete partial-write paths, trust/parent-child isolation and installation without dependencies. The idle test advances a clock through a subprocess preload; the automatic deadline test shortens only the test subprocess's `AbortSignal.timeout(300000)`. Neither introduces a production test setting.

## Actual automatic language tools

`test/automatic-real-e2e.test.mjs` establishes a baseline, edits each source to introduce an error, retrieves automatic PostToolUse feedback, fixes the source and receives the clearing confirmation. It never calls diagnostic MCP during this sequence; only status is read afterward. Traditional TypeScript dependencies are installed explicitly during fixture setup before automatic execution.

Toolchain: ty 0.0.82, Ruff 0.16.8, clangd 22.1.8, rust-analyzer 1.98.1, traditional TypeScript 5.9.3 and native TypeScript 7.0.2. The measured executable commands and per-workspace service identities are in [the raw performance record](performance-0.6-real.json).

| Fixture | Cold Hook ms | Edit/fix Hook ms | LSP process starts |
| --- | ---: | ---: | ---: |
| python | 614 | 123 | 1 |
| typescript | 1210 | 671 | 1 |
| native-typescript | 632 | 143 | 1 |
| c | 829 | 335 | 1 |
| cpp | 816 | 345 | 1 |
| rust | 2845 | 823 | 1 |

These are one-pass small-fixture observations, including Hook startup, discovery, IPC and diagnostic waiting; they are not a repeated benchmark or a large-workspace latency guarantee. Each language fixture reused one LSP process across introducing and fixing its error. The cold-delay bundle fixture independently verifies pending feedback before server initialization finishes.

## Actual Codex session

A real `codex exec` session used an isolated CODEX_HOME and trusted fixture workspace, with the delivered Hook command configured through `hooks.json`. The invocation used `--dangerously-bypass-hook-trust` only for this vetted test definition; it did not change the user's installed plugin or persistent Hook trust. The existing login was reused without copying credentials into repository artifacts.

Session: `01a0f247-7c06-7883-b406-7c4dab64260c`, model `gpt-6.1-sol`. Codex executed exactly two `apply_patch` calls and no diagnostic MCP calls. The first changed `value: int = 1` to `value: int = "wrong"`; the next restored it. Actual Hook outputs supplied `error [ty/invalid-assignment]` and `main.py: previous diagnostics cleared`, and the model's next commentary explicitly acknowledged both. Stop supplied only `systemMessage` with full `checked=1/1 errors=0 pending=0`; SessionEnd returned no output.

[Captured event/output evidence](codex-session-0.6.json) includes SessionStart, PreToolUse, PostToolUse, Stop and SessionEnd plus the model's observations, tied to the final bundle SHA-256. It contains no authentication material. The separate installation-copy tests verify the bundled plugin delivery path; this live session tests Codex's actual Hook feedback consumption.

IPC transport follows [Node's Unix socket / Windows named-pipe support](https://nodejs.org/api/net.html#ipc-support). Hook outputs and the distinction between installation and Hook-definition trust follow [the official Hook documentation](https://learn.chatgpt.com/docs/hooks) and [plugin packaging documentation](https://developers.openai.com/plugins/build/plugins).
