# Codex CodeIntel usage guide

This guide covers **0.10.1**. Development uses Node 26 LTS and the repository's npm 12.2.1; the CLI is codeintel. The plugin provides ten MCP tools, with Hooks and MCP sharing local LSP services, project checks and diagnostic caches. Runtime requirements are Node.js 24.20.0+ on 24.x or 26.13.0+ on 26.x. The delivered bundle needs no runtime dependency installation.

## Installation and first use

```sh
codex plugin marketplace add https://github.com/zoisythe/codex-codeintel
codex plugin add codex-codeintel@codex-codeintel
```

Start a new session and review Hook definitions through `/hooks`. Use setupLSP (`$setup-lsp`) to configure, install or repair tools. During ordinary coding, report a missing capability once and continue other work.

<a id="configuration"></a>

## Configuration locations and precedence

Read `$CODEX_HOME/lsp-client.json` (default `~/.codex/lsp-client.json`) and the project's `.codex/lsp-client.json`. Precedence is built-ins < global < project; both files use `schemaVersion: 1`. Each language's LSP entry replaces the previous entry wholesale, as do the exclude/projectChecks arrays.

```json
{
  "schemaVersion": 1,
  "projectChecks": "auto",
  "lsp": {"python":"ty","typescript":"typescript","go":"gopls","cpp":"clangd","rust":"rust"},
  "lint": {"javascript":"auto","python":"auto"},
  "automaticDiagnostics": {"postToolUse":"off","stop":"off"}
}
```

| Field | Meaning |
| --- | --- |
| lsp | Map languages to built-in names, false, or custom command/extensions/env/initialization/settings/languageId objects |
| lint.javascript | auto, biome, eslint, off |
| lint.python | auto, ruff, off |
| formatting | tabSize (1–16), insertSpaces |
| exclude | Relative forward-slash globs; absolute paths, backslashes, negation and .. are rejected |
| projectChecks | auto or an explicit array of checks; the array replaces automatic discovery |
| automaticDiagnostics | postToolUse=delta/off, stop=errors/off; both default to off |
| stopGate | introduced-errors is accepted only in the user's global configuration; defaults to off |

Local tools take precedence. A failing explicit command does not fall back to a downloaded version. Python ty and Ruff work independently; lint=off leaves explicit formatting available. TypeScript defaults to the traditional language server; native TypeScript 7 can select tsc. Go uses gopls, while C/C++ and Rust reuse installed local toolchains.

Malformed configuration does not block editing. status and cached reads remain available; localized language/check errors affect only the relevant capabilities. status starts no LSP process and downloads no tools; unverified does not establish successful startup. Directory trust records do not control plugin execution.

## Ten MCP tools

Every call uses an absolute workspace. Positions are **1-based, with UTF-16 columns**. Position-based operations accept one locator:

- line/column;
- symbol, such as Class.method; overload indexes come from symbols results;
- pattern, such as function @@greet, with @@ marking the cursor.

Ambiguous names or multiple anchor matches return candidates. Workspace symbol search uses navigate with operation=symbols and query; path selects the language server.

| Tool | Purpose |
| --- | --- |
| check | Project CLI checks; active starts a job, cached reads it; follow next |
| diagnostics | LSP, lint or both for explicit paths or turn/session scope; active/cached |
| status | Tools, configuration, capabilities, failures and job state; refresh revalidates |
| warmup | Explicitly initialize local LSP services without diagnostic baselines or downloads |
| navigate | Atomic semantic queries and outlines |
| rename | Read-only rename plans |
| format | Read-only formatting plans |
| inspect | Composite symbol exploration or impact analysis |
| actions | List, explain or preview fixes |
| apply | Consume an existing plan and write sequentially; the only source writer |

### Project checks and diagnostics

Call check with:

```json
{"workspace":"/project","run":"active"}
```

Follow the returned next until the job finishes; state=running/failed/stale is not a clean result. The CLI also supports `codeintel check <workspace>`.

Example diagnostics call:

```json
{"workspace":"/project","paths":["src/main.ts"],"source":"both","run":"active","severity":"error"}
```

scope accepts paths, turn or session; provide session when multiple sessions exist. Use check for whole-project checks; omitting diagnostic paths or passing "." does not replace it. rule/severity filter display only, leaving checks, baselines and caches unchanged. Failures and pending states remain visible.

Diagnostics retain positions, rules, severity, messages and known fix availability. They omit full edits, documentation and raw tool payloads by default. Counts group by rule/file. Attribution uses reliable existing checker baselines and is unattributed when no baseline exists. Rules, checkers and coverage sets cannot substitute for one another's baselines.

Each projectChecks entry contains name, cwd, command, parser and coverage; relative commands and coverage resolve from cwd. Supported parsers are tsc, ty, go, cargo, ruff, eslint, biome, sarif and json. Custom json output has this shape:

```json
{"diagnostics":[{"path":"src/a.ts","line":1,"column":1,"severity":"error","source":"rule","message":"problem"}]}
```

Automatic discovery supports root tsconfig, ty, Go modules, Cargo workspaces and matching lint configurations. Configure TypeScript references/multiple packages, special features, custom languages and C/C++ CLI checks explicitly. Commands must check without modifying source, applying fixes or installing dependencies. See [configuration examples](examples/).

Go auto checking runs go vet -mod=readonly -json ./... and uses go list to identify actual Go/Test inputs. Files excluded by build tags/platform or belonging to other modules do not count as covered. Automatic checking disables Go toolchain/module downloads; prepare dependencies and environments beforehand. Missing tools or package-discovery failures remain unavailable/failed.

### Explicit warmup

MCP warmup accepts an absolute workspace and optional path/paths. The CLI is `codeintel warmup <workspace> [--path relative-path]`, with repeatable --path. Without files, it selects at most two languages by workspace file counts and initializes one representative file per language. Explicit files are deduplicated by actual server/root, up to 200 files.

Warmup has a 20-second total budget, supports cancellation and returns per-item initialized/reused/unsupported/pending/failed states and timings. It initializes installed tools without diagnostics or downloads and works with automatic feedback off. status, including refresh=true, remains passive.

### Navigation and composite analysis

navigate supports definition, declaration, references, symbols, prepare_rename, hover, typeDefinition, implementation, signatureHelp, incoming, outgoing, supertypes, subtypes and completion.

```json
{"workspace":"/project","path":"src/main.ts","operation":"symbols"}
```

Outlines show top-level nodes by default. Keep navigate's operation="symbols" and pass symbol to expand a node's immediate members. Large member lists paginate instead of returning an empty list for an oversized class. Relationship queries return direct relationships; locate the next symbol to expand further. Unsupported server capabilities return unsupported explicitly.

Use inspect with operation="symbol" for a symbol overview. The source parameter belongs to inspect; set it to true when source text is needed:

```json
{"workspace":"/project","path":"src/main.ts","operation":"symbol","symbol":"greet","source":true}
```

inspect combines signatures/documentation, definitions, reference summaries and call relationships; source is omitted by default. operation=impact accepts explicit path/paths or a locator, collecting references to top-level types/functions and type members while excluding local-variable and field noise. symbols can select symbol paths within files, preserving ambiguity or failures per item. Callers come from call hierarchy; ordinary references are counted separately. transitive=true adds at most one layer and reports partial when the budget is exhausted. Each subquery reports failures independently.

Candidate tests are based on filenames and symbol references; they do not establish runtime coverage. Zero references does not prove safe deletion. The tool does not automatically decide concurrency safety or dead code.

### Lint and LSP fixes

Call actions with:

```json
{"workspace":"/project","path":"src/main.py","operation":"list","source":"lint"}
```

source accepts lint/lsp/both and defaults to both. list returns action IDs, titles, origins, applicability and unavailability reasons, omitting full edits by default.

explain takes path and rule and returns documentation and effective settings confirmed by the installed tool. details=true expands information on demand. Missing configuration provenance or ignore reasons remain unknown.

preview takes selected ids or creates a batch plan within an explicit file scope:

```json
{"workspace":"/project","operation":"preview","ids":["action-id"]}
```

Batch selection includes only actions explicitly marked safe by their vendor. Select unsafe, unknown and suggestion actions explicitly; ESLint fixable does not mean safe. Ruff/ESLint retain per-diagnostic edits; Biome generates file-level fixes through stdin. A rule-scoped preview uses rules confirmed enabled by current diagnostics without enabling disabled rules.

LSP actions can resolve into text-only plans. Actions with command, disabled status or file creation/deletion/move operations are unsupported; their commands never execute and the action is not partially applied. Lint fixes do not run a formatter, add suppression comments or change configuration.

### Edit plans and apply

Example rename arguments:

```json
{"workspace":"/project","path":"src/main.ts","symbol":"greet","newName":"welcome"}
```

Example format arguments:

```json
{"workspace":"/project","paths":["src/main.ts"]}
```

Both return a plan, file summaries and a diff without writing. Then call apply with:

```json
{"workspace":"/project","plan":"returned-plan-id"}
```

Preview and apply an already-authorized edit consecutively without another manual approval step. Text plans preview diagnostic changes using configured local language/checking tools by default. validate=false skips simulation. actions accepts validate/validationPaths only with operation=preview; validate=false cannot be combined with validationPaths. Simulation leaves apply authorization and write rules unchanged and does not guarantee a successful build or test run.

Plans live in bounded workspace-service memory for a fixed 30 minutes; reads and pagination do not renew them. Responses include createdAt, expiresAt and storage=memory. Limits are 16 plans and 32 MiB of total before/after content. Nonempty valid plans prevent the normal five-minute service idle exit but do not keep LSP subprocesses alive indefinitely. Capacity eviction, explicit refresh or service restart can invalidate plans earlier. apply's planFailure distinguishes consumed, expired, evicted, unavailable, stale and conflict; unknown IDs after restart report unavailable. Source, configuration, tool or request-environment changes invalidate plans. Application preflights every target, rejecting conflicts, boundary escapes, changed symlinks or overlapping edits, then rechecks and writes each file sequentially.

Plans are consumed when application starts and cannot be replayed. Cancellation/failure returns paths actually modified; multi-file application does not promise atomic rollback. Post-write diagnostic failures are supplementary status, not a reason to apply the same plan again. Generate a new plan for subsequent edits.

### Multi-tool diagnostic previews

Providers include Python ty and Ruff, traditional/native TypeScript including project-enabled checkJs, Biome/ESLint, Go/gopls and C/C++ clangd. Tools follow existing project configuration; disabled capabilities stay disabled and missing tools are not downloaded. Unsupported servers/scopes return unsupported explicitly. ESLint project/projectService type-aware rules are not simulated; the TypeScript provider supplies type checking.

A preview accepts up to 20 existing changed files plus up to 20 unchanged callers/dependencies in validationPaths, with at most 2 MiB of combined before/after content across all files. Additional files participate in diagnostics and plan identity checks without being formatted or written. They are an explicit scope, not automatically inferred complete impact coverage.

A language scope spanning multiple LSP projects returns unsupported; split it by project. Separate server instances are not assumed to share every overlay. Ruff/ESLint stdin checks cover file-level rules; custom rules reading other files still see their original on-disk content, and the relevant check reports this limitation.

```json
{"workspace":"/project","path":"values.py","symbol":"value","newName":"new_value","validationPaths":["use.py"]}
```

rename/format/actions preview validation returns aggregate state, paths, introduced/resolved findings and per-tool/project checks. Each check includes provider, state, paths, findings, limitations and failure reasons. errorsIntroduced/errorsResolved/netDelta count errors only. Aggregate counts sum provider observations, so providers may report the same issue. netDelta can be zero after resolving one old error and introducing another; inspect the actual findings.

Aggregate state is complete only when all enabled checks within the requested scope finish fully. Partial success returns state=partial with successful findings and null aggregate counts; successful per-check counts remain available. Unselected dependencies, builds and runtime behavior remain outside the guarantee.

ty/native TS prefer pull diagnostics. Traditional TypeScript uses ordered read-only synchronous tsserver diagnostics to avoid treating unversioned async pushes as fresh. gopls enables pull and waits for matching-version push when pull output is unavailable. clangd requires a current-version push. Every provider installs all changes before collecting diagnostics. Simulation content stays separate from shared LSP services, caches and Hook baselines.

Biome stdin lacks usable structured lint reports, and clangd header references cannot rely solely on other documents' unsaved content, so both use isolated temporary project copies. Snapshots discover at most 2,000 files and copy at most 32 MiB, mapping local compilation databases/paths and reusing installed dependencies and readable generated headers. After workspace files are selected, Biome disables snapshot VCS discovery while respecting file includes and rules; incomplete selected-file processing returns unknown. Missing headers or unusable C/C++ baseline flags also return unknown.

Simulation has a 30-second total budget, 10 seconds per LSP project and at most four concurrent groups. Completion, cancellation or failure closes isolated servers and removes temporary copies; abrupt process/system termination may leave temporary files. Simulation failures, timeouts or missing capabilities retain the text plan with unconfirmed counts set to null; user cancellation follows normal cancellation semantics. Changes to workspace or additional-file identities reject an old preview.

## Pagination and response information

Pages default to 20 items and about 8 KiB of detail, with structured output also budgeted. Text is a short summary. Follow the complete returned next arguments; do not calculate offsets, copy old revisions or construct cursors manually.

Large nested values become field fragments in items. field uses result["key"][index] to identify the original output path; value preserves a complete small value, while part/text provides ordered text segments. Keys containing dots or slashes use quoted subscripts. Source, diffs and large outlines remain fully retrievable. When an underlying project job or diagnostic batch needs more work, the final page's next forwards its continuation arguments.

Query cursors bind the query, snapshot, configuration and tools. apply continuation pages bind the completed execution record, so later source edits do not prevent reading all modifiedPaths. Restart the original query after cursor invalidation; changed filters require a new cursor. Preserve partial/failed/pending information: completed pagination does not imply completed analysis.

## Automatic Hook feedback

Automatic feedback defaults to off. Preserve existing automaticDiagnostics and global stopGate choices. A current Codex host with native async command Hooks and Interrupt is required; there is no legacy-host execution mode. Hooks never call apply, fix source or format it.

| Event | Behavior |
| --- | --- |
| SessionStart | Synchronous entry budget: 500 ms. Capture a pre-edit snapshot and register a baseline job without waiting for project checks. Handles startup/resume/clear/fork; compact skips rediscovery. resume reuses valid state; the others create a new epoch. |
| PostToolUse | Native async, matching only Bash, apply_patch and mcp__lsp__apply. Internal total budget: 310 seconds; host timeout: 330 seconds. The original tool result stays available. Known shell reads collect completed feedback without starting a service or check. |
| Stop | Ordinary feedback budget: 1.5 seconds, including at most 300 ms waiting for results. Discovery/checks may continue in the background. An explicitly enabled global gate retains a 44-second total budget. |
| SubagentStop | Independent actor feedback, with a 1.5-second total budget; never requests continuation. |
| SessionEnd | Internal budget: 1.6 seconds; host timeout: 3 seconds. Cancel tasks and invalidate old deliveries through the epoch. |
| Interrupt | Internal budget: 1 second; host timeout: 3 seconds. Release waits and cancel automatic work explicitly owned by the interrupted turn. Unknown ownership retains pending work; shared LSP processes and MCP writes continue. |

Only explicit agent_id marks a subagent; ownership is never guessed from transcripts. Workspace versions, LSP services and caches are shared, while actor waits, turns and feedback records remain separate. Unknown ownership is marked shared and summarized by the main Stop. MCP session still denotes the shared session. SubagentStop cannot consume another actor's feedback.

Only main Stop with the user's global stopGate=introduced-errors may request at most one repair pass per turn for reliable, covered and fresh introduced errors. Missing pre-edit baselines, unknown, failed, pending and stale results do not block. setupLSP never enables the gate automatically. SessionStart additionalContext can reach the model; ordinary Stop/SubagentStop output is a UI summary and does not prove model receipt.

Write events register idempotently by session epoch, explicit actor and tool_use_id; missing IDs are not guessed to be duplicates. Changes coalesce over 200 ms, with continuous changes delayed at most one second, and snapshots are confirmed by current content hashes. apply's complete modifiedPaths, including partial writes, hints the scope; paged, unknown or incomplete results fall back to change discovery. Matching analysis identities and snapshots reuse apply's post-write diagnostics.

Each feedback message is limited to 2 KiB UTF-8 and five key diagnostics, reporting introduced/resolved/unattributed/pending counts. Identical states are deduplicated. Each actor/turn has an 8 KiB total budget with room reserved for ending summaries. Use diagnostics(run=cached, scope=session) with the shared session for details. Internal hook_wait only long-polls registered work, at most 20 seconds per call; it adds no MCP tool.

Deliveries retain deliveryId, sourceTurn and the content snapshot and recheck freshness before sending. ACK means successful stdout output; ACK failure may resend the same ID and does not guarantee exactly-once model receipt. Checks without a proven pre-edit baseline remain unattributed. Completed background pre-edit baselines are saved before check reports completion, survive service restarts and cannot repopulate ended sessions.

The 0.10 upgrade changes internal metadata without migrating old deliveries. Review definitions through /hooks after updating and use a new session; the plugin leaves trust records and user configuration untouched. Follow [native host acceptance](testing/hooks-host.md): direct CLI JSON tests cannot establish native async scheduling, routing or Interrupt delivery.

## Troubleshooting

Use status with representative paths to inspect tool selection and capabilities, then refresh=true after repairs. A failing installed command is not replaced with a downloaded alternative. Windows Path/PATH keys are normalized in request environments; an explicitly empty PATH remains meaningful.

Dependency installation, compilation/linking and tests still use the project's own commands. A complete check establishes completion of its configured checks only.

### Independent Rust CI

`.github/workflows/rust.yml` runs independently on Linux and Windows with Rust 1.99.1 and matching rust-analyzer, rust-src and rustfmt. Tools are installed only on CI runners; ordinary development and default npm test do not require Rust.

`npm run test:rust` uses the same REAL_TOOLS=1 switch as Python and other real-tool cases. It skips by default and fails on missing tools when enabled. Rust CI enables the switch and verifies the delivered bundle's diagnostics and repair updates, symbol/anchor targeting, references and calls, composite inspection and candidate test association, rename/format/Code Action previews and apply, and Cargo workspace checks. Fixtures use local path crates, pregenerated lockfiles and disabled dependency downloads during checking.

CI retains tool versions, test logs and MCP/fixture records in rust-<os> artifacts for 14 days. Artifact upload success does not establish acceptance; use the corresponding job conclusion. This entry is independent of the legacy test:real Rust opt-in.

### Local Rust and MATLAB LSP acceptance

npm test registers Rust and MATLAB MCP acceptance sequentially through test:local; both skip unless REAL_TOOLS=1. With that switch, run npm run test:local or select npm run test:rust / npm run test:matlab. Tests use dist/cli.js, so build after source changes. Missing prerequisites fail enabled suites.

MATLAB acceptance discovers the official server under ~/.vscode/extensions/mathworks.language-matlab-* and MATLAB on PATH. Override the server's out/index.js with CODEX_LSP_MATLAB_SERVER or the installation root with CODEX_LSP_MATLAB_INSTALL_PATH. Acceptance starts a separate local MATLAB analysis process and needs a working license. Default npm test and existing CI require no MATLAB installation. See [local LSP acceptance](testing/local-lsp.md) for configuration, coverage and records.

Custom LSP settings supplies section-keyed workspace/configuration responses and configuration-change notifications. languageId explicitly sets didOpen's document language, such as matlab for MATLAB. Omitting it preserves the extension mapping, including the default Objective-C language ID for .m.

<a id="limits"></a>

## Scope limits and local data

Discovery is limited to 10,000 files, individual reads to 1 MiB and paths to 200 entries. Impact analysis handles at most 200 symbols and 100 additional indirect nodes for one transitive layer, returning partial when exceeded. Composite queries and edit plans require a complete workspace snapshot; exceeding discovery/read limits rejects the operation. Narrow workspace or configure exclude. Project checks have a five-minute budget.

No telemetry. Source, diagnostic baselines and unresolved findings stay in private local caches. Plans/actions stay in service memory, and an idle workspace service normally exits after about five minutes. Different users, workspaces, CODEX_HOME values and bundles are isolated. Stop the service before clearing CODEX_LSP_CACHE.

<a id="upgrade"></a>

## Upgrading from 0.9

| Removed name | Replacement |
| --- | --- |
| check_project | check |
| check_diagnostics / lsp_diagnostics | diagnostics |
| lsp_status | status |
| lsp_navigation | navigate |
| lsp_rename | rename → apply |
| lsp_format | format → apply |

Old names return migration guidance without executing and have no hidden aliases. Update prompts, Skills and calling scripts, then start a new session.

rename/format now produce read-only plans; apply is the only source writer. Configuration still uses schemaVersion: 1, so existing global configuration can be retained. Preserve automatic-off and global gate choices and review Hook definitions again.
