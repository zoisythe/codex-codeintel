import { resolve } from "node:path";
import type { Config } from "./config.js";
import type { PlannedFile } from "./edit-plans.js";
import { executionEnvironment } from "./environment.js";
import { parseLint } from "./lint-output.js";
import { type ValidationCheck, validationResult } from "./plan-validation.js";
import { withPreviewWorkspace } from "./preview-workspace.js";
import { type Finding, record } from "./results.js";
import { type Runner, run, splitLint } from "./runners.js";

export async function validateBiome(
	runner: Runner,
	root: string,
	scope: PlannedFile[],
	files: PlannedFile[],
	config: Config,
	signal: AbortSignal,
): Promise<ValidationCheck> {
	return withPreviewWorkspace(root, scope, config, signal, async (workspace) => {
		const collect = async (after: boolean) => {
			await workspace.writePhase(after);
			const environment = executionEnvironment();
			if (environment["BIOME_CONFIG_PATH"])
				environment["BIOME_CONFIG_PATH"] = workspace.translate(environment["BIOME_CONFIG_PATH"]);
			const output = await run(
				runner.command,
				[
					...runner.prefix,
					"lint",
					"--reporter=json",
					"--max-diagnostics=none",
					"--vcs-enabled=false",
					...files.map((file) => workspace.map(file.path)),
				],
				workspace.root,
				signal,
				undefined,
				{ environment },
			);
			if (![0, 1].includes(output.code)) throw new Error(output.stderr || `Biome exit ${output.code}`);
			const data: unknown = JSON.parse(output.stdout);
			if (
				!record(data) ||
				!record(data["summary"]) ||
				Number(data["summary"]["skipped"]) > 0 ||
				Number(data["summary"]["changed"]) + Number(data["summary"]["unchanged"]) !== files.length
			)
				throw new Error("unsupported: Biome did not process every requested file");
			const split = splitLint("biome", data, workspace.root, workspace.root);
			const findings: Finding[] = [];
			for (const file of files) {
				const path = workspace.map(file.path);
				const relative = path.slice(resolve(workspace.root).length + 1);
				findings.push(
					...parseLint(
						"biome",
						split.get(relative) ?? { diagnostics: [] },
						file.path,
						after ? file.after : file.before,
					).map(({ lint: _lint, ...finding }) => finding),
				);
			}
			return findings;
		};
		const before = await collect(false),
			after = await collect(true);
		const result = validationResult(
			"complete",
			files.map((file) => file.path),
			undefined,
			before,
			after,
			"biome",
		);
		result.limitations.push(
			"Bounded temporary project snapshot; VCS discovery disabled after workspace file selection. Project file includes and rule configuration still apply.",
		);
		return result;
	});
}
