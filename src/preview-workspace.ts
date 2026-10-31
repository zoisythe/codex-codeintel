import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Config } from "./config.js";
import type { PlannedFile } from "./edit-plans.js";
import { inside, inventory, workspacePath } from "./files.js";

export interface PreviewWorkspace {
	root: string;
	map(path: string): string;
	translate(text: string): string;
	writePhase(after: boolean): Promise<void>;
}
// Some tools read headers/project files from disk even when editor buffers exist.
// Keep their filesystem view private, bounded and disposable; never edit originals.
export async function withPreviewWorkspace<T>(
	root: string,
	files: PlannedFile[],
	config: Config,
	signal: AbortSignal,
	use: (workspace: PreviewWorkspace) => Promise<T>,
): Promise<T> {
	const snapshot = await inventory(root, 2000, signal, config.exclude);
	if (!snapshot.complete) throw new Error("unsupported: preview snapshot exceeds 2000 files or is incomplete");
	const temporary = await mkdtemp(join(tmpdir(), "codeintel-preview-"));
	const shadow = join(temporary, "workspace");
	const map = (path: string) => {
		const absolute = resolve(root, path);
		if (!inside(root, absolute)) throw new Error("Preview path outside workspace");
		return join(shadow, relative(root, absolute));
	};
	const translate = (text: string) => {
		for (const [from, to] of [
			[root.replaceAll("\\", "/"), shadow.replaceAll("\\", "/")],
			[root.replaceAll("\\", "\\\\"), shadow.replaceAll("\\", "\\\\")],
			[root, shadow],
		] as const) {
			text = text === from ? to : text;
			text = text
				.replaceAll(`${from}/`, `${to}/`)
				.replaceAll(`${from}\\`, `${to}\\`)
				.replaceAll(`"${from}"`, `"${to}"`)
				.replaceAll(`=${from}`, `=${to}`);
		}
		return text;
	};
	try {
		await mkdir(shadow);
		let bytes = 0;
		const selected = new Set([...snapshot.files.keys(), ...files.map((file) => file.path)]);
		for (const file of files)
			for (let dir = dirname(file.absolute); inside(root, dir); dir = dirname(dir)) {
				for (const name of [
					"biome.json",
					"biome.jsonc",
					".clangd",
					"compile_commands.json",
					"compile_flags.txt",
					"package.json",
				])
					if (
						await access(join(dir, name)).then(
							() => true,
							() => false,
						)
					)
						selected.add(relative(root, join(dir, name)));
				if (dir === root || dirname(dir) === dir) break;
			}
		if (selected.size > 2000) throw new Error("unsupported: preview snapshot exceeds 2000 files");
		const names = [...selected];
		let copied = names.length;
		for (const path of names) {
			signal.throwIfAborted();
			const absolute = await workspacePath(root, path);
			bytes += (await stat(absolute)).size;
			if (bytes > 32 * 1024 * 1024) throw new Error("unsupported: preview snapshot exceeds 32 MiB");
			const destination = map(path);
			await mkdir(dirname(destination), { recursive: true });
			const content = await readFile(absolute);
			const configuration = /(?:^|[\\/])(?:biome\.jsonc?|\.clangd|compile_commands\.json|compile_flags\.txt)$/.test(
				path,
			);
			await writeFile(destination, configuration ? translate(content.toString("utf8")) : content);
		}
		// Generated headers and compilation databases commonly live in ignored build
		// directories. Keep dependencies readable, while copying/remapping databases.
		for (const name of ["build", "dist", "target", "vendor"]) {
			const directory = join(root, name);
			if (!(await stat(directory).catch(() => undefined))?.isDirectory()) continue;
			await mkdir(map(name), { recursive: true });
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				signal.throwIfAborted();
				const path = join(name, entry.name),
					destination = map(path);
				if (
					await access(destination).then(
						() => true,
						() => false,
					)
				)
					continue;
				if (
					entry.name === "compile_commands.json" ||
					/\.(?:h|hh|hpp|hxx|inc|def|modulemap|json|txt|cmake)$/.test(entry.name)
				) {
					if (++copied > 2000) throw new Error("unsupported: preview snapshot exceeds 2000 copied files");
					bytes += (await stat(join(root, path))).size;
					if (bytes > 32 * 1024 * 1024) throw new Error("unsupported: preview snapshot exceeds 32 MiB");
					const content = await readFile(join(root, path), "utf8");
					await writeFile(destination, entry.name === "compile_commands.json" ? translate(content) : content);
				} else if (entry.isDirectory())
					await symlink(join(root, path), destination, process.platform === "win32" ? "junction" : "dir");
			}
		}
		// Preserve package/config resolution without copying dependency installations.
		const linked = new Set<string>();
		for (const file of files)
			for (let dir = dirname(file.absolute); inside(root, dir); dir = dirname(dir)) {
				const dependencies = join(dir, "node_modules");
				if (
					!linked.has(dependencies) &&
					(await access(dependencies).then(
						() => true,
						() => false,
					))
				) {
					const destination = map(dependencies);
					await mkdir(dirname(destination), { recursive: true });
					await symlink(dependencies, destination, process.platform === "win32" ? "junction" : "dir");
					linked.add(dependencies);
				}
				if (dir === root || dirname(dir) === dir || relative(root, dir).split(sep).includes("node_modules")) break;
			}
		return await use({
			root: shadow,
			map,
			translate,
			writePhase: async (after) => {
				for (const file of files) {
					signal.throwIfAborted();
					await writeFile(map(file.path), after ? file.after : file.before);
				}
			},
		});
	} finally {
		await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
}
