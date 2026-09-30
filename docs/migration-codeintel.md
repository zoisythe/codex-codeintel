# Codex CodeIntel name migration

The independently maintained distribution is now named **Codex CodeIntel**. It provides LSP/lint diagnostics, symbol navigation, rename, formatting and automatic Hooks through the existing MCP + Hooks architecture.

| Component | Previous name | New name |
| --- | --- | --- |
| GitHub repository | `zoisythe/codex-lsp-standalone` | `zoisythe/codex-codeintel` |
| Marketplace | `codex-lsp-standalone` | `codex-codeintel` |
| Plugin | `codex-lsp` | `codex-codeintel` |
| npm package | `@zoisythe/codex-lsp` | `@zoisythe/codex-codeintel` |
| CLI | `codex-lsp` | `codex-codeintel` |
| Skill | `lsp` | `code-intelligence` |
| Skill file | `skills/lsp/SKILL.md` | `skills/code-intelligence/SKILL.md` |
| MCP server identity | `codex-lsp` | `codex-codeintel` |

## Plugin installation

For an existing installation, first remove the old plugin:

```sh
codex plugin remove codex-lsp@codex-lsp-standalone
```

Then install through the new repository and marketplace identity:

```sh
codex plugin marketplace add https://github.com/zoisythe/codex-codeintel
codex plugin add codex-codeintel@codex-codeintel
```

An existing installation remains registered under its old plugin identity until removed. Start a new Codex session and review the installed Hook definitions through `/hooks`. Once no other plugins use the old marketplace, its registration can also be removed with `codex plugin marketplace remove codex-lsp-standalone`.

Replace explicit `$lsp` Skill requests with `$code-intelligence`, and update any personal instructions referring to the old distribution. The new CLI is `codex-codeintel [mcp | hook]`; the bundle remains `dist/cli.js`.

## Configuration and runtime compatibility

The five MCP tool names and arguments are unchanged: `check_diagnostics`, `lsp_status`, `lsp_navigation`, `lsp_rename`, and `lsp_format`. The MCP registration key remains `lsp` so existing tool references continue to identify the same server.

Keep existing `$CODEX_HOME/lsp-client.json`, `<workspace>/.codex/lsp-client.json`, and Codex workspace trust settings. `CODEX_LSP_CACHE` and `CODEX_LSP_REAL_TOOLS` retain their names. The rejected legacy `CODEX_LSP_TRUST_PROJECT` variable still produces its existing migration error.

Prepared-tool metadata, session metadata, logs and IPC endpoint locations retain their existing names, including `codex-lsp-v5` and `clsp6-*`. Branding does not require cache deletion, new tool downloads or configuration changes. Existing source acknowledgements, MIT notices and historical validation records retain their original names.
