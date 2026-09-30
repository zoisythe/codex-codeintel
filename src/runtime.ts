import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { BUDGET } from "./budgets.js";
import { Engine, type ToolOutput } from "./engine.js";
import { ensureService, exchange, existingService } from "./ipc.js";

export class Runtime {
	private readonly active = new Set<AbortController>();
	async request(
		root: string,
		operation: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<ToolOutput> {
		if (!isAbsolute(root)) throw new Error("workspace must be an absolute project directory");
		root = await realpath(root);
		const controller = new AbortController();
		this.active.add(controller);
		signal = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(BUDGET.request)]);
		try {
			const existing = await existingService(root, signal);
			const passive =
				operation === "lsp_status" ||
				(operation === "check_diagnostics" && args["run"] === "cached") ||
				operation === "session_end" ||
				(operation === "check_project" && args["run"] === "cached");
			if (!existing && passive) {
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
