# CodeIntel configuration

Read `$CODEX_HOME/lsp-client.json` (or `~/.codex/lsp-client.json`) and `<workspace>/.codex/lsp-client.json`. Built-in defaults < global < project. Objects merge by field/language; arrays replace wholesale. Both files use `schemaVersion: 1`. Do not overwrite unrelated entries or user-off settings. A malformed existing file needs repair from its existing intent, not replacement with a default file.

A new project feedback configuration can start with:

```json
{
  "schemaVersion": 1,
  "automaticDiagnostics": { "postToolUse": "delta", "stop": "errors" },
  "projectChecks": "auto",
  "lsp": { "python": "ty", "typescript": "typescript", "cpp": "clangd", "rust": "rust" },
  "lint": { "python": "auto", "javascript": "auto" }
}
```

Limit language additions to the project and preserve existing choices. No configuration means automatic feedback is off while all six MCP tools remain explicitly callable. `automaticDiagnostics.stop="errors"` is feedback only. Ending gates require a separately authorized **global** `stopGate="introduced-errors"`; setup never enables it automatically. An existing global choice is preserved. Project `stopGate` is ignored. No plugin trust field or environment variable is required.

LSP entries are a built-in name, `false`, or `{command: [program, ...args], extensions: [".ext"], env?: {KEY: "value"}, initialization?: {...}}`. Use `.py/.pyi`, `.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs`, `.c/.h/.cpp/.hpp` and `.rs` as appropriate for custom servers; do not conflict with enabled built-in extensions. Explicit relative commands resolve from the workspace and never fall back. Built-ins resolve the nearest project environment, then PATH; automatic work never downloads missing tools.

`lint.python` accepts `auto/ruff/off`; `lint.javascript` accepts `auto/biome/eslint/off`. Lint-off does not disable explicitly requested formatting. `formatting` accepts `tabSize` (1–16) and `insertSpaces`. `exclude` is an array of relative forward-slash globs, without `..`, absolute paths or negation.

For multi-package or custom checks, replace `projectChecks` with the complete desired array. Each entry has a unique `name`, relative `cwd`, nonempty `command` array, `parser`, and nonempty `coverage` globs relative to that cwd. Relative command paths resolve from that cwd. Automatic commands must check without dependency installation or source modification. Output parsers: `tsc`, concise `ty`, JSON `cargo`, `ruff`, `eslint`, `biome`, `sarif`, and custom `json`:

```json
{
  "diagnostics": [
    { "path": "src/main.c", "line": 1, "column": 1, "severity": "error", "source": "compiler/rule", "message": "description" }
  ]
}
```

Diagnostic paths are relative to the check cwd; positions are 1-based. An empty custom result is `{"diagnostics":[]}`. Coverage must match actual inputs and exclusions, not merely desired coverage. Explicit checks replace automatic discovery, so keep needed checks for every language. See the [usage guide](../../../docs/usage.md#configuration) and [multi-package example](../../../docs/examples/lsp-client.project-checks.json).
