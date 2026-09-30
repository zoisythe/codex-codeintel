---
name: code-intelligence
description: Choose Codex CodeIntel diagnostics, project checks, navigation, rename and explicit formatting; respond to automatic feedback.
---

Use the absolute user repository as `workspace`; positions are 1-based.
Use `check_project` for whole-project checks and unmodified callers; follow structured `next` arguments until finished.
Use `check_diagnostics` for explicit paths or turn/session scope; cached queries read shared Hook results without running tools.
Use `lsp_status` to explain trust, command selection, failures and pending tasks; refresh after repairing tools.
Use `lsp_navigation` for definition/references/symbols/hover and rename preparation.
PostToolUse reports introduced errors/warnings. Fix those; preserve uncertainty for pending/stale/failed results.
A Stop block asks for one repair pass. Historical errors are not automatically introduced errors.
Source writes require project baseline coverage; repair check configuration or honor explicit automatic-off settings.
Run rename/format only when requested or already authorized, keeping writes sequential.
Inspect complete `modifiedPaths` after failed/cancelled writes before continuing; never assume rollback or replay.
See the [usage guide](../../docs/usage.md), including [configuration](../../docs/usage.md#configuration), [limits](../../docs/usage.md#limits) and [upgrading](../../docs/usage.md#upgrade).
