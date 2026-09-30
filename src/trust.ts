import { readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parse } from "smol-toml";
import { record } from "./results.js";

export interface Trust {
	readonly path: string;
	readonly workspace: string;
	readonly level: "trusted" | "untrusted" | "unset";
}

export async function workspaceTrust(root: string, path: string): Promise<Trust> {
	const workspace = await realpath(root);
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if (record(error) && error["code"] === "ENOENT") return { path, workspace, level: "unset" };
		throw new Error(`Cannot read Codex user trust configuration: ${path}`);
	}
	let config: unknown;
	try {
		config = parse(content);
	} catch {
		// Parser errors can include unrelated user configuration values.
		throw new Error(`Invalid TOML in Codex user trust configuration: ${path}`);
	}
	const projects = record(config) ? config["projects"] : undefined;
	if (projects === undefined) return { path, workspace, level: "unset" };
	if (!record(projects)) throw new Error(`Invalid projects table in Codex user trust configuration: ${path}`);
	const levels = await Promise.all(
		Object.entries(projects).map(async ([candidate, entry]) => {
			if (!isAbsolute(candidate) || !record(entry)) return undefined;
			// Match the workspace itself, never an ancestor. Canonicalization only
			// makes aliases of the same directory equivalent.
			if ((await realpath(candidate).catch(() => undefined)) !== workspace) return undefined;
			return entry["trust_level"];
		}),
	);
	const level = levels.includes("untrusted") ? "untrusted" : levels.includes("trusted") ? "trusted" : "unset";
	return { path, workspace, level };
}
