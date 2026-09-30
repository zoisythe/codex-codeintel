# Source attribution and independent maintenance

[zoisythe/codex-lsp-standalone](https://github.com/zoisythe/codex-lsp-standalone) is independently maintained by [zoisythe](https://github.com/zoisythe). It keeps the existing repository name, `codex-lsp` plugin name and `@zoisythe/codex-lsp` package name.

## Sources and retained history

The project originated from [code-yeongyu/codex-lsp](https://github.com/code-yeongyu/codex-lsp), a Codex integration of the standalone LSP runtime from [code-yeongyu/pi-lsp-client](https://github.com/code-yeongyu/pi-lsp-client). That runtime was subsequently extracted into [code-yeongyu/lsp-tools-mcp](https://github.com/code-yeongyu/lsp-tools-mcp).

Development consumes the [zoisythe/lsp-tools-mcp](https://github.com/zoisythe/lsp-tools-mcp) source through `packages/lsp-tools-mcp`. The 0.6.0 bundle uses the pinned commit `9cc6f753d04834c148d08bbca72e3b483d6301b2`; the committed submodule reference identifies the source used by each later revision. Installed copies use the self-contained `dist/cli.js` and do not need a submodule checkout.

The existing Git commit history, including original author and committer attribution, is retained. Independent maintenance adds commits to that history rather than replacing it. Removing the GitHub fork association does not remove the project's provenance or license obligations.

On 2026-09-30, the repository left GitHub's fork network through the repository settings. GitHub reports `fork: false` with no parent repository; the repository name and existing branch history were retained.

## Maintenance policy

This repository owns its configuration, MCP interface, Hooks, bundled delivery, validation and versioning. Changes and releases are reviewed here; upstream changes are considered individually rather than automatically synchronized. Compatibility decisions are documented in the [changelog](../CHANGELOG.md) and migration guides.

Use [this repository's issues](https://github.com/zoisythe/codex-lsp-standalone/issues) for bugs and feature requests concerning this distribution. Its independent maintenance does not imply endorsement or support by the original authors.

## Licensing and attribution

The project remains MIT licensed. The original `Copyright (c) 2026 Yeongyu Kim` notice and license text are preserved in [LICENSE](../LICENSE); source acknowledgements are also shipped in [NOTICE](../NOTICE). The submodule's license and notices remain with its source. Bundled third-party dependency notices remain in the generated bundle.
