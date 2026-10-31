import type { PlanValidation } from "../src/plan-validation.js";
import type { ProjectResult } from "../src/project-types.js";
import type { FileResult, Finding } from "../src/results.js";

export type Arguments = Record<string, unknown> & { workspace?: string; session?: string };
export interface CommonOutput {
	operation?: string;
	status?: string;
	state?: string;
	reason?: string;
	next?: Arguments;
	paged?: boolean;
}
export interface DiagnosticsOutput extends CommonOutput {
	results: FileResult[];
	errors: number;
	warnings: number;
	partial?: boolean;
	unavailable: Record<string, unknown>;
}
export interface ToolStatus {
	path: string;
	language: string;
	tool: { source: string; command: string[]; note?: string };
	lint: { source?: string; command?: string; name?: string; verification?: { state: string } };
	capabilities: {
		diagnostics: string;
		navigation: string;
		rename: string;
		formatting: string;
		lint: string;
		lintFixes: string;
		actions: string;
		completion: string;
		declaration: string;
		callHierarchy: string;
		typeHierarchy: string;
	};
	running: boolean;
	verified: boolean;
	failure?: string;
}
export interface StatusOutput extends CommonOutput {
	tools: ToolStatus[];
	service: { state: string; pid?: number; identity?: string };
	clients: { running: number; processStarts: number };
	hookTasks: { queued: number; running: number };
	configuration: { valid: boolean; stopGate?: string; trust?: unknown; automaticDiagnostics: unknown };
	trusted?: unknown;
	index: { fullScans?: number; scans?: number };
	configurationSources: { path: string; exists: boolean }[];
	configurationIssues: { message: string; scope: string }[];
	sessions: string[];
}
export interface PreviewOutput extends CommonOutput {
	plan: string;
	files: string[];
	diff: string[];
	createdAt: string;
	expiresAt: string;
	storage: "memory";
	validation: PlanValidation;
}
export interface ApplyOutput extends CommonOutput {
	modifiedPaths: string[];
	diagnostics: { state: string; errors: number; warnings: number };
	planFailure?: string;
}
export interface ActionItem {
	id: string;
	title: string;
	rule?: string;
	applicability: string;
	status?: string;
}
export interface ActionsOutput extends PreviewOutput {
	items: ActionItem[];
	effective?: unknown;
	explanation?: string;
}
export interface InspectOutput extends CommonOutput {
	source?: string;
	sections: { hover?: { status: string; result: { contents: unknown } }; references?: { count: number } };
	symbols: {
		references: { count: number };
		callers: { items: { symbol: string }[] };
		candidateTests: { paths: string[] };
	}[];
	indirect: unknown[];
}
export interface ToolOutputs {
	diagnostics: DiagnosticsOutput;
	status: StatusOutput;
	check: ProjectResult;
	rename: PreviewOutput;
	format: PreviewOutput;
	apply: ApplyOutput;
	actions: ActionsOutput;
	inspect: InspectOutput;
	navigate: CommonOutput & { result: unknown };
	warmup: CommonOutput & { items: { path: string; status: string }[] };
}
export type Output<N extends string> = CommonOutput & (N extends keyof ToolOutputs ? ToolOutputs[N] : CommonOutput);
export interface McpResult<N extends string = string> {
	isError?: boolean;
	content: [{ type: string; text: string }, ...{ type: string; text: string }[]];
	structuredContent: Output<N>;
}
export interface HookResult {
	text: string;
	value: { decision?: string; reason?: string };
	ms: number;
}
export interface WireRequest {
	id?: number | string;
	method?: string;
	params?: Record<string, unknown>;
}
export type TraceEntry = Record<string, unknown>;
export type FindingList = Finding[];

export interface NavigationItem {
	path?: string;
	symbol?: string;
	label?: string;
	from?: { path?: string };
}
export interface FixtureRequest {
	method: string;
	id?: number | string;
	params: {
		textDocument: { uri: string; version: number; text?: string };
		contentChanges: { text: string }[];
		previousResultId?: string;
		newName: string;
		data: { uri: string };
	};
}
