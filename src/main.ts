import { resolve } from "node:path";
import { BUDGET } from "./budgets.js";
import { runHookCli } from "./codex-hook.js";
import { restoreInstalledHome } from "./environment.js";
import { runMcp } from "./protocol.js";
import { Runtime } from "./runtime.js";
import { runService } from "./service.js";

export async function main(): Promise<void> {
	restoreInstalledHome();
	const [command = "mcp"] = process.argv.slice(2);
	if (["--help", "help", "-h"].includes(command)) {
		process.stdout.write("Usage: codeintel [mcp | hook | check [workspace] | warmup [workspace] [--path path]]\n");
	} else if (command === "mcp") await runMcp();
	else if (command === "hook") await runHookCli();
	else if (command === "service")
		await runService(process.argv[3] ?? "", process.argv[4] ?? "", process.argv[5] ?? "");
	else if (command === "check" || command === "warmup") {
		const runtime = new Runtime();
		const options: Record<string, unknown> = command === "check" ? { run: "active" } : {};
		const tokens = process.argv.slice(3);
		const workspace = tokens[0] && !tokens[0].startsWith("--") ? (tokens.shift() ?? process.cwd()) : process.cwd();
		while (tokens.length) {
			const flag = tokens.shift();
			if (command === "check" && flag === "--refresh") options["refresh"] = true;
			else if (command === "warmup" && flag === "--path") {
				const value = tokens.shift();
				if (!value || value.startsWith("--")) throw new Error("Missing value for --path");
				const paths = (options["paths"] ?? []) as string[];
				paths.push(value);
				if (paths.length > 200) throw new Error("At most 200 paths");
				options["paths"] = paths;
			} else if (
				(command === "check" && ["--run", "--job", "--cursor"].includes(flag ?? "")) ||
				flag === "--cursor"
			) {
				const value = tokens.shift();
				if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
				options[flag?.slice(2) ?? ""] = value;
			} else throw new Error(`Unknown option ${flag}`);
		}
		if (command === "check" && !["active", "cached"].includes(String(options["run"])))
			throw new Error("run must be active or cached");
		try {
			process.stdout.write(
				`${JSON.stringify(await runtime.request(resolve(workspace), command, options, AbortSignal.timeout(BUDGET.request)))}\n`,
			);
		} finally {
			await runtime.close();
		}
	} else throw new Error("Usage: codeintel [mcp | hook | check [workspace] | warmup [workspace] [--path path]]");
}
