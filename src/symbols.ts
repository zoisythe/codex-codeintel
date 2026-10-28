import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { DocumentSymbol, Range, SymbolInfo } from "./lsp/types.js";
import { number, record, text } from "./results.js";

export interface Outline {
	name: string;
	symbol: string;
	parent?: string;
	kind: number;
	range: Range;
	selection: Range;
}
export function contains(range: Range, line: number, column: number): boolean {
	return (
		(line > range.start.line || (line === range.start.line && column >= range.start.character)) &&
		(line < range.end.line || (line === range.end.line && column <= range.end.character))
	);
}
export function sourceRange(content: string, range: Range): string {
	const lines = content.split("\n");
	const start =
		lines.slice(0, range.start.line).reduce((sum, line) => sum + line.length + 1, 0) + range.start.character;
	const end = lines.slice(0, range.end.line).reduce((sum, line) => sum + line.length + 1, 0) + range.end.character;
	return content.slice(start, end);
}
export function outline(symbols: Array<DocumentSymbol | SymbolInfo>, parent = ""): Outline[] {
	const result: Outline[] = [];
	const counts = new Map<string, number>();
	for (const symbol of symbols) counts.set(symbol.name, (counts.get(symbol.name) ?? 0) + 1);
	const indices = new Map<string, number>();
	for (const item of symbols) {
		const index = indices.get(item.name) ?? 0;
		indices.set(item.name, index + 1);
		const name = item.name + ((counts.get(item.name) ?? 0) > 1 ? `[${index}]` : "");
		const symbol = parent ? `${parent}.${name}` : name;
		const range = "range" in item ? item.range : item.location.range;
		result.push({
			name: item.name,
			symbol,
			...(parent ? { parent } : {}),
			kind: item.kind,
			range,
			selection: "selectionRange" in item ? item.selectionRange : range,
		});
		if ("children" in item && item.children) result.push(...outline(item.children, symbol));
	}
	return result;
}
export function publicOutline(item: Outline): Record<string, unknown> {
	return {
		symbol: item.symbol,
		...(item.parent ? { parent: item.parent } : {}),
		kind: item.kind,
		line: item.selection.start.line + 1,
		column: item.selection.start.character + 1,
		endLine: item.range.end.line + 1,
	};
}
export async function position(
	path: string,
	args: Record<string, unknown>,
	symbols: () => Promise<Outline[]>,
): Promise<{ line: number; column: number }> {
	const selectors = [
		args["symbol"] !== undefined,
		args["pattern"] !== undefined,
		args["line"] !== undefined || args["column"] !== undefined,
	].filter(Boolean).length;
	if (selectors > 1) throw new Error("Use exactly one position selector: line/column, symbol or pattern");
	if (args["symbol"] !== undefined) {
		const query = text(args["symbol"]);
		const matches = (await symbols()).filter((item) => item.symbol === query || item.name === query);
		if (matches.length !== 1)
			throw new Error(`Symbol ambiguous or missing; candidates: ${JSON.stringify(matches.map(publicOutline))}`);
		const match = matches[0];
		if (!match) throw new Error("Symbol missing");
		return { line: match.selection.start.line + 1, column: match.selection.start.character + 1 };
	}
	if (args["pattern"] !== undefined) {
		const pattern = text(args["pattern"]);
		if (pattern.split("@@").length !== 2) throw new Error("pattern requires exactly one @@ cursor marker");
		const [prefix = "", suffix = ""] = pattern.split("@@");
		const needle = prefix + suffix;
		if (!needle) throw new Error("Empty pattern");
		const content = await readFile(path, "utf8");
		const candidates: { line: number; column: number }[] = [];
		for (let offset = content.indexOf(needle); offset !== -1; offset = content.indexOf(needle, offset + 1)) {
			const before = content.slice(0, offset + prefix.length).split("\n");
			candidates.push({ line: before.length, column: (before.at(-1)?.length ?? 0) + 1 });
		}
		if (candidates.length !== 1)
			throw new Error(`Pattern ambiguous or missing; candidates: ${JSON.stringify(candidates.slice(0, 20))}`);
		return candidates[0] ?? { line: 1, column: 1 };
	}
	return { line: number(args["line"], 1, 1, 10000000), column: number(args["column"], 1, 1, 1000000) };
}
export function locations(value: unknown): Array<{ uri: string; range: Range }> {
	const values = Array.isArray(value) ? value : value ? [value] : [];
	return values.flatMap((item) =>
		record(item) && typeof item["uri"] === "string" && record(item["range"])
			? [{ uri: item["uri"], range: item["range"] as unknown as Range }]
			: [],
	);
}
export function publicNavigation(value: unknown, root: string): unknown {
	if (Array.isArray(value)) return value.map((item) => publicNavigation(item, root));
	if (!record(value)) return value;
	if (
		record(value["start"]) &&
		record(value["end"]) &&
		typeof value["start"]["line"] === "number" &&
		typeof value["end"]["line"] === "number"
	) {
		return {
			start: { line: value["start"]["line"] + 1, column: Number(value["start"]["character"]) + 1 },
			end: { line: value["end"]["line"] + 1, column: Number(value["end"]["character"]) + 1 },
		};
	}
	const uri =
		typeof value["uri"] === "string"
			? value["uri"]
			: typeof value["targetUri"] === "string"
				? value["targetUri"]
				: undefined;
	const range = value["range"] ?? value["targetSelectionRange"] ?? value["targetRange"];
	const output = Object.fromEntries(
		Object.entries(value)
			.filter(
				([key]) =>
					![
						"data",
						"selectionRange",
						...(uri ? ["uri", "targetUri", "targetRange", "targetSelectionRange", "range"] : []),
					].includes(key),
			)
			.map(([key, item]) => [key, publicNavigation(item, root)]),
	);
	if (uri && record(range) && record(range["start"])) {
		let path = uri;
		try {
			path = relative(root, fileURLToPath(uri));
		} catch {
			/* Non-file targets retain their URI. */
		}
		return {
			...output,
			path,
			line: Number(range["start"]["line"]) + 1,
			column: Number(range["start"]["character"]) + 1,
		};
	}
	return output;
}
