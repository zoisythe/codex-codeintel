# Codex CodeIntel 使用指南

本文对应 **0.10.0**。插件提供九个 MCP 工具，Hooks 与 MCP 共享本地 LSP、项目检查和诊断缓存。运行要求 Node.js >=22.12.0；交付 bundle 不需要安装运行时依赖。

## 安装与首次使用

```sh
codex plugin marketplace add https://github.com/zoisythe/codex-codeintel
codex plugin add codex-codeintel@codex-codeintel
```

开启新会话并通过 `/hooks` 检查 Hook 定义。使用 setupLSP（`$setup-lsp`）配置、安装或修复所需工具。普通编码中能力缺失只需报告一次并继续其他工作。

<a id="configuration"></a>
## 配置位置与覆盖规则

读取 `$CODEX_HOME/lsp-client.json`（默认 `~/.codex/lsp-client.json`）和项目的 `.codex/lsp-client.json`。优先级为内置、全局、项目；两者都使用 `schemaVersion:1`。同一语言的 LSP 对象整体替换；exclude/projectChecks 数组整体替换。

```json
{
  "schemaVersion":1,
  "projectChecks":"auto",
  "lsp":{"python":"ty","typescript":"typescript","go":"gopls","cpp":"clangd","rust":"rust"},
  "lint":{"javascript":"auto","python":"auto"},
  "automaticDiagnostics":{"postToolUse":"off","stop":"off"}
}
```

| 字段 | 含义 |
| --- | --- |
| lsp | 语言到内置名称、false 或自定义 command/extensions/env/initialization 对象的映射 |
| lint.javascript | auto、biome、eslint、off |
| lint.python | auto、ruff、off |
| formatting | tabSize（1–16）、insertSpaces |
| exclude | 相对路径正向 glob；不接受绝对路径、反斜线、否定或 .. |
| projectChecks | auto 或显式检查数组；数组替换自动发现结果 |
| automaticDiagnostics | postToolUse=delta/off，stop=errors/off；默认均 off |
| stopGate | 只有用户全局配置可设 introduced-errors；默认 off |

本地工具优先，显式命令失败不回退到下载版本。Python ty 与 Ruff 独立；lint=off 不会禁用显式格式化。TypeScript 默认使用传统 language server，原生 TypeScript 7 可选择 tsc。Go 使用 gopls；C/C++ 和 Rust 使用现有本地工具链。

配置损坏不阻断编辑。status、缓存读取仍可用；可定位的语言/检查配置错误只影响相关能力。status 不启动 LSP、不下载工具，unverified 不代表已经成功启动。目录信任记录不控制插件执行。

## 九个 MCP 工具

所有调用使用绝对 workspace。位置为 **1-based、UTF-16 列**。位置操作接受以下一种定位方式：

- line/column；
- symbol，例如 Class.method；重载索引由 symbols 结果提供；
- pattern，例如 function @@greet，以 @@ 标记光标。

重名或多个锚点匹配返回候选，插件不会猜测。工作区符号搜索仍使用 navigate 的 operation=symbols 和 query；path 用于选择语言服务器。

| 工具 | 用途 |
| --- | --- |
| check | 项目 CLI 检查；active 启动任务，cached 读取 job，跟随 next |
| diagnostics | 显式路径、turn/session 的 LSP、lint 或 both 检查；active/cached |
| status | 工具、配置、能力、失败和任务状态；refresh 重新验证 |
| navigate | 原子语义查询及 outline |
| rename | 只读重命名计划 |
| format | 只读格式化计划 |
| inspect | symbol 组合探索或 impact 影响分析 |
| actions | list/explain/preview 修复动作 |
| apply | 消费既有计划并顺序写入；唯一源码写入口 |

### 项目检查与诊断

```json
{"workspace":"/project","run":"active"}
```

使用 check。任务未完成时跟随返回的 next；state=running/failed/stale 不能证明项目无错误。CLI 也可使用 `codex-codeintel check <workspace>`。

diagnostics 示例：

```json
{"workspace":"/project","paths":["src/main.ts"],"source":"both","run":"active","severity":"error"}
```

scope 可为 paths、turn、session；多会话时必须提供 session。路径诊断不能用省略路径或 "." 代替全项目检查，应使用 check。rule/severity 只筛选展示，不改变实际检查、基线或缓存；失败和 pending 状态不会被过滤隐藏。

默认诊断保留位置、规则、严重性、消息和已知修复可用性。修复编辑、完整文档及工具原始信息不会随每次诊断发送。统计按规则/文件汇总；归因仅使用可靠的既有 checker 基线，缺失时为 unattributed。不同规则、检查器与覆盖范围不能相互替代基线。

projectChecks 的每项包含 name、cwd、command、parser、coverage；相对命令/coverage 均相对 cwd。支持 parser：tsc、ty、go、cargo、ruff、eslint、biome、sarif、json。自定义 json 为：

```json
{"diagnostics":[{"path":"src/a.ts","line":1,"column":1,"severity":"error","source":"rule","message":"problem"}]}
```

自动发现支持根 tsconfig、ty、Go module、Cargo workspace 和匹配的 lint 配置。TypeScript references/多包、特殊 features、自定义语言及 C/C++ CLI 检查应显式配置。命令必须只检查，不修改源码、自动修复或安装依赖。示例见 [docs/examples](examples/)。

Go 自动检查使用 go vet -mod=readonly -json ./...，由 go list 确认实际 Go/Test 输入，不把 build tags、平台排除或其他 module 的文件算作覆盖。自动检查禁止 Go 工具链/模块下载；需要的环境和依赖应先准备好。缺失工具或包发现失败为 unavailable/failed，不能返回干净结果。

### 导航与组合分析

navigate 支持 definition、declaration、references、symbols、prepare_rename、hover、typeDefinition、implementation、signatureHelp、incoming、outgoing、supertypes、subtypes、completion。

```json
{"workspace":"/project","path":"src/main.ts","operation":"symbols"}
```

outline 默认只展示顶层；传入 symbol 展开该节点的直接成员。成员过多会分页，不再因一个大 class 超限而返回空列表。关系查询返回直接关系；进一步展开需重新定位对应符号。服务器不支持时明确返回 unsupported。

```json
{"workspace":"/project","path":"src/main.ts","operation":"symbol","symbol":"greet","source":true}
```

使用 inspect 聚合签名/文档、定义、引用摘要和调用关系；source 默认省略。operation=impact 接收明确 path/paths 或定位符，汇总顶层类型/函数及类型成员的引用，排除局部变量、字段噪声。symbols 可指定文件内的符号路径集合，逐项保留歧义或失败；调用方来自调用层级，普通引用单独统计。transitive=true 最多追加一层，预算不足明确 partial。各子查询独立报告失败。

候选测试仅依据文件命名和符号引用，不是运行时覆盖证明。零引用不证明可安全删除；没有并发安全或死代码自动裁决。

### lint 与 LSP 修复

```json
{"workspace":"/project","path":"src/main.py","operation":"list","source":"lint"}
```

使用 actions。source=lint/lsp/both，默认 both。list 返回动作 id、标题、来源、适用性和不可用原因，不默认返回全部编辑。

explain 接收 path 和 rule。返回当前安装工具可确认的规则说明、文档和有效设置；details=true 按需展开。工具未提供配置来源或忽略原因时明确为 unknown，不猜测。

preview 传入选定 ids，或在明确文件范围内批量生成计划：

```json
{"workspace":"/project","operation":"preview","ids":["action-id"]}
```

批量默认只选择工具明确标记 safe 的动作。unsafe、unknown 和 suggestions 需显式选择；ESLint fixable 不会被重标成 safe。Ruff/ESLint 保留逐诊断编辑，Biome 通过 stdin 生成文件级修复；按 rule 预览时仅处理当前诊断已确认启用的规则，不通过筛选开启原本关闭的规则。

LSP 动作可 resolve 后生成纯文本计划。带 command、disabled 或创建/删除/移动文件的动作标为 unsupported，不执行其命令，也不部分应用。lint 修复不会顺带调用 formatter、添加抑制注释或修改配置。

### 编辑计划与 apply

rename 示例：

```json
{"workspace":"/project","path":"src/main.ts","symbol":"greet","newName":"welcome"}
```

format 示例：

```json
{"workspace":"/project","paths":["src/main.ts"]}
```

两者都只生成 plan、文件摘要和 diff，不写入。随后：

```json
{"workspace":"/project","plan":"returned-plan-id"}
```

调用 apply。对已授权修改可连续执行预览与应用，无需新增人工批准步骤。计划只描述文本修改；它不包含内存类型模拟，也不保证构建或测试成功。

计划存在工作区服务的有界内存中，服务重启即失效。源文件、配置、工具或请求环境变化会使计划失效。应用先预检所有目标，冲突、越界、符号链接变化或重叠编辑会拒绝；之后逐文件确认并写入。

计划进入应用后被消费，不能重放。取消/失败返回实际修改路径；多文件操作不承诺原子回滚。写后诊断失败是补充状态，不能因此再次应用同一个计划。需要继续操作时重新生成计划。

## 分页与返回信息

默认最多 20 项，详情页约 8 KiB，结构化输出也受预算控制。文本仅作短摘要。始终跟随 next 提供的完整参数；不要自行计算 offset、复制旧 revision 或拼接游标。

大型嵌套值拆成 items 中的字段片段：field 使用 result["key"][index] 表示原输出路径；value 保存完整小值，part/text 保存按序文本分段。路径中带点或斜线的键使用带引号的下标，避免歧义。源码、diff 和大 outline 可以完整续取，不静默丢失。底层项目任务或诊断批次仍需继续时，最后一页的 next 转交对应任务的后续参数。

查询游标绑定查询、快照、配置及工具；apply 的后续页绑定已发生的执行记录，因此后续源码修改不妨碍读完 modifiedPaths。失效时重新发起原查询；不要用不同的过滤条件复用旧游标。页面中的 partial/failed/pending 信息必须保留，分页完成不代表底层分析已完成。

## 自动 Hook 反馈

自动反馈默认关闭，保留现有 automaticDiagnostics 和全局 stopGate 选择，不增加配置项。需要支持原生异步 command Hook 和 Interrupt 的当前 Codex 宿主；没有旧宿主兼容执行模式。Hooks 不调用 apply，不自动修复或格式化源码。

| 事件 | 处理方式 |
|---|---|
| SessionStart | 同步入口预算 500 ms，保存修改前快照并登记基线任务，不等待项目检查。仅 startup/resume/clear/fork；compact 不重复发现。resume 复用有效状态，其余建立新 epoch。 |
| PostToolUse | 原生 async，仅匹配 Bash、apply_patch、mcp__lsp__apply。内部总预算 310 秒，宿主 timeout 330 秒；原工具结果不受影响。已知只读 shell 只领取完成的反馈，不启动服务或检查。 |
| Stop | 普通反馈总预算 1.5 秒，最多等待结果 300 ms；变化发现和检查可在后台继续。显式全局门禁开启时保留 44 秒总预算。 |
| SubagentStop | 独立代理反馈，总预算 1.5 秒，始终不能请求续跑。 |
| SessionEnd | 内部预算 1.6 秒、宿主 3 秒，取消任务并以 epoch 失效旧交付。 |
| Interrupt | 内部预算 1 秒、宿主 3 秒，解除等待、取消明确属于被中断轮次的自动任务；身份不明保留 pending，不终止共享 LSP 或 MCP 写入。 |

只有明确 agent_id 的事件属于子代理，不从 transcript 猜测。工作区版本、LSP 和缓存共享，代理任务等待、轮次、反馈记录分别保存；归属不明的结果标记 shared，由主任务 Stop 汇总。MCP 的 session 仍表示共享会话。SubagentStop 不消费主任务或其他代理的反馈。

只有主任务 Stop 在用户全局 stopGate=introduced-errors 时，才可为可靠、覆盖且新鲜的新增错误请求每 turn 最多一次修复。缺少修改前基线、未知、失败、pending、stale 不阻断。setupLSP 不自动启用门禁。SessionStart 的 additionalContext 可供模型读取；Stop/SubagentStop 普通输出是 UI 摘要，不能据此声称模型已经读取。

写事件按 session epoch、明确代理及 tool_use_id 幂等登记；没有 ID 时不猜测重复。合并窗口 200 ms，连续变化最长延后 1 秒，以当前内容哈希确认快照。apply 的完整 modifiedPaths（含部分写入）用于范围提示；分页、未知或不完整结果回退文件变化发现。分析身份和快照相同时复用 apply 写后的诊断。

每条自动反馈最多 2 KiB UTF-8、五条关键诊断，报告 introduced/resolved/unattributed/pending 数量；同一状态去重，每代理每 turn 总量最多 8 KiB，并为收尾摘要预留空间。详情使用现有 diagnostics(run=cached, scope=session) 并提供共享 session。内部 hook_wait 仅长轮询已登记任务，单次最多 20 秒，不新增 MCP 工具。

deliveryId、sourceTurn 和内容快照随交付保留，发送前复核新鲜度。ACK 仅表示 stdout 成功写出，ACK 失败可使用同一 ID 重发；不保证模型层恰好一次接收。没有证明建立于修改前的检查始终未归因。

本版升级内部元数据格式，不迁移旧交付记录。更新后通过 /hooks 重新审阅定义，并在新会话使用；插件不修改信任记录或用户配置。真实宿主验收按 [Hooks 验收步骤](testing/hooks-host.md) 执行，CLI JSON 测试不能替代宿主原生异步、路由和 Interrupt 检查。

## 排查问题

用 status 配合代表性 path 查看工具选择与能力；修复后 refresh=true。现有命令启动失败不选择下载替代品。Windows 的 Path/PATH 在请求环境中统一规范化；显式空 PATH 仍然有效。

依赖安装、构建/链接与测试仍需项目自己的命令。check 完成只代表指定检查完成。

### 独立 Rust CI

`.github/workflows/rust.yml` 独立运行于 Linux 和 Windows，固定 Rust 1.99.1 及配套的 rust-analyzer、rust-src、rustfmt。工具只安装到 CI runner，本机日常开发和默认 `npm test` 不要求 Rust。

`npm run test:rust` 是需要已准备工具链的真实验收入口；缺少工具会失败，不会跳过。用例通过已交付 bundle 验证诊断及修复后的更新、符号/锚点定位、引用和调用、组合探索与候选测试关联、重命名/格式化/Code Action 的预览与 apply，以及 Cargo 工作区检查。fixture 只依赖本地 path crate，预先生成 lockfile，检查期间禁用依赖下载。

CI 保留工具版本、测试日志及 MCP/fixture 记录为 `rust-<os>` artifact，保留 14 天。日志成功上传不代表验收通过，应以对应 job 的结果为准。新入口与历史多语言 `test:real` 的 Rust 开关独立。

<a id="limits"></a>
## 范围限制与本地数据

发现预算 10,000 文件，单文件读取预算 1 MiB，paths 最多 200 项。影响分析每次最多处理 200 个符号、追加一层时最多 100 个间接节点；超限明确 partial。组合查询和编辑计划需要完整的工作区快照；超出发现或单文件预算时明确拒绝，需缩小 workspace 或配置 exclude。项目检查预算五分钟。

无遥测。源码、诊断基线和未解决问题留在私有本地缓存。计划与动作在服务内存中，工作区服务空闲约五分钟退出。不同用户、workspace、CODEX_HOME 和 bundle 隔离；停止服务后可清理 CODEX_LSP_CACHE。

<a id="upgrade"></a>
## 从 0.9 升级

| 移除的旧名 | 新名 |
| --- | --- |
| check_project | check |
| check_diagnostics / lsp_diagnostics | diagnostics |
| lsp_status | status |
| lsp_navigation | navigate |
| lsp_rename | rename → apply |
| lsp_format | format → apply |

旧名只返回迁移提示，不执行，也不保留隐藏调用别名。更新提示词、Skills 和调用脚本，并启动新会话。

rename/format 的含义发生变化：它们是只读计划工具；apply 是唯一源码写入口。配置仍使用 schemaVersion:1，不需要重新创建全局配置。保留既有 automatic-off 和全局门禁选择；重新审阅 Hook 定义。
