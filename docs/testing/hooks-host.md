# Codex 原生 Hook 宿主验收

该步骤需要支持 async command Hook、SubagentStop.agent_id 和 Interrupt 的当前 Codex 宿主。先构建交付 bundle、审阅 hooks/hooks.json，再由用户通过 /hooks 重新审阅；在新会话运行。不要复制、修改信任记录或使用绕过 Hook 信任的参数。保留原有自动诊断/门禁选择；需要启用测试模式时只使用用户已经授权的隔离测试配置。

记录宿主版本、插件 bundle SHA-256、六个已审阅事件、测试工作区和运行时间；不要保存凭据或未经筛选的用户 transcript。

1. 在隔离 TypeScript 或 Biome fixture 使用 Bash 读取文件，确认没有启动检查；分别通过 Bash 写入、apply_patch 和 mcp__lsp__apply 修改源码，核对宿主实际投递的规范工具名与 tool_use_id。八个只读 MCP 工具不能触发写分析，rename/format/actions 只预览。
2. 使用缓慢检查器让 PostToolUse 持续运行，确认原工具结果立即可用，后台结果经宿主原生 async 投递。普通 Stop 应在 1.5 秒内结束，等待后台结果不超过 300 ms，pending 留存；注意宿主只在安全点追加异步上下文，不自动创建新 turn。
3. 由用户明确授权两个测试子代理，各修改不同文件并并行结束，主任务同时 Stop。核对显式 agent_id 的独立反馈和 shared 标记，子代理不得收到其他代理交付或 decision:block。仅主任务在已启用的全局门禁下，可对当前可靠新增错误每 turn 请求一次续跑。
4. 正在等待后台结果时使用宿主中断操作，捕获真实 Interrupt 事件。确认中断迅速完成，明确归属的旧等待被解除，其他代理仍可领取结果；共享 LSP 和进行中的 MCP 写入未被中断。结束会话后迟到结果不得重新出现。
5. 触发 resume、clear、fork 和 compact；前三者按会话语义复用或重建，compact 不重新发现基线。每条反馈最多 2 KiB、五条关键诊断；缓存 diagnostics 可查看详情。核对 stdout 成功写出才 ACK，重试允许使用相同 deliveryId。

仓库中的 hook-flow、automatic-e2e、background-hooks-e2e 测试验证实际服务/CLI、竞态、输出预算、ACK 和取消；它们直接输入 Hook JSON，不证明宿主 matcher、原生 async 调度或真实 agent_id/Interrupt 投递正确。未完成上述宿主步骤时必须在验收记录中明确标为待验收。Linux/macOS/Windows CI 验证 bundle 行为，不需要本机 Rust。
