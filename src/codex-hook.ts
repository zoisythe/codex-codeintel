import { realpath } from "node:fs/promises";
import { stdin } from "node:process";
import { HookEngine } from "./hook-engine.js";
import { message, record, text } from "./results.js";

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
	const budget = event === "SessionEnd" ? 1600 : event === "Stop" || event === "SubagentStop" ? 44000 : 4400;
	const signal = AbortSignal.timeout(budget);
	// The session workspace is the trust boundary, including inside a Git repo.
	const root = await realpath(text(parsed["cwd"], process.cwd()));
	try {
		const output = await new HookEngine(root).hook(parsed, signal);
		if (output) process.stdout.write(`${output}\n`);
	} catch (error) {
		const context = signal.aborted
			? "Codex CodeIntel: Hook budget reached; unfinished checks remain pending. Background tasks already registered continue; later Hooks or MCP queries can retrieve results."
			: `Codex CodeIntel unavailable: ${message(error).slice(0, 300)}`;
		process.stdout.write(
			`${JSON.stringify(event === "PostToolUse" ? { hookSpecificOutput: { hookEventName: event, additionalContext: context } } : { systemMessage: context })}\n`,
		);
	}
}
