import { BUDGET } from "./budgets.js";
import { runHookCli } from "./codex-hook.js";
import { restoreInstalledHome } from "./environment.js";
import { runMcp } from "./protocol.js";
import { Runtime } from "./runtime.js";
import { runService } from "./service.js";

export async function main(): Promise<void> {
	restoreInstalledHome();
	const [command = "mcp"] = process.argv.slice(2);
	if (command === "mcp") await runMcp();
	else if (command === "hook") await runHookCli();
	else if (command === "service")
		await runService(process.argv[3] ?? "", process.argv[4] ?? "", process.argv[5] ?? "");
	else if (command === "check_project") {
		const runtime = new Runtime();
		const options: Record<string, unknown> = { run: "active" };
		const tokens = process.argv.slice(3);
		const workspace = tokens[0] && !tokens[0].startsWith("--") ? (tokens.shift() ?? process.cwd()) : process.cwd();
		while (tokens.length) {
			const flag = tokens.shift();
			if (flag === "--refresh") options["refresh"] = true;
			else if (["--run", "--job", "--cursor"].includes(flag ?? "")) {
				const value = tokens.shift();
				if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
				options[flag?.slice(2) ?? ""] = value;
			} else throw new Error(`Unknown option ${flag}`);
		}
		if (!["active", "cached"].includes(String(options["run"]))) throw new Error("run must be active or cached");
		try {
			process.stdout.write(
				`${JSON.stringify(await runtime.request(workspace, "check_project", options, AbortSignal.timeout(BUDGET.request)))}\n`,
			);
		} finally {
			await runtime.close();
		}
	} else throw new Error("Usage: codex-codeintel [mcp | hook | check_project [workspace]]");
}
