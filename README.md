# Codex CodeIntel

Standalone Codex plugin for local code intelligence. **Node.js 24.20+ (24.x) or 26.13+ (26.x)**, ten MCP tools, optional Hooks, and a self-contained bundle with no runtime dependency installation.

## Install

```sh
codex plugin marketplace add https://github.com/zoisythe/codex-codeintel
codex plugin add codex-codeintel@codex-codeintel
```

Start a new session and review Hook definitions through `/hooks`. Use **setupLSP** (`$setup-lsp`) to configure or repair the current project's tools.

**0.10 is a breaking upgrade:** old MCP names no longer execute. `rename` and `format` now return previews; **only `apply` writes source files**.

## Tools

| Tool | Purpose |
| --- | --- |
| `check` | Start/read project CLI checks; follow `next` until finished. |
| `diagnostics` | LSP/lint for explicit paths or turn/session scope; optional rule/severity filters and cached reads. |
| `status` | Configuration, local tools, capabilities and failures without starting servers or downloading tools. |
| `warmup` | Initialize local servers for explicit files or two representative languages; no diagnostics or downloads. |
| `navigate` | Symbols, definitions, references, hover, signatures, declarations, call/type relationships and completion. |
| `rename` | Preview a cross-file rename and return a plan. |
| `format` | Preview explicitly scoped formatting and return a plan. |
| `inspect` | Explore a symbol or analyze affected files, callers and candidate tests. |
| `actions` | List, explain or preview Ruff/Biome/ESLint and LSP text fixes. |
| `apply` | Apply one existing plan once; returns complete `modifiedPaths`, continuing pages when necessary. |

Use the absolute project as `workspace`. Positions use 1-based UTF-16 columns. Choose line/column, a symbol path such as `Class.method`, or a text anchor such as `function @@greet`. Ambiguous targets return candidates.

```json
{"workspace":"/project","path":"src/main.ts","symbol":"greet","newName":"welcome"}
```

Call `rename` with those arguments, inspect the returned plan/diff, then call `apply` with `{"workspace":"/project","plan":"returned-id"}`. An already-authorized edit needs no additional manual approval.

Plans have a fixed 30-minute lifetime, retain at most 16 entries / 32 MiB, and bind source snapshots, configurations, tools and request environments. Nonempty pending plans keep the service alive beyond its normal idle timeout; restart and capacity eviction can invalidate them earlier. Preview responses include `createdAt`, `expiresAt` and `storage="memory"`. Conflicts reject before writes; concurrent changes or cancellation can still interrupt multi-file application. Inspect every `modifiedPaths` result. Plans are consumed when application begins and cannot be replayed. Follow-up diagnostic failure does not undo completed writes.

Plans validate by default with the configured local tools: Python ty/Ruff, native or traditional TypeScript (including checked JavaScript), Biome/ESLint, Go gopls and C/C++ clangd. Use `validationPaths` to include up to 20 additional existing files, such as unchanged callers. The scope is bounded to 20 changed files and 2 MiB of before/after content including additional files. Per-provider `checks` preserve coverage, introduced/resolved findings and completeness; incomplete aggregate counts are unknown. Counts describe provider observations and can overlap. Zero net errors is not a safety guarantee. Validation does not block applying the text plan; `validate=false` skips it.

Type services use separate processes. Biome and clangd use temporary local project snapshots so lint rules and header dependencies see all proposed contents; snapshots are bounded to 2,000 discovered files / 32 MiB of copies, reuse installed dependencies and are removed on completion, cancellation or failure. Validation has a 30-second total budget, a 10-second budget per LSP group and at most four concurrent groups. Builds, runtime behavior and unselected dependents remain outside its scope.

The npm CLI is `codeintel`, with no legacy bin alias: `codeintel check /project` and `codeintel warmup /project --path src/main.py`. Development uses Node 26 LTS and npm 12.2.1.

Responses use compact summaries and bounded pages. Follow the returned `next` arguments. Large nested values use field-path fragments and ordered text parts; no GCF or raw LSP payload dump is required.

## Configure

Configuration: `$CODEX_HOME/lsp-client.json` (default `~/.codex/lsp-client.json`) and `<workspace>/.codex/lsp-client.json`. Built-ins < global < project; arrays replace wholesale.

```json
{
  "schemaVersion": 1,
  "projectChecks": "auto",
  "lsp": {"python":"ty","typescript":"typescript","go":"gopls","cpp":"clangd","rust":"rust"},
  "lint": {"javascript":"auto","python":"auto"},
  "automaticDiagnostics": {"postToolUse":"off","stop":"off"}
}
```

Local tools resolve from the nearest project environment, then PATH. Native TypeScript 7 can select `"typescript":"tsc"`; the traditional TypeScript server remains the default. Python ty and Ruff work independently. Go uses local gopls, with automatic `go vet` project checking scoped by `go list` inputs. Multi-package and custom setups should provide explicit checker definitions.

Project checks accept `tsc`, `ty`, `go`, `cargo`, `ruff`, `eslint`, `biome`, `sarif` and custom `json` output. Commands must check without modifying source or installing dependencies. Automatic work never downloads tools or applies fixes.

Automatic diagnostics default to off. The six Hooks require a current Codex host supporting native asynchronous command Hooks and Interrupt. SessionStart captures a pre-edit snapshot and registers background baseline work; compact does not restart it. PostToolUse runs natively async for Bash, apply_patch and mcp__lsp__apply, leaving the original tool result intact. Known shell reads only collect completed feedback.

Subagents receive independent informational feedback; only the main Stop can use the explicitly configured global `stopGate="introduced-errors"` for one repair pass per turn. Ordinary Stop waits at most 300 ms for background work. Pending, failed, uncovered or stale checks never block; findings without reliable pre-edit baselines remain unattributed. Hooks never apply plans, format source or fix lint automatically.

Feedback is limited to five diagnostics and 2 KiB per message, with an 8 KiB per-agent/turn budget. Query cached diagnostics for details. Delivery IDs acknowledge successful stdout writes, not model receipt; an acknowledgement failure may repeat the same ID. After upgrading, review the changed definitions using `/hooks` and use a new session; the plugin does not change trust records or existing user settings. See the [host acceptance procedure](docs/testing/hooks-host.md).

See the [usage guide](docs/usage.md), [configuration examples](docs/examples/), [CHANGELOG](CHANGELOG.md), and [NOTICE](NOTICE).

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
CODEX_LSP_REAL_TOOLS=1 npm run test:features
git diff --check
```

The feature script prepares a separately pinned TypeScript 5 fixture under test/fixtures so its executable cannot replace the native TypeScript 7 compiler. This preparation is test-only.

Default tests include delivered MCP behavior, native TypeScript, traditional TypeScript, Biome and ESLint. Real feature acceptance additionally covers Ruff, ty, clangd and Go/gopls.

The independent [Rust workflow](.github/workflows/rust.yml) runs on Linux and Windows with Rust 1.99.1 and matching rust-analyzer, rust-src and rustfmt. It tests the committed bundle without npm dependencies, using an offline Cargo workspace with local path dependencies. `npm run test:rust` explicitly runs this suite on a prepared Rust host; missing tools fail rather than skip. It is separate from `npm test` and requires no Rust installation on ordinary development machines. CI saves tool versions, test logs and fixture/MCP traces as `rust-<os>` artifacts for 14 days. Legacy mixed-language tests retain the `CODEX_LSP_TEST_RUST=1` opt-in.

Core CI targets Linux/macOS/Windows with Node 24.20.0 and 26.13.0; dependency-free delivery uses Node 26.13.0. The [real-tools workflow](.github/workflows/real-tools.yml) adds Linux/Windows acceptance with pinned Go/gopls, Ruff 0.17.3, ty 0.0.95 and LLVM/clangd 23.1.4, checks for skipped acceptance cases, and retains versions, reports and fixture/MCP traces for 14 days. Local engineering evidence is kept under ignored `docs/history/`.

<a id="privacy"></a>
<a id="license"></a>
## Privacy and license

No telemetry. Source, diagnostic baselines and unresolved findings stay in private local caches. Plans stay in bounded service memory for at most 30 minutes and can expire earlier on service restart/capacity eviction. Biome/clangd validation temporarily copies scoped source and project context to the system temporary directory and removes its private snapshot in cleanup; an abrupt process/system failure can interrupt cleanup. Action payloads also stay in bounded service memory and are cleared on service restart or configuration invalidation. Request environments use authenticated local IPC. Logs use fixed categories, not source or credentials.

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Project origin

Codex CodeIntel originated from [code-yeongyu/codex-lsp](https://github.com/code-yeongyu/codex-lsp) and is independently maintained by zoisythe. The adapted LSP runtime was originally developed for [pi-lsp-client](https://github.com/code-yeongyu/pi-lsp-client) and extracted into [lsp-tools-mcp](https://github.com/code-yeongyu/lsp-tools-mcp). Original authorship and MIT copyright/license notices are retained in [NOTICE](NOTICE).
