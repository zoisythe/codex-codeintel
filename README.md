# Codex CodeIntel

[![ci](https://github.com/zoisythe/codex-codeintel/actions/workflows/ci.yml/badge.svg)](https://github.com/zoisythe/codex-codeintel/actions/workflows/ci.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Standalone Codex plugin with five MCP tools and automatic LSP/lint Hooks. Requires Node.js `>=24.20.0`. Installed copies run the self-contained `dist/cli.js`; only development uses the pinned `lsp-tools-mcp` submodule.

Maintained independently by [zoisythe](https://github.com/zoisythe). This project originated from [code-yeongyu/codex-lsp](https://github.com/code-yeongyu/codex-lsp), whose runtime derives from `pi-lsp-client` and `lsp-tools-mcp`. The repository and plugin are named `codex-codeintel`; the package is `@zoisythe/codex-codeintel`. See [source attribution and independent maintenance](docs/provenance.md) for the retained history, licenses and maintenance policy.

Renamed from `codex-lsp-standalone` / `codex-lsp`; see the [name migration guide](docs/migration-codeintel.md) for installation and Skill changes, and [rename acceptance](docs/validation-codeintel.md) for verified installation and runtime behavior.

**0.6.0 enables automatic diagnostics by default.** Read the [automatic diagnostics migration guide](docs/migration-0.6.md) and the [configuration and MCP migration guide](docs/migration-0.5.md). There are no aliases for the removed tools, modes or environment overrides.

## Execution

```text
Codex --stdio--> MCP process ----local IPC----> shared workspace service
Codex --Hook---> short Hook ------local IPC----> Engine / LspManager / lint
                          durable session hashes and pending boundaries
```

A local service owns the Engine, LSP clients and in-memory findings. MCP navigation, sequential writes, manual checks and automatic Hooks share those clients. Services are isolated by user, canonical workspace, CODEX_HOME, bundle content hash and IPC protocol version. Unix sockets / Windows named pipes use a private endpoint directory, authentication token, handshake and startup mutex.

Initialize, status and cached queries remain lazy; they do not launch a stopped service or LSP. Active requests start the service on demand. A workspace schedules analysis and writes sequentially; automatic jobs yield between batches of at most 50 files so waiting foreground requests can run. With no requests or running jobs for two minutes, the service closes all its clients and exits. MCP EOF cancels only that connection's requests.

Diagnostics live only in memory. Session metadata retains generations, hashes, pending channel paths and feedback fingerprints. A later Hook reconstructs unfinished work after a service crash. Automatic checks never download tools, format or lint-fix.

## Tools

Every tool requires the absolute user repository as `workspace`. Paths resolve inside that workspace. Navigation positions are 1-based.

| Tool | Behavior |
| --- | --- |
| `check_diagnostics` | `scope=paths/turn/session`, `source=lsp/lint/both`, `run=active/cached`; defaults paths + both + active, no path means workspace |
| `lsp_status` | Configuration/trust, selected commands and sources, launchability, running state, failure recovery, automatic settings, service/task progress and bounded timing statistics; optional path and refresh |
| `lsp_navigation` | Read-only definition, references, symbols, prepare_rename, hover, typeDefinition, implementation, signatureHelp |
| `lsp_rename` | Explicit cross-file rename using path, position and newName |
| `lsp_format` | Explicit paths; Ruff for Python, configured project formatter or LSP for other languages |

Text summaries accompany structured results, channel states, error/warning counts and unavailable reasons. Directory scans process available languages and report partial results. Unsupported explicit files and entirely unavailable target scopes produce MCP `isError`. Unsupported navigation capabilities are separate from language availability.

Cached requests never run analysis. Completed automatic Hook results are available to every MCP connection sharing the service; unfinished files remain pending. Turn/session scopes use the existing Hook session boundaries; provide `session` if more than one session shares the workspace. `complete` is evidence about the requested scope and executed channels, not a replacement for builds or tests.

Follow the complete structured `next` arguments with their opaque `cursor`. Content, configuration, tool or result changes invalidate continuation; restart without cursor. Active pages check up to 50 files. Inventory is limited to 10,000 files and 1 MiB per file. Explicit files bypass exclusions, not workspace/size limits. Incomplete dependency inventory prevents fresh cache reuse.

Writes preflight all target languages, check conflicts and proceed sequentially. Structured `modifiedPaths` retains complete write records even when text is shortened. Cancellation or later failures report completed writes; changes are neither replayed nor rolled back automatically. Use the included [code-intelligence Skill](skills/code-intelligence/SKILL.md) for tool selection.

## Configuration and local tools

Read `$CODEX_HOME/lsp-client.json` (default `~/.codex/lsp-client.json`) and trusted `<workspace>/.codex/lsp-client.json`. Both require `schemaVersion: 1`. Trust comes only from `[projects."/absolute/workspace"].trust_level = "trusted"` in Codex's user `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`). The plugin reads Codex's recorded choice and never prompts or writes trust records. Legacy `trustedWorkspaces` is ignored; project files cannot grant trust.

Trust matches the selected workspace directory itself, with real paths used for directory aliases; it never inherits from a parent directory. With `/PJ` as the trusted workspace, files under `/PJ/PJ1` can be checked. Selecting `/PJ/PJ1` as a separate workspace requires its own Codex trust entry, even inside the same Git repository. Hooks use the session `cwd`; MCP uses the requested `workspace`. Status reports the user trust file and effective level. Missing or unrecognized entries are untrusted; malformed user TOML reports a configuration error. Changes to the selected workspace's trust invalidate analysis/client state on the next request or Hook. Untrusted project plugin configuration does not participate in merging.

See [Codex trust acceptance](docs/validation-codex-trust.md) for the verified MCP/Hook behavior.

```json
{
  "schemaVersion": 1,
  "automaticDiagnostics": { "postToolUse": "delta", "stop": "full" },
  "lsp": { "python": "ty", "cpp": "clangd", "rust": "rust" },
  "lint": { "javascript": "auto", "python": "auto" },
  "formatting": { "tabSize": 4, "insertSpaces": true },
  "exclude": ["generated/**"]
}
```

Precedence is built-ins < global < project. LSP language entries replace whole entries; arrays replace whole arrays. Each language selects a built-in name, custom command/extensions (optional env/initialization), or false. Extension conflicts and obsolete priority/disabled fields are errors. See the migration guide for custom examples and language keys.

Explicit commands always win and never fall back. Built-ins search nearest project `.venv` or `node_modules/.bin`, stopping at the workspace root, then PATH. For explicit active MCP calls, missing tools may use registered temporary recipes: Python tries uvx, uv tool run, then pipx run; npm tools use npx. TypeScript's temporary recipe includes TypeScript 5.9.3, which provides tsserver.js. Launchers cannot replace an incompatible or broken local tool. A recipe indicates an available attempt; successful LSP initialization is required for running status.

For native TypeScript 7, set `"lsp": { "typescript": "tsc" }`. This selects `tsc --lsp --stdio`; a missing local executable may use the registered `typescript@7.0.2` npx recipe. A locally selected TypeScript 6 or older `tsc` fails without downloading a replacement. The legacy `"typescript"` built-in remains the default (`typescript-language-server --stdio`). Preview installations can select `"tsgo"` for `tsgo --lsp --stdio`, which requires a project/PATH executable and has no temporary recipe. Replace the `typescript` language entry rather than adding another language with overlapping extensions.

Trusted active MCP calls can download registered tools into tool caches without modifying project dependencies, lockfiles or global installations. Hooks never download. Ruff prepared through uv/uvx is recorded as an executable path for later direct Hook execution; if the cache disappears, Hook reports it unavailable. clangd and rust-analyzer have no automatic toolchain installation path.

Python `.py`/`.pyi` defaults to `ty server` for type diagnostics/navigation and Ruff CLI for lint/format. Ruff uses its own defaults without a configuration file. Missing Ruff disables only Ruff capabilities. C/C++ use clangd diagnostics/navigation/formatting; Rust uses rust-analyzer and its rustfmt formatting integration. clangd can operate with its fallback compile command when no compilation database is present; this is not equivalent to a missing server.

Lint requires trust. JavaScript selection is auto/biome/eslint/off, with matching project configuration; auto prefers Biome. Python selection is auto/ruff/off. Turning lint off does not disable explicit formatting. Formatting defaults to four spaces; project formatters can apply their native settings.

Workspace content is hashed conservatively. Direct tool configuration participates in identity, including ty/Python/Ruff, `.clangd`, compilation databases, `.clang-format`, Cargo manifests/lockfiles, Rust toolchain and rustfmt files. External dependency changes require `refresh`. Status refresh clears clients and failures without starting analysis; active diagnostics refresh forces revalidation. Initialization failures retry after 30 seconds, or immediately when configuration/resolution changes.

## Hooks

| Event | Behavior | Wait / host budget |
| --- | --- | --- |
| SessionStart / PreToolUse | Establish missing baseline; no analysis | 4.4 / 10 s |
| PostToolUse | Delta: complete diagnostics for changed and unfinished files | about 5 / 10 s |
| Stop / SubagentStop | Full workspace, including unmodified callers; never blocks | about 45 / 50 s |
| SessionEnd | Cancel only this session's tasks and clear its state | 1.6 / 3 s |

`automaticDiagnostics.postToolUse` and `.stop` each accept `delta`, `full`, or `off`. They follow the same global/trusted-project precedence as other settings. Delta selects files; it does not calculate added/removed-error differences. A first PostToolUse without a baseline uses full scope. New, moved and deleted files update both LSP and caches; removed diagnostics disappear.

Automatic execution requires recorded workspace trust and available local tools. LSP and lint retain separate states; a missing server does not suppress available lint. Disabled language entries are excluded from automatic scope. Changed configuration, tool environment, file content or task generation prevents delivery of older results. Failed, skipped, stale, pending and incomplete discovery are partial results, never a clean result.

A Hook wait timeout leaves the service job running for up to five minutes. Pending ranges survive a job deadline and are retried by later Hooks. Full jobs complete their own batches without requiring a manual cursor. PostToolUse reports through `additionalContext`; Stop reports completion, errors and unfinished range through `systemMessage` only. Matching feedback is deduplicated, and a previously reported error receives one clearing confirmation when fixed. Background completion is retrieved on a later Hook or MCP query; it cannot inject into an ended Hook.

Incomplete discovery retains the previous baseline. Missing session_id disables automatic checking with an explanatory note. SessionEnd cleanup still works when configuration is broken. Workspace trust and Codex Hook-definition trust are separate; a user must review updated Hook definitions through `/hooks` after installation.

## Install

```bash
codex plugin marketplace add https://github.com/zoisythe/codex-codeintel
codex plugin add codex-codeintel@codex-codeintel
```

Start a new session and review the exact Hook definitions through `/hooks`. Installation does not grant Hook trust. Installed copies need neither npm install nor a recursive submodule checkout. MCP runs with plugin-relative cwd; the user repository is supplied as workspace.

## Development and validation

```bash
git submodule update --init packages/lsp-tools-mcp
npm install
npm run bootstrap
npm run check
npm test
npm run typecheck
CODEX_LSP_REAL_TOOLS=1 npm run test:real
node scripts/benchmark.mjs
```

`npm test` includes real native TypeScript 7 MCP acceptance; use `npm run test:typescript` to run that acceptance alone. See [native TypeScript validation](docs/validation-typescript-native.md) for the verified scope.

The bootstrap rebuilds the pinned upstream source. Tests exercise the delivered bundle in MCP/Hook subprocesses, including installation copies without development dependencies. Real-tool tests are opt-in and need working local Python, Clang and Rust tooling. [0.6 validation](docs/validation-0.6.md) distinguishes actual Linux evidence from historical [0.4](docs/validation.md) and [Windows](docs/windows-validation.md) results. No 0.6 Windows/macOS result is claimed by the CI workflow alone.

## Privacy

No telemetry. MCP/Hook stdout is protocol-only. `metadata-v6-*` stores content hashes, change generations, touched/pending/delivery boundaries, separate channel pending paths and feedback fingerprints, not findings. Atomic updates use a bounded per-session mutex; dead-writer recovery preserves concurrent state. Analysis holds no metadata lock.

Fixed-category `logs-v5` files contain no source, environment values or raw error text and are limited to 1 MiB plus one rotated file per instance. In-process timing samples are bounded to 128 per category and exposed by status. Private `clsp6-<user>` endpoint files store service PID, identity and authentication token, never diagnostics or environment values. Request environments travel over authenticated local IPC and participate in tool/client identity; services do not reuse the first starter's PATH for subsequent requests. Prepared Ruff metadata under `$CODEX_HOME/cache/codex-lsp-v5/tools` stores only its executable path.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
