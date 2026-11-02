import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { bundleClient } from "./bundle-client.mjs";
import { navigationArray } from "./protocol.mjs";

// Real-tool acceptance is opt-in. Once enabled, an unavailable server,
// MATLAB installation or license must fail the suite.
const enabled = process.env["REAL_TOOLS"] === "1";
async function localTools() {
	let server = process.env["CODEX_LSP_MATLAB_SERVER"];
	if (!server) {
		const extensions = join(homedir(), ".vscode", "extensions");
		const installed = (await readdir(extensions).catch(() => []))
			.filter((name) => /^mathworks\.language-matlab-\d/.test(name))
			.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
		for (const name of installed) {
			const candidate = join(extensions, name, "server", "out", "index.js");
			if ((await stat(candidate).catch(() => undefined))?.isFile()) { server = candidate; break; }
		}
	}
	assert(server, "Set CODEX_LSP_MATLAB_SERVER to MathWorks MATLAB-language-server's out/index.js, or install the MATLAB VS Code extension");
	server = await realpath(server);
	let installPath = process.env["CODEX_LSP_MATLAB_INSTALL_PATH"];
	if (!installPath) {
		const found = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["matlab"], {
			encoding: "utf8", windowsHide: true, timeout: 10000,
		});
		const executable = found.stdout?.trim().split(/\r?\n/)[0];
		assert.equal(found.status, 0, "Put MATLAB on PATH or set CODEX_LSP_MATLAB_INSTALL_PATH to the MATLAB installation root");
		assert(executable);
		installPath = dirname(dirname(await realpath(executable)));
	}
	installPath = await realpath(installPath);
	const executable = join(installPath, "bin", process.platform === "win32" ? "matlab.exe" : "matlab");
	assert((await stat(executable)).isFile(), `MATLAB executable not found: ${executable}`);
	const version = JSON.parse(await readFile(join(dirname(server), "..", "package.json"), "utf8"));
	return { server, installPath, version: String(version.version) };
}

const source = "function result = codeintel_fixture(value)\nif value>0\nresult=twice(value);\nelse\nresult=0;\nend\nend\n\nfunction result = twice(value)\nresult=value*2;\nend\n";
/** @type {[string, string]} */ const paths = ["codeintel_fixture.m", "broken.m"];
const local = (/** @type {string} */ path) => path.replaceAll("\\", "/");

test("real MATLAB LSP through the delivered MCP bundle", { skip: !enabled, timeout: 240000 }, async (t) => {
	const tools = await localTools();
	t.diagnostic(`Node ${process.version}; MATLAB ${tools.installPath}; MATLAB-language-server ${tools.version}`);
	const dir = await realpath(await mkdtemp(join(tmpdir(), "codeintel-matlab-")));
	const root = join(dir, "project"), home = join(dir, "home");
	/** @type {Record<string, unknown>[]} */ const trace = [];
	/** @type {ReturnType<typeof bundleClient> | undefined} */ let client;
	t.after(async () => {
		try {
			const artifacts = process.env["CODEX_LSP_MATLAB_ARTIFACTS"];
			if (artifacts) {
				await mkdir(artifacts, { recursive: true });
				const sources = Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await readFile(join(root, path), "utf8").catch(() => null)])));
				await writeFile(join(artifacts, "matlab.json"), JSON.stringify({ platform: process.platform, node: process.version, tools, trace, sources }, null, 2));
			}
		} finally {
			try { await client?.close(); }
			finally {
				assert.equal(dirname(dir), await realpath(tmpdir()));
				assert(basename(dir).startsWith("codeintel-matlab-"));
				await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		}
	});
	await mkdir(root); await mkdir(home);
	await writeFile(join(root, paths[0]), source.replace("result=value*2;", "result=;"));
	await writeFile(join(root, paths[1]), "function result = broken(value)\nresult = ;\nend\n");
	await writeFile(join(home, "lsp-client.json"), JSON.stringify({
		schemaVersion: 1,
		automaticDiagnostics: { postToolUse: "off", stop: "off" },
		lint: { javascript: "off", python: "off" },
		lsp: { typescript: false, python: false, matlab: {
			command: [process.execPath, tools.server, "--stdio"],
			extensions: [".m"],
			languageId: "matlab",
			settings: { MATLAB: {
				installPath: tools.installPath, matlabConnectionTiming: "onStart",
				indexWorkspace: false, telemetry: false, maxFileSizeForAnalysis: 0, signIn: false,
			} },
		} },
	}));
	client = bundleClient(root, home, { CODEX_LSP_CACHE: join(dir, "cache") });
	/** @template {string} N @param {N} name @param {import("./protocol-types.js").Arguments} [args] */
	const raw = async (name, args = {}) => {
		const output = await client.full(name, args);
		trace.push({ name, args, output });
		return output;
	};
	/** @template {string} N @param {N} name @param {import("./protocol-types.js").Arguments} [args] */
	const call = async (name, args = {}) => {
		const output = await raw(name, args);
		assert(!output.isError, JSON.stringify(output));
		return output.structuredContent;
	};
	const hashes = async () => Object.fromEntries(await Promise.all(paths.map(async (path) => [path, createHash("sha256").update(await readFile(join(root, path))).digest("hex")])));
	const diagnostics = async (/** @type {string} */ path) => {
		const deadline = Date.now() + 90000;
		do {
			const output = await call("diagnostics", { path, source: "lsp" });
			if (output.results.length && output.results.every((result) => result.state === "complete")) return output;
			assert(output.results.length && output.results.every((result) => result.state === "pending"), JSON.stringify(output));
			await delay(250);
		} while (Date.now() < deadline);
		assert.fail("MATLAB did not publish complete diagnostics; check the local installation and license");
	};
	await t.test("passive status, startup, located diagnostics and repair", async () => {
		const before = await hashes();
		const status = await call("status", { path: paths[0] });
		assert.equal(status.configuration.valid, true);
		assert.equal(status.tools[0]?.language, "matlab");
		assert.equal(status.tools[0]?.running, false, "status must not launch MATLAB");
		const warmed = await call("warmup", { path: paths[0] });
		assert.equal(warmed.status, "complete", JSON.stringify(warmed));
		// MATLAB publishes unversioned diagnostics, including provisional empty
		// reports during startup. Establish analysis evidence with a real error
		// before asserting that the repaired document is clean.
		assert((await diagnostics(paths[0])).errors > 0);
		const broken = await diagnostics(paths[1]);
		assert(broken.errors > 0, JSON.stringify(broken));
		assert(broken.results[0]?.findings.some((item) => item.severity === "error" && item.line === 2));
		assert.deepEqual(await hashes(), before, "analysis must preserve MATLAB source files");
		await writeFile(join(root, paths[0]), source);
		await writeFile(join(root, paths[1]), "function result = broken(value)\nresult = value;\nend\n");
		assert.equal((await diagnostics(paths[0])).errors, 0);
		assert.equal((await diagnostics(paths[1])).errors, 0, "repairs must clear stale diagnostics");
	});
	await t.test("symbols, anchored definition, references and completion", async () => {
		const before = await hashes();
		const symbols = await call("navigate", { operation: "symbols", path: paths[0] });
		assert.equal(symbols.status, "complete");
		assert(navigationArray(symbols.result).some((item) => item.symbol === "twice"));
		const definition = await call("navigate", { operation: "definition", path: paths[0], pattern: "result=@@twice(value)" });
		assert.equal(definition.status, "complete");
		assert(navigationArray(definition.result).some((item) => local(item.path ?? "") === paths[0]));
		const references = await call("navigate", { operation: "references", path: paths[0], pattern: "result=@@value*2" });
		assert.equal(references.status, "complete");
		assert(navigationArray(references.result).length >= 2, JSON.stringify(references));
		const completion = await call("navigate", { operation: "completion", path: paths[0], pattern: "result=@@twice(value)" });
		assert.equal(completion.status, "complete");
		assert(navigationArray(completion.result).some((item) => item.label?.startsWith("twice")), JSON.stringify(completion));
		const unsupported = await call("navigate", { operation: "incoming", path: paths[0], symbol: "twice" });
		assert.equal(unsupported.status, "unsupported", "unadvertised call hierarchy must stay explicit");
		assert.deepEqual(await hashes(), before);
	});
	await t.test("rename and formatting previews, single-use apply and stale plans", async () => {
		let before = await hashes();
		const rename = await call("rename", { path: paths[0], pattern: "result=@@value*2", newName: "input_value" });
		assert.equal(rename.status, "planned", JSON.stringify(rename));
		assert.deepEqual(await hashes(), before);
		const renamed = await call("apply", { plan: rename.plan });
		assert.deepEqual(renamed.modifiedPaths.map(local), [paths[0]]);
		assert.match(await readFile(join(root, paths[0]), "utf8"), /twice\(input_value\)/);
		assert.match(await readFile(join(root, paths[0]), "utf8"), /result=input_value\*2/);
		assert((await raw("apply", { plan: rename.plan })).isError);
		const stale = await call("format", { path: paths[0] });
		assert.equal(stale.status, "planned", JSON.stringify(stale));
		await writeFile(join(root, paths[1]), (await readFile(join(root, paths[1]), "utf8")) + "\n");
		before = await hashes();
		const conflict = await raw("apply", { plan: stale.plan });
		assert(conflict.isError);
		assert.equal(conflict.structuredContent.status, "conflict");
		assert.deepEqual(conflict.structuredContent.modifiedPaths, []);
		assert.deepEqual(await hashes(), before);
		const format = await call("format", { path: paths[0] });
		assert.equal(format.status, "planned");
		assert.deepEqual(await hashes(), before);
		await call("apply", { plan: format.plan });
		assert.match(await readFile(join(root, paths[0]), "utf8"), /\n[\t ]+result=twice\(value\);/);
		assert.equal((await diagnostics(paths[0])).errors, 0);
	});
});
