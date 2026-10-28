import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { bundleClient } from "./bundle-client.mjs";
import { completeOutput } from "./page-output.mjs";

async function fixture(t, lsp = { typescript: false, python: false }) {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "codeintel-feature-"))), root = join(dir, "project"), home = join(dir, "home");
	await mkdir(root); await mkdir(home);
	await symlink(resolve("node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
	await writeFile(join(home, "lsp-client.json"), JSON.stringify({ schemaVersion: 1, lsp }));
	const client = bundleClient(root, home, { CODEX_LSP_CACHE: join(dir, "cache") });
	t.after(async () => { await client.close(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
	const call = async (name, args) => { const output = await client.full(name, args); assert(!output.isError, JSON.stringify(output)); return output.structuredContent; };
	return { dir, root, home, client, call };
}
test("real ESLint: findings, unknown fixes, explicit selection, preview, application and stale plans", { timeout: 30000 }, async t => {
	const { root, client, call } = await fixture(t);
	await writeFile(join(root, "eslint.config.mjs"), 'export default [{files:["**/*.js"],rules:{"no-var":"error","prefer-const":"error","eqeqeq":"error"}}];\n');
	const before = '\ufeffvar value = 1;\r\nexport function compare(input) { return input == value; }\r\n';
	await writeFile(join(root, "a.js"), before);
	const checked = await call("diagnostics", { path: "a.js", source: "lint", rule: "no-var" });
	assert.equal(checked.results[0].findings.length, 1); assert.equal(checked.results[0].findings[0].rule, "no-var");
	assert.equal(checked.results[0].findings[0].lint, undefined);
	const listed = await call("actions", { operation: "list", path: "a.js", source: "lint" });
	const fix = listed.items.find(item => item.rule === "no-var"); assert(fix); assert.equal(fix.applicability, "unknown");
	const batch = await call("actions", { operation: "preview", path: "a.js", source: "lint" }); assert.equal(batch.status, "unchanged");
	const preview = await call("actions", { operation: "preview", ids: [fix.id] });
	assert.equal(await readFile(join(root, "a.js"), "utf8"), before);
	await call("apply", { plan: preview.plan }); assert.match(await readFile(join(root, "a.js"), "utf8"), /^\ufefflet value/);
	assert((await client.call("apply", { plan: preview.plan })).isError);
	const explanation = await call("actions", { operation: "explain", path: "a.js", rule: "eqeqeq" }); assert(explanation.effective);
	for (const name of ["check_project", "check_diagnostics", "lsp_navigation", "lsp_rename", "lsp_format", "lsp_status"]) assert.match((await client.call(name)).content[0].text, /Migration required/);
});
test("real Biome: safe file fixes stay separate from unsafe fixes and formatting", { timeout: 30000 }, async t => {
	const { root, call } = await fixture(t);
	await writeFile(join(root, "biome.json"), JSON.stringify({ linter: { rules: { recommended: true, style: { useConst: "error" } } } }));
	const before = "let value=1;\nexport {value};\ndebugger;\n"; await writeFile(join(root, "a.js"), before);
	const listed = await call("actions", { path: "a.js", operation: "list", source: "lint" });
	assert(listed.items.some(item => item.applicability === "safe"));
	const preview = await call("actions", { path: "a.js", operation: "preview", source: "lint" });
	assert.equal(await readFile(join(root, "a.js"), "utf8"), before);
	await call("apply", { plan: preview.plan });
	const after = await readFile(join(root, "a.js"), "utf8"); assert.match(after, /const value=1/); assert.match(after, /debugger/);
	const format = await call("format", { path: "a.js" }); assert.equal(await readFile(join(root, "a.js"), "utf8"), after);
	await call("apply", { plan: format.plan }); assert.notEqual(await readFile(join(root, "a.js"), "utf8"), after);
	await mkdir(join(root, "nested"));
	await writeFile(join(root, "nested", "biome.json"), JSON.stringify({ root: false, linter: { rules: { recommended: false, style: { useConst: "error" } } } }));
	await writeFile(join(root, "nested", "b.js"), "let nested=1;\nexport {nested};\n");
	const nested = await call("actions", { path: "nested/b.js", operation: "preview", source: "lint", rule: "lint/style/useConst" });
	assert.equal(nested.status, "planned"); await call("apply", { plan: nested.plan });
	assert.match(await readFile(join(root, "nested", "b.js"), "utf8"), /^const nested/);
});
test("delivered apply outcomes remain fully readable after subsequent source changes", { timeout: 45000 }, async t => {
	const { root, client, call } = await fixture(t, { fake: { command: [process.execPath, resolve("test/fixtures/fake-lsp.mjs")], extensions: [".fake"], env: { CODEX_LSP_TEST_MODE: "intelligence" } } });
	const paths = Array.from({ length: 25 }, (_, i) => `${i}.fake`);
	for (const path of paths) await writeFile(join(root, path), "broken\n");
	const preview = await call("format", { paths }); assert.equal(preview.files.length, 25);
	const first = await client.raw("apply", { plan: preview.plan }); assert(first.structuredContent.paged);
	await writeFile(join(root, paths[0]), "subsequent edit\n");
	const output = await completeOutput(first, next => client.raw("apply", next));
	assert(!output.isError, JSON.stringify(output)); assert.equal(output.structuredContent.modifiedPaths.length, 25);
	assert((await client.call("apply", { plan: preview.plan })).isError);
});
test("traditional TypeScript server: symbol selectors, relationships, completion and read-only context", { timeout: 45000 }, async t => {
	const { root, call } = await fixture(t, { typescript: { command: [process.execPath, resolve("node_modules/typescript-language-server/lib/cli.mjs"), "--stdio"], extensions: [".ts"], initialization: { tsserver: { path: resolve("test/fixtures/legacy-typescript/node_modules/typescript/lib/tsserver.js") } } } });
	await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", types: [] }, include: ["*.ts"] }));
	const before = 'export function greet(value: string): string { return value; }\nexport function caller() { return greet("hello"); }\n'; await writeFile(join(root, "a.ts"), before);
	const refs = await call("navigate", { operation: "references", path: "a.ts", symbol: "greet" }); assert.equal(refs.status, "complete"); assert(refs.result.length);
	const incoming = await call("navigate", { operation: "incoming", path: "a.ts", pattern: "function @@greet" }); assert.equal(incoming.status, "complete"); assert(incoming.result.length);
	const completion = await call("navigate", { operation: "completion", path: "a.ts", line: 2, column: 35 }); assert.equal(completion.status, "complete");
	const context = await call("inspect", { operation: "symbol", path: "a.ts", symbol: "greet", source: true }); assert(context.sections.hover); assert.match(context.source, /function greet/);
	const impact = await call("inspect", { operation: "impact", path: "a.ts" }); assert(impact.symbols.length >= 2);
	const focused = await call("inspect", { operation: "impact", path: "a.ts", symbols: ["greet"], transitive: true });
	assert.equal(focused.symbols[0].references.count, refs.result.length);
	assert(focused.symbols[0].callers.items.some(item => item.symbol === "caller"));
	assert(focused.indirect.length);
	assert.equal(await readFile(join(root, "a.ts"), "utf8"), before);
});
test("real Ruff: classified fixes and rule explanation through delivered MCP", { skip: process.env.CODEX_LSP_REAL_TOOLS !== "1", timeout: 30000 }, async t => {
	const { root, call } = await fixture(t);
	await writeFile(join(root, "ruff.toml"), '[lint]\nselect=["F401"]\n');
	const before = '\ufeffimport os\r\nvalue="😀"\r\n'; await writeFile(join(root, "a.py"), before);
	const listed = await call("actions", { operation: "list", source: "lint", path: "a.py" }); assert.equal(listed.items[0].applicability, "safe");
	const preview = await call("actions", { operation: "preview", path: "a.py", source: "lint" });
	assert.equal(await readFile(join(root, "a.py"), "utf8"), before);
	await call("apply", { plan: preview.plan }); assert.equal(await readFile(join(root, "a.py"), "utf8"), '\ufeffvalue="😀"\r\n');
	const explained = await call("actions", { operation: "explain", path: "a.py", rule: "F401" }); assert.match(explained.explanation, /unused-import/i);
});
test("real Go/gopls: diagnostics, calls, selectors, rename/format plans, actions and project checks", { skip: process.env.CODEX_LSP_REAL_TOOLS !== "1", timeout: 60000 }, async t => {
	const { root, client, call } = await fixture(t, { go: "gopls" });
	await writeFile(join(root, "go.mod"), "module example.com/fixture\n\ngo 1.23\n");
	await writeFile(join(root, "value.go"), 'package fixture\nfunc Greet(value string) string { return value }\n');
	await writeFile(join(root, "caller.go"), 'package fixture\nfunc Caller() string {return Greet("hello")}\n');
	const checked = await call("diagnostics", { path: "value.go", source: "lsp" }); assert.equal(checked.results[0].state, "complete");
	const refs = await call("navigate", { path: "value.go", operation: "references", symbol: "Greet" }); assert.equal(refs.status, "complete"); assert(refs.result.length);
	const callers = await call("navigate", { path: "value.go", operation: "incoming", symbol: "Greet" }); assert.equal(callers.status, "complete"); assert(callers.result.length);
	const preview = await call("rename", { path: "value.go", symbol: "Greet", newName: "Welcome" }); assert.match(await readFile(join(root, "caller.go"), "utf8"), /Greet/);
	await call("apply", { plan: preview.plan }); assert.match(await readFile(join(root, "caller.go"), "utf8"), /Welcome/);
	const format = await call("format", { paths: ["value.go", "caller.go"] }); await call("apply", { plan: format.plan });
	const actions = await call("actions", { path: "value.go", operation: "list", source: "lsp" }); assert(["complete", "partial"].includes(actions.status));
	let project = await call("check", { run: "active" });
	for (let i = 0; i < 80 && project.state === "running"; i++) { await new Promise(resolve => setTimeout(resolve, 100)); project = await call("check", { job: project.job, run: "cached" }); }
	assert.equal(project.state, "complete", JSON.stringify(project)); assert(project.checkers.some(check => check.parser === "go"));
	await writeFile(join(root, "value.go"), 'package fixture\nfunc Welcome(value string) int { return value }\n');
	project = await call("check", { run: "active" });
	for (let i = 0; i < 80 && project.state === "running"; i++) { await new Promise(resolve => setTimeout(resolve, 100)); project = await call("check", { job: project.job, run: "cached" }); }
	assert(project.errors > 0, JSON.stringify(project)); assert.equal(project.state, "complete");
	assert(project.diagnostics.every(item => ["value.go", "caller.go"].includes(item.path)), JSON.stringify(project));
	assert(!(await client.call("status", { path: "value.go" })).isError);
});

test("real ty: type diagnostics and previewed Python rename", { skip: process.env.CODEX_LSP_REAL_TOOLS !== "1", timeout: 30000 }, async t => {
	const { root, call } = await fixture(t, { python: "ty" });
	await writeFile(join(root, "pyproject.toml"), '[project]\nname="fixture"\nversion="0.1.0"\nrequires-python=">=3.13"\n');
	await writeFile(join(root, "a.py"), 'def greet(value: str) -> str:\n    return value\n\nresult: str = greet("hello")\n');
	const checked = await call("diagnostics", { path: "a.py", source: "lsp" }); assert.equal(checked.results[0].state, "complete"); assert.equal(checked.errors, 0);
	const preview = await call("rename", { path: "a.py", symbol: "greet", newName: "welcome" }); assert.match(await readFile(join(root, "a.py"), "utf8"), /def greet/);
	await call("apply", { plan: preview.plan }); assert.match(await readFile(join(root, "a.py"), "utf8"), /welcome\("hello"\)/);
	await writeFile(join(root, "a.py"), 'result: int = "wrong"\n');
	const broken = await call("diagnostics", { path: "a.py", source: "lsp" }); assert(broken.errors > 0);
});

for (const extension of ["c", "cpp"]) test(`real clangd: ${extension} navigation and cross-file-safe edit plans`, { skip: process.env.CODEX_LSP_REAL_TOOLS !== "1", timeout: 30000 }, async t => {
	const { root, call } = await fixture(t, { cpp: "clangd" });
	await writeFile(join(root, "compile_flags.txt"), extension === "c" ? "-xc\n-std=c17\n" : "-xc++\n-std=c++17\n");
	const path = `a.${extension}`;
	const before = "int twice(int value) { return value * 2; }\nint caller(void) { return twice(2); }\n";
	await writeFile(join(root, path), before);
	const checked = await call("diagnostics", { path, source: "lsp" }); assert.equal(checked.results[0].state, "complete"); assert.equal(checked.errors, 0);
	const refs = await call("navigate", { path, operation: "references", symbol: "twice" }); assert.equal(refs.status, "complete"); assert(refs.result.length);
	const preview = await call("rename", { path, symbol: "twice", newName: "double_value" }); assert.equal(await readFile(join(root, path), "utf8"), before);
	await call("apply", { plan: preview.plan }); assert.match(await readFile(join(root, path), "utf8"), /double_value\(2\)/);
});
