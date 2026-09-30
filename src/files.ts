import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import * as nodePath from "node:path";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { BUDGET } from "./budgets.js";
import { executionEnvironment } from "./environment.js";
import type { TextEdit } from "./lsp/types.js";

import { measured } from "./metrics.js";

const exec = promisify(execFile);
const SKIP = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	".next",
	"coverage",
	".canon",
	".venv",
	".ruff_cache",
	".mypy_cache",
	".pytest_cache",
	"__pycache__",
	"vendor",
	"target",
]);
export const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
export function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
export async function workspacePath(root: string, path: string): Promise<string> {
	const absolute = resolve(root, path);
	if (!inside(root, absolute)) throw new Error("Path is outside workspace");
	const actual = await realpath(absolute);
	if (!inside(root, actual)) throw new Error("Symlink is outside workspace");
	return actual;
}
export interface Inventory {
	files: Map<string, string>;
	version: string;
	complete: boolean;
}
export async function inventory(...args: Parameters<typeof scanInventory>): Promise<Inventory> {
	return measured("discovery/hash", () => scanInventory(...args));
}
interface Indexed {
	signature: string;
	content: string;
}
const snapshots = new Map<string, Inventory>();
export function latestInventory(root: string): Inventory | undefined {
	return snapshots.get(root);
}
const indexes = new Map<string, Map<string, Indexed>>();
const counters = { scans: 0, contentReads: 0, bytesRead: 0 };
export function indexStatistics(): typeof counters {
	return { ...counters };
}
export function forgetIndex(root: string): void {
	indexes.delete(root);
	snapshots.delete(root);
}
async function scanInventory(
	root: string,
	maxFiles = 10000,
	signal?: AbortSignal,
	exclude: string[] = [],
	scope = root,
	dependencyOnly = false,
	force: readonly string[] = [],
): Promise<Inventory> {
	signal?.throwIfAborted();
	const included = (name: string) =>
		!name.split(/[\\/]/).some((part) => SKIP.has(part)) &&
		!exclude.some((pattern) => nodePath.matchesGlob(name.split(sep).join("/"), pattern));
	let names: string[];
	let complete = true;
	try {
		const { stdout } = await exec(
			"git",
			["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."],
			{
				cwd: scope,
				env: executionEnvironment(),
				timeout: 5000,
				maxBuffer: 4 * 1024 * 1024,
				...(signal ? { signal } : {}),
			},
		);
		names = [
			...new Set(
				stdout
					.split("\0")
					.filter(Boolean)
					.map((name) => relative(root, join(scope, name))),
			),
		].filter(included);
	} catch (error) {
		signal?.throwIfAborted();
		if (error instanceof Error && "killed" in error && error.killed)
			throw new Error("Git discovery timed out; baseline retained");
		names = [];
		const walk = async (dir: string): Promise<void> => {
			for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
				a.name.localeCompare(b.name),
			)) {
				signal?.throwIfAborted();
				if (names.length > maxFiles) {
					complete = false;
					break;
				}
				if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
				const path = join(dir, entry.name);
				if (entry.isDirectory()) await walk(path);
				else if (entry.isFile() && included(relative(root, path))) names.push(relative(root, path));
			}
		};
		await walk(scope);
	}
	const files = new Map<string, string>();
	names.sort();
	if (names.length > maxFiles) complete = false;
	if (!complete && dependencyOnly) return { files, complete: false, version: hash(JSON.stringify(names)) };
	counters.scans++;
	let index = indexes.get(root);
	if (!index) {
		index = new Map();
		indexes.set(root, index);
	}
	const cache = index;
	const verify = new Set(force);
	const selected = names.slice(0, maxFiles);
	let next = 0;
	await Promise.all(
		Array.from({ length: BUDGET.scanWorkers }, async () => {
			while (next < selected.length) {
				const name = selected[next++];
				if (!name) continue;
				signal?.throwIfAborted();
				try {
					const path = await workspacePath(root, name);
					const info = await lstat(path);
					if (!info.isFile()) continue;
					if (info.size > BUDGET.fileBytes) {
						complete = false;
						continue;
					}
					const key = relative(root, path);
					const signature = JSON.stringify([info.size, info.mtimeMs, info.ctimeMs, info.dev, info.ino]);
					let entry = cache.get(key);
					if (verify.has(key) || entry?.signature !== signature) {
						const content = await readFile(path, { encoding: "utf8", ...(signal ? { signal } : {}) });
						counters.contentReads++;
						counters.bytesRead += Buffer.byteLength(content);
						entry = { signature, content: hash(content) };
						cache.set(key, entry);
					}
					if (entry) files.set(key, entry.content);
				} catch (error) {
					signal?.throwIfAborted();
					if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) complete = false;
				}
			}
		}),
	);
	if (scope === root && complete) for (const key of cache.keys()) if (!files.has(key)) cache.delete(key);
	const sorted = new Map([...files].sort(([a], [b]) => a.localeCompare(b)));

	const snapshot = { files: sorted, version: hash(JSON.stringify([...sorted])), complete };
	if (scope === root) snapshots.set(root, snapshot);
	return snapshot;
}
export function applyTextChanges(text: string, edits: readonly TextEdit[]): string {
	const lines = text.split("\n");
	const offset = (line: number, character: number): number => {
		if (
			!Number.isInteger(line) ||
			!Number.isInteger(character) ||
			line < 0 ||
			character < 0 ||
			line >= lines.length ||
			character > (lines[line]?.length ?? 0)
		)
			throw new Error("Invalid edit range");
		return lines.slice(0, line).reduce((n, part) => n + part.length + 1, 0) + character;
	};
	const sorted = edits
		.map((edit) => ({
			start: offset(edit.range.start.line, edit.range.start.character),
			end: offset(edit.range.end.line, edit.range.end.character),
			text: edit.newText,
		}))
		.sort((a, b) => b.start - a.start || b.end - a.end);
	let boundary = text.length;
	for (const edit of sorted) {
		if (edit.start > edit.end || edit.end > boundary) throw new Error("Overlapping edit ranges");
		text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
		boundary = edit.start;
	}
	return text;
}
