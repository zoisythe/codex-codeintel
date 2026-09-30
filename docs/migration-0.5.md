# Migrating to 0.5.0

0.5 is a breaking configuration and MCP upgrade. User files are never rewritten automatically.

## Configuration

Only `$CODEX_HOME/lsp-client.json` (default `~/.codex/lsp-client.json`) and `<workspace>/.codex/lsp-client.json` are read. Remove `LSP_TOOLS_MCP_*_CONFIG` and `CODEX_LSP_TRUST_PROJECT`; their presence raises an actionable migration error. Add `schemaVersion: 1` to each file. Put absolute, canonical workspace paths in the global `trustedWorkspaces` array. Untrusted project plugin configuration is ignored, including malformed project JSON.

```json
{
  "schemaVersion": 1,
  "trustedWorkspaces": ["/absolute/project"],
  "lsp": {
    "python": "ty",
    "typescript": "typescript",
    "cpp": "clangd",
    "rust": "rust"
  },
  "lint": { "python": "auto", "javascript": "auto" },
  "formatting": { "tabSize": 4, "insertSpaces": true },
  "exclude": ["generated/**"]
}
```

`lsp` is keyed by language. Each value is a built-in server name, `false`, or a complete custom object with `command` and `extensions`, optionally `env` and `initialization`. Entries merge by language, but each language object is replaced as a whole; arrays also replace. There is no priority competition. Duplicate extensions raise an error: replace or disable the original language entry first.

For example, migrate an old `lsp.basedpyright` override to `"lsp": { "python": "basedpyright" }`. To use a custom Python server:

```json
{
  "schemaVersion": 1,
  "lsp": {
    "python": {
      "command": ["/absolute/venv/bin/custom-server", "--stdio"],
      "extensions": [".py", ".pyi"]
    },
    "rust": false
  }
}
```

Defaults include Python/ty, TypeScript, C/C++/clangd (`cpp`), Rust (`rust`), Bash, YAML, HTML/CSS/JSON, Svelte, Astro, Go, Lua and Java. Other languages can select a registered built-in or a custom object. `.py` and `.pyi` use Ruff without requiring a Ruff configuration file. `lint.python=off` disables lint, not explicit formatting.

Native TypeScript 7 is available with `"lsp": { "typescript": "tsc" }`, launching `tsc --lsp --stdio`. The default `"typescript"` server still launches the legacy `typescript-language-server`. Preview packages exposing `tsgo` can use `"lsp": { "typescript": "tsgo" }`. These choices cover the same TypeScript/JavaScript extensions. Local `tsc` must be version 7 or newer; incompatible local tools fail without fallback. If `tsc` is missing, trusted active calls may use npx with `typescript@7.0.2`. The `tsgo` preview built-in has no temporary installer.

Explicit commands execute exactly the configured entry and arguments; a failure never downloads a replacement. Built-ins resolve the nearest `.venv`/`node_modules/.bin` up to the workspace root, then PATH, then a registered ecosystem launcher. Temporary execution is restricted to trusted active MCP calls and does not edit dependencies or lockfiles. clangd and rust-analyzer have no automatic installer.

## MCP

| Old request | New request |
| --- | --- |
| `lsp_diagnostics` | `check_diagnostics source=lsp` |
| `check_diagnostics mode=full` | `check_diagnostics scope=paths run=active` |
| `mode=delta` | `scope=turn run=cached` |
| `mode=all` | `scope=session run=cached` |
| `mode=status` | `lsp_status` |
| navigation `operation=rename` | `lsp_rename` with the same position and `newName` |
| `start/offset/revision` | Follow the complete structured `next` arguments with opaque `cursor` |

Old names/arguments are rejected, with no aliases. Default diagnostics now actively check the workspace with both channels. Navigation is read-only and adds hover, typeDefinition, implementation and signatureHelp. Unsupported operations do not disable a language.

`refresh` is accepted on status or active diagnostics; status remains lazy even with refresh. Initialization failures are retained for 30 seconds, and changed resolution/configuration or refresh retries immediately. Missing tools, failures and pending results must not be interpreted as clean diagnostics.

Session metadata uses `metadata-v5-*`; fixed-category logs use `logs-v5`. Old metadata is not imported. A small executable-discovery manifest for prepared Ruff lives under `$CODEX_HOME/cache/codex-lsp-v5/tools`; it contains no diagnostics or running-client state.
