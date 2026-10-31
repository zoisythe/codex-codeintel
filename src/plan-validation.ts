import { addedFindings } from "./diagnostic-delta.js";
import type { Diagnostic } from "./lsp/types.js";
import type { Finding } from "./results.js";

export interface ValidationCheck {
	state: "complete" | "partial" | "pending" | "unsupported" | "failed" | "skipped";
	provider: string;
	paths: string[];
	introduced: Finding[];
	resolved: Finding[];
	errorsIntroduced: number | null;
	errorsResolved: number | null;
	netDelta: number | null;
	limitations: string[];
	reason?: string;
}
export interface PlanValidation extends ValidationCheck {
	checks?: ValidationCheck[];
}
export function diagnosticFindings(path: string, items: Diagnostic[]): Finding[] {
	return items
		.filter((item) => item.severity === 1 || item.severity === 2)
		.map((item) => ({
			path,
			line: item.range.start.line + 1,
			column: item.range.start.character + 1,
			severity: item.severity === 1 ? "error" : "warning",
			source: `${item.source ?? "lsp"}${item.code === undefined ? "" : `/${item.code}`}`,
			...(item.code !== undefined ? { rule: String(item.code) } : {}),
			endLine: item.range.end.line + 1,
			endColumn: item.range.end.character + 1,
			message: item.message,
		}));
}
export function validationResult(
	state: PlanValidation["state"],
	paths: string[],
	reason?: string,
	before: Finding[] = [],
	after: Finding[] = [],
	provider = "ty",
): PlanValidation {
	const introduced = addedFindings(before, after);
	const resolved = addedFindings(after, before);
	const errorsIntroduced = state === "complete" ? introduced.filter((item) => item.severity === "error").length : null;
	const errorsResolved = state === "complete" ? resolved.filter((item) => item.severity === "error").length : null;
	return {
		state,
		provider,
		paths,
		introduced,
		resolved,
		errorsIntroduced,
		errorsResolved,
		netDelta: errorsIntroduced === null || errorsResolved === null ? null : errorsIntroduced - errorsResolved,
		limitations: [
			"Only listed files and this provider were checked; builds and runtime behavior were not validated. Zero delta is not a safety guarantee.",
		],
		...(reason ? { reason } : {}),
	};
}
export function combineValidation(paths: string[], checks: ValidationCheck[]): PlanValidation {
	const active = checks.filter((check) => check.state !== "skipped");
	const complete = active.filter((check) => check.state === "complete");
	const state =
		complete.length === active.length && complete.length
			? "complete"
			: complete.length
				? "partial"
				: active.some((check) => check.state === "pending")
					? "pending"
					: active.some((check) => check.state === "failed")
						? "failed"
						: active.length
							? "unsupported"
							: "skipped";
	const result = validationResult(state, paths, undefined, [], [], "combined");
	result.checks = checks;
	result.introduced = complete.flatMap((check) => check.introduced);
	result.resolved = complete.flatMap((check) => check.resolved);
	if (state === "complete") {
		result.errorsIntroduced = complete.reduce((sum, check) => sum + (check.errorsIntroduced ?? 0), 0);
		result.errorsResolved = complete.reduce((sum, check) => sum + (check.errorsResolved ?? 0), 0);
		result.netDelta = result.errorsIntroduced - result.errorsResolved;
	}
	result.limitations = [
		"Only changed files and explicit validationPaths were checked; other dependents, builds and runtime behavior were not validated.",
		"Counts are provider observations; different providers can report the same problem. Consult checks for per-provider coverage and completeness.",
	];
	return result;
}
