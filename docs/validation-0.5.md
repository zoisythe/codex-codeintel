# 0.5.0 本地验收（2026-09-30）

本记录针对交付的 `dist/cli.js`。MCP 和 Hook 验收通过独立 Node 子进程驱动，不将旧版本的 Codex 会话或其他平台结果作为本次证据。

## 环境与交付身份

- Linux x86_64，WSL2 内核 `6.18.33.2-microsoft-standard-WSL2`；Node.js `26.10.0`，npm `12.1.0`。
- 本地工具实际版本：ty `0.0.82`、Ruff `0.16.8`、uv `0.12.20`；Clang、clangd、clang-format 均为 `22.1.8`；rust-analyzer、Cargo、rustc 均为 `1.98.1`，rustfmt `1.9.0-stable`。
- package、plugin manifest 和 MCP serverInfo 版本均为 `0.5.0`。会话元数据和日志使用 v5 命名空间。
- 开发 submodule 保持 `9cc6f753d04834c148d08bbca72e3b483d6301b2`，未修改。安装副本没有 node_modules 或 submodule，实际执行复制的 bundle 和 Skill。
- 最终 bundle SHA-256：`b3149cf5878b1c318ab64dce19da5bdf6b779262768560f856b6584f4b1e616f`。性能报告独立记录同一 SHA-256。
- 实际 `npm pack` 交付包包含 17 个文件，涵盖 bundle、Skill、迁移与验收文档；没有 node_modules 或 packages。解包后 bundle/Skill 逐字节一致，MCP 初始化返回 0.5.0 和五个工具，Hook SessionEnd 成功。

## 检查命令

```sh
npm run check
npm test
npm run typecheck
CODEX_LSP_REAL_TOOLS=1 npm run test:real
node scripts/benchmark.mjs
git diff --check
```

`check` 的严格 TypeScript、Biome 和构建通过；完整测试为 6 个文件中的 **32 项 Vitest 测试，加 8 项 Node 子进程测试**。真实工具验收另有 **3 项子进程测试**，没有跳过。Skill 通过 skill-creator 的 `quick_validate.py`。

## 本地优先、停用与配置

`test/resolution-e2e.test.mjs` 使用隔离 PATH、可记录调用的启动器和实际 bundle：

- PATH 中已有 ty/Ruff、最近项目 `.venv` 中已有两者、两者来源混合时，选择正确；存在 uvx/uv/pipx/npx 时，其调用记录仍为空。
- 嵌套包与工作区根同时有 TypeScript `node_modules/.bin` 时，选择最近包。
- 本地 ty 启动失败明确报告 no fallback，未调用启动器；另一个包成功启动不会清除该失败的 30 秒缓存。Python 依次选择 uvx、uv、pipx；TypeScript 选择 npx 并包含所需 TypeScript 分发；只有 npx 时 clangd 仍为 missing。
- 所有启动器缺失、Python 关闭、Ruff 缺失、混合目录 partial、普通文本跳过、两个工作区隔离和写操作预检失败均覆盖。Ruff 缺失时 LSP 通道和导航继续可用。
- 未信任项目的无效配置被忽略；信任后相同配置报错。旧 schema 与废弃环境变量得到迁移提示；配置错误不影响 SessionEnd 清理。

真实 uvx 与 npx 验收使用空的隔离工具缓存：首次下载成功，后续离线复用成功；空缓存离线请求失败，不显示干净诊断。TypeScript 临时方案实际初始化 tsserver。项目 package.json 和 lockfile 未创建。准备 Ruff 后，用失败的 uvx 替代启动器，Hook 仍直接执行缓存 Ruff，启动器调用次数为零。

uv 和 pipx 的启动器选择经过隔离子进程验证；本次未声称实际完成它们的首次联网下载。未对 Bash/YAML/HTML/CSS/JSON/Svelte/Astro 各自重复联网安装验收。

## Python、C/C++ 与 Rust

`test/three-language-e2e.test.mjs` 驱动真实工具，测试内容均在临时工作区中生成：

- **Python**：ty 类型错误→修复→清空；跨文件定义、引用、符号和 hover 返回内容；类型定义指向另一文件，签名包含参数；声明位置 prepare_rename；跨文件 rename；Ruff 默认 lint、`.pyi` 格式化。uv 创建的虚拟环境包含本地依赖，ty 正确解析该依赖。将真实 ty/Ruff 可执行入口链接至 `.venv/bin`，分别验证两者均来自项目、ty 项目＋Ruff PATH、ty PATH＋Ruff 项目的实际运行，两个通道均完成。implementation 在本例返回空数组，表示无匹配实现。
- **C 和 C++ 分别验证**：Clang 构建多文件工程，真实编译数据库含宏和 include 参数；源文件/头文件定义、引用、hover、符号；头文件引入错误及修复、编译宏移除及恢复、源文件错误及修复均更新诊断。跨文件 rename 和遵循四空格 `.clang-format` 的 LSP 格式化后，重新构建通过。无编译数据库的独立 C 文件仍由 clangd fallback 返回诊断。
- **Rust**：无外部依赖的两 crate Cargo workspace；类型错误→修复→清空；实际定义、跨 crate 引用、hover 和符号；rename 更新另一 crate；LSP 格式化产生 rustfmt 的四空格缩进，随后 `cargo check --offline --workspace` 和 `cargo test --offline --workspace` 通过。新增模块和 Cargo 配置变化后重新分析成功。将 rustfmt 配置为不可执行命令时，格式化请求明确报错，没有报告服务器缺失或干净成功。

三语言测试执行了服务器初始化、诊断和导航请求；rust-analyzer 的证据来自实际运行，而非仅检查 rustup 代理路径。没有实际卸载本机 Rust 工具链，也没有声称覆盖所有工具版本组合。

## 可靠性与公共行为

公共 bundle 测试覆盖：

- MCP 内客户端复用、不同 MCP 进程隔离、Hook 不启动 LSP；Hook-only 文件 cached 状态为 pending；EOF 清理。
- pull full/unchanged；push 文档版本匹配、迟到更新及静默等待；首次无版本空结果在冷/热请求中均保持 pending；旧版本通知不作为新鲜结果。
- 不支持 hover 或 prepare_rename 时返回 unsupported，随后诊断仍完成；prepare_rename 独立检查服务器的 prepareProvider 能力。
- 初始化失败短期复用；推进测试时钟 31 秒后重试；status refresh 不启动服务器；配置改变立即恢复。
- opaque cursor 续页及内容/配置变化失效；扫描过程中内容变化保守失效；排队取消、执行取消、格式化/rename 部分写入报告及后续恢复。成功与取消后的结构化 modifiedPaths 保留完整路径；60 个长路径文件的格式化验证了短文本截断不会丢失结构化修改记录。
- Hook 时间预算、pending 补查、环境反馈去重、Stop 阻止去重、并发元数据写入及死写入者锁恢复；现有 PreToolUse 基线避免重复扫描。
- 加速两分钟闲置定时器后释放客户端、stdio 保持可用并能新建客户端。该测试使用加速定时器，不是等待两分钟的实测。

30 秒恢复使用模拟时钟推进；完整安装副本、实际三语言和工具下载测试使用真实子进程。没有在本轮启动真实 Codex GUI/CLI 会话；验证范围是交付 MCP/Hook 协议进程。

## 性能

原始测量见 [performance-0.5.json](performance-0.5.json)，复现脚本为 `scripts/benchmark.mjs`。基线固定为 `94ba395` 的交付 bundle，同一批 1,000/10,000 文件夹具用于前后版本。每组先预热，再分别进行 10 次修改后的主动检查、10 次缓存查询，共 80 次测量。读取计数器只统计夹具的依赖文件，用于核对完整内容扫描轮数。

| 文件数 | 版本 | 请求 | 中位数 ms | p95 ms | 完整扫描轮数 |
| --- | --- | --- | ---: | ---: | ---: |
| 1,000 | 0.4 基线 | active | 900.1 | 926.7 | 3 |
| 1,000 | 0.4 基线 | cached | 591.3 | 598.1 | 2 |
| 1,000 | 0.5 最终 | active | 828.6 | 839.0 | 2 |
| 1,000 | 0.5 最终 | cached | 303.0 | 304.8 | 1 |
| 10,000 | 0.4 基线 | active | 8814.9 | 9164.0 | 3 |
| 10,000 | 0.4 基线 | cached | 5865.8 | 6133.3 | 2 |
| 10,000 | 0.5 最终 | active | 6048.1 | 6169.4 | 2 |
| 10,000 | 0.5 最终 | cached | 2926.0 | 2948.2 | 1 |

每组只有十个样本，p95 使用最近秩方法，等于该组最大值。所有样本均确认主动扫描 3→2 轮、缓存扫描 2→1 轮。耗时包含文件发现、哈希与协议处理，受本机文件系统和缓存状态影响；这些结果不承诺其他仓库或平台的加速比例。

## 范围边界

本轮实际平台仅 Linux/WSL2，实际 Node 版本仅 26.10.0。Windows 工具解析保留原生可执行文件和 `.cmd`/`.bat` 入口优先，并复用上游命令包装供 Runner 执行；该兼容路径未经本轮原生 Windows 实测。CI 配置中的 Node 24.20.0、macOS 和 Windows 不构成本次通过证据。历史 [0.4 验收](validation.md) 与 [Windows 验收](windows-validation.md) 保留为历史资料。

没有持久诊断缓存或依赖图。外部依赖变化仍需 refresh；多文件写入不承诺事务回滚。初始化、下载或分析超时不能证明结果干净。临时启动器只能表示可尝试，运行正常以完成服务器初始化为准。没有发布 npm 包或创建 GitHub release。
