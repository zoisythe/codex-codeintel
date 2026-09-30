# Changelog

## 0.7.0 (unreleased)

- Consolidate current usage and configuration examples; keep phase engineering records locally under ignored `docs/history/` and exclude common local settings/caches from Git.

- Add project CLI checks and reliable pre-edit baselines; deny uncovered or failed-checker source writes while permitting reads and checker configuration repair.
- Compare diagnostic multisets after edits; report introduced findings and repairs, and request one Stop continuation for confirmed unresolved introduced errors.
- Vendor the pinned MIT LSP dependency closure, remove submodule/bootstrap/legacy-peer-deps, and pass explicit subprocess environments.
- Preserve hot clients on cancellation/timeouts, classify configuration impacts precisely, batch lint and use a workspace stat index with shared session snapshots.
- Support Node >=22.12.0, add Linux/macOS/Windows Node 22.12/24 CI, shorten user guidance and publish only user documentation.

- Rename the repository, marketplace and plugin to `codex-codeintel`, the package and CLI to `@zoisythe/codex-codeintel` / `codex-codeintel`, and the `lsp` Skill to `code-intelligence`. Update MCP server identity, Hook feedback and installation guidance; preserve source attribution and Git history. See [upgrading](docs/usage.md#upgrade).
- Keep existing MCP tool names, configuration paths, environment variables and cache/IPC locations compatible across the rename.

## 0.6.0

- Document the original codex-lsp, pi-lsp-client and lsp-tools-mcp sources and independent maintenance by zoisythe; retain existing names, Git history and MIT attribution.
- Share one authenticated local workspace service, Engine, diagnostic cache and LspManager across Hooks and MCP. Initialize/status/cached reads remain lazy; inactive services exit after two minutes.
- Automatically run LSP plus independent lint after edits (delta) and at Stop (full). Configure each event as delta/full/off; a missing baseline starts with full scope. Stop never blocks.
- Keep short Hook waits independent from five-minute background jobs; serialize workspace operations, yield between 50-file batches, merge pending edits and cancel superseded/session-ended tasks.
- Isolate by canonical workspace, user, CODEX_HOME, bundle hash and protocol; include each request's execution environment in tool/client identity. Automatic execution requires trust and never downloads tools.
- Share automatic findings with cached MCP queries, track per-channel pending state in metadata v6, deduplicate feedback and confirm error clearing once. Invalidate changed content/configuration/tools and remove deleted diagnostics.
- Add bundle concurrency/recovery/full-scope acceptance, actual automatic Python/legacy and native TypeScript/C/C++/Rust checks, and a live Codex Hook session. Phase migration and validation records are kept locally in the ignored `docs/history/` directory.


## 0.5.0 follow-up (2026-09-30, 386d1b1)

- Read workspace trust directly from Codex's user config.toml; match the selected directory without parent inheritance, ignore legacy plugin trust lists, and invalidate cached analysis when trust changes.
- Keep Hook scope at the session cwd instead of promoting it to the Git root; expose the trust file and effective level in status and cover parent/child workspaces and live revocation through real MCP/Hook subprocesses.

## 0.5.0 follow-up (2026-09-30, cbe16cb)

- Support native TypeScript 7 through the `tsc` built-in (`tsc --lsp --stdio`) with local-first resolution and a pinned temporary recipe; add a local-only `tsgo` preview built-in while preserving the legacy TypeScript default.
- Send object parameters with the LSP `initialized` notification so native TypeScript completes initialization; cover real MCP diagnostics, dependency updates, navigation, rename and formatting.

## 0.5.0

- Breaking: schemaVersion 1, fixed global/project paths, global-only workspace trust and language-keyed server replacement; removed environment overrides and priority competition.
- Local project/PATH tools precede registered ecosystem launchers; Python defaults to ty plus Ruff CLI, including .pyi and no-config Ruff. No clangd/Rust toolchain auto-installation.
- Five MCP tools: unified scope/source/run diagnostics, lazy status, read-only expanded navigation, independent rename and explicit formatting. Opaque cursors replace legacy modes and offsets.
- Capability-aware pull/push diagnostics, quiet windows, pending analysis updates, initialization failure recovery, write preflight and conflict reporting.
- Two active content inventories, one cached inventory, no redundant PreToolUse baseline scan; bounded local timing statistics.
- Updated bundle, Skill, migration guide, real Python/C/C++/Rust subprocess acceptance and performance measurements.

Phase migration and validation records are kept locally in the ignored `docs/history/` directory.

## 0.4.0

- Normalize Windows diagnostic URI drive letters and escaping so TypeScript push diagnostics are not left permanently pending; cover canonicalized server URIs in native subprocess tests.

- Ship a concise `lsp` Skill covering tool purposes, scope/session selection, revision/refresh, and write-call conventions.

- Replace shared worker IPC with process-local MCP Engines and independent lint-only Hooks. Release idle LSP clients after two minutes without closing MCP stdio.
- Add versioned, atomic session metadata, short Hook budgets, cancellation cleanup, pending retries and fresh lint-only Stop blocking with fingerprint deduplication.
- Add `lint.javascript`, `lint.python`, `exclude`, unified trust/config paths, configuration-aware cache validation and explicit diagnostics `refresh`.
- Apply directory budgets within the requested scope; require content/config-bound `revision` for nonzero `start`/`offset`, including all/delta output pages.
- Report LSP/lint channels and partial write outcomes separately; preserve explicit-only formatting/rename and bounded local error logs.
- Extend dependency-free delivery subprocess tests to all three CI platforms. Phase validation records are kept locally in `docs/history/`; workflow configuration is not a remote pass.


## 0.3.0

Released from 50138d8 (2026-09-08). Earlier packaging/toolchain changes below preceded this release.

- Ship a self-contained `dist/cli.js` bundle so clean installs no longer need submodule contents or runtime `node_modules`.
- Replace the upstream MCP tool surface with four static tools: `check_diagnostics`, `lsp_diagnostics`, `lsp_navigation`, and `lsp_format`.
- Add a workspace-shared worker, inventory-based PostToolUse/Bash change tracking, SessionStart baseline, and SessionEnd cleanup.
- Remove Skills from the plugin package and run the bundle from Codex's plugin-relative MCP cwd.
- Keep Biome/ESLint/Ruff as trusted, check-only runners; formatting remains an explicit tool. Disable Ruff cache writes to avoid self-triggered Hook feedback.
- Validate MCP arguments, content-check explicitly ignored files before cache reuse, retain over-budget changed paths as pending, and recheck rename targets.
- Add source/bundle drift checking and a dependency-free delivery CI job on Linux, macOS and Windows.

- Restore `.codex-plugin/plugin.json` so this repository is a standalone Codex plugin again.
- Point package, plugin, and marketplace metadata at [`zoisythe/codex-lsp-standalone`](https://github.com/zoisythe/codex-lsp-standalone).
- Disable npm lifecycle scripts during install so native optional packages cannot run install hooks.
- Historical development updates: Biome 2.5.12, Vitest 5.0.0, Node types 26.4.1 and legacy peer handling for the former submodule.
- Point the `packages/lsp-tools-mcp` submodule at [`zoisythe/lsp-tools-mcp`](https://github.com/zoisythe/lsp-tools-mcp) and pin `main` at `9cc6f75`.
- Install `smol-toml` as an optional dependency so Cargo workspace parsing works after a parent `npm install`.
- Require Node.js 24.20.0 LTS (Krypton).

## 0.2.0

- Extracted the LSP runtime and MCP server into [`@code-yeongyu/lsp-tools-mcp`](https://github.com/code-yeongyu/lsp-tools-mcp).
- codex-lsp now consumes that runtime as a git submodule at `packages/lsp-tools-mcp`.
- Kept the Codex-specific PostToolUse hook in this package and routed MCP serving through the upstream CLI.

- Extract LSP runtime to `lsp-tools-mcp` upstream and consume it via git submodule at `packages/lsp-tools-mcp`.
- Renamed the MCP server namespace to `lsp` and exposed shorter tool names such as `lsp.diagnostics`.
- Use portable Codex hook interpolation and add package smoke coverage for hook/MCP entrypoints.
- Spawn language servers without shell mode; Windows `.cmd` and `.bat` shims are routed through `cmd.exe` with explicit arguments.
- Cap directory diagnostics file traversal and run CI on Windows in addition to Ubuntu and macOS.
- Replace the external JSON-RPC runtime dependency with an internal LSP framing layer so clean Codex plugin installs run without `node_modules`.

## 0.1.0

- Ported the standalone LSP client, server resolution, diagnostics aggregation, and workspace edit runtime from `pi-lsp-client`.
- Added Codex `PostToolUse` diagnostics for edit-style tools.
- Added MCP tools for status, diagnostics, definitions, references, symbols, prepare rename, and rename.
- Added Codex plugin metadata, skill docs, CI, and release automation.
