# Codex CodeIntel 使用手册

本文对应当前 **0.9.0** 实现。Codex CodeIntel 通过 MCP 工具提供项目检查、LSP/lint 诊断、符号导航、重命名和格式化，通过可选 Hooks 在后台建立基线并反馈诊断。运行要求 **Node.js >=22.12.0**；发布包包含可直接运行的 `dist/cli.js`，使用插件无需安装本仓库的开发依赖。

## 安装与首次使用

```sh
codex plugin marketplace add https://github.com/zoisythe/codex-codeintel
codex plugin add codex-codeintel@codex-codeintel
```

安装或更新后启动新的 Codex 会话，通过 `/hooks` 查看并信任当前安装包的 Hook 定义。插件不再检查目录信任；宿主对 Hook 定义的审阅仍需完成。

在用户项目中开始会话，先调用 `lsp_status`，将 `workspace` 设置为该项目的绝对路径，并传入一个代表性的源文件 `path`。确认配置问题、所选工具和配置来源后，用 `check_project` 检查整个项目，或用 `check_diagnostics` 检查具体文件。可以在对话中要求使用 `$code-intelligence` Skill 选择工具和处理反馈。

使用 **setupLSP**（`$setup-lsp`）配置、安装或修复当前项目的语言工具；明确要求全局时才修改用户全局配置。普通编码遇到缺失能力时仍可继续编辑。setup 默认配置非阻塞自动反馈，不会自动开启结束门禁。也可手动准备类型检查器、语言服务器和 lint 工具；C/C++ 与 Rust 需要本地工具链。Python 的类型检查与导航使用 ty，lint 与格式化使用 Ruff；两者独立，缺少 Ruff 时仍可使用 ty。

<a id="configuration"></a>
## 配置位置与覆盖规则

插件只读取以下配置文件；文件不存在时使用默认值：

| 文件 | 用途 |
| --- | --- |
| `$CODEX_HOME/lsp-client.json` | 用户全局默认；未设置 `CODEX_HOME` 时为 `~/.codex/lsp-client.json` |
| `<workspace>/.codex/lsp-client.json` | 项目覆盖 |

每份 `lsp-client.json` 都必须是合法 JSON，包含 `"schemaVersion": 1`。不支持注释。覆盖顺序是内置默认、全局、项目；`lsp` 按语言合并，但同一语言的对象整体替换。`lint`、`formatting` 和 `automaticDiagnostics` 按字段合并；`exclude` 和 `projectChecks` 数组整体替换，项目数组不会追加到全局数组后。

插件不读取 Codex `config.toml` 或目录信任记录。父/子工作区均可加载自己的项目配置；路径边界、符号链接防护与写入冲突检测保持有效。`CODEX_HOME` 仍用于配置、缓存及服务隔离。旧信任字段和环境变量只产生迁移说明。

配置损坏不会阻断 Hooks。完整 JSON/schema 损坏时，状态与缓存仍可读取，执行请求返回配置错误；可定位的语言、lint 或检查定义错误只停用相关部分。状态返回 `configurationSources`、`configurationIssues` 以及语言能力状态，未实际启动的能力标为 `unverified`。状态查询不启动 LSP、不下载工具。

### 可复制的配置示例

| 示例 | 适用场景与修改要求 |
| --- | --- |
| [显式启用自动反馈](examples/lsp-client.default.json) | 自动发现检查器、默认语言服务器、非阻塞反馈；未配置时自动反馈仍为 off；可直接作为全局或项目配置 |
| [显式项目检查](examples/lsp-client.project-checks.json) | `web/` TypeScript + ESLint、`api/` ty + Ruff；按实际目录、工具位置和检查范围修改 |
| [自定义语言服务器](examples/lsp-client.custom-server.json) | 修改 Python 绝对工具路径；本地 TypeScript 7 原生 LSP；关闭 Rust LSP |
| [全局结束门禁](examples/lsp-client.stop-gate.global.json) | 仅写入用户全局配置，明确选择门禁时使用；setup 不会自动启用 |
| [关闭自动检查](examples/lsp-client.automatic-off.json) | 关闭两个自动反馈模式；仍可显式使用 MCP 工具 |

从插件仓库复制配置到自己的项目，例如：

```sh
mkdir -p /absolute/path/to/project/.codex
cp docs/examples/lsp-client.default.json /absolute/path/to/project/.codex/lsp-client.json
```

文件名必须改为 `lsp-client.json`，示例不会被自动加载。项目 `.codex/` 在本仓库的 Git 忽略范围内；不要将个人路径或凭据混入共享示例。

### 配置字段

| 字段 | 接受值与默认行为 |
| --- | --- |
| `schemaVersion` | 必须为数字 `1` |
| `projectChecks` | 默认 `"auto"`，或完整检查定义数组 |
| `automaticDiagnostics.postToolUse` | 默认 `"off"`，可设为 `"delta"` |
| `automaticDiagnostics.stop` | 默认 `"off"`，可设为 `"errors"`，只控制结束反馈 |
| `stopGate` | 仅用户全局有效；`"off"`（默认）或 `"introduced-errors"`；项目字段被忽略并说明 |
| `lsp` | 语言名到内置服务器名、自定义对象或 `false` 的映射 |
| `lint.javascript` | `"auto"`、`"biome"`、`"eslint"`、`"off"`；默认 `"auto"` |
| `lint.python` | `"auto"`、`"ruff"`、`"off"`；默认 `"auto"` |
| `formatting.tabSize` | 整数 1–16，默认 `4` |
| `formatting.insertSpaces` | 布尔值，默认 `true` |
| `exclude` | 默认 `[]`；相对工作区的正斜杠 glob，如 `generated/**`，不支持绝对路径、`..`、反斜杠或 `!` 否定规则 |

`lint.python="off"` 只关闭 Python lint，显式格式化仍可使用 Ruff。关闭某语言 LSP 使用该语言的 `false` 值；这不会替代对应的项目 CLI 检查配置。

### 语言服务器与本地工具

| 语言键 | 默认服务器 | 常用选择 |
| --- | --- | --- |
| `python` | `ty` | `ty`、`basedpyright`、`pyright` 或自定义对象 |
| `typescript` | `typescript` | 传统 `typescript-language-server`；`tsc` 为 TypeScript 7 原生 LSP，`tsgo` 为预览入口 |
| `cpp` | `clangd` | C 与 C++ 共用该语言键 |
| `rust` | `rust` | 启动 `rust-analyzer` |
| `bash`、`yaml` | `bash`、`yaml-ls` | Shell、YAML |
| `html`、`css`、`json` | 同名服务器 | HTML、CSS/SCSS/Less、JSON/JSONC |
| `svelte`、`astro`、`go`、`lua`、`java` | `svelte`、`astro`、`gopls`、`lua-ls`、`jdtls` | 安装对应本地服务器 |

也可按新语言键选择已注册服务器或定义完整自定义对象。自定义对象需要非空 `command` 参数数组与带点的 `extensions` 数组，可提供字符串环境变量映射 `env` 和初始化对象 `initialization`。不同启用语言不得争用同一扩展名；先关闭或替换原语言条目。

工具解析顺序为：显式命令、最近的项目环境（如 `.venv` 或 `node_modules/.bin`）、PATH、已注册的临时启动器。显式命令按配置执行；本地工具启动失败会报告错误，不会下载替代版本。

自动检查不下载工具，只使用本地或已经准备好的工具。显式活跃 LSP 请求在找不到本地工具时可以准备已注册的临时工具，不修改项目依赖或锁文件。clangd、rust-analyzer 和 `tsgo` 无自动安装器。`"typescript": "tsc"` 要求 TypeScript 7 或更高版本；本地旧版 `tsc` 不会被自动替换。

## 项目检查与诊断基线

`projectChecks="auto"` 从工作区根目录配置发现 TypeScript、Python、Cargo 和 lint 检查。TypeScript 按有效 `files/include/exclude` 范围判定覆盖；JavaScript 类型覆盖需要同时启用 `allowJs` 与 `checkJs`。Python 尊重 ty 的 include/exclude。Cargo 默认检查 workspace、all-targets 和默认 features。

TypeScript references、多包仓库、C/C++、自定义语言和特殊 Cargo features 应显式定义检查。显式数组替换自动发现结果，必须列出需要的类型和 lint 检查。

| 检查定义字段 | 要求 |
| --- | --- |
| `name` | 非空且在数组中唯一 |
| `cwd` | 相对工作区的目录；根目录使用 `"."`，不能越出工作区 |
| `command` | 可执行程序与参数组成的非空数组，直接执行而非 shell 字符串 |
| `parser` | `tsc`、`ty`、`cargo`、`ruff`、`eslint`、`biome`、`json` 或 `sarif` |
| `coverage` | 相对该检查 `cwd` 的非空路径/glob 数组，必须准确描述命令实际检查的源文件 |

显式示例假定 Node 工具安装在 `web/node_modules/.bin/`，Python 工具在 `api/.venv/bin/`。若依赖提升到仓库根目录或使用 Windows，应改为实际可执行文件路径。检查程序必须只检查，不安装依赖、不修改源文件；避免 `--fix`。Ruff 示例明确关闭 fix 和 fix-only。

ty 使用 concise 输出，Cargo 使用 JSON，Ruff/ESLint/Biome 使用相应结构化诊断输出。自定义 `json` 输出格式如下；空诊断使用 `{"diagnostics":[]}`：

```json
{
  "diagnostics": [
    {
      "path": "src/example.c",
      "line": 1,
      "column": 1,
      "severity": "error",
      "source": "type-check",
      "message": "problem description"
    }
  ]
}
```

路径相对检查工作目录，行列从 1 开始。C/C++ 可通过自己的只检查命令或包装脚本输出 `json`/`sarif`；clangd 提供文件诊断与导航，并不能替代项目 CLI 基线。

文件编辑、shell、MCP 重命名和格式化均不需要诊断基线。SessionStart 在自动反馈启用时后台尝试建立基线。基线按检查器和实际覆盖范围判断可靠性，部分失败不妨碍其他范围反馈；没有可靠编辑前基线时仍可报告当前诊断，但标为无法归因，不认为是本轮新增。

结束门禁仅在用户全局 `stopGate="introduced-errors"` 且 `automaticDiagnostics.stop="errors"` 时有效。它要求编辑前基线可靠、覆盖充分、当前同一检查器确认新增错误、文件内容和配置仍匹配；每轮最多阻断一次。pending、超时、配置错误、工具缺失、覆盖不足或过期结果均不触发。项目不能自行启用门禁。空检查数组表示没有项目覆盖，不影响编辑。

## MCP 工具与调用示例

所有工具都传入绝对用户项目路径 `workspace`。`path`/`paths` 指向该项目内文件；位置从 1 开始。多会话共享工作区时，turn/session 范围传入对应 Codex `session` ID。

| 工具 | 用途 |
| --- | --- |
| `check_project` | 启动或读取整个项目的 CLI 检查任务，查找未修改调用方中的错误 |
| `check_diagnostics` | 显式文件或 turn/session 范围的 LSP、lint 或双通道检查 |
| `lsp_status` | 检查配置问题、能力状态、配置来源、工具选择、启动失败与运行状态；不启动 LSP |
| `lsp_navigation` | 只读符号导航与重命名前检查 |
| `lsp_rename` | 应用跨文件重命名 |
| `lsp_format` | 格式化显式文件；Python 使用 Ruff，其他语言采用项目格式化器或 LSP |

以下 JSON 为工具参数，替换项目路径和文件位置后使用。

### 全项目检查与缓存

调用 `check_project`：

```json
{ "workspace": "/absolute/path/to/project", "run": "active" }
```

活跃请求启动或复用后台任务。返回 `state="running"` 时继续查询；有分页或后续工作时使用完整结构化 `next` 参数，包括 `run="cached"`、`job`、`cursor`。不要自行构造游标。`run="cached"` 只读取结果，不启动检查；`missing` 表示没有可读任务，`stale` 表示结果已失效。`complete` 可能包含历史错误，应查看 `errors`、`warnings` 和各检查器状态。

也可使用随包 CLI，输出为 JSON：

```sh
codex-codeintel check_project /absolute/path/to/project
codex-codeintel check_project /absolute/path/to/project --run cached --job JOB_ID
codex-codeintel check_project /absolute/path/to/project --refresh
```

从源码仓库使用 `node dist/cli.js check_project ...`；`--cursor` 支持后续分页。CLI 的 `mcp` 和 `hook` 入口供宿主集成使用。

### 文件诊断与状态

调用 `check_diagnostics`：

```json
{
  "workspace": "/absolute/path/to/project",
  "paths": ["src/main.ts", "src/helper.ts"],
  "scope": "paths",
  "source": "both",
  "run": "active"
}
```

`scope` 支持 `paths`、`turn`、`session`；`source` 支持 `lsp`、`lint`、`both`；`run` 支持 `active`、`cached`。默认采用 paths/both/active；paths 范围必须提供显式文件或文件目录范围，不能用 `"."` 或省略路径请求全工作区检查。全项目改用 `check_project`。

读取当前轮 Hook 共享诊断可调用 `check_diagnostics`：

```json
{
  "workspace": "/absolute/path/to/project",
  "session": "CODEX_SESSION_ID",
  "scope": "turn",
  "source": "both",
  "run": "cached"
}
```

`refresh=true` 用于活跃诊断、活跃项目检查或状态请求。调用 `lsp_status` 检查某语言：

```json
{ "workspace": "/absolute/path/to/project", "path": "src/main.py", "refresh": true }
```

状态刷新会重新解析工具并清除相关失败/客户端；状态请求本身仍不启动服务器。`pending`、`stale`、`failed`、缺少工具或部分覆盖不能解释为检查通过。

### 导航、重命名和格式化

调用 `lsp_navigation`：

```json
{
  "workspace": "/absolute/path/to/project",
  "path": "src/main.ts",
  "operation": "definition",
  "line": 12,
  "column": 5
}
```

`operation` 支持 `definition`、`references`、`symbols`、`prepare_rename`、`hover`、`typeDefinition`、`implementation`、`signatureHelp`；符号查询可提供 `query`。服务器未支持某操作时明确报告，不影响该语言的其他操作。导航结构化输出使用 `status` 和 `result`。

调用 `lsp_rename` 时传入文件、行列和 `newName`；调用 `lsp_format` 时传入显式 `path` 或 `paths`。先检查编辑目标与授权范围，再按顺序执行写操作。

```json
{
  "workspace": "/absolute/path/to/project",
  "path": "src/main.ts",
  "line": 12,
  "column": 5,
  "newName": "updatedName"
}
```

```json
{ "workspace": "/absolute/path/to/project", "paths": ["src/main.py"] }
```

格式化返回 `status="formatted"` 或 `"unchanged"`。成功、部分失败或取消都要检查完整 `modifiedPaths`；部分写入不自动回滚，响应丢失后先检查文件再决定后续操作。写入成功后诊断失败作为附加 `diagnostics` 状态返回，不将成功写入报告为失败，也不应重放写操作。

## 自动 Hook 反馈

| 事件 | 默认行为 |
| --- | --- |
| SessionStart | 自动反馈默认关闭；启用时在短前台预算内登记后台基线任务 |
| PreToolUse | 发布定义已移除；手动调用始终直接放行，包括缺少会话标识和不支持运行环境 |
| PostToolUse | 自动反馈启用时登记后台检查或交付已完成反馈，不等待分析完成；只读操作消费缓存 |
| Stop / SubagentStop | 默认仅反馈；全局授权门禁后只阻断确认新增错误，每轮最多一次 |
| SessionEnd | 清理会话状态，即使配置损坏也可执行 |

两个自动模式均为 off 时，不扫描项目、不建立基线、不启动检查器或预热 LSP。
历史错误不会仅因存在而变成新增错误。仅行号移动不会新增同一诊断；重复诊断数量增加会计为新增。pending/stale/failed 结果保持不确定性，不清除未解决问题。

前台预算从输入解析后计时，包含 IPC、排队和结果校验；Node 进程加载耗时另计。Stop 最多等待约 42.5 秒，显式编辑 Hook 内部总预算 4.4 秒。等待超时或客户端断开只结束等待，已经登记的后台任务继续运行，最多运行五分钟。会话结束、内容代次或相关配置失效、工具身份、结束策略变化及服务关闭取消相应任务。

后台结果持久排队，通过后续 PostToolUse 的 additionalContext 或 Stop 交付。消息带有 `[Codex CodeIntel automatic diagnostics]` 标记、来源 turn 和稳定 deliveryId；成功输出后确认交付，确认丢失可重发同一 ID。文件 hash、generation、会话代次及分析身份不匹配时不交付旧结果。部分、失败、过期和仍在检查不代表检查通过；只有可靠完成的空结果表示没有诊断。零等待是读取已完成状态，不给异步读取套 0ms 超时。需要检查未修改调用方或整个项目时显式使用 `check_project`。

自动反馈启用时，共享服务就绪后延迟约两秒预热最多两种主要语言，复用已有文件 inventory 和本地工具，不安装依赖。同一 workspace 合并预热及 LSP 初始化。初始化失败按 30、60、120、最高 300 秒冷却；成功、工具身份变化或显式 refresh 重置。LSP 与服务的闲置复用窗口均为 300 秒，活跃任务不计闲置。

## 排查问题

| 现象 | 处理步骤 |
| --- | --- |
| 能力未配置或工具缺失 | 普通编辑继续；配置/安装/修复任务使用 `$setup-lsp` |
| Hook 未运行 | 查看 `/hooks`，确认当前安装版本的定义已启用和信任；更新后重启会话 |
| 工具缺失或启动失败 | 用 `lsp_status` 指定代表性文件查看解析命令；修复本地环境后 `refresh=true` |
| 结束被门禁阻断 | 检查全局 stopGate 及确认新增错误，修复一次；诊断不可靠时不会阻断 |
| TypeScript 原生 LSP 启动失败 | 检查本地 `tsc` 是否 >=7；若使用传统服务器，将语言条目改为 `"typescript"` |
| Ruff 缺失 | 单独安装/修复 Ruff；ty 类型与导航仍可用；lint=off 不会禁用显式格式化 |
| Rust 长时间 pending | 等待索引及后续结果，确认 rust-analyzer、rust-src、项目工具链和依赖已准备好 |
| 缓存结果 stale/missing | 发起活跃检查；项目结果跟随 `next` 查询，不把缺少结果当作零错误 |
| 环境或外部依赖改变 | 刷新状态或活跃检查；工作区外的变化不保证被自动观察 |

自动命令禁止下载 Rustup 工具链或 uv Python、同步环境和自动修复源码。应在检查前完成依赖准备；自定义检查命令也必须遵守只检查约定。

<a id="limits"></a>
## 范围限制与本地数据

文件发现上限为 10,000 个文件，单文件读取上限为 1 MiB；显式诊断每页最多处理 50 个文件，单次 `paths` 参数最多 200 项。项目检查任务预算为五分钟，输出存在大小限制；超限、超时或未完成状态不能证明项目没有错误。

`complete` 表示对应分析已完成，构建、链接和测试仍需项目自己的命令。CLI coverage 必须匹配命令的实际范围；自定义 Cargo features、外部配置导入与工作区外依赖需要项目配置和必要的刷新。

无遥测。源文件、诊断基线与未解决问题留在本地私有缓存；日志使用固定类别，不记录源代码或凭据。`CODEX_LSP_CACHE` 可指定会话元数据和日志目录。停止服务后可删除该目录清理会话数据；全局配置、项目配置及准备工具缓存分别管理。工作区服务空闲约五分钟后退出；不同用户、工作区、`CODEX_HOME` 和 bundle 版本隔离。

<a id="upgrade"></a>
## 从旧版本升级

使用旧名称安装的插件先移除旧插件，再执行本手册的安装命令：

```sh
codex plugin remove codex-lsp@codex-lsp-standalone
```

无其他插件依赖旧 marketplace 时，可移除 `codex-lsp-standalone` marketplace。将旧 `$lsp` Skill 请求改为 `$code-intelligence`。现名称为 `codex-codeintel`，npm 包为 `@zoisythe/codex-codeintel`；MCP 注册键仍为 `lsp`。`lsp-client.json` 路径、`CODEX_LSP_CACHE` 和 `CODEX_LSP_REAL_TOOLS` 环境变量名保持不变。

| 旧配置或请求 | 当前用法 |
| --- | --- |
| 无 schemaVersion 的配置 | 添加 `"schemaVersion": 1`，按语言定义 `lsp` |
| `LSP_TOOLS_MCP_*_CONFIG`、`CODEX_LSP_TRUST_PROJECT` | 这些变量仅提示迁移且被忽略；使用固定配置路径 |
| `trustedWorkspaces` | 移除旧字段；仅提示迁移，不影响执行 |
| `priority`、`disabled` 服务器字段 | 使用完整语言条目；关闭时设为 `false` |
| `lsp_diagnostics` | `check_diagnostics`，`source="lsp"` |
| `mode`、`start`、`offset`、`revision` | 使用 `scope/source/run`，分页跟随结构化 `next` 和 opaque `cursor` |
| 全工作区 `check_diagnostics` | 使用 `check_project`；文件诊断提供显式路径或 turn/session 范围 |
| 自动 `full`、Stop `delta` 模式 | PostToolUse 使用 `delta/off`，Stop 使用 `errors/off` |
| 导航中的 rename | 独立 `lsp_rename` 工具 |

0.9 移除插件目录信任检查和 PreToolUse 编辑门禁。两个自动模式默认关闭，已有显式设置继续生效。原有 `stop="errors"` 现在只反馈；要恢复结束阻断，用户须在全局配置明确设置 `stopGate="introduced-errors"`。setupLSP 不会自动开启它。项目同名字段被忽略。更新后重启会话，并**重新审阅 Hook 定义**；用户配置不会自动改写。新增 setupLSP Skill 可正常发现，以 `$setup-lsp` 调用。

源码归属与 MIT 许可见 [NOTICE](../NOTICE) 和 [LICENSE](../LICENSE)。阶段架构、迁移、验收和性能记录保留在维护者本地 `docs/history/`，该目录被 Git 忽略，不包含在仓库新提交或发布包中。
