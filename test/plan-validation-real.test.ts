import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configuration } from "../src/config.js";
import { plannedFile } from "../src/edit-plans.js";
import { Languages } from "../src/language.js";
import type { PlanValidation } from "../src/plan-validation.js";
import { withPreviewWorkspace } from "../src/preview-workspace.js";

const roots: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
	);
});
async function fixture(lsp: Record<string, unknown>, lint: Record<string, unknown> = {}) {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "codeintel-preview-real-")));
	roots.push(dir);
	const root = join(dir, "project"),
		home = join(dir, "home");
	await mkdir(root);
	await mkdir(home);
	await symlink(
		resolve("node_modules"),
		join(root, "node_modules"),
		process.platform === "win32" ? "junction" : "dir",
	);
	vi.stubEnv("CODEX_HOME", home);
	vi.stubEnv("CODEX_LSP_CACHE", join(dir, "cache"));
	await writeFile(
		join(home, "lsp-client.json"),
		JSON.stringify({
			schemaVersion: 1,
			lsp: { python: false, typescript: false, cpp: false, go: false, ...lsp },
			lint: { python: "off", javascript: "off", ...lint },
		}),
	);
	const language = new Languages(root, await configuration(root));
	const put = async (path: string, content: string) => {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), content);
	};
	const validate = async (changes: Record<string, string>, extra: string[] = []) =>
		language.validatePlan(
			await Promise.all(Object.entries(changes).map(([path, content]) => plannedFile(root, path, content))),
			AbortSignal.timeout(30000),
			extra,
		);
	return { root, put, validate, language };
}
function complete(result: PlanValidation, provider: string) {
	expect(result.state, JSON.stringify(result)).toBe("complete");
	expect(result.checks?.find((check) => check.provider === provider)?.state, JSON.stringify(result)).toBe("complete");
}
it("ESLint stdin previews compare rule changes and reject type-aware project services", async () => {
	const { root, put, validate, language } = await fixture({}, { javascript: "eslint" });
	try {
		await put(
			"eslint.config.mjs",
			'export default [{files:["**/*.js"],rules:{"no-var":"error","prefer-const":"error"}}];\n',
		);
		const before = "var value = 1;\nexport {value};\n";
		await put("a.js", before);
		const result = await validate({ "a.js": before.replace("var", "let") });
		complete(result, "eslint");
		expect(result).toMatchObject({ errorsIntroduced: 1, errorsResolved: 1, netDelta: 0 });
		expect(result.introduced[0]?.rule).toBe("prefer-const");
		expect(result.resolved[0]?.rule).toBe("no-var");
		expect(await readFile(join(root, "a.js"), "utf8")).toBe(before);
		await put("eslint.config.mjs", "export default [{languageOptions:{parserOptions:{projectService:true}}}];\n");
		expect(await validate({ "a.js": "const value = 2;\n" })).toMatchObject({ state: "unsupported", netDelta: null });
	} finally {
		await language.close();
	}
}, 30000);
it("Biome snapshot previews retain separate introduced and resolved findings", async () => {
	const { root, put, validate, language } = await fixture({}, { javascript: "biome" });
	try {
		await put(
			"biome.json",
			JSON.stringify({
				linter: {
					rules: { recommended: false, style: { useConst: "error" }, suspicious: { noDebugger: "error" } },
				},
			}),
		);
		const before = "let value=1;\nexport {value};\n";
		await put("a.js", before);
		const result = await validate({ "a.js": `${before.replace("let", "const")}debugger;\n` });
		complete(result, "biome");
		expect(result).toMatchObject({ errorsIntroduced: 1, errorsResolved: 1, netDelta: 0 });
		expect(await readFile(join(root, "a.js"), "utf8")).toBe(before);
		await put("biome.json", JSON.stringify({ files: { includes: ["included/**"] } }));
		expect(await validate({ "a.js": "const value=1;\n" })).toMatchObject({ state: "unsupported", netDelta: null });
	} finally {
		await language.close();
	}
}, 30000);
for (const kind of ["native", "traditional"] as const)
	it(`${kind} TypeScript: complete overlays detect errors in unchanged callers`, async () => {
		const typescript =
			kind === "native"
				? "tsc"
				: {
						command: [
							process.execPath,
							resolve("node_modules/typescript-language-server/lib/cli.mjs"),
							"--stdio",
						],
						extensions: [".ts", ".js"],
						initialization: {
							tsserver: {
								path: resolve("test/fixtures/legacy-typescript/node_modules/typescript/lib/tsserver.js"),
							},
						},
					};
		const { root, put, validate, language } = await fixture({ typescript });
		try {
			await put(
				"tsconfig.json",
				JSON.stringify({
					compilerOptions: {
						strict: true,
						target: "ES2022",
						module: "NodeNext",
						moduleResolution: "NodeNext",
						types: [],
						allowJs: true,
						checkJs: true,
					},
					include: ["*.ts", "*.js"],
				}),
			);
			await put("values.ts", "export const value: number = 1;\n");
			const caller = 'import {value} from "./values.js";\nexport const result: number = value;\n';
			await put("use.ts", caller);
			const result = await validate({ "values.ts": 'export const value: string = "new";\n' }, ["use.ts"]);
			complete(result, "typescript");
			expect(result.errorsIntroduced).toBe(1);
			expect(result.introduced[0]?.path).toBe("use.ts");
			const all = await validate({
				"values.ts": 'export const value: string = "new";\n',
				"use.ts": caller.replace(": number", ": string"),
			});
			complete(all, "typescript");
			expect(all.errorsIntroduced).toBe(0);
			await put("plain.js", "/** @type {number} */\nexport const item = 1;\n");
			const js = await validate({ "plain.js": '/** @type {number} */\nexport const item = "wrong";\n' });
			complete(js, "typescript");
			expect(js.errorsIntroduced).toBe(1);
			expect(await readFile(join(root, "use.ts"), "utf8")).toBe(caller);
			expect(language.statistics()).toEqual({ running: 0, processStarts: 0 });
		} finally {
			await language.close();
		}
	}, 30000);
it.skipIf(process.env["CODEX_LSP_REAL_TOOLS"] !== "1")(
	"Ruff stdin preview complements ty without writing source or caches",
	async () => {
		const { root, put, validate, language } = await fixture({}, { python: "ruff" });
		try {
			await put("ruff.toml", '[lint]\nselect=["F401","F821"]\n');
			await put("a.py", "import os\n");
			const result = await validate({ "a.py": "print(missing)\n" });
			complete(result, "ruff");
			expect(result).toMatchObject({ errorsIntroduced: 1, errorsResolved: 1, netDelta: 0 });
			expect(result.introduced[0]?.rule).toBe("F821");
			expect(result.resolved[0]?.rule).toBe("F401");
			expect(await readFile(join(root, "a.py"), "utf8")).toBe("import os\n");
			await expect(access(join(root, ".ruff_cache"))).rejects.toThrow();
		} finally {
			await language.close();
		}
	},
	30000,
);
it.skipIf(process.env["CODEX_LSP_REAL_TOOLS"] !== "1")(
	"ty preview checks explicitly selected unchanged dependents",
	async () => {
		const { put, validate, language } = await fixture({ python: "ty" });
		try {
			await put("pyproject.toml", '[project]\nname="preview"\nversion="0.0.0"\nrequires-python=">=3.13"\n');
			await put("values.py", "value: int = 1\n");
			await put("use.py", "from values import value\nresult: int = value\n");
			const result = await validate({ "values.py": 'value: str = "new"\n' }, ["use.py"]);
			complete(result, "ty");
			expect(result.errorsIntroduced).toBe(1);
			expect(result.introduced[0]?.path).toBe("use.py");
		} finally {
			await language.close();
		}
	},
	30000,
);
it.skipIf(process.env["CODEX_LSP_REAL_TOOLS"] !== "1")(
	"gopls pull preview sees changed and unchanged package files together",
	async () => {
		const { root, put, validate, language } = await fixture({ go: "gopls" });
		try {
			await put("go.mod", "module example.com/preview\n\ngo 1.23\n");
			await put("value.go", 'package preview\nfunc Value() string { return "old" }\n');
			const caller = "package preview\nfunc Caller() string { return Value() }\n";
			await put("use.go", caller);
			const result = await validate({ "value.go": "package preview\nfunc Value() int { return 1 }\n" }, ["use.go"]);
			complete(result, "gopls");
			expect(result.errorsIntroduced).toBeGreaterThan(0);
			expect(result.introduced.some((item) => item.path === "use.go")).toBe(true);
			const all = await validate({
				"value.go": "package preview\nfunc Value() int { return 1 }\n",
				"use.go": caller.replace("string", "int"),
			});
			complete(all, "gopls");
			expect(all.errorsIntroduced).toBe(0);
			expect(await readFile(join(root, "use.go"), "utf8")).toBe(caller);
		} finally {
			await language.close();
		}
	},
	30000,
);
it("private project snapshots are removed after an interrupted analysis", async () => {
	const { root, put, language } = await fixture({});
	await put("a.js", "original\n");
	let shadow = "";
	try {
		const files = [await plannedFile(root, "a.js", "simulated\n")];
		await expect(
			withPreviewWorkspace(
				root,
				files,
				await configuration(root),
				new AbortController().signal,
				async (workspace) => {
					shadow = workspace.root;
					await workspace.writePhase(true);
					expect(await readFile(workspace.map("a.js"), "utf8")).toBe("simulated\n");
					throw new Error("interrupted analysis");
				},
			),
		).rejects.toThrow("interrupted analysis");
		await expect(access(shadow)).rejects.toThrow();
		expect(await readFile(join(root, "a.js"), "utf8")).toBe("original\n");
	} finally {
		await language.close();
	}
});
for (const extension of ["c", "cpp"])
	it.skipIf(process.env["CODEX_LSP_REAL_TOOLS"] !== "1")(
		`clangd ${extension} preview observes unsaved header overlays in unchanged translation units`,
		async () => {
			const { root, put, validate, language } = await fixture({ cpp: "clangd" });
			try {
				await put(".clangd", "CompileFlags:\n  CompilationDatabase: build\n");
				await put(
					"build/compile_commands.json",
					JSON.stringify([
						{
							directory: root,
							file: join(root, `main.${extension}`),
							arguments: [
								"clang",
								`-x${extension === "c" ? "c" : "c++"}`,
								`-std=${extension === "c" ? "c17" : "c++20"}`,
								"-c",
								join(root, `main.${extension}`),
							],
						},
					]),
				);
				await put("build/generated.h", "#define VALUE 1\n");
				await put("value.h", '#include "build/generated.h"\nstatic inline int value(void) { return VALUE; }\n');
				const before = '#include "value.h"\nint use(void) { return value() * 2; }\n';
				await put(`main.${extension}`, before);
				const result = await validate({ "value.h": 'static inline const char *value(void) { return "new"; }\n' }, [
					`main.${extension}`,
				]);
				complete(result, "clangd");
				expect(result.errorsIntroduced).toBeGreaterThan(0);
				expect(result.introduced.some((item) => item.path === `main.${extension}`)).toBe(true);
				expect(await readFile(join(root, `main.${extension}`), "utf8")).toBe(before);
			} finally {
				await language.close();
			}
		},
		30000,
	);
