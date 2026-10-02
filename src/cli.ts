#!/usr/bin/env node
// Load the application only after checking APIs used by the bundle.
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
	const reason = `Codex CodeIntel requires Node >=22.12.0; found ${process.versions.node}.`;
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
				const tool = "tool_name" in parsed && typeof parsed.tool_name === "string" ? parsed.tool_name : "";
				passthrough =
					event === "PreToolUse" &&
					(/^(?:bash|shell|exec_command|unified_exec)$/i.test(tool.split(".").at(-1) ?? "") ||
						/read|search|list|status|diagnostics|check_project|navigation|glob|view_image/i.test(tool));
			}
		} catch {
			/* Runtime message remains useful for invalid input. */
		}
		if (!passthrough)
			process.stdout.write(
				`${JSON.stringify({ systemMessage: reason, ...(event === "PreToolUse" ? { hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: reason } } : {}) })}\n`,
			);
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
