import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { BUDGET } from "./budgets.js";
import { Engine, type ToolOutput } from "./engine.js";
import { registerHook } from "./hook-inbox.js";
import { ensureService, exchange, existingService } from "./ipc.js";
import { Metadata } from "./metadata.js";
import { text } from "./results.js";
import { isShellTool, writeIntent } from "./write-intent.js";

export class Runtime {
	private readonly active = new Set<AbortController>();
	async request(
		root: string,
		operation: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<ToolOutput> {
		const event = operation === "hook" ? text(args["hook_event_name"], "PostToolUse") : "";
		if (event === "PreToolUse" && (isShellTool(args) || writeIntent(root, args).kind !== "write"))
			return { operation: "hook", output: { kind: "silent" } };
		if (!isAbsolute(root)) throw new Error("workspace must be an absolute project directory");
		root = await realpath(root);
		const controller = new AbortController();
		this.active.add(controller);
		signal = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(BUDGET.request)]);
		try {
			const passiveHook =
				(event === "PostToolUse" && writeIntent(root, args).kind === "read") || event === "SessionEnd";
			if (operation === "hook" && !passiveHook && event !== "PreToolUse" && args["stop_hook_active"] !== true)
				await registerHook(root, args, signal);
			const existing = await existingService(root, signal);
			const passive =
				operation === "lsp_status" ||
				passiveHook ||
				operation === "hook_ack" ||
				(operation === "check_diagnostics" && args["run"] === "cached") ||
				operation === "session_end" ||
				(operation === "check_project" && args["run"] === "cached");
			if (!existing && passive) {
				if (operation === "hook_ack") return { operation };
				if (operation === "hook") {
					if (event === "SessionEnd") await new Metadata(root).end(text(args["session_id"]), signal);
					return { operation, output: { kind: "silent" } };
				}
				if (operation === "session_end") return { operation };
				if (operation === "check_project")
					return {
						operation,
						job: typeof args["job"] === "string" ? args["job"] : "",
						state: "missing",
						checkers: [],
						diagnostics: [],
						errors: 0,
						warnings: 0,
					};
				const engine = new Engine(root);
				try {
					const output = await engine.dispatch(operation, args, signal);
					return operation === "lsp_status"
						? { ...output, service: { state: "stopped" }, automaticTasks: [] }
						: output;
				} finally {
					await engine.dispose();
				}
			}
			const endpoint = existing ?? (await ensureService(root, signal));
			return await exchange(endpoint, operation, args, signal);
		} finally {
			this.active.delete(controller);
		}
	}
	async close(): Promise<void> {
		for (const controller of this.active) controller.abort();
		this.active.clear();
	}
}
