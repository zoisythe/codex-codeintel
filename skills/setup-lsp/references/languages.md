# Language setup decisions

Read only the relevant language guidance. Work in the requested project/global scope and verify with real MCP requests after configuration.

## Python

Reuse configured ty commands, package `.venv` executables and PATH installations; Ruff is a separate capability. For an existing uv project, missing project tools can use `uv add --dev ty ruff`, respecting its dependency groups and lockfile. For a project without a managed environment, use `uv venv .venv` then `uv pip install --python .venv/bin/python ty ruff` (use `.venv/Scripts/python.exe` on Windows). Explicit global setup can use `uv tool install ty` and `uv tool install ruff`. Do not synchronize or replace an existing environment merely to repair one executable. Respect the chosen Python version.

Use `"python": "ty"`. Root `pyproject.toml` or `ty.toml` enables auto project type checking. For nested packages or custom scope, use separate checks:

- Types: `[".venv/bin/ty", "check", "--output-format", "concise", "--color", "never"]`, parser `ty`.
- Lint: `[".venv/bin/ruff", "check", "--no-fix", "--no-fix-only", "--output-format", "json", "src"]`, parser `ruff`.

Set cwd to the package and coverage to its checked Python inputs, respecting ty/Ruff exclusions. Ruff failure should not remove ty diagnostics/navigation; ty failure should not prevent Ruff lint/formatting. Validate types and lint separately when one is missing. Do not infer repair authorization for formatting from a setup request.

## TypeScript / JavaScript

Read `packageManager`, lockfiles, workspace definitions and the effective tsconfig inputs/references. Keep the package manager. With no convention prefer `pnpm`. Choose the LSP that actually starts with the project's installed compiler: the built-in `typescript` uses `typescript-language-server --stdio`; `tsc` uses `tsc --lsp --stdio` and requires native LSP support (TypeScript 7+); `tsgo` requires that executable. An older or incompatible local compiler must be repaired explicitly rather than silently launching a downloaded replacement. Preserve project TypeScript version constraints.

Install only missing project tools with the chosen manager (for example `pnpm add -D typescript-language-server`); global setup uses that manager's user-level global installation conventions. Select Biome or ESLint from existing configuration. Do not invent a new lint system if there is none. Reuse existing scripts only if they check without modifying source and produce a supported format.

For a simple root tsconfig, auto checking reads its effective coverage. For references/multiple packages use explicit per-package type and lint checks. A typical type command is `["node_modules/.bin/tsc", "--noEmit", "--pretty", "false", "-p", "tsconfig.json"]` with parser `tsc`; use actual hoisted/Windows tool paths where appropriate. Biome uses `lint --reporter=json --max-diagnostics=none`; ESLint uses `--format json`. JS type coverage requires both `allowJs` and `checkJs`. Derive globs from each command's actual config, files, include and exclude. Verify representative files from each package.

## Rust

Reuse `rust-analyzer`, Cargo, rust-src and the pinned Rustup toolchain. Install missing components within the requested toolchain scope only; avoid a workspace toolchain change as a setup shortcut. Root Cargo auto checking uses `cargo check --workspace --all-targets --message-format=json`. Nested workspaces or special features need explicit checks with their actual cwd, flags and coverage. Prepare dependencies intentionally during setup if needed. Automatic checks disable Rustup auto-install; a missing pinned toolchain remains unavailable. Verify actual diagnostics and navigation after indexing, and CLI checking of the workspace. Explain feature or platform coverage limitations.

## C / C++

Reuse clangd and the configured Clang/LLVM or project toolchain. Reuse `compile_commands.json`; if absent, generate it through the project's existing CMake/Meson/other build process with the project's build options. A fallback `compile_flags.txt` is appropriate only when it matches the actual build. Supply clangd's `--compile-commands-dir` via an explicit custom entry if the database is in an undiscovered build directory.

Project checks need structured JSON/SARIF output from a real compiler/checker or an existing read-only wrapper. For a single translation unit on a compatible Clang, `clang -fsyntax-only -fdiagnostics-format=sarif -Wno-sarif-format-unstable` plus the actual compile flags may work with parser `sarif`; restrict coverage to the checked files/headers. Do not concatenate multiple SARIF JSON documents or claim a representative command covers the entire build. Prefer the project's structured checking path for a full build. If unavailable, keep clangd diagnostics/navigation and explain the project-check and reliable-baseline gap. Do not require a new system LLVM installation to finish unrelated language setup.

## Mixed projects and offline failures

Configure each package's cwd and real input coverage. A checker failing in one language does not cancel verification of other languages. Preserve working local tools. If an offline install fails, stop retrying that install, retain usable configuration and explicitly report the missing capability; do not disable the whole workspace or turn on a gate. Verify in isolated project and `CODEX_HOME` directories when evaluating setup examples, so user global configuration remains untouched.
