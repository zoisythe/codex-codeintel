# Codex user trust acceptance (2026-09-30)

The plugin reads only the selected workspace's `projects.<path>.trust_level` from the user `$CODEX_HOME/config.toml`. Paths refer to the same canonical directory; ancestor trust is not inherited. The Hook workspace is the session `cwd`, including inside Git repositories. MCP uses its requested `workspace`. Legacy plugin `trustedWorkspaces` is ignored.

## Executed acceptance

```sh
npm run check
npm test
CODEX_LSP_REAL_TOOLS=1 npm run test:real
git diff --check
```

Linux/WSL2, Node.js 26.10.0 and npm 12.1.0: 32 Vitest tests, 9 delivery/MCP/Hook subprocess tests, 1 actual TypeScript 7 MCP test, and 4 opt-in real-tool tests passed, with no skips. The delivered bundle contains the TOML parser and does not require installed dependencies.

`test/trust-e2e.test.mjs` executes actual MCP and Hook subprocesses against a Git parent workspace and a child workspace. It verifies:

- A trusted parent can lint files inside its child; selecting the child independently requires the child's own record. Similar path prefixes grant no trust.
- User trust grants and revocations take effect in the existing MCP process and subsequent Hooks; cached lint findings cannot authorize a revoked workspace.
- Explicit `untrusted`, missing records, missing user configuration, unknown trust levels, malformed TOML, symlink aliases and conflicting aliases.
- Project config.toml and legacy global/project plugin lists cannot grant trust. Untrusted project plugin settings are ignored.
- An installed Hook with sanitized CODEX_HOME recovers the owning home from its bundle path and reads that home's user trust. The plugin does not modify trust records.
- An available temporary TypeScript recipe cannot launch in an untrusted workspace. SessionEnd still cleans up when user trust TOML is malformed.

Actual local status also read `/home/zoisythe/.codex/config.toml` and reported this repository as trusted without creating lsp-client.json.

The full regression run retained real TypeScript 7 diagnostics/navigation/rename/formatting, native and legacy temporary recipes with offline cache reuse, ty/Ruff, clangd C/C++, and rust-analyzer Cargo workspace acceptance. Windows and macOS paths are covered by configured CI jobs but were not executed locally. Older validation documents and bundle hashes describe their original runs. Installed copies must be updated to the new bundle before this behavior applies.
