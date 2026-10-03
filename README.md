# Codex CodeIntel

Standalone Codex plugin maintained by [zoisythe](https://github.com/zoisythe). MCP and Hooks share local language servers, project checks and diagnostic results. Requires **Node.js >=22.12.0**. The committed bundle runs without installing runtime dependencies.

## Install

```sh
codex plugin marketplace add https://github.com/zoisythe/codex-codeintel
codex plugin add codex-codeintel@codex-codeintel
```

Start a new session and review the exact Hook definitions through `/hooks`. The plugin no longer checks directory trust. Updated Hook definitions still need host review.

See the [detailed usage guide](docs/usage.md) for setup, all tools, Hook behavior, troubleshooting and upgrading. Current copyable configuration examples are in [docs/examples](docs/examples/).

## Use

| Tool | Purpose |
| --- | --- |
| `check_project` | Project CLI checks; `run=active` starts a job, `run=cached` reads it. Follow structured `next` arguments. |
| `check_diagnostics` | LSP/lint for explicit paths or `scope=turn/session`. Cached reads share Hook results. |
| `lsp_status` | Explain configuration issues, capability availability, selected tools and running processes. `refresh=true` revalidates. |
| `lsp_navigation` | Definition, references, symbols, hover, type definitions, implementations, signature help and rename preparation. |
| `lsp_rename` | Sequential cross-file rename with complete `modifiedPaths` reporting. |
| `lsp_format` | Explicitly scoped formatting; Ruff for Python, project formatter or LSP elsewhere. |

Pass the absolute user project as `workspace`. Positions are 1-based. Keep write calls sequential; inspect `modifiedPaths` after errors or cancellation before retrying.

Automatic feedback defaults to off; all six MCP tools remain explicitly callable. Edits, shell commands, rename and formatting never require diagnostic baselines. With feedback enabled, SessionStart attempts a baseline in the background, and PostToolUse registers analysis without waiting for it. Current diagnostics without a reliable baseline are reported as unattributed. Stop/SubagentStop normally provide feedback only; only a global `stopGate="introduced-errors"` can request one repair pass for confirmed new errors with reliable coverage and fresh results. Pending, failed, uncovered or stale checks never block completion.

Use **setupLSP** (`$setup-lsp`) to configure, install or repair tools for the current project. It reuses local tools, verifies actual diagnostics/navigation/project checks, and continues independent languages after installation failures. Global setup must be explicitly requested; setup never turns on ending gates. Ordinary coding continues when capabilities are unavailable.

## Configure

Settings are read from `$CODEX_HOME/lsp-client.json` (default `~/.codex/lsp-client.json`) and `<workspace>/.codex/lsp-client.json`. Built-ins < global < project; arrays replace wholesale. `CODEX_HOME` still isolates configuration, prepared tools, cache and services. Directory trust records and old trust variables do not control execution.

```json
{
  "schemaVersion": 1,
  "projectChecks": "auto",
  "automaticDiagnostics": { "postToolUse": "delta", "stop": "errors" },
  "lsp": { "python": "ty", "typescript": "typescript", "cpp": "clangd", "rust": "rust" },
  "lint": { "javascript": "auto", "python": "auto" },
  "exclude": ["generated/**"]
}
```

Automatic root detection uses `tsconfig.json`, `pyproject.toml`/`ty.toml`, `Cargo.toml` and lint configuration. TypeScript references, multiple packages, C/C++ and custom languages require explicit check definitions:

```json
{
  "schemaVersion": 1,
  "projectChecks": [
    {
      "name": "web-types",
      "cwd": "web",
      "command": ["node_modules/.bin/tsc", "--noEmit", "--pretty", "false"],
      "parser": "tsc",
      "coverage": ["src/**/*.ts", "src/**/*.tsx"]
    }
  ]
}
```

Commands must check without modifying source or installing dependencies. Parsers: `tsc`, `ty` (concise), `cargo` (JSON), `ruff`, `eslint`, `biome`, `sarif`, or custom `json` (`{"diagnostics":[{"path":"src/a.ts","line":1,"column":1,"severity":"error","source":"rule","message":"problem"}]}`). Coverage paths are relative to the check's working directory. Include all needed type and lint checks; uncovered ranges can report diagnostics but cannot support an ending gate.

Local tools resolve from the nearest project environment, then PATH. Explicit commands never fall back. Python uses ty and Ruff independently; missing Ruff keeps type/navigation available. Native TypeScript 7 can select `"typescript": "tsc"`; the traditional TypeScript language server remains the default. Automatic checks never download tools, format or lint-fix. Explicit active LSP requests can prepare registered temporary tools. C/C++ and Rust need local toolchains.

Both automatic modes default to `"off"`; the example above opts into nonblocking feedback. Existing explicit settings remain effective. A project cannot enable a gate. To opt into a gate, separately set `"stopGate": "introduced-errors"` in the **user global** configuration and enable Stop feedback. See [configuration and upgrading](docs/usage.md#upgrade).

## Troubleshoot

Use `lsp_status` with a representative `path` to inspect configuration issues, command resolution and startup failures. Repair the local executable/configuration and retry with `refresh=true`. A local startup failure never selects a downloaded replacement. Pending/stale results are not evidence of a clean project. Follow `check_project` jobs until they finish; use it to discover errors in unmodified callers.

See the [usage guide](docs/usage.md#limits) for limits, [NOTICE](NOTICE) for source attribution of the vendored MIT runtime, and [CHANGELOG](CHANGELOG.md) for breaking changes.

## Development

```sh
npm install
npm run check
npm test
CODEX_LSP_REAL_TOOLS=1 npm run test:real
git diff --check
```

No submodule or bootstrap step is required. CI covers Node 22.12/24 on Linux/macOS/Windows. Phase engineering and local validation records are retained under ignored `docs/history/` and excluded from published packages. The maintained `docs/` content is the usage guide and current configuration examples.

## Privacy

No telemetry. Project source, diagnostic baselines and unresolved findings stay in private local caches. Request environments travel over authenticated local IPC. Logs contain fixed categories, not source or credentials. Clear the configured `CODEX_LSP_CACHE` directory to remove session data after stopping the service.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
