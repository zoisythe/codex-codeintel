import { isAbsolute, relative, resolve } from "node:path";
import { configurationImpact } from "./config-files.js";
import { inside } from "./files.js";
import { record, text } from "./results.js";

export type WriteIntent =
	| { kind: "read" }
	| { kind: "configuration"; paths: string[] }
	| { kind: "write"; paths?: string[] };
export function isShellTool(input: Record<string, unknown>): boolean {
	return input["tool_name"] === "Bash";
}
const readTools = new Set(
	["check", "diagnostics", "status", "navigate", "rename", "format", "inspect", "actions"].map(
		(name) => `mcp__lsp__${name}`,
	),
);

function applyPaths(input: Record<string, unknown>): string[] | undefined {
	let result = input["tool_response"];
	if (!record(result)) return;
	if (record(result["structuredContent"])) result = result["structuredContent"];
	if (!record(result)) return;
	// An output page, omitted result, or unknown outcome cannot prove the complete write range.
	if (result["next"] || result["truncated"] || result["complete"] === false || !Array.isArray(result["modifiedPaths"]))
		return;
	return result["modifiedPaths"].every((path) => typeof path === "string")
		? (result["modifiedPaths"] as string[])
		: undefined;
}
export function writeIntent(root: string, input: Record<string, unknown>): WriteIntent {
	const tool = text(input["tool_name"]);
	const args = record(input["tool_input"]) ? input["tool_input"] : {};
	let paths: string[] = [];
	if (tool === "mcp__lsp__apply" || tool === "apply_patch") {
		if (tool === "mcp__lsp__apply") {
			const modified = applyPaths(input);
			if (!modified) return { kind: "write" };
			paths = modified;
		} else {
			const command =
				typeof input["tool_input"] === "string" ? input["tool_input"] : text(args["command"], text(args["patch"]));
			paths.push(
				...[...command.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(
					(match) => match[1] ?? "",
				),
			);
		}
		paths.push(
			...[args["path"], args["file_path"], ...(Array.isArray(args["paths"]) ? args["paths"] : [])].filter(
				(path): path is string => typeof path === "string",
			),
		);
	} else if (isShellTool(input)) {
		const command = text(args["command"], text(args["cmd"])).trim();
		if (
			!/[<>;|&`\n]|\$\(|\$\{/.test(command) &&
			/^(?:pwd|ls(?:\s|$)|rg(?:\s|$)|cat(?:\s|$)|head(?:\s|$)|tail(?:\s|$)|wc(?:\s|$)|Get-(?:Content|ChildItem|Location|Item)(?:\s|$)|Select-String(?:\s|$)|git (?:status|diff|log|show|ls-files|rev-parse)(?:\s|$))/i.test(
				command,
			) &&
			!/--(?:output|ext-diff|textconv|pre)|--exec/.test(command)
		)
			return { kind: "read" };
		return { kind: "write" };
	} else if (readTools.has(tool)) return { kind: "read" };
	else return { kind: "write" };
	if (!paths.length) return { kind: "write" };
	paths = [
		...new Set(
			paths.map((path) => {
				const absolute = isAbsolute(path) ? path : resolve(root, path);
				if (!inside(root, absolute)) throw new Error("Write target outside workspace");
				return relative(root, absolute);
			}),
		),
	];
	return paths.every((path) => configurationImpact(path).length)
		? { kind: "configuration", paths }
		: { kind: "write", paths };
}
