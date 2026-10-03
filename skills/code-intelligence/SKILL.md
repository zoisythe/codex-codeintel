---
name: code-intelligence
description: Choose Codex CodeIntel diagnostics, project checks, navigation, rename and explicit formatting; respond to optional automatic feedback.
---

Use the absolute user repository as `workspace`; positions are 1-based.
Use `check_project` for whole-project checks and unmodified callers; follow structured `next` arguments until finished.
Use `check_diagnostics` for explicit paths or turn/session scope; cached queries read shared Hook results without running tools.
Use `lsp_status` for configuration sources/issues, per-capability availability, command selection, failures and pending tasks; refresh after repairing tools. Unverified is not verified startup.
For configuration, installation or repair requests use [setupLSP](../setup-lsp/SKILL.md), invoked as `$setup-lsp`. During ordinary coding, briefly suggest setup for unavailable capabilities and continue; do not repeatedly install, retry or demand setup.
Automatic feedback is off unless configured. Missing baselines do not restrict editing. Current diagnostics without a reliable checker baseline are unattributed; never call them introduced errors.
Stop feedback normally informs only. A separately configured global gate can request one repair pass for confirmed introduced errors; pending/stale/failed results never justify blocking.
Use `lsp_navigation` for definition/references/symbols/hover and rename preparation.
Run rename/format only when requested or already authorized, keeping writes sequential.
Inspect complete `modifiedPaths` after failed/cancelled writes; never assume rollback or replay. Post-write diagnostic failure is supplementary and does not undo successful writes.
See the [usage guide](../../docs/usage.md), including [configuration](../../docs/usage.md#configuration), [limits](../../docs/usage.md#limits) and [upgrading](../../docs/usage.md#upgrade).
