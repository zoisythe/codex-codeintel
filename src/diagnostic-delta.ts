import type { Finding } from "./results.js";

// Compare multisets: line insertion does not create new findings; duplicate count does.
// CLI and LSP spell the same rules differently (TS2322/typescript/2322, rustc/E0308).
export function diagnosticKey(finding: Finding): string {
	const rule =
		finding.source
			.split("/")
			.at(-1)
			?.replace(/^TS(?=\d)/, "") ?? "";
	return JSON.stringify([
		finding.path,
		rule,
		finding.severity,
		finding.column,
		finding.message.replace(/\s+/g, " ").trim(),
	]);
}
export function addedFindings(before: Finding[], after: Finding[]): Finding[] {
	const counts = new Map<string, number>();
	for (const item of before) {
		const key = diagnosticKey(item);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return after.filter((item) => {
		const key = diagnosticKey(item);
		const remaining = counts.get(key) ?? 0;
		if (!remaining) return true;
		counts.set(key, remaining - 1);
		return false;
	});
}
export function retainedFindings(before: Finding[], after: Finding[]): Finding[] {
	return addedFindings(addedFindings(before, after), after);
}

// A successful lint baseline cannot establish the history of type diagnostics.
export function attributableFinding(
	finding: Finding,
	parsers: readonly string[],
	before: readonly Finding[] = [],
): boolean {
	if (parsers.includes("json")) return true;
	if (parsers.includes("sarif")) {
		// Compiler SARIF and clangd use different rule ids/messages. With existing
		// findings, a cross-protocol comparison cannot establish new occurrences.
		return before
			.filter((item) => item.path === finding.path)
			.every((item) => item.source.split("/")[0] === finding.source.split("/")[0]);
	}
	const source = finding.source.toLowerCase();
	const parser = /^(?:typescript|tsc|ts(?:\/|$|\d))/.test(source)
		? "tsc"
		: /^(?:rust|cargo)/.test(source)
			? "cargo"
			: ["ty", "ruff", "eslint", "biome"].find((name) => source === name || source.startsWith(`${name}/`));
	return parser !== undefined && parsers.includes(parser);
}
