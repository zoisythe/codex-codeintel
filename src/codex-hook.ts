import { realpath } from "node:fs/promises";
import { stdin } from "node:process";
import { BUDGET } from "./budgets.js";
import { type HookOutput, renderHook } from "./hook-engine.js";
import { message, record, text } from "./results.js";
import { Runtime } from "./runtime.js";
import { isShellTool, writeIntent } from "./write-intent.js";

export async function runHookCli(): Promise<void> {
	stdin.setEncoding("utf8");
	let raw = "";
	for await (const chunk of stdin) {
		raw += chunk;
		if (raw.length > 1024 * 1024) throw new Error("Hook input too large");
	}
	if (!raw.trim()) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("Invalid Hook JSON");
	}
	if (!record(parsed)) throw new Error("Hook input must be an object");
	const event = text(parsed["hook_event_name"], "PostToolUse");
	if (event === "PreToolUse") return;
	const cwd = text(parsed["cwd"], process.cwd());
	const shell = isShellTool(parsed);
	const budget =
		event === "SessionEnd"
			? 1600
			: event === "Stop" || event === "SubagentStop"
				? BUDGET.stop
				: event === "SessionStart" || (event === "PostToolUse" && shell)
					? BUDGET.quickHook
					: BUDGET.hook;
	let signal = AbortSignal.timeout(budget);
	// Keep the selected workspace boundary, including inside a Git repository.
	try {
		const intent = shell ? undefined : writeIntent(cwd, parsed);
		if (event === "PostToolUse" && intent?.kind === "read") signal = AbortSignal.timeout(BUDGET.quickHook);
		const root = await realpath(cwd);
		const runtime = new Runtime();
		try {
			const result = await runtime.request(root, "hook", parsed, signal);
			const output = renderHook(result["output"] as HookOutput);
			if (output) {
				await new Promise<void>((resolve, reject) =>
					process.stdout.write(`${JSON.stringify(output)}\n`, (error) => (error ? reject(error) : resolve())),
				);
				if (typeof result["deliveryId"] === "string") {
					await runtime
						.request(
							root,
							"hook_ack",
							{ session: text(parsed["session_id"]), deliveryId: result["deliveryId"] },
							AbortSignal.any([signal, AbortSignal.timeout(100)]),
						)
						.catch(() => undefined);
				}
			}
		} finally {
			await runtime.close();
		}
	} catch (error) {
		const context = signal.aborted
			? "Codex CodeIntel: Hook budget reached; unfinished checks remain pending. Background tasks already registered continue; later Hooks or MCP queries can retrieve results."
			: `Codex CodeIntel unavailable: ${message(error).slice(0, 300)}`;
		process.stdout.write(
			`${JSON.stringify(event === "PostToolUse" ? { hookSpecificOutput: { hookEventName: event, additionalContext: context } } : { systemMessage: context })}\n`,
		);
	}
}
