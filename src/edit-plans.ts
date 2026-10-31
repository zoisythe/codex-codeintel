import { randomUUID } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { BUDGET } from "./budgets.js";
import { applyTextChanges, workspacePath } from "./files.js";
import type { TextEdit, WorkspaceEdit } from "./lsp/types.js";
import { message, WriteFailure } from "./results.js";

export interface PlannedFile {
	path: string;
	absolute: string;
	before: string;
	after: string;
	fileIdentity: string;
}
export interface EditPlan {
	id: string;
	identity: string;
	files: PlannedFile[];
	paths: string[];
	createdAt: string;
	expiresAt: string;
	storage: "memory";
}
export type PlanFailureCode = "consumed" | "expired" | "evicted" | "unavailable" | "stale" | "conflict";
export function isPlanFailureCode(value: unknown): value is PlanFailureCode {
	return (
		typeof value === "string" &&
		["consumed", "expired", "evicted", "unavailable", "stale", "conflict"].includes(value)
	);
}
export class PlanFailure extends Error {
	constructor(
		readonly planFailure: PlanFailureCode,
		reason: string,
	) {
		super(reason);
	}
}
export async function fileIdentity(path: string): Promise<string> {
	const info = await lstat(path);
	if (!info.isFile() || info.size > BUDGET.fileBytes) throw new Error("Unsupported or oversized edit target");
	return JSON.stringify([info.dev, info.ino, info.birthtimeMs]);
}
export async function plannedFile(root: string, path: string, after: string, before?: string): Promise<PlannedFile> {
	const absolute = await workspacePath(root, path);
	const content = await readFile(absolute, "utf8");
	if (before !== undefined && content !== before) throw new Error("File changed while preparing plan");
	if (Buffer.byteLength(after) > BUDGET.fileBytes) throw new Error("Planned content exceeds file budget");
	return {
		path: relative(root, absolute),
		absolute,
		before: content,
		after,
		fileIdentity: await fileIdentity(absolute),
	};
}
export async function workspaceEdits(root: string, edit: WorkspaceEdit | null): Promise<PlannedFile[]> {
	const changes = new Map<string, TextEdit[]>();
	for (const [uri, edits] of Object.entries(edit?.changes ?? {})) changes.set(uri, edits);
	for (const change of edit?.documentChanges ?? []) {
		if ("kind" in change) throw new Error("Unsupported resource operation; no part of this action was applied");
		if (changes.has(change.textDocument.uri)) throw new Error("Duplicate edit target");
		changes.set(change.textDocument.uri, change.edits);
	}
	const files: PlannedFile[] = [];
	const seen = new Set<string>();
	for (const [uri, edits] of changes) {
		const absolute = await workspacePath(root, fileURLToPath(uri));
		if (seen.has(absolute)) throw new Error("Duplicate canonical edit target");
		seen.add(absolute);
		await fileIdentity(absolute);
		const before = await readFile(absolute, "utf8");
		files.push(await plannedFile(root, absolute, applyTextChanges(before, edits), before));
	}
	return files;
}
export function diffLines(file: PlannedFile): string[] {
	const before = file.before.split("\n");
	const after = file.after.split("\n");
	let start = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) start++;
	let endBefore = before.length;
	let endAfter = after.length;
	while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
		endBefore--;
		endAfter--;
	}
	return [
		`--- ${file.path}`,
		`+++ ${file.path}`,
		`@@ -${start + 1},${endBefore - start} +${start + 1},${endAfter - start} @@`,
		...before.slice(start, endBefore).map((line) => `-${line}`),
		...after.slice(start, endAfter).map((line) => `+${line}`),
	];
}
export class EditPlans {
	private readonly plans = new Map<string, EditPlan>();
	private readonly ended = new Map<string, { reason: PlanFailureCode; until: number }>();
	constructor(private readonly now: () => number = Date.now) {}
	private remove(id: string, reason: PlanFailureCode): void {
		this.plans.delete(id);
		this.ended.set(id, { reason, until: this.now() + BUDGET.planTtl });
		while (this.ended.size > 64) this.ended.delete(this.ended.keys().next().value ?? "");
	}
	private prune(): void {
		const now = this.now();
		for (const [id, entry] of this.ended) if (entry.until <= now) this.ended.delete(id);
		for (const [id, plan] of this.plans) if (Date.parse(plan.expiresAt) <= now) this.remove(id, "expired");
	}
	hasLivePlans(): boolean {
		this.prune();
		return [...this.plans.values()].some((plan) => plan.files.length > 0);
	}
	create(identity: string, files: PlannedFile[], paths: string[] = files.map((file) => file.path)): EditPlan {
		this.prune();
		const now = this.now();
		const plan: EditPlan = {
			id: randomUUID(),
			identity,
			paths,
			createdAt: new Date(now).toISOString(),
			expiresAt: new Date(now + BUDGET.planTtl).toISOString(),
			storage: "memory",
			files: files.filter((file) => file.before !== file.after).sort((a, b) => a.path.localeCompare(b.path)),
		};
		if (
			files.length > 200 ||
			files.reduce((sum, file) => sum + Buffer.byteLength(file.before + file.after), 0) > 8 * BUDGET.outputBytes
		)
			throw new Error("Edit plan exceeds budget; narrow scope");
		this.plans.set(plan.id, plan);
		const memory = () =>
			[...this.plans.values()]
				.flatMap((plan) => plan.files)
				.reduce((sum, file) => sum + Buffer.byteLength(file.before + file.after), 0);
		while (this.plans.size > 16 || memory() > 8 * BUDGET.outputBytes)
			this.remove(this.plans.keys().next().value ?? "", "evicted");
		return plan;
	}
	get(id: string): EditPlan {
		this.prune();
		const plan = this.plans.get(id);
		if (!plan) {
			const reason = this.ended.get(id)?.reason ?? "unavailable";
			throw new PlanFailure(reason, `Plan missing: ${reason}; generate a new preview`);
		}
		return plan;
	}
	clear(): void {
		this.plans.clear();
		this.ended.clear();
	}
	discard(id: string, reason: PlanFailureCode = "stale"): void {
		if (this.plans.has(id)) this.remove(id, reason);
	}
	async apply(id: string, identity: string, root: string, signal: AbortSignal): Promise<string[]> {
		const plan = this.get(id);
		this.remove(id, "consumed");
		if (plan.identity !== identity)
			throw new PlanFailure(
				"stale",
				"Plan stale: workspace, configuration, tools or environment changed; preview again",
			);
		const validate = async (file: PlannedFile) => {
			const actual = await workspacePath(root, file.path);
			if (
				actual !== file.absolute ||
				(await fileIdentity(actual)) !== file.fileIdentity ||
				(await readFile(actual, "utf8")) !== file.before
			)
				throw new PlanFailure("conflict", `Plan conflict: ${file.path}`);
		};
		for (const file of plan.files) {
			signal.throwIfAborted();
			await validate(file);
		}
		const modified: string[] = [];
		let writing: PlannedFile | undefined;
		try {
			for (const file of plan.files) {
				signal.throwIfAborted();
				await validate(file);
				signal.throwIfAborted();
				writing = file;
				await writeFile(file.absolute, file.after);
				modified.push(file.path);
				writing = undefined;
			}
		} catch (error) {
			// A filesystem write may fail after truncating its target. Report every
			// target whose contents actually differ, including the failing write.
			if (
				writing &&
				!modified.includes(writing.path) &&
				(await readFile(writing.absolute, "utf8").catch(() => null)) !== writing.before
			)
				modified.push(writing.path);
			throw new WriteFailure(message(error), modified, error instanceof PlanFailure ? error.planFailure : undefined);
		}
		return modified;
	}
}
