---
name: code-intelligence
description: Use CodeIntel checks, compact navigation/context and previewed lint/LSP edits; handle optional automatic feedback.
---

Use the absolute user repository as workspace. Positions are 1-based UTF-16 columns; choose line/column, symbol path or a unique @@ pattern.

Use check for project CLI checks; diagnostics for explicit paths or turn/session, source=lsp/lint/both and active/cached. Filters affect display only. Follow returned next arguments through every page; partial, stale, failed and pending do not mean clean.

Use status for configuration, local tools, capabilities and failures without starting servers. Refresh after repairs. For installation/configuration requests use [setupLSP](../setup-lsp/SKILL.md) ($setup-lsp); during ordinary coding report missing capabilities once and continue.

Use navigate for atomic queries. symbols shows a top-level outline; symbol expands a node, query searches the workspace. Use inspect operation=symbol for a compact overview, source=true only when source is needed; operation=impact finds callers and candidate tests. Test association is not runtime coverage, and zero references is not proof of safe deletion.

Use actions operation=list/explain/preview for lint/LSP fixes. Batch preview selects only vendor-safe actions; select ids explicitly for unsafe/unknown/suggestions. Command/resource actions are unsupported. Never infer safety from fixable alone.

rename and format only produce a plan and diff. apply is the only source writer. After an authorized edit, preview then apply without adding a manual approval step. Keep applies sequential; plans are consumed and cannot be replayed. On cancellation/failure, read every modifiedPaths page before doing anything else. Follow-up diagnostic failure does not undo writes.

All nine tools are check, diagnostics, status, navigate, rename, format, inspect, actions, apply. Old underscore names are removed.

Automatic feedback defaults off and requires a current Codex host with native async Hooks and Interrupt. PostToolUse feedback is informational; its asynchronous process does not replace the tool result. Subagents receive independent feedback and never request continuation. Only the main Stop may use the explicit global gate for one repair pass per turn, with confirmed fresh introduced errors. Missing checker baselines never prevent editing; unknown findings remain unattributed. Stop/SubagentStop UI summaries do not prove model receipt.

Automatic feedback contains at most five diagnostics and 2 KiB, under an 8 KiB per-agent/turn budget. Use diagnostics with run=cached and scope=session for details. Repeated delivery IDs may follow an ACK failure; ACK confirms stdout only. After a Hook-definition upgrade, ask the user to review /hooks and start a new session; never change Hook trust or existing automatic/gate choices. Hooks never apply plans.

See [usage](../../docs/usage.md), [configuration](../../docs/usage.md#configuration), [limits](../../docs/usage.md#limits) and [upgrade](../../docs/usage.md#upgrade).
