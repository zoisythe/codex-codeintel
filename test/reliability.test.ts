import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { configuration } from "../src/config.js";
import { Engine as ProductionEngine } from "../src/engine.js";
import { inventory } from "../src/files.js";
import { HookEngine as ProductionHook } from "../src/hook-engine.js";
import { Metadata } from "../src/metadata.js";
import { lint, run } from "../src/runners.js";
import { Engine, HookEngine } from "./engine-harness.js";

const temps: string[] = [];
const signal = () => new AbortController().signal;
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "codex-reliable-"));
	temps.push(dir);
	const root = join(dir, "project");
	const home = join(dir, "home");
	await mkdir(root);
	await mkdir(home);
	await mkdir(join(root, ".codex"));
	const user = join(home, "lsp-client.json");
	const project = join(root, ".codex", "lsp-client.json");
	vi.stubEnv("CODEX_HOME", home);

	vi.stubEnv("CODEX_LSP_CACHE", join(dir, "cache"));

	await writeFile(join(home, "config.toml"), `[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n`);
	await writeFile(
		user,
		JSON.stringify({ schemaVersion: 1, automaticDiagnostics: { postToolUse: "delta", stop: "errors" } }),
	);
	await writeFile(join(root, "a.js"), "export const a=1;");
	return { dir, root, user, project };
}
it("merges lint fields and replaces exclude without directory trust", async () => {
	const { root, user, project } = await fixture();
	await writeFile(
		user,
		JSON.stringify({
			schemaVersion: 1,
			lint: { javascript: "off", python: "ruff" },
			exclude: ["old/**"],
		}),
	);
	await writeFile(project, JSON.stringify({ schemaVersion: 1, lint: { javascript: "eslint" }, exclude: ["new/**"] }));
	expect(await configuration(root)).toMatchObject({ javascript: "eslint", python: "ruff", exclude: ["new/**"] });
	await writeFile(user, JSON.stringify({ schemaVersion: 1, lint: { javascript: "off" }, exclude: ["user/**"] }));
	await writeFile(join(process.env["CODEX_HOME"] ?? "", "config.toml"), "");
	await writeFile(
		project,
		JSON.stringify({
			schemaVersion: 1,
			trustedWorkspaces: [root],
			lint: { javascript: "biome" },
			exclude: ["project/**"],
		}),
	);
	expect(await configuration(root)).toMatchObject({ javascript: "biome", exclude: ["project/**"] });
});
it("explicit Runner selection never falls back and off never runs installed Biome", async () => {
	const { root, project } = await fixture();
	await symlink(
		resolve("node_modules"),
		join(root, "node_modules"),
		process.platform === "win32" ? "junction" : "dir",
	);
	await writeFile(join(root, "biome.json"), "{}");
	await writeFile(project, JSON.stringify({ schemaVersion: 1, lint: { javascript: "off" } }));
	expect((await lint(root, "a.js", signal()))?.state).toBe("skipped");
	await writeFile(project, JSON.stringify({ schemaVersion: 1, lint: { javascript: "eslint" } }));
	expect((await lint(root, "a.js", signal()))?.note).toContain("eslint: matching project configuration missing");
	await writeFile(project, JSON.stringify({ schemaVersion: 1, lint: { javascript: "auto" } }));
	expect((await lint(root, "a.js", signal()))?.state).toBe("complete");
	const missing = await fixture();
	await writeFile(join(missing.root, "biome.json"), "{}");
	await writeFile(
		missing.user,
		JSON.stringify({
			schemaVersion: 1,
			lsp: { typescript: { command: [process.execPath], extensions: [".js"] } },
		}),
	);
	vi.stubEnv("PATH", "");
	expect((await lint(missing.root, "a.js", signal()))?.state).toBe("failed");
});
it("excludes directory discovery but permits explicit files and invalidates direct excluded tool config", {
	timeout: 15000,
}, async () => {
	const { root, project } = await fixture();
	await writeFile(project, JSON.stringify({ schemaVersion: 1, exclude: ["a.js", "biome.json"] }));
	await writeFile(join(root, "biome.json"), "{}");
	let count = 0;
	const engine = new Engine(root, async (path) => {
		count++;
		return { path, state: "complete", findings: [] };
	});
	expect((await inventory(root, 10000, signal(), (await configuration(root)).exclude)).files.has("a.js")).toBe(false);
	const args = { path: "a.js", scope: "paths", session: "s" };
	await engine.dispatch("check_diagnostics", args, signal());
	await engine.dispatch("check_diagnostics", args, signal());
	expect(count).toBe(1);
	await writeFile(join(root, "biome.json"), '{"linter":{"enabled":false}}');
	await engine.dispatch("check_diagnostics", args, signal());
	expect(count).toBe(2);
	await engine.dispatch("check_diagnostics", { ...args, refresh: true }, signal());
	expect(count).toBe(3);
	await engine.close();
});
it("keeps pending on timeout and checks it on the next PostToolUse", async () => {
	const { root } = await fixture();
	let slow = true;
	const cancellation = new AbortController();
	const hook = new HookEngine(root, async (path, abort) => {
		if (slow) {
			setTimeout(() => cancellation.abort(), 50);
			await new Promise<void>((resolve) => abort.addEventListener("abort", () => resolve(), { once: true }));
		}
		return { path, state: "complete", findings: [] };
	});
	await hook.hook({ session_id: "s", hook_event_name: "SessionStart" }, signal());
	await writeFile(join(root, "a.js"), "changed");
	await expect(hook.hook({ session_id: "s" }, cancellation.signal)).rejects.toThrow();
	expect((await new Metadata(root).read("s")).pending).toContain("a.js");
	slow = false;
	await hook.hook({ session_id: "s" }, signal());
	expect((await new Metadata(root).read("s")).pending).toEqual([]);
});
it("does not commit old findings after a concurrent newer Hook or file edit", async () => {
	const { root } = await fixture();
	let release: () => void = () => undefined;
	let started: () => void = () => undefined;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	const hook = new HookEngine(root, async (path) => {
		started();
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return {
			path,
			state: "complete",
			findings: [{ path, line: 1, column: 1, severity: "error", source: "fake", message: "old finding" }],
		};
	});
	await hook.hook({ session_id: "s", hook_event_name: "SessionStart" }, signal());
	await writeFile(join(root, "a.js"), "first");
	const old = hook.hook({ session_id: "s" }, signal());
	await ready;
	await writeFile(join(root, "a.js"), "second");
	await new HookEngine(root, async (path) => ({ path, state: "complete", findings: [] })).hook(
		{ session_id: "s" },
		signal(),
	);
	release();
	expect(await old).not.toContain("old finding");
	expect((await new Metadata(root).read("s")).pending).toEqual([]);
});
it("cancels a queued request promptly without executing it or cancelling the active request", async () => {
	const { root } = await fixture();
	let release: () => void = () => undefined;
	let started: () => void = () => undefined;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	let calls = 0;
	const engine = new Engine(root, async (path) => {
		calls++;
		started();
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return { path, state: "complete", findings: [] };
	});
	const args = { path: "a.js", scope: "paths", session: "s" };
	const first = engine.dispatch("check_diagnostics", args, signal());
	await ready;
	const controller = new AbortController();
	const second = engine.dispatch("check_diagnostics", args, controller.signal);
	controller.abort();
	await expect(second).rejects.toThrow("cancelled");
	release();
	await first;
	expect(calls).toBe(1);
	await engine.dispose();
});
it("kills a slow Runner before resolving cancellation", async () => {
	const { root, dir } = await fixture();
	const pidFile = join(dir, "runner.pid");
	const task = run(
		process.execPath,
		[
			"-e",
			'require("node:fs").writeFileSync(process.argv[1], String(process.pid));setInterval(()=>{},1000)',
			pidFile,
		],
		root,
		AbortSignal.timeout(250),
	);
	await expect(task).rejects.toThrow("cancelled");
	const pid = Number(await readFile(pidFile, "utf8"));
	expect(() => process.kill(pid, 0)).toThrow();
});
it("keeps baseline when discovery is aborted", async () => {
	const { root } = await fixture();
	const store = new Metadata(root);
	const hook = new HookEngine(root);
	await hook.hook({ session_id: "s", hook_event_name: "SessionStart" }, signal());
	const before = await store.read("s");
	await writeFile(join(root, "a.js"), "changed");
	await expect(hook.hook({ session_id: "s" }, AbortSignal.abort())).rejects.toThrow();
	expect((await store.read("s")).baseline).toEqual(before.baseline);
});
it("checks a small scope in a repository over 10000 files without reusing unverified dependencies", {
	timeout: 30000,
}, async () => {
	const { root } = await fixture();
	await promisify(execFile)("git", ["init", "-q"], { cwd: root });
	await mkdir(join(root, "many"));
	await mkdir(join(root, "small"));
	for (let i = 0; i < 10100; i += 100)
		await Promise.all(Array.from({ length: 100 }, (_, j) => writeFile(join(root, "many", `${i + j}.txt`), "x")));
	await writeFile(join(root, "small", "only.js"), "export {};");
	let calls = 0;
	const engine = new Engine(root, async (path) => {
		calls++;
		return { path, state: "complete", findings: [] };
	});
	const args = { scope: "paths", path: "small", session: "s" };
	const result = await engine.dispatch("check_diagnostics", args, signal());
	expect(result).toContain("checked=1");
	expect(result).toContain("dependency freshness unverified");
	await engine.dispatch("check_diagnostics", args, signal());
	expect(calls).toBe(2);
	await engine.close();
});
it.each(["add", "delete", "modify", "configuration"])("rejects old revision after %s", async (change) => {
	const { root, project } = await fixture();
	const engine = new Engine(root, async (path) => ({ path, state: "complete", findings: [] }));
	await Promise.all(Array.from({ length: 60 }, (_, i) => writeFile(join(root, `page${i}.js`), "x")));
	const args = { scope: "paths", paths: Array.from({ length: 60 }, (_, i) => `page${i}.js`), session: "s" };
	const first = await engine.dispatch("check_diagnostics", args, signal());
	const cursor = (JSON.parse(first) as { next: { cursor: string } }).next.cursor;
	if (change === "add") await writeFile(join(root, "b.js"), "new");
	else if (change === "delete") await rm(join(root, "a.js"));
	else if (change === "modify") await writeFile(join(root, "a.js"), "modified");
	else await writeFile(project, '{"schemaVersion":1,"lint":{"javascript":"off"}}');
	await expect(engine.dispatch("check_diagnostics", { ...args, cursor }, signal())).rejects.toThrow("Cursor");
	await engine.close();
});

it("reports completed MCP writes successfully when follow-up diagnostics fail", async () => {
	const { root, project } = await fixture();
	await writeFile(
		project,
		JSON.stringify({
			schemaVersion: 1,
			lsp: { fake: { command: [process.execPath, resolve("test/fixtures/fake-lsp.mjs")], extensions: [".fake"] } },
		}),
	);
	await writeFile(join(root, "a.fake"), "clean text\n");
	const engine = new ProductionEngine(root, {
		checkBatch: async () => {
			throw new Error("follow-up checker unavailable");
		},
	});
	try {
		const output = await engine.dispatch("lsp_format", { path: "a.fake" }, signal());
		expect(output["modifiedPaths"]).toEqual(["a.fake"]);
		expect(output["diagnostics"]).toMatchObject({ state: "unavailable", note: "follow-up checker unavailable" });
		expect(await readFile(join(root, "a.fake"), "utf8")).toContain("fixed!");
	} finally {
		await engine.dispose();
	}
});

it.each(["pending", "stale", "failed"] as const)(
	"does not gate on %s diagnostics even when a project checker confirms an error",
	async (readiness) => {
		const { root, user } = await fixture();
		await writeFile(
			user,
			JSON.stringify({
				schemaVersion: 1,
				automaticDiagnostics: { postToolUse: "delta", stop: "errors" },
				stopGate: "introduced-errors",
			}),
		);
		const store = new Metadata(root);
		const finding = {
			path: "a.js",
			line: 1,
			column: 1,
			severity: "error" as const,
			source: "fake",
			message: "introduced",
		};
		let pending = false;
		const hook = new ProductionHook(root, {
			projects: {
				baseline: async (session) => {
					const reference = await store.shared({ results: [] });
					await store.update(session, signal(), (state) => {
						state.diagnosticBaseline = reference;
					});
					return {
						reference,
						findings: [],
						failures: [],
						pending: [],
						reliable: { "a.js": ["json"] },
						covered: ["a.js"],
					};
				},
				introduced: async () => [finding],
			},
			check: async (_paths, _session, _turn, generation) => ({
				generation,
				results: [{ path: "a.js", state: pending ? readiness : "complete", findings: [finding] }],
				note: "",
			}),
			end: () => undefined,
		});
		await hook.hook({ session_id: "s", hook_event_name: "SessionStart" }, signal());
		await writeFile(join(root, "a.js"), "changed");
		await hook.hook({ session_id: "s", hook_event_name: "PostToolUse" }, signal());
		expect((await store.read("s")).unresolved["a.js"]).toHaveLength(1);
		pending = true;
		expect((await hook.hook({ session_id: "s", hook_event_name: "Stop" }, signal())).kind).not.toBe("block");
		expect((await store.read("s")).blocked).toEqual([]);
	},
);
it("legacy trust-only configuration changes do not invalidate execution identity", async () => {
	const { root, user } = await fixture();
	const before = await configuration(root);
	await writeFile(
		user,
		JSON.stringify({
			schemaVersion: 1,
			automaticDiagnostics: { postToolUse: "delta", stop: "errors" },
			trustedWorkspaces: [root],
			trust: { level: "untrusted" },
		}),
	);
	const after = await configuration(root);
	expect(after.version).toBe(before.version);
	expect(after.issues.filter((issue) => issue.severity === "migration")).toHaveLength(2);
});
