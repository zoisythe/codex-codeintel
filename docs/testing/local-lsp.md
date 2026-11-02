# 本机 Rust 与 MATLAB LSP 验收

在已安装工具的本机，通过交付的 `dist/cli.js` 验证真实 MCP 行为：

```sh
npm run build
REAL_TOOLS=1 npm run test:local
```

两套测试顺序执行，也可独立使用 `npm run test:rust` 和 `npm run test:matlab`。所有入口均需要 `REAL_TOOLS=1` 才运行真实验收；未设置或值不为 `1` 时跳过，启用后缺少工具则失败。`npm test` 包含两套测试，并沿用同一开关。Rust CI 显式启用；MATLAB 验收使用本机安装和许可证。

完整本机检查入口为 `npm run ci`，顺序执行类型检查、Biome、构建及 `npm test`，使用当前平台和 Node 版本。设置 `REAL_TOOLS=1` 后，该入口也会运行真实工具验收。

## 工具要求

Rust 需要 PATH 上的 `rustc`、`cargo`、`rust-analyzer`，以及 `rustc --print sysroot` 对应工具链 `bin` 目录下的 rustfmt。支持 rustup 管理的工具链和独立安装。fixture 使用离线 Cargo 工作区与本地 path 依赖；集成测试中的目标调用位于 `assert_eq!` 宏外，因此引用与重命名验收不依赖 rust-src 的标准库宏展开。

MATLAB 使用 [MathWorks MATLAB-language-server](https://github.com/mathworks/MATLAB-language-server)，需要 MATLAB R2021b 或更新版本及可用许可证。测试自动从 `~/.vscode/extensions/mathworks.language-matlab-*` 查找已安装服务，并从 PATH 查找 MATLAB。可用以下变量覆盖路径：

| 变量 | 含义 |
| --- | --- |
| `REAL_TOOLS` | 设为 `1` 启用真实工具验收；默认跳过 |
| `CODEX_LSP_MATLAB_SERVER` | 官方语言服务的 `out/index.js` 绝对路径 |
| `CODEX_LSP_MATLAB_INSTALL_PATH` | MATLAB 安装根目录，例如 `C:/Program Files/MATLAB/R2026b` |
| `CODEX_LSP_RUST_ARTIFACTS` | Rust 最终 fixture 与 MCP 记录目录 |
| `CODEX_LSP_MATLAB_ARTIFACTS` | MATLAB 工具路径、服务版本、fixture 与 MCP 记录目录 |
| `CODEX_LSP_ARTIFACTS` | 各次 MCP 响应的 JSONL 记录目录，便于查看进行中的检查 |

MATLAB 测试由 LSP 启动独立本地分析进程；测试结束时关闭 fixture 服务并清理临时工作区。测试配置与缓存独立于用户的 `CODEX_HOME`，自动反馈保持关闭。

## 覆盖范围

| 服务 | 验收行为 |
| --- | --- |
| Rust | 被动状态、诊断及修复后的更新、符号与锚点定位、引用、调用、补全、组合探索与候选测试关联、重命名、rustfmt、Code Action 的预览与 apply、计划冲突与单次使用、Cargo 工作区检查 |
| MATLAB | 被动状态、warmup、带位置的语法诊断与修复、符号、锚点定义、引用、补全、不支持调用层次的明确结果、局部变量重命名、格式化、预览不写入、apply 单次使用及冲突拒绝 |

Rust 与 MATLAB 的编辑操作都通过 MCP 预览与 apply 验证。MATLAB 尚不属于计划诊断模拟的内置 provider 范围；其重命名和格式化测试验证编辑计划、写入和写后真实诊断。

MATLAB 的诊断不带文档版本，首次空报告仍显示 pending；验收先确认真实错误，再验证修复后的清空。引用与重命名通过 `@@` 锚点定位标识符，格式化验证 MATLAB 的代码缩进。

## 自定义 MATLAB 配置

项目的 `.codex/lsp-client.json` 可配置同一服务：

```json
{
  "schemaVersion": 1,
  "lsp": {
    "matlab": {
      "command": ["node", "/absolute/path/to/MATLAB-language-server/out/index.js", "--stdio"],
      "extensions": [".m"],
      "languageId": "matlab",
      "settings": {
        "MATLAB": {
          "installPath": "/absolute/path/to/MATLAB",
          "matlabConnectionTiming": "onStart",
          "indexWorkspace": false,
          "telemetry": false,
          "maxFileSizeForAnalysis": 0,
          "signIn": false
        }
      }
    }
  }
}
```

`settings` 同时用于服务的配置请求与配置变更通知；支持 `MATLAB.installPath` 等点分节名称。`languageId` 只影响所配置服务的文档标识，未配置时保留现有扩展名映射。

PowerShell 记录示例：

```powershell
$env:REAL_TOOLS = "1"
$env:CODEX_LSP_RUST_ARTIFACTS = Join-Path $PWD "test-results/local-lsp/rust"
$env:CODEX_LSP_MATLAB_ARTIFACTS = Join-Path $PWD "test-results/local-lsp/matlab"
$env:CODEX_LSP_ARTIFACTS = Join-Path $PWD "test-results/local-lsp/mcp"
npm run test:local
```

记录包含 fixture 源码和本机工具路径，位于 Git 忽略的 `test-results/` 下。
