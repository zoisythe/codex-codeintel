import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inside } from "./files.js";
import { parseLint } from "./lint-output.js";
import type { ProjectCheck } from "./project-types.js";
import { type Finding, record, text } from "./results.js";
import { splitLint } from "./runners.js";

export async function projectOutput(
	check: ProjectCheck,
	output: string,
	root: string,
	cwd: string,
): Promise<Finding[]> {
	const pathOf = (file: string) => {
		const absolute = resolve(cwd, file);
		if (!inside(root, absolute)) throw new Error("Checker diagnostic outside workspace");
		return relative(root, absolute);
	};
	if (check.parser === "sarif") {
		if (!output.trim()) return [];
		const data: unknown = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1));
		if (!record(data) || !Array.isArray(data["runs"])) throw new Error("Malformed SARIF checker output");
		const findings: Finding[] = [];
		for (const run of data["runs"]) {
			if (!record(run) || !Array.isArray(run["results"])) throw new Error("Malformed SARIF run");
			for (const result of run["results"]) {
				if (!record(result) || !["error", "warning"].includes(String(result["level"]))) continue;
				const locations = result["locations"];
				const first = Array.isArray(locations) ? (locations[0] as unknown) : undefined;
				const physical = record(first) && record(first["physicalLocation"]) ? first["physicalLocation"] : {};
				const artifact = record(physical["artifactLocation"]) ? physical["artifactLocation"] : {};
				const region = record(physical["region"]) ? physical["region"] : {};
				const uri = text(artifact["uri"]);
				if (!uri || !record(result["message"])) throw new Error("Unlocated SARIF diagnostic");
				findings.push({
					path: pathOf(uri.startsWith("file:") ? fileURLToPath(uri) : decodeURI(uri)),
					line: Number(region["startLine"] ?? 1),
					column: Number(region["startColumn"] ?? 1),
					severity: result["level"] === "error" ? "error" : "warning",
					source: `compiler/${text(result["ruleId"], "diagnostic")}`,
					message: text(result["message"]["text"]),
				});
			}
		}
		return findings;
	}

	if (["ruff", "eslint", "biome"].includes(check.parser)) {
		const split = splitLint(check.parser, JSON.parse(output) as unknown, root, cwd);
		const findings: Finding[] = [];
		for (const [path, data] of split)
			findings.push(...parseLint(check.parser, data, path, await readFile(resolve(root, path), "utf8")));
		return findings;
	}
	if (check.parser === "json") {
		const data: unknown = JSON.parse(output);
		if (!record(data) || !Array.isArray(data["diagnostics"]))
			throw new Error("Custom checker requires {diagnostics: [...]} output");
		return data["diagnostics"].map((item: unknown) => {
			if (
				!record(item) ||
				typeof item["path"] !== "string" ||
				typeof item["message"] !== "string" ||
				!["error", "warning"].includes(String(item["severity"])) ||
				!Number.isInteger(item["line"]) ||
				Number(item["line"]) < 1 ||
				!Number.isInteger(item["column"]) ||
				Number(item["column"]) < 1
			)
				throw new Error("Malformed custom diagnostic");
			return {
				path: pathOf(item["path"]),
				message: item["message"],
				line: Number(item["line"]),
				column: Number(item["column"]),
				severity: item["severity"] === "error" ? "error" : "warning",
				source: text(item["source"], check.name),
			};
		});
	}
	const findings: Finding[] = [];
	if (check.parser === "cargo") {
		for (const line of output.split("\n").filter(Boolean)) {
			const item: unknown = JSON.parse(line);
			if (!record(item) || item["reason"] !== "compiler-message" || !record(item["message"])) continue;
			const diagnostic = item["message"];
			if (!["error", "warning"].includes(String(diagnostic["level"]))) continue;
			const spans = diagnostic["spans"];
			const span = Array.isArray(spans)
				? (spans.find((entry: unknown) => record(entry) && entry["is_primary"] === true) as unknown)
				: undefined;
			if (!record(span) || typeof span["file_name"] !== "string")
				throw new Error(text(diagnostic["message"], "Cargo diagnostic without location"));
			findings.push({
				path: pathOf(span["file_name"]),
				line: Number(span["line_start"]),
				column: Number(span["column_start"]),
				severity: diagnostic["level"] === "error" ? "error" : "warning",
				message: text(diagnostic["message"]),
				source: `rust/${record(diagnostic["code"]) ? text(diagnostic["code"]["code"], "compiler") : "compiler"}`,
			});
		}
		return findings;
	}
	for (const line of output.split("\n")) {
		const match =
			check.parser === "tsc"
				? /^(.*?)\((\d+),(\d+)\): (error|warning) TS(\d+): (.*)$/.exec(line)
				: /^(.*?):(\d+):(\d+): (error|warning)\[([^\]]+)\] (.*)$/.exec(line);
		if (match)
			findings.push({
				path: pathOf(match[1] ?? ""),
				line: Number(match[2]),
				column: Number(match[3]),
				severity: match[4] === "error" ? "error" : "warning",
				source: `${check.parser === "tsc" ? "ts" : "ty"}/${match[5]}`,
				message: match[6] ?? "",
			});
		else if (/^(?:error|warning)(?: TS\d+|\[)/.test(line.trim()))
			throw new Error(`Unlocated checker diagnostic: ${line}`);
	}
	return findings;
}
