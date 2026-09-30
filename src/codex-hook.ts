import { realpath } from "node:fs/promises";
import { stdin } from "node:process";
import { BUDGET } from "./budgets.js";
import { type HookOutput, renderHook } from "./hook-engine.js";
import { message, record, text } from "./results.js";
import { Runtime } from "./runtime.js";

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
	const budget =
		event === "SessionEnd" ? 1600 : event === "Stop" || event === "SubagentStop" ? BUDGET.stop : BUDGET.hook;
	const signal = AbortSignal.timeout(budget);
	// The session workspace is the trust boundary, including inside a Git repo.
	const root = await realpath(text(parsed["cwd"], process.cwd()));
	try {
		const runtime = new Runtime();
		try {
			const result = await runtime.request(root, "hook", parsed, signal);
			const output = renderHook(result["output"] as HookOutput);
			if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
		} finally {
			await runtime.close();
		}
	} catch (error) {
		const context = signal.aborted
			? "Codex CodeIntel: Hook budget reached; unfinished checks remain pending. Background tasks already registered continue; later Hooks or MCP queries can retrieve results."
			: `Codex CodeIntel unavailable: ${message(error).slice(0, 300)}`;
		process.stdout.write(
			`${JSON.stringify(event === "PreToolUse" ? { hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: context } } : event === "PostToolUse" ? { hookSpecificOutput: { hookEventName: event, additionalContext: context } } : { systemMessage: context })}\n`,
		);
	}
}
