# Native TypeScript LSP acceptance (2026-09-30)

Verified the delivered `dist/cli.js` through independent MCP subprocesses on Linux/WSL2, Node.js 26.10.0 and npm 12.1.0, with TypeScript 7.0.2. No dependency submodule changes were needed.

## Fix and configuration

The native server rejected the inherited `initialized` notification because it omitted `params`, reporting `InvalidParams: params must be an object or array`. Later diagnostic requests timed out. The standalone client now supplies `{}` for that notification, allowing initialization to complete.

Select the native server with `"lsp": { "typescript": "tsc" }` in a schemaVersion 1 global or trusted project configuration. This launches `tsc --lsp --stdio`. The legacy TypeScript default remains unchanged. The local-only `tsgo` built-in provides the equivalent preview entry point.

## Executed checks

```sh
npm run check
npm test
CODEX_LSP_REAL_TOOLS=1 npm run test:real
git diff --check
```

All passed: 32 Vitest tests, 8 delivery/MCP/Hook subprocess tests, 1 real native TypeScript MCP test, and 4 opt-in real-tool subprocess tests. No real-tool tests were skipped.

- Native TypeScript: project-local resolution, lazy status, TS2322 diagnostics, error-to-clean updates, changed dependency return types, definition, references, hover, symbols, prepare rename, signature help, type definition and implementation requests, cross-file rename, formatting and clean diagnostics after writes.
- Isolated resolution: nearest nested `tsc`, workspace `tsc`, incompatible local `tsc` failure without npx fallback, PATH `tsgo`, missing `tsgo`, and the pinned `typescript@7.0.2` temporary recipe. A strict initialization fixture also covers the parameter requirement in dependency-free delivery tests.
- Real temporary execution: legacy TypeScript 5.9.3 and native TypeScript 7.0.2 download into empty isolated npm caches, return type errors, and work offline after preparation without creating project package.json or package-lock.json.
- Regression acceptance: actual ty/Ruff, clangd C/C++, and rust-analyzer Cargo workspace diagnostics, navigation, rename and formatting; temporary Python preparation, offline reuse and Hook direct execution.

## Limits

Native TypeScript was executed locally on Linux only. CI runs the native MCP test on Linux, macOS and Windows through `npm test`; workflow configuration is not evidence of a remote pass. The `tsgo` preview entry point was checked for command selection and availability, but an actual preview package was not executed. This run did not measure performance or launch a Codex GUI session. Earlier 0.5 validation bundle hashes and performance measurements describe the earlier artifact.
