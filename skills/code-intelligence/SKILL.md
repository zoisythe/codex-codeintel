---
name: code-intelligence
description: Use the codex-codeintel plugin for scoped diagnostics, status, symbol navigation, rename, and explicit formatting. Consult when selecting its MCP tools, especially after automatic Hook feedback.
---

# Codex CodeIntel tools

| Tool | Use |
| --- | --- |
| `check_diagnostics` | `scope=paths/turn/session`, `source=lsp/lint/both`, `run=active/cached`. Defaults: paths, both, active; no path means workspace. |
| `lsp_status` | Explain effective configuration, trust, selected commands, launchability and running state. Optional `path`, `refresh`; never starts LSP. |
| `lsp_navigation` | Read-only definition, references, symbols, prepare_rename, hover, typeDefinition, implementation, signatureHelp. |
| `lsp_rename` | Rename a symbol across files; `path`, `newName`, and 1-based position. |
| `lsp_format` | Format explicitly scoped paths with Ruff for Python or project formatter/LSP for other languages. |

Use the absolute user repository as `workspace`, never the plugin directory. Prefer narrow `path` or `paths`. Positions use 1-based `line` and `column`; symbols accepts an optional workspace `query`.

Hooks automatically run LSP and lint in the same workspace service as MCP. PostToolUse defaults to delta (changed and unfinished files); Stop defaults to full (including unmodified callers), reports results without blocking, and continues pending work in the background. Global/trusted project `automaticDiagnostics.postToolUse` and `automaticDiagnostics.stop` support delta/full/off. Cached MCP queries read completed Hook results without starting analysis; turn/session scopes require `session` when multiple sessions share a workspace. PostToolUse waits about five seconds, Stop about 45 seconds. Later Hooks or queries retrieve completion; background work does not inject into an ended Hook.

Read both text and structured content. Follow the complete `next` arguments, including the opaque `cursor`, until no continuation remains. Content, configuration or result changes invalidate cursors; restart without cursor. Limits are 10,000 inventoried files and 1 MiB per file; active pages contain at most 50 files. An incomplete dependency inventory prevents fresh cache reuse.

Python defaults to `ty server` plus Ruff CLI. Commands resolve nearest project environment, then PATH; explicit commands never fall back. Trusted active MCP calls may prepare registered tools in a tool cache. Automatic checks require workspace trust and use local tools or already prepared Ruff; they never download. Status and cached queries do not start a stopped service. The shared service exits after two idle minutes. A launch recipe means an attempt is possible, not that initialization succeeded. C/C++ and Rust require working local clangd/rust-analyzer toolchains. Use status to explain failures; `refresh: true` clears clients and failure state. External dependency changes require refresh.

Workspace trust is read directly from the exact directory's `projects.<path>.trust_level` in the user `$CODEX_HOME/config.toml`. Parent trust does not inherit to a separately selected child workspace; files inside a trusted workspace remain in scope. Hooks use session `cwd`, MCP uses `workspace`, and neither writes trust records or prompts. `lsp_status` explains the trust file and effective level. Legacy plugin `trustedWorkspaces` is ignored.

Run rename/format when requested or already authorized and keep writes sequential. Prepare rename if its range is uncertain. If a write fails or is cancelled, inspect the reported modified paths before continuing; do not replay automatically or assume rollback.

`complete` describes the scope and channels executed, not a passing build. Report pending, stale, skipped, failed and unsupported capabilities explicitly. Ruff unavailability does not remove Python type/navigation support. Version 0.5 removed `lsp_diagnostics`, `mode`, `start`, `offset` and `revision`; do not send them.
