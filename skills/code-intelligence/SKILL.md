---
name: code-intelligence
description: Use CodeIntel checks, compact navigation/context and previewed lint/LSP edits; handle optional automatic feedback.
---

Use the absolute user repository as workspace. Positions are 1-based UTF-16 columns; choose line/column, symbol path or a unique @@ pattern.

Use check for project CLI checks; diagnostics for explicit paths or turn/session, source=lsp/lint/both and active/cached. Filters affect display only. Follow returned next arguments through every page; partial, stale, failed and pending do not mean clean.

Use status for configuration, local tools, capabilities and failures without starting servers. Refresh after repairs. For installation/configuration requests use [setupLSP](../setup-lsp/SKILL.md) ($setup-lsp); during ordinary coding report missing capabilities once and continue.

Use warmup for explicit initialization of installed local servers, independent of automatic feedback. Pass path/paths or omit them for two representative languages. Follow next when paged. Warmup does not collect diagnostic baselines or download tools; status remains passive. The CLI is codeintel, including codeintel check and codeintel warmup.

Use navigate for atomic queries. symbols shows a top-level outline; symbol expands a node, query searches the workspace. Use inspect operation=symbol for a compact overview, source=true only when source is needed; operation=impact finds callers and candidate tests. Test association is not runtime coverage, and zero references is not proof of safe deletion.

Use actions operation=list/explain/preview for lint/LSP fixes. Batch preview selects only vendor-safe actions; select ids explicitly for unsafe/unknown/suggestions. Command/resource actions are unsupported. Never infer safety from fixable alone.

rename and format only produce a plan and diff. apply is the only source writer. After an authorized edit, preview then apply without adding a manual approval step. Keep applies sequential; plans are consumed and cannot be replayed. Plans expire after 30 minutes without renewal and may disappear earlier on eviction, refresh or restart; use planFailure to decide when to generate a fresh preview. On cancellation/failure, read every modifiedPaths page before doing anything else. Follow-up diagnostic failure does not undo writes.

Previews validate with configured local ty/Ruff, TypeScript/checked JavaScript, Biome/ESLint, gopls and clangd. Use validationPaths for up to 20 explicit unchanged callers/dependents; it does not discover all affected files. Inspect each validation.checks entry for provider, scope and completeness. Partial aggregate counts are null; successful providers retain their findings/counts. Counts can overlap between providers, and netDelta=0 is not a safety verdict. validate=false skips simulation. Biome/clangd use bounded temporary project copies and clean them up; other type checks use isolated processes/overlays. Validation never blocks an otherwise authorized apply or changes Hook baselines.

All ten tools are check, diagnostics, status, warmup, navigate, rename, format, inspect, actions, apply. Old underscore names are removed.

Automatic feedback defaults off and requires a current Codex host with native async Hooks and Interrupt. PostToolUse feedback is informational; its asynchronous process does not replace the tool result. Subagents receive independent feedback and never request continuation. Only the main Stop may use the explicit global gate for one repair pass per turn, with confirmed fresh introduced errors. Missing checker baselines never prevent editing; unknown findings remain unattributed. Stop/SubagentStop UI summaries do not prove model receipt.

Automatic feedback contains at most five diagnostics and 2 KiB, under an 8 KiB per-agent/turn budget. Use diagnostics with run=cached and scope=session for details. Repeated delivery IDs may follow an ACK failure; ACK confirms stdout only. After a Hook-definition upgrade, ask the user to review /hooks and start a new session; never change Hook trust or existing automatic/gate choices. Hooks never apply plans.

See [usage](../../docs/usage.md), [configuration](../../docs/usage.md#configuration), [limits](../../docs/usage.md#limits) and [upgrade](../../docs/usage.md#upgrade).
