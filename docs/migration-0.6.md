# Migrating to 0.6.0

The five MCP tools and `scope/source/run/cursor` arguments are unchanged. Schema version stays at 1. Do not restore the removed `mode=delta/full` parameters; those names now describe automatic Hook scope only.

PostToolUse now runs LSP and lint for changed and unfinished files. Stop defaults to the full workspace to find errors in unmodified callers, reports results with `systemMessage`, and never returns `decision: block`. SessionStart/PreToolUse establish a baseline without analysis. SessionEnd cancels only its session's automatic work. A missing initial baseline makes the first PostToolUse full.

Optional global or trusted project settings:

```json
{
  "schemaVersion": 1,
  "automaticDiagnostics": { "postToolUse": "delta", "stop": "full" }
}
```

Each field accepts `delta`, `full`, or `off`. To disable automatic analysis, set both to `off`. Global/trusted-project merging, exact Codex workspace trust and local-first tool resolution are unchanged. Codex's user `config.toml` remains the trust source; legacy `trustedWorkspaces` cannot grant trust.

A workspace service owns LSP clients and memory-only findings. Hooks and all MCP connections with the same user, real workspace, CODEX_HOME, bundle identity and protocol share that service. Status/cached calls do not start a stopped service. Explicit active MCP checks can prepare registered temporary tools; automatic checks only execute local tools and already prepared Ruff. Install the required language servers locally to enable automatic type/semantic diagnostics.

PostToolUse waits about five seconds and Stop about 45 seconds. Timeout feedback means the service continues independently for a maximum five-minute job budget. Later Hooks or MCP cached queries retrieve completed findings. Unfinished ranges remain durable for later Hooks; no background output is injected into a Hook that already ended. Services close clients and exit after two idle minutes; MCP disconnection does not close other clients or cancel automatic work.

Metadata v6 is isolated from v5 and contains hashes, generations, pending/delivery paths and feedback fingerprints, not findings. Start a new Codex session to establish its new baseline. Reinstall/update the delivered bundle and review the changed Hook definitions through `/hooks`; prior trusted hashes do not automatically approve new definitions. Existing MCP processes and old installed copies remain on their original bundle until restarted/updated.

Per-request environments now affect resolution and client identity. A later caller's PATH, virtual environment or tool-cache settings replace its request's execution context rather than inheriting the first service starter's values. Configuration or trust changes invalidate cached findings; trust revocation cancels running automatic jobs.

`complete` remains a diagnostic scope/channel result. Builds, linking and tests remain project-command responsibilities. Missing tools, startup failures, timeouts, stale results and inventory limits are reported as partial. Sequential rename/format and complete `modifiedPaths` reporting remain; a lost write response must not be automatically replayed.
