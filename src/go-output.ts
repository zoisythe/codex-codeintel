import { record, text } from "./results.js";

export function goDocuments(output: string): unknown[] {
	let depth = 0;
	let start = -1;
	let quoted = false;
	let escaped = false;
	const documents: unknown[] = [];
	for (let index = 0; index < output.length; index++) {
		const character = output[index];
		if (!depth && character === "{" && output.slice(output.lastIndexOf("\n", index) + 1, index).trim() !== "")
			continue;
		if (quoted) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') quoted = false;
			continue;
		}
		if (depth && character === '"') {
			quoted = true;
			continue;
		}
		if (character === "{") {
			if (!depth) start = index;
			depth++;
		}
		if (character === "}" && depth) {
			depth--;
			if (!depth) documents.push(JSON.parse(output.slice(start, index + 1)) as unknown);
		}
	}
	if (depth) throw new Error("Truncated Go JSON output");
	return documents;
}
export function goFiles(output: string): string[] {
	return goDocuments(output).flatMap((document) => {
		if (!record(document) || document["Incomplete"] || document["Error"])
			throw new Error("Go package scope incomplete; configure explicit projectChecks");
		return ["GoFiles", "CgoFiles", "TestGoFiles", "XTestGoFiles"].flatMap((key) =>
			Array.isArray(document[key])
				? document[key]
						.filter((file): file is string => typeof file === "string")
						.map((file) => `${text(document["Dir"])}/${file}`)
				: [],
		);
	});
}
