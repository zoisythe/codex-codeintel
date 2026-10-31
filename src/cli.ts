#!/usr/bin/env node
import { supportsNode } from "./node-version.js";

// Load the application only after checking APIs used by the bundle.
if (!supportsNode(process.versions.node)) {
	const reason = `CodeIntel requires Node ^24.20.0 || ^26.13.0; found ${process.versions.node}.`;
	if (process.argv[2] === "hook") {
		let event = "";
		let passthrough = false;
		let input = "";
		for await (const chunk of process.stdin) {
			input += String(chunk);
			if (input.length > 1024 * 1024) break;
		}
		try {
			const parsed: unknown = JSON.parse(input);
			if (
				parsed &&
				typeof parsed === "object" &&
				"hook_event_name" in parsed &&
				typeof parsed.hook_event_name === "string"
			) {
				event = parsed.hook_event_name;
				passthrough = !["SessionStart", "PostToolUse", "Stop", "SubagentStop", "SessionEnd", "Interrupt"].includes(
					event,
				);
			}
		} catch {
			/* Runtime message remains useful for invalid input. */
		}
		if (!passthrough) process.stdout.write(`${JSON.stringify({ systemMessage: reason })}\n`);
	} else {
		process.stderr.write(`${reason}\n`);
		process.exitCode = 1;
	}
} else {
	const { main } = await import("./main.js");
	await main().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
