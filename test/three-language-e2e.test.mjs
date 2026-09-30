import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";

// Opt-in actual toolchain acceptance; ordinary bundle tests remain hermetic.
const enabled = process.env.CODEX_LSP_REAL_TOOLS === "1";
test("delivered bundle: Python, C, C++ and Cargo workspace", { skip: !enabled, timeout: 180000 }, async t => {
	const dir = await mkdtemp(join(tmpdir(), "codex-three-"));
	const root = join(dir, "project"), home = join(dir, "home");
	await mkdir(root); await mkdir(home);
	await writeFile(join(home, "config.toml"), `[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n`);
	await writeFile(join(home, "lsp-client.json"), JSON.stringify({ schemaVersion: 1, automaticDiagnostics: { postToolUse: "off", stop: "off" } }));
	const child = spawn(process.execPath, [resolve("dist/cli.js"), "mcp"], { cwd: root, env: { ...process.env, CODEX_HOME: home, CODEX_LSP_CACHE: join(dir, "cache") }, stdio: ["pipe", "pipe", "pipe"] });
	const exit = once(child, "exit");
	let sequence = 0, stderr = "";
	const pending = new Map();
	child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
	createInterface({ input: child.stdout }).on("line", line => { const message = JSON.parse(line); pending.get(message.id)?.(message.result); pending.delete(message.id); });
	t.after(async () => { child.stdin.end(); await exit; await rm(dir, { recursive: true, force: true }); });
	const call = (name, args = {}) => new Promise((resolve, reject) => {
		const id = ++sequence;
		const timer = setTimeout(() => reject(new Error(`Timeout ${name}: ${stderr}`)), 50000);
		pending.set(id, result => { clearTimeout(timer); if (result.isError) reject(new Error(JSON.stringify(result))); else resolve(result); });
		child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { workspace: root, ...args } } }) + "\n");
	});
	const check = async path => {
		for (let i = 0; i < 4; i++) {
			const result = (await call("check_diagnostics", { path, source: "lsp" })).structuredContent;
			if (result.results.every(entry => entry.state === "complete")) return result;
		}
		assert.fail(`Diagnostics never completed: ${path}`);
	};
	const build = (command, args, cwd) => { const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 30000 }); assert.equal(result.status, 0, result.stderr); };
	build("uv", ["venv", "--python", spawnSync("uv", ["python", "find"], { encoding: "utf8" }).stdout.trim(), join(root, ".venv")], root);
	build("uv", ["run", "--no-project", "--no-sync", "--python", join(root, ".venv", "bin", "python"), "python", "-c", "import pathlib,sysconfig; p=pathlib.Path(sysconfig.get_paths()['purelib'])/'localdep'; p.mkdir(); (p/'__init__.py').write_text('number: int = 7\\n')"], root);
	await writeFile(join(root, "dependency.py"), "from localdep import number\nvalue: int = number\n");
	assert.equal((await check("dependency.py")).errors, 0);
	await writeFile(join(root, "lib.py"), "def twice(value: int) -> int:\n    return value * 2\n");
	await writeFile(join(root, "main.py"), 'from lib import twice\nvalue: int = "wrong"\nanswer = twice(2)\n');
	assert((await check("main.py")).errors > 0);
	await writeFile(join(root, "main.py"), "from lib import twice\nvalue: int = 1\nanswer = twice(2)\n");
	assert.equal((await check("main.py")).errors, 0);
	for (const operation of ["definition", "references", "symbols", "hover", "typeDefinition", "implementation", "signatureHelp", "prepare_rename"]) {
		const response = await call("lsp_navigation", { path: operation === "prepare_rename" ? "lib.py" : "main.py", operation, line: operation === "prepare_rename" ? 1 : 3, column: operation === "prepare_rename" ? 6 : operation === "signatureHelp" ? 16 : 12 });
		const navigation = response.structuredContent.result ?? response.structuredContent;
		if (operation === "definition") assert.match(JSON.stringify(navigation), /lib\.py/);
		if (operation === "references") assert.match(JSON.stringify(navigation), /main\.py/);
		if (operation === "symbols") assert(Array.isArray(navigation) && navigation.length > 0);
		if (operation === "hover") assert(navigation.contents);
		if (operation === "typeDefinition") assert.match(JSON.stringify(navigation), /lib\.py/);
		if (operation === "signatureHelp") assert(navigation.signatures?.length > 0);
		if (operation === "prepare_rename") assert(!Array.isArray(navigation), "rename preparation returns a range");
		if (["typeDefinition", "implementation", "signatureHelp"].includes(operation)) t.diagnostic(`ty ${operation}: ${JSON.stringify(navigation)}`);
	}
	await call("lsp_rename", { path: "lib.py", line: 1, column: 6, newName: "double_value" });
	assert.match(await readFile(join(root, "main.py"), "utf8"), /double_value/);
	await writeFile(join(root, "stub.pyi"), "def f( x:int)->int: ...\n");
	await call("lsp_format", { paths: ["main.py", "stub.pyi"] });
	await writeFile(join(root, "lint.py"), "import os\n");
	assert((await call("check_diagnostics", { path: "lint.py", source: "lint" })).structuredContent.results[0].findings.length > 0);
	const ty = spawnSync("which", ["ty"], { encoding: "utf8" }).stdout.trim();
	const ruff = spawnSync("which", ["ruff"], { encoding: "utf8" }).stdout.trim();
	const projectTy = join(root, ".venv", "bin", "ty"), projectRuff = join(root, ".venv", "bin", "ruff");
	await symlink(ty, projectTy); await symlink(ruff, projectRuff);
	for (const expected of [["project", "project"], ["project", "PATH"], ["PATH", "project"]]) {
		const local = (await call("lsp_status", { path: "main.py" })).structuredContent.tools[0];
		assert.equal(local.tool.source, expected[0]); assert.equal(local.lint.source, expected[1]);
		const result = (await call("check_diagnostics", { path: "main.py" })).structuredContent;
		assert.equal(result.errors, 0); assert.equal(result.results[0].channels.lsp, "complete"); assert.equal(result.results[0].channels.lint, "complete");
		if (expected[1] === "project") await rm(projectRuff);
		else { await rm(projectTy); await symlink(ruff, projectRuff); }
	}
	for (const [folder, extension, compiler] of [["c", "c", "clang"], ["cpp", "cpp", "clang++"]]) {
		const project = join(root, folder); await mkdir(project);
		await writeFile(join(project, "value.h"), "#pragma once\nint twice(int value);\n");
		await writeFile(join(project, `value.${extension}`), '#include "value.h"\nint twice(int value){return value*MULTIPLIER;}\n');
		await writeFile(join(project, `main.${extension}`), '#include "value.h"\nint main(){return twice(2)==4 ? 0:1;}\n');
		await writeFile(join(project, ".clang-format"), "BasedOnStyle: LLVM\nIndentWidth: 4\nAllowShortFunctionsOnASingleLine: None\n");
		const files = [`main.${extension}`, `value.${extension}`];
		await writeFile(join(project, "compile_commands.json"), JSON.stringify(files.map(file => ({ directory: project, file: join(project, file), arguments: [compiler, "-DMULTIPLIER=2", "-I", project, "-c", join(project, file)] }))));
		build(compiler, ["-DMULTIPLIER=2", ...files, "-o", "program"], project);
		assert.equal((await check(`${folder}/main.${extension}`)).errors, 0);
		await writeFile(join(project, "value.h"), "#pragma once\n#error changed header\nint twice(int value);\n");
		assert((await check(`${folder}/main.${extension}`)).errors > 0);
		await writeFile(join(project, "value.h"), "#pragma once\nint twice(int value);\n");
		assert.equal((await check(`${folder}/main.${extension}`)).errors, 0);
		const database = JSON.parse(await readFile(join(project, "compile_commands.json"), "utf8"));
		await writeFile(join(project, "compile_commands.json"), JSON.stringify(database.map(entry => ({ ...entry, arguments: entry.arguments.filter(value => value !== "-DMULTIPLIER=2") }))));
		assert((await check(`${folder}/value.${extension}`)).errors > 0);
		await writeFile(join(project, "compile_commands.json"), JSON.stringify(database));
		assert.equal((await check(`${folder}/value.${extension}`)).errors, 0);
		for (const operation of ["definition", "references", "hover", "symbols"]) {
			const navigation = (await call("lsp_navigation", { path: `${folder}/main.${extension}`, operation, line: 2, column: 21 })).structuredContent.result;
			if (operation === "definition") assert.match(JSON.stringify(navigation), /value\./);
			if (operation === "references") assert.match(JSON.stringify(navigation), /main\./);
			if (operation === "hover") assert(navigation.contents);
			if (operation === "symbols") assert(Array.isArray(navigation) && navigation.length > 0);
		}
		await writeFile(join(project, `main.${extension}`), '#include "value.h"\nint main(){return unknown_name;}\n');
		assert((await check(`${folder}/main.${extension}`)).errors > 0);
		await writeFile(join(project, `main.${extension}`), '#include "value.h"\nint main(){return twice(2)==4 ? 0:1;}\n');
		assert.equal((await check(`${folder}/main.${extension}`)).errors, 0);
		await call("lsp_rename", { path: `${folder}/value.h`, line: 2, column: 6, newName: "double_value" });
		await call("lsp_format", { paths: files.map(file => `${folder}/${file}`) });
		assert.match(await readFile(join(project, `value.${extension}`), "utf8"), /double_value/);
		assert.match(await readFile(join(project, `value.${extension}`), "utf8"), /\n    return/);
		build(compiler, ["-DMULTIPLIER=2", ...files, "-o", "program"], project);
	}
	await mkdir(join(root, "fallback")); await writeFile(join(root, "fallback", "main.c"), "int main(void) { return unknown_name; }\n");
	assert((await check("fallback/main.c")).errors > 0, "clangd fallback still runs without a compilation database");
	const rust = join(root, "rust"); await mkdir(join(rust, "core", "src"), { recursive: true }); await mkdir(join(rust, "app", "src"), { recursive: true });
	await writeFile(join(rust, "Cargo.toml"), '[workspace]\nmembers = ["core", "app"]\nresolver = "2"\n');
	await writeFile(join(rust, "rustfmt.toml"), "tab_spaces = 4\n");
	await writeFile(join(rust, "core", "Cargo.toml"), '[package]\nname="example_core"\nversion="0.1.0"\nedition="2021"\n');
	await writeFile(join(rust, "core", "src", "lib.rs"), "pub fn twice(value:i32)->i32{value*2}\n");
	await writeFile(join(rust, "app", "Cargo.toml"), '[package]\nname="example_app"\nversion="0.1.0"\nedition="2021"\n[dependencies]\nexample_core={path="../core"}\n');
	await writeFile(join(rust, "app", "src", "main.rs"), 'fn main(){let value: i32 = "wrong";println!("{}",example_core::twice(value));}\n');
	assert((await check("rust/app/src/main.rs")).errors > 0);
	await writeFile(join(rust, "app", "src", "main.rs"), 'fn main(){let value: i32 = 2;println!("{}",example_core::twice(value));}\n');
	assert.equal((await check("rust/app/src/main.rs")).errors, 0);
	for (const operation of ["definition", "references", "hover", "symbols"]) {
		const navigation = (await call("lsp_navigation", { path: "rust/core/src/lib.rs", operation, line: 1, column: 9 })).structuredContent.result;
		if (operation === "definition") assert.match(JSON.stringify(navigation), /lib\.rs/);
		if (operation === "references") assert.match(JSON.stringify(navigation), /main\.rs/);
		if (operation === "hover") assert(navigation.contents);
		if (operation === "symbols") assert(Array.isArray(navigation) && navigation.length > 0);
	}
	await call("lsp_rename", { path: "rust/core/src/lib.rs", line: 1, column: 9, newName: "double_value" });
	assert.match(await readFile(join(rust, "app", "src", "main.rs"), "utf8"), /double_value/);
	await call("lsp_format", { paths: ["rust/core/src/lib.rs", "rust/app/src/main.rs"] });
	assert.match(await readFile(join(rust, "core", "src", "lib.rs"), "utf8"), /\n    value \* 2/);
	build("cargo", ["check", "--offline", "--workspace"], rust); build("cargo", ["test", "--offline", "--workspace"], rust);
	await writeFile(join(rust, "core", "src", "extra.rs"), "pub const EXTRA: i32 = 1;\n");
	await writeFile(join(rust, "core", "src", "lib.rs"), (await readFile(join(rust, "core", "src", "lib.rs"), "utf8")) + "pub mod extra;\n");
	assert.equal((await check("rust/core/src/lib.rs")).errors, 0);
	await writeFile(join(rust, "Cargo.toml"), (await readFile(join(rust, "Cargo.toml"), "utf8")) + "[workspace.metadata]\nacceptance = true\n");
	assert.equal((await check("rust/core/src/lib.rs")).errors, 0);
	const rustAnalyzer = spawnSync("which", ["rust-analyzer"], { encoding: "utf8" }).stdout.trim();
	await writeFile(join(home, "lsp-client.json"), JSON.stringify({ schemaVersion: 1, automaticDiagnostics: { postToolUse: "off", stop: "off" }, lsp: { rust: { command: [rustAnalyzer], extensions: [".rs"], initialization: { rustfmt: { overrideCommand: [join(dir, "missing-rustfmt")] } } } } }));
	await assert.rejects(call("lsp_format", { path: "rust/core/src/lib.rs" }), /rustfmt|formatting/i);
	const status = (await call("lsp_status", { path: "main.py" })).structuredContent;
	assert.equal(status.tools[0].tool.source, "PATH");
	assert(status.tools[0].tool.command[0].endsWith("/ty"));
	t.diagnostic(JSON.stringify({ platform: process.platform, timings: status.timings }));
});
