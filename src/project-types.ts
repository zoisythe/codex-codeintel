import type { Finding } from "./results.js";
export interface ProjectCheck {
	name: string;
	cwd: string;
	command: string[];
	parser: "sarif" | "tsc" | "ty" | "cargo" | "ruff" | "eslint" | "biome" | "json";
	coverage: string[];
}
export interface CheckerResult {
	parser: ProjectCheck["parser"];
	name: string;
	cwd: string;
	coverage: string[];
	excluded?: string[];
	state: "running" | "complete" | "failed" | "stale";
	findings: Finding[];
	note?: string;
}
export interface ProjectResult {
	operation: "check_project";
	job: string;
	state: "running" | "complete" | "failed" | "stale" | "missing";
	checkers: CheckerResult[];
	diagnostics: Finding[];
	errors: number;
	warnings: number;
	next?: Record<string, unknown>;
}
