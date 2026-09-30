# Codex CodeIntel rename acceptance

Executed locally on 2026-09-30, Linux x86_64 / WSL2, Node.js 26.10.0 and npm 12.1.0. This record validates the renamed working-tree delivery; it does not claim npm publication or remote CI results.

## Delivered identity

- Repository, marketplace, plugin, CLI and MCP server identity: `codex-codeintel`.
- Package: `@zoisythe/codex-codeintel`; package/plugin/MCP version remains `0.6.0`.
- Skill: `code-intelligence`, at `skills/code-intelligence/SKILL.md`.
- Bundle SHA-256: `20868a3e4c65d8e8283c94ad38cf8b7d125325b63c91ac5bb9af0aba53486f98`.
- The existing five MCP tool names, `lsp` registration key, configuration paths, environment variables and cache/IPC locations remain compatible.

## Checks and end-to-end behavior

`npm run check` passed strict TypeScript, Biome and bundle generation. `npm test` passed 32 Vitest tests, 21 MCP/Hook subprocess tests and 1 real native TypeScript MCP test. The installation suites now also assert the new delivered package/plugin/CLI/Skill names and MCP server identity.

`CODEX_LSP_REAL_TOOLS=1 npm run test:real` passed all 5 tests without skips. These exercised diagnostics, navigation, rename, formatting, local-first tool resolution, temporary tool preparation, offline reuse, and automatic error/repair feedback using actual Python, TypeScript, C/C++ and Rust tools. The automatic-language observations for this bundle are stored in [the rename performance record](performance-codeintel-real.json); the historical 0.6 record was preserved. These observations are not a repeated performance benchmark.

The renamed Skill passed the `skill-creator` frontmatter/name validator using `uv run --with pyyaml`. `git diff --check` also passed.

## Actual installation acceptance

An isolated temporary `CODEX_HOME` registered this working tree through `codex plugin marketplace add <repository> --json`, then installed `codex-codeintel@codex-codeintel` through the actual Codex plugin installer. The returned marketplace and plugin identities matched the new names. The installed `dist/cli.js` and `skills/code-intelligence/SKILL.md` matched the source delivery byte for byte, and no old `skills/lsp/SKILL.md` was installed. An actual installed MCP subprocess returned `serverInfo.name = codex-codeintel`.

`npm pack --json --pack-destination <temporary-directory>` created a real `@zoisythe/codex-codeintel@0.6.0` tarball containing the renamed Skill. It was installed into a separate temporary npm prefix with development dependencies omitted. The installed `codex-codeintel` executable initialized MCP with the new server identity and reported the new CLI usage on an invalid command. This used actual packing and installation, rather than a dry run. Temporary installations were removed; the user's installed plugin and configuration were not changed.

## Repository identity

GitHub's repository API confirmed `zoisythe/codex-codeintel`, `fork: false`, and the existing `main` default branch after the rename. Local `origin` now targets `git@github.com:zoisythe/codex-codeintel.git`; the original upstream remote and source acknowledgements remain intact. Validation was performed on the working tree before delivery; no npm package was published during acceptance.
