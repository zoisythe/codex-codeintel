# Changelog

## Unreleased

- Read workspace trust directly from Codex's user config.toml; match the selected directory without parent inheritance, ignore legacy plugin trust lists, and invalidate cached analysis when trust changes.
- Keep Hook scope at the session cwd instead of promoting it to the Git root; expose the trust file and effective level in status and cover parent/child workspaces and live revocation through real MCP/Hook subprocesses.

- Support native TypeScript 7 through the `tsc` built-in (`tsc --lsp --stdio`) with local-first resolution and a pinned temporary recipe; add a local-only `tsgo` preview built-in while preserving the legacy TypeScript default.
- Send object parameters with the LSP `initialized` notification so native TypeScript completes initialization; cover real MCP diagnostics, dependency updates, navigation, rename and formatting.

## 0.5.0

- Breaking: schemaVersion 1, fixed global/project paths, global-only workspace trust and language-keyed server replacement; removed environment overrides and priority competition.
- Local project/PATH tools precede registered ecosystem launchers; Python defaults to ty plus Ruff CLI, including .pyi and no-config Ruff. No clangd/Rust toolchain auto-installation.
- Five MCP tools: unified scope/source/run diagnostics, lazy status, read-only expanded navigation, independent rename and explicit formatting. Opaque cursors replace legacy modes and offsets.
- Capability-aware pull/push diagnostics, quiet windows, pending analysis updates, initialization failure recovery, write preflight and conflict reporting.
- Two active content inventories, one cached inventory, no redundant PreToolUse baseline scan; bounded local timing statistics.
- Updated bundle, Skill, migration guide, real Python/C/C++/Rust subprocess acceptance and performance measurements.

See [migration](docs/migration-0.5.md) and [validation](docs/validation-0.5.md).

## 0.4.0

- Normalize Windows diagnostic URI drive letters and escaping so TypeScript push diagnostics are not left permanently pending; cover canonicalized server URIs in native subprocess tests.

- Ship a concise `lsp` Skill covering tool purposes, scope/session selection, revision/refresh, and write-call conventions.

- Replace shared worker IPC with process-local MCP Engines and independent lint-only Hooks. Release idle LSP clients after two minutes without closing MCP stdio.
- Add versioned, atomic session metadata, short Hook budgets, cancellation cleanup, pending retries and fresh lint-only Stop blocking with fingerprint deduplication.
- Add `lint.javascript`, `lint.python`, `exclude`, unified trust/config paths, configuration-aware cache validation and explicit diagnostics `refresh`.
- Apply directory budgets within the requested scope; require content/config-bound `revision` for nonzero `start`/`offset`, including all/delta output pages.
- Report LSP/lint channels and partial write outcomes separately; preserve explicit-only formatting/rename and bounded local error logs.
- Extend dependency-free delivery subprocess tests to all three CI platforms. See validation.md for actual run evidence; workflow configuration is not a remote pass.


## 0.3.0

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
- Upgrade Biome to 2.5.12, Vitest to 5.0.0, and `@types/node` to 26.4.1. Require Node.js 22.12+ and enable `legacy-peer-deps` so the submodule's Vitest 4 tree can install beside it.
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
