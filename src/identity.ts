import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import type { Config } from "./config.js";
import { executionEnvironment } from "./environment.js";
import { hash, inside } from "./files.js";
import { runnerIdentity } from "./runners.js";
import { resolveServer } from "./tool-resolution.js";

const CONFIGS = [
	"ty.toml",
	".clangd",
	"compile_commands.json",
	"build/compile_commands.json",
	"compile_flags.txt",
	".clang-format",
	"Cargo.lock",
	"rust-toolchain",
	"rust-toolchain.toml",
	"rustfmt.toml",
	".rustfmt.toml",
	"biome.json",
	"biome.jsonc",
	"eslint.config.js",
	"eslint.config.mjs",
	"eslint.config.cjs",
	"eslint.config.ts",
	".eslintrc.json",
	".eslintrc.cjs",
	"pyproject.toml",
	"ruff.toml",
	".ruff.toml",
	"tsconfig.json",
	"jsconfig.json",
	"pyrightconfig.json",
	"package.json",
	"Cargo.toml",
	"go.mod",
];
// Direct workspace configuration is read even when scan exclusions hide it.
// External extends/imports and tool installation changes require refresh.
export async function analysisIdentity(
	root: string,
	paths: string[],
	config: Config,
	signal: AbortSignal,
	lsp = true,
): Promise<string> {
	const dirs = new Set<string>();

	const runners = new Map<string, string>();
	for (const path of paths) {
		signal.throwIfAborted();
		const absolute = resolve(root, path);

		const key = `${dirname(absolute)}:${extname(path)}`;
		if (!runners.has(key)) runners.set(key, await runnerIdentity(root, absolute, config));
		let dir = dirname(absolute);
		while (inside(root, dir)) {
			dirs.add(dir);
			if (dir === root) break;
			dir = dirname(dir);
		}
	}
	const contents: string[] = [];
	for (const dir of [...dirs].sort())
		for (const name of CONFIGS) {
			signal.throwIfAborted();
			const path = join(dir, name);
			try {
				if ((await stat(path)).size > 1024 * 1024) throw new Error("Tool configuration exceeds 1 MiB");
				contents.push(path, hash(await readFile(path, { encoding: "utf8", signal })));
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			}
		}
	const representatives = [...new Map(paths.map((path) => [`${dirname(path)}:${extname(path)}`, path])).values()];
	const servers = lsp
		? await Promise.all(
				representatives.map((path) => resolveServer(root, path, config).catch((error) => String(error))),
			)
		: [];
	return hash(JSON.stringify([config.version, executionEnvironment(), contents, [...runners].sort(), servers]));
}
