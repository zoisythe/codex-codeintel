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
	create(identity: string, files: PlannedFile[], paths: string[] = files.map((file) => file.path)): EditPlan {
		const plan = {
			id: randomUUID(),
			identity,
			paths,
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
			this.plans.delete(this.plans.keys().next().value ?? "");
		return plan;
	}
	get(id: string): EditPlan {
		const plan = this.plans.get(id);
		if (!plan) throw new Error("Plan missing, consumed or expired; generate a new preview");
		return plan;
	}
	clear(): void {
		this.plans.clear();
	}
	discard(id: string): void {
		this.plans.delete(id);
	}
	async apply(id: string, identity: string, root: string, signal: AbortSignal): Promise<string[]> {
		const plan = this.get(id);
		this.plans.delete(id);
		if (plan.identity !== identity)
			throw new Error("Plan stale: workspace, configuration, tools or environment changed; preview again");
		const validate = async (file: PlannedFile) => {
			const actual = await workspacePath(root, file.path);
			if (
				actual !== file.absolute ||
				(await fileIdentity(actual)) !== file.fileIdentity ||
				(await readFile(actual, "utf8")) !== file.before
			)
				throw new Error(`Plan conflict: ${file.path}`);
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
			throw new WriteFailure(message(error), modified);
		}
		return modified;
	}
}
