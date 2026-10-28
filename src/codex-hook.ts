import { realpath } from "node:fs/promises";
import { stdin } from "node:process";
import { BUDGET } from "./budgets.js";
import { configuration } from "./config.js";
import { type HookOutput, renderHook } from "./hook-engine.js";
import { normalizeHook } from "./hook-events.js";
import { message, record, text } from "./results.js";
import { Runtime } from "./runtime.js";
import { writeIntent } from "./write-intent.js";

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
	const normalized = normalizeHook(parsed);
	if (!normalized) return;
	parsed = normalized;
	const event = text(normalized["hook_event_name"]);
	const began = Date.now();
	const cwd = text(normalized["cwd"], process.cwd());
	const budget =
		event === "SessionEnd"
			? 1600
			: event === "Interrupt"
				? 1000
				: event === "Stop" || event === "SubagentStop"
					? BUDGET.ordinaryStop
					: event === "SessionStart"
						? BUDGET.quickHook
						: BUDGET.asyncHook;
	let signal = AbortSignal.timeout(budget);
	// Keep the selected workspace boundary, including inside a Git repository.
	try {
		const intent = writeIntent(cwd, normalized);
		if (event === "PostToolUse" && intent?.kind === "read") signal = AbortSignal.timeout(BUDGET.quickHook);
		const root = await realpath(cwd);
		if (event === "Stop" && (await configuration(root)).stopGate === "introduced-errors")
			signal = AbortSignal.timeout(Math.max(1, BUDGET.stop - (Date.now() - began)));
		const runtime = new Runtime();
		try {
			let result = await runtime.request(root, "hook", normalized, signal);
			if (event === "PostToolUse" && intent.kind !== "read" && typeof result["registration"] === "string") {
				do {
					result = await runtime.request(
						root,
						"hook_wait",
						{
							...normalized,
							registration: result["registration"],
							revision: result["revision"],
							waitToken: result["waitToken"],
						},
						signal,
					);
				} while (["queued", "running", "waiting"].includes(text(result["state"])));
			}
			if (result["state"] === "failed" || result["state"] === "unavailable") {
				process.stdout.write(
					`${JSON.stringify({ systemMessage: "Codex CodeIntel: background analysis failed; uncertain diagnostics remain pending. Use status or cached diagnostics for details." })}\n`,
				);
				return;
			}
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
							{
								session: text(result["deliverySession"], text(normalized["session_id"])),
								deliveryId: result["deliveryId"],
							},
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
		process.stdout.write(`${JSON.stringify({ systemMessage: context })}\n`);
	}
}
