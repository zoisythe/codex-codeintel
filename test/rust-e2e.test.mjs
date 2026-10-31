import { navigationArray } from "./protocol.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { bundleClient } from "./bundle-client.mjs";

// This file is an explicit real-tool suite, separate from npm test. Missing tools
// fail acceptance instead of silently turning the dedicated CI job into a skip.
const files = ["core/src/lib.rs", "app/src/lib.rs", "app/tests/usage.rs", "Cargo.lock"];
const library = "/// Return twice the supplied value.\npub fn twice(value:i32)->i32{value*2}\n";
const application = "pub fn caller() -> i32 {\n    codeintel_fixture_core::twice(2)\n}\n";
const usage = "#[test]\nfn uses_twice() {\n    assert_eq!(codeintel_fixture_core::twice(2), 4);\n}\n";
const local = (/** @type {string} */ value) => value.replaceAll("\\", "/");

async function fixture(/** @type {import("node:test").TestContext} */ t, /** @type {string} */ name) {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "codeintel-rust-")));
	const root = join(dir, "project"),
		home = join(dir, "home");
	/** @type {Record<string, unknown>[]} */ const trace = [];
	/** @type {ReturnType<typeof bundleClient> | undefined} */ let client;
	t.after(async () => {
		try {
			if (process.env["CODEX_LSP_RUST_ARTIFACTS"]) {
				const output = resolve(process.env["CODEX_LSP_RUST_ARTIFACTS"]);
				await mkdir(output, { recursive: true });
				const sources = Object.fromEntries(
					await Promise.all(
						files.map(async (path) => [path, await readFile(join(root, path), "utf8").catch(() => null)]),
					),
				);
				await writeFile(
					join(output, `${name}.json`),
					JSON.stringify({ platform: process.platform, node: process.version, trace, sources }, null, 2),
				);
			}
		} finally {
			try {
				await client?.close();
			} finally {
				assert.equal(dirname(dir), await realpath(tmpdir()));
				assert(basename(dir).startsWith("codeintel-rust-"));
				await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		}
	});
	await mkdir(home);
	await mkdir(join(root, "core", "src"), { recursive: true });
	await mkdir(join(root, "app", "src"), { recursive: true });
	await mkdir(join(root, "app", "tests"));
	await writeFile(join(root, "Cargo.toml"), '[workspace]\nmembers=["core","app"]\nresolver="2"\n');
	await writeFile(
		join(root, "core", "Cargo.toml"),
		'[package]\nname="codeintel_fixture_core"\nversion="0.0.0"\nedition="2021"\n',
	);
	await writeFile(
		join(root, "app", "Cargo.toml"),
		'[package]\nname="codeintel_fixture_app"\nversion="0.0.0"\nedition="2021"\n[dependencies]\ncodeintel_fixture_core={path="../core"}\n',
	);
	await writeFile(join(root, "core", "src", "lib.rs"), library);
	await writeFile(join(root, "app", "src", "lib.rs"), application);
	await writeFile(join(root, "app", "tests", "usage.rs"), usage);
	const environment = { ...process.env, CARGO_NET_OFFLINE: "true", RUSTUP_AUTO_INSTALL: "0" };
	// Prepare the lockfile before creating any analysis snapshot. Only path
	// dependencies are used, so checking never needs the registry or a download.
	const lock = spawnSync("cargo", ["generate-lockfile", "--offline"], {
		cwd: root,
		env: environment,
		encoding: "utf8",
		windowsHide: true,
		timeout: 60000,
	});
	trace.push({
		command: ["cargo", "generate-lockfile", "--offline"],
		code: lock.status,
		stdout: lock.stdout,
		stderr: lock.stderr,
		error: lock.error?.message,
	});
	assert.equal(lock.status, 0, lock.error?.message ?? lock.stderr);
	await writeFile(
		join(home, "lsp-client.json"),
		JSON.stringify({
			schemaVersion: 1,
			automaticDiagnostics: { postToolUse: "off", stop: "off" },
			lint: { javascript: "off", python: "off" },
			lsp: {
				typescript: false,
				python: false,
				rust: {
					command: ["rust-analyzer"],
					extensions: [".rs"],
					initialization: {
						numThreads: 4,
						cargo: { buildScripts: { enable: false }, metadataExtraArgs: ["--locked"] },
						check: { extraArgs: ["--locked"] },
						procMacro: { enable: false },
					},
				},
			},
		}),
	);
	client = bundleClient(root, home, { ...environment, CODEX_LSP_CACHE: join(dir, "cache") });
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
	const hashes = async () =>
		Object.fromEntries(
			await Promise.all(
				files.map(async (path) => [
					path,
					createHash("sha256")
						.update(await readFile(join(root, path)))
						.digest("hex"),
				]),
			),
		);
	const diagnostics = async (/** @type {string} */ path) => {
		for (let attempt = 0; attempt < 4; attempt++) {
			const output = await call("diagnostics", { path, source: "lsp" });
			if (output.results.every((result) => result.state === "complete")) return output;
			assert(
				output.results.every((result) => result.state === "pending"),
				JSON.stringify(output),
			);
			await delay(250);
		}
		assert.fail("Rust diagnostics remained pending");
	};
	const check = async () => {
		let output = await call("check", { run: "active" });
		const deadline = Date.now() + 90000;
		while (output.state === "running" && Date.now() < deadline) {
			await delay(200);
			output = await call("check", { run: "cached", job: output.job });
		}
		assert.equal(output.state, "complete", JSON.stringify(output));
		assert(
			output.checkers.some((checker) => checker.parser === "cargo" && checker.state === "complete"),
			JSON.stringify(output),
		);
		return output;
	};
	return { root, call, raw, hashes, diagnostics, check };
}

test("real Rust: diagnostics, selectors, navigation, context and candidate test impact", {
	timeout: 240000,
}, async (t) => {
	const f = await fixture(t, "navigation");
	const before = await f.hashes();
	const initial = await f.call("status", { path: "core/src/lib.rs" });
	assert.equal(initial.tools[0]?.running, false, "status must not launch rust-analyzer");
	assert.equal((await f.diagnostics("app/src/lib.rs")).errors, 0);
	const symbols = await f.call("navigate", { operation: "symbols", path: "core/src/lib.rs" });
	assert.equal(symbols.status, "complete");
	assert(navigationArray(symbols.result).some((item) => item.symbol === "twice"));
	const definition = await f.call("navigate", {
		operation: "definition",
		path: "app/src/lib.rs",
		pattern: "codeintel_fixture_core::@@twice",
	});
	assert.equal(definition.status, "complete");
	assert(navigationArray(definition.result).some((item) => local(item.path ?? "") === "core/src/lib.rs"));
	const refs = await f.call("navigate", { operation: "references", path: "core/src/lib.rs", symbol: "twice" });
	assert.equal(refs.status, "complete");
	assert(navigationArray(refs.result).some((item) => local(item.path ?? "") === "app/src/lib.rs"));
	const incoming = await f.call("navigate", { operation: "incoming", path: "core/src/lib.rs", symbol: "twice" });
	assert.equal(incoming.status, "complete");
	assert(navigationArray(incoming.result).some((item) => local(item.from?.path ?? "") === "app/src/lib.rs"));
	const completion = await f.call("navigate", {
		operation: "completion",
		path: "app/src/lib.rs",
		pattern: "codeintel_fixture_core::@@twice",
	});
	assert.equal(completion.status, "complete");
	assert(navigationArray(completion.result).some((item) => /^twice\b/.test(item.label ?? "")));
	const context = await f.call("inspect", {
		operation: "symbol",
		path: "core/src/lib.rs",
		symbol: "twice",
		source: true,
	});
	assert.equal(context.sections.hover?.status, "complete");
	assert(context.sections.hover?.result.contents);
	assert.equal(context.sections.references?.count, navigationArray(refs.result).length);
	assert.match(context.source ?? "", /pub fn twice/);
	const impact = await f.call("inspect", {
		operation: "impact",
		path: "core/src/lib.rs",
		symbols: ["twice"],
		transitive: true,
	});
	assert.equal(impact.status, "complete", JSON.stringify(impact));
	assert.equal(impact.symbols[0]?.references.count, navigationArray(refs.result).length);
	assert(impact.symbols[0]?.callers.items.some((item) => item.symbol.includes("caller")));
	assert(impact.symbols[0]?.candidateTests.paths.some((/** @type {string} */ path) => local(path) === "app/tests/usage.rs"));
	assert(impact.indirect.length);
	assert.deepEqual(await f.hashes(), before, "Read-only tools must preserve Rust sources and Cargo.lock");
	await writeFile(join(f.root, "app/src/lib.rs"), 'pub fn caller() -> i32 { "wrong" }\n');
	assert((await f.diagnostics("app/src/lib.rs")).errors > 0, "real compiler errors must be reported");
	await writeFile(join(f.root, "app/src/lib.rs"), application);
	assert.equal((await f.diagnostics("app/src/lib.rs")).errors, 0, "repairs must clear stale diagnostics");
});

test("real Rust: rename, rustfmt and Code Action plans write only through apply", { timeout: 240000 }, async (t) => {
	const f = await fixture(t, "plans");
	assert.equal((await f.diagnostics("core/src/lib.rs")).errors, 0);
	let before = await f.hashes();
	const rename = await f.call("rename", { path: "core/src/lib.rs", symbol: "twice", newName: "double_value" });
	assert.equal(rename.status, "planned");
	assert.deepEqual(await f.hashes(), before);
	assert.deepEqual(rename.files.map(local).sort(), files.filter((path) => path.endsWith(".rs")).sort());
	const applied = await f.call("apply", { plan: rename.plan });
	assert.deepEqual(applied.modifiedPaths.map(local).sort(), rename.files.map(local).sort());
	assert.match(await readFile(join(f.root, "app/src/lib.rs"), "utf8"), /::double_value\(2\)/);
	assert((await f.raw("apply", { plan: rename.plan })).isError, "consumed rename plans cannot replay");
	const stale = await f.call("format", { path: "core/src/lib.rs" });
	assert.equal(stale.status, "planned");
	await writeFile(join(f.root, "app/src/lib.rs"), (await readFile(join(f.root, "app/src/lib.rs"), "utf8")) + "\n");
	before = await f.hashes();
	const conflict = await f.raw("apply", { plan: stale.plan });
	assert(conflict.isError);
	assert.equal(conflict.structuredContent.status, "conflict");
	assert.match(conflict.structuredContent.reason ?? "", /Plan stale/);
	assert.deepEqual(conflict.structuredContent.modifiedPaths, []);
	assert.deepEqual(await f.hashes(), before);
	const format = await f.call("format", { paths: files.filter((path) => path.endsWith(".rs")) });
	assert.equal(format.status, "planned");
	assert.deepEqual(await f.hashes(), before);
	await f.call("apply", { plan: format.plan });
	assert.match(await readFile(join(f.root, "core/src/lib.rs"), "utf8"), /\n    value \* 2\n/);
	await writeFile(
		join(f.root, "core/src/lib.rs"),
		(await readFile(join(f.root, "core/src/lib.rs"), "utf8")) +
			"\npub fn action_target() -> i32 {\n    let mut value = 1;\n    value\n}\n",
	);
	assert.equal((await f.diagnostics("core/src/lib.rs")).errors, 0);
	before = await f.hashes();
	const actions = await f.call("actions", {
		operation: "list",
		source: "lsp",
		path: "core/src/lib.rs",
		pattern: "let @@mut value",
	});
	assert.equal(actions.status, "complete", JSON.stringify(actions));
	const action = actions.items.find(
		(item) => item.status !== "unsupported" && /remove.*mut|mut.*remove|make.*immutable/i.test(item.title),
	);
	assert(action, JSON.stringify(actions));
	assert.equal(action.applicability, "unknown");
	const preview = await f.call("actions", { operation: "preview", ids: [action.id] });
	assert.equal(preview.status, "planned");
	assert.deepEqual(await f.hashes(), before);
	await f.call("apply", { plan: preview.plan });
	assert.doesNotMatch(await readFile(join(f.root, "core/src/lib.rs"), "utf8"), /let mut value/);
	assert.equal((await f.check()).errors, 0);
});

test("real Rust: Cargo workspace checks report and clear located compiler failures", { timeout: 180000 }, async (t) => {
	const f = await fixture(t, "checks");
	assert.equal((await f.check()).errors, 0);
	await writeFile(join(f.root, "app/src/lib.rs"), 'pub fn caller() -> i32 { "wrong" }\n');
	const broken = await f.check();
	assert(broken.errors > 0, JSON.stringify(broken));
	assert(broken.diagnostics.some((item) => local(item.path ?? "") === "app/src/lib.rs" && item.severity === "error"));
	await writeFile(join(f.root, "app/src/lib.rs"), application);
	assert.equal((await f.check()).errors, 0);
});
