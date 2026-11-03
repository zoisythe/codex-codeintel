# Local Rust and MATLAB LSP acceptance

Verify real MCP behavior through the delivered `dist/cli.js` on a machine with the tools installed:

```sh
npm run build
REAL_TOOLS=1 npm run test:local
```

The suites run sequentially. You can also run `npm run test:rust` or `npm run test:matlab` separately. Every entry requires `REAL_TOOLS=1` for real acceptance; it skips by default and fails on missing prerequisites when enabled. `npm test` includes both suites with the same switch. Rust CI explicitly enables it; MATLAB acceptance uses the local installation and license.

`npm run ci` runs type checking, Biome, the build and `npm test` sequentially on the current platform and Node version. Setting `REAL_TOOLS=1` includes real-tool acceptance in this entry as well.

## Tool requirements

Rust requires `rustc`, `cargo` and `rust-analyzer` on PATH, plus rustfmt in the toolchain's `bin` directory located through `rustc --print sysroot`. Both Rustup-managed and standalone toolchains are supported. Fixtures use offline Cargo workspaces and local path dependencies. Target calls in integration tests sit outside `assert_eq!` macros, so reference and rename acceptance does not depend on standard-library macro expansion through rust-src.

MATLAB uses the [MathWorks MATLAB-language-server](https://github.com/mathworks/MATLAB-language-server) and requires MATLAB R2021b or later with a working license. Tests discover an installed server under `~/.vscode/extensions/mathworks.language-matlab-*` and MATLAB on PATH. Override paths with these variables:

| Variable | Meaning |
| --- | --- |
| `REAL_TOOLS` | Set to `1` to enable real-tool acceptance; skipped by default |
| `CODEX_LSP_MATLAB_SERVER` | Absolute path to the official server's `out/index.js` |
| `CODEX_LSP_MATLAB_INSTALL_PATH` | MATLAB installation root, such as `C:/Program Files/MATLAB/R2026b` |
| `CODEX_LSP_RUST_ARTIFACTS` | Directory for final Rust fixtures and MCP records |
| `CODEX_LSP_MATLAB_ARTIFACTS` | Directory for MATLAB tool paths, server version, fixtures and MCP records |
| `CODEX_LSP_ARTIFACTS` | Directory for per-response MCP JSONL traces, including in-progress checks |

The MATLAB LSP starts a separate local analysis process. Tests close fixture services and remove temporary workspaces on completion. Configuration and caches are isolated from the user's `CODEX_HOME`, and automatic feedback stays off.

## Coverage

| Server | Accepted behavior |
| --- | --- |
| Rust | Passive status, diagnostics and repair updates, symbol/anchor targeting, references, calls, completion, composite inspection and candidate test association, rename, rustfmt, Code Action previews and apply, plan conflicts and single use, Cargo workspace checks |
| MATLAB | Passive status, warmup, positioned syntax diagnostics and repairs, symbols, anchor-based definitions, references, completion, explicit unsupported call hierarchy, local-variable rename, formatting, read-only previews, single-use apply and conflict rejection |

Both suites verify edits through MCP previews and apply. MATLAB is outside the built-in plan-diagnostic simulation providers; its rename and format cases verify edit plans, writes and real post-write diagnostics.

MATLAB diagnostics lack document versions, so an initial empty report remains pending. Acceptance first confirms a real error, then verifies clearing after repair. References and rename target identifiers through `@@` anchors; formatting checks MATLAB indentation.

## Custom MATLAB configuration

Configure the same server in the project's `.codex/lsp-client.json`:

```json
{
  "schemaVersion": 1,
  "lsp": {
    "matlab": {
      "command": ["node", "/absolute/path/to/MATLAB-language-server/out/index.js", "--stdio"],
      "extensions": [".m"],
      "languageId": "matlab",
      "settings": {
        "MATLAB": {
          "installPath": "/absolute/path/to/MATLAB",
          "matlabConnectionTiming": "onStart",
          "indexWorkspace": false,
          "telemetry": false,
          "maxFileSizeForAnalysis": 0,
          "signIn": false
        }
      }
    }
  }
}
```

`settings` serves configuration requests and configuration-change notifications, including dotted section names such as `MATLAB.installPath`. `languageId` changes only this server's document language; omitting it preserves the existing extension mapping.

Example trace capture in PowerShell:

```powershell
$env:REAL_TOOLS = "1"
$env:CODEX_LSP_RUST_ARTIFACTS = Join-Path $PWD "test-results/local-lsp/rust"
$env:CODEX_LSP_MATLAB_ARTIFACTS = Join-Path $PWD "test-results/local-lsp/matlab"
$env:CODEX_LSP_ARTIFACTS = Join-Path $PWD "test-results/local-lsp/mcp"
npm run test:local
```

Records include fixture source and local tool paths and are stored under the Git-ignored `test-results/` directory.
