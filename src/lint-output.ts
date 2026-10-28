import type { TextEdit } from "./lsp/types.js";
import { type Finding, type LintFix, record, text } from "./results.js";

function offsetPosition(content: string, offset: number): { line: number; character: number } {
	if (!Number.isInteger(offset) || offset < 0 || offset > content.length) throw new Error("Invalid lint fix offset");
	const lines = content.slice(0, offset).split("\n");
	return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}
function bytePosition(content: string, offset: number): { line: number; character: number } {
	const prefix = Buffer.from(content).subarray(0, offset).toString("utf8");
	return offsetPosition(prefix, prefix.length);
}
function editsFor(runner: string, fix: Record<string, unknown>, content: string): TextEdit[] {
	if (runner === "eslint" && Array.isArray(fix["range"]) && typeof fix["text"] === "string") {
		const [start, end] = fix["range"];
		if (typeof start !== "number" || typeof end !== "number") throw new Error("Invalid lint edit range");
		const bom = content.startsWith("\ufeff") ? 1 : 0;
		const from = bom && start === 0 && fix["text"].startsWith("\ufeff") ? 0 : start + bom;
		return [
			{
				range: { start: offsetPosition(content, from), end: offsetPosition(content, end + bom) },
				newText: fix["text"],
			},
		];
	}
	if (runner === "ruff" && Array.isArray(fix["edits"]))
		return fix["edits"].map((value) => {
			if (
				!record(value) ||
				!record(value["location"]) ||
				!record(value["end_location"]) ||
				typeof value["content"] !== "string"
			)
				throw new Error("Malformed Ruff fix");
			const at = (position: Record<string, unknown>) => {
				const row = Number(position["row"]);
				const column = Number(position["column"]);
				const line = content.split("\n")[row - 1];
				const bom = row === 1 && line?.startsWith("\ufeff") ? 1 : 0;
				const scalarLine = line?.slice(bom);
				if (
					!Number.isInteger(row) ||
					row < 1 ||
					line === undefined ||
					!Number.isInteger(column) ||
					column < 1 ||
					column > Array.from(scalarLine ?? "").length + 1
				)
					throw new Error("Invalid Ruff fix position");
				return {
					line: row - 1,
					character:
						bom +
						Array.from(scalarLine ?? "")
							.slice(0, column - 1)
							.join("").length,
				};
			};
			return { range: { start: at(value["location"]), end: at(value["end_location"]) }, newText: value["content"] };
		});
	return [];
}

function position(value: Record<string, unknown>, content: string): { line: number; column: number } {
	const location = record(value["location"]) ? value["location"] : {};
	const span = location["span"];
	if (Array.isArray(span) && typeof span[0] === "number") {
		const at = bytePosition(content, span[0]);
		return { line: at.line + 1, column: at.character + 1 };
	}
	const start = record(location["start"]) ? location["start"] : {};
	const line = value["line"] ?? location["row"] ?? start["line"];
	const column = value["column"] ?? location["column"] ?? start["column"];
	return { line: typeof line === "number" ? line : 1, column: typeof column === "number" ? column : 1 };
}
function ruffPosition(value: Record<string, unknown>, content: string): { line: number; column: number } {
	const row = Number(value["row"] ?? 1);
	const column = Number(value["column"] ?? 1);
	const line = content.split("\n")[row - 1] ?? "";
	const bom = row === 1 && line.startsWith("\ufeff") ? 1 : 0;
	return {
		line: row,
		column:
			bom +
			Array.from(line.slice(bom))
				.slice(0, column - 1)
				.join("").length +
			1,
	};
}
function items(runner: string, data: unknown): unknown[] {
	if (runner === "eslint" && Array.isArray(data))
		return data.flatMap((file: unknown) => (record(file) && Array.isArray(file["messages"]) ? file["messages"] : []));
	if (runner === "ruff" && Array.isArray(data)) return data;
	if (runner === "biome" && record(data) && Array.isArray(data["diagnostics"])) {
		const summary = data["summary"];
		if (record(summary) && Number(summary["diagnosticsNotPrinted"]) > 0)
			throw new Error("Lint result truncated; narrow file scope");
		return data["diagnostics"];
	}
	throw new Error("Unexpected lint output");
}
export function parseLint(runner: string, data: unknown, path: string, content: string): Finding[] {
	const findings: Finding[] = [];
	for (const value of items(runner, data)) {
		if (!record(value)) throw new Error("Malformed lint finding");
		const severity = value["severity"];
		if (severity !== undefined && ![1, 2, "error", "warning", "fatal"].includes(severity as string | number))
			continue;
		const rule = text(value["ruleId"], text(value["code"], text(value["category"], "lint")));
		const fixes: LintFix[] = [];
		if (record(value["fix"])) {
			const raw = value["fix"];
			const edits = editsFor(runner, raw, content);
			const applicability =
				runner === "ruff" && ["safe", "unsafe"].includes(text(raw["applicability"]))
					? (text(raw["applicability"]) as "safe" | "unsafe")
					: "unknown";
			if (edits.length) fixes.push({ title: text(raw["message"], `Fix ${rule}`), applicability, edits });
		}
		if (Array.isArray(value["suggestions"]))
			for (const suggestion of value["suggestions"]) {
				if (record(suggestion) && record(suggestion["fix"]))
					fixes.push({
						title: text(suggestion["desc"], `Suggestion for ${rule}`),
						applicability: "suggestion",
						edits: editsFor(runner, suggestion["fix"], content),
					});
			}
		const end = record(value["end_location"])
			? value["end_location"]
			: record(value["location"]) && record(value["location"]["end"])
				? value["location"]["end"]
				: {};
		const start =
			runner === "ruff" && record(value["location"])
				? ruffPosition(value["location"], content)
				: position(value, content);
		if (runner === "eslint" && start.line === 1 && content.startsWith("\ufeff")) start.column++;
		const endPosition =
			runner === "ruff" && record(value["end_location"]) ? ruffPosition(value["end_location"], content) : undefined;
		const location = record(value["location"]) ? value["location"] : {};
		const span = Array.isArray(location["span"]) ? location["span"] : [];
		const biomeEnd = runner === "biome" && typeof span[1] === "number" ? bytePosition(content, span[1]) : undefined;
		findings.push({
			path,
			...start,
			severity: severity === 1 || severity === "warning" ? "warning" : "error",
			source: `${runner}/${text(value["ruleId"], text(value["code"], text(value["category"], "lint")))}`,
			message: text(value["description"], text(value["message"], "Lint finding")),
			rule,
			fixable:
				fixes.length > 0 ||
				(runner === "biome" &&
					((Array.isArray(value["tags"]) && value["tags"].includes("fixable")) ||
						(Array.isArray(value["advices"]) &&
							value["advices"].some(
								(advice) => record(advice) && /^(?:Safe|Unsafe) fix:/.test(text(advice["text"])),
							)))),
			...(typeof (value["endLine"] ?? end["row"] ?? end["line"]) === "number"
				? { endLine: Number(value["endLine"] ?? end["row"] ?? end["line"]) }
				: {}),
			...(typeof (value["endColumn"] ?? end["column"]) === "number"
				? {
						endColumn:
							Number(value["endColumn"] ?? end["column"]) +
							(runner === "eslint" && value["endLine"] === 1 && content.startsWith("\ufeff") ? 1 : 0),
					}
				: {}),
			...(typeof value["url"] === "string" ? { documentation: value["url"] } : {}),
			...(endPosition
				? { endLine: endPosition.line, endColumn: endPosition.column }
				: biomeEnd
					? { endLine: biomeEnd.line + 1, endColumn: biomeEnd.character + 1 }
					: {}),
			lint: { runner, fixes, raw: value },
		});
	}
	return findings;
}
