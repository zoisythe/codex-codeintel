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
