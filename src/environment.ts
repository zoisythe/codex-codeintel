import { AsyncLocalStorage } from "node:async_hooks";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Codex command hooks sanitize inherited environment, including CODEX_HOME. The
// installed bundle location still identifies the owning home unambiguously.
export function restoreInstalledHome(script: string = fileURLToPath(import.meta.url)): void {
	if (process.env["CODEX_HOME"]) return;
	let child = dirname(script);
	for (let parent = dirname(child); parent !== child; parent = dirname(child)) {
		if (basename(parent) === "plugins" && basename(child) === "cache") {
			process.env["CODEX_HOME"] = dirname(parent);
			return;
		}
		child = parent;
	}
}

interface ExecutionContext {
	environment: NodeJS.ProcessEnv;
	automatic: boolean;
}
const executions = new AsyncLocalStorage<ExecutionContext>();
export function executionEnvironment(): NodeJS.ProcessEnv {
	// IPC objects and native environment blocks need not enumerate in the same order.
	return Object.fromEntries(
		Object.entries(executions.getStore()?.environment ?? process.env).sort(([a], [b]) => a.localeCompare(b)),
	);
}
export function automaticExecution(): boolean {
	return executions.getStore()?.automatic ?? false;
}
// Local shims may otherwise install a missing toolchain or synchronize a Python
// environment before they execute the checker. Apply only at the spawn boundary.
export function subprocessEnvironment(environment = executionEnvironment()): NodeJS.ProcessEnv {
	return automaticExecution()
		? {
				...environment,
				RUSTUP_AUTO_INSTALL: "0",
				UV_PYTHON_DOWNLOADS: "never",
				UV_NO_SYNC: "1",
				UV_OFFLINE: "1",
			}
		: environment;
}
export function withExecution<T>(
	environment: NodeJS.ProcessEnv,
	automatic: boolean,
	action: () => Promise<T>,
): Promise<T> {
	return executions.run({ environment, automatic }, action);
}
