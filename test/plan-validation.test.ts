import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { type Config, configuration } from "../src/config.js";
import { plannedFile } from "../src/edit-plans.js";
import { Languages } from "../src/language.js";

const roots: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
	);
});
async function fixture(mode = "pull", real = false) {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "codeintel-validation-")));
	roots.push(dir);
	const root = join(dir, "project"),
		home = join(dir, "home");
	await mkdir(root);
	await mkdir(home);
	vi.stubEnv("CODEX_HOME", home);
	vi.stubEnv("CODEX_LSP_CACHE", join(dir, "cache"));
	await writeFile(
		join(root, "pyproject.toml"),
		'[project]\nname="validation"\nversion="0.0.0"\nrequires-python=">=3.13"\n',
	);
	await writeFile(
		join(home, "lsp-client.json"),
		JSON.stringify({
			schemaVersion: 1,
			lint: { python: "off" },
			lsp: {
				python: real
					? "ty"
					: {
							command: [process.execPath, resolve("test/fixtures/fake-lsp.mjs")],
							extensions: [".py"],
							env: {
								CODEX_LSP_TEST_MODE: mode,
								CODEX_LSP_TEST_LOG: join(dir, "spawns"),
								CODEX_LSP_TEST_REQUESTS: join(dir, "requests"),
							},
						},
			},
		}),
	);
	const base = await configuration(root);
	const server = base.servers["python"];
	if (!server) throw new Error("Python fixture disabled");
	const config: Config = { ...base, servers: { ...base.servers, python: { ...server, id: "ty" } } };
	return { root, config, dir };
}
it("compares complete multi-file overlays without writing source or contaminating the shared client", async () => {
	const { root, config } = await fixture();
	await writeFile(join(root, "a.py"), "broken old\n");
	await writeFile(join(root, "b.py"), "clean\n");
	const language = new Languages(root, config);
	try {
		const before = await language.check("a.py", new AbortController().signal);
		expect(before.findings).toHaveLength(1);
		const starts = language.statistics().processStarts;
		const files = [await plannedFile(root, "a.py", "clean\n"), await plannedFile(root, "b.py", "broken new\n")];
		const result = await language.validatePlan(files, new AbortController().signal);
		expect(result).toMatchObject({ state: "complete", errorsIntroduced: 1, errorsResolved: 1, netDelta: 0 });
		expect(result.introduced.map((item) => item.path)).toEqual(["b.py"]);
		expect(result.resolved.map((item) => item.path)).toEqual(["a.py"]);
		expect(await readFile(join(root, "a.py"), "utf8")).toBe("broken old\n");
		expect(await readFile(join(root, "b.py"), "utf8")).toBe("clean\n");
		expect(language.statistics().processStarts).toBe(starts);
		expect((await language.check("a.py", new AbortController().signal)).findings).toEqual(before.findings);
	} finally {
		await language.close();
	}
});
it("leaves counts unknown after startup failure and rejects unsupported scopes without simulation", async () => {
	const { root, config } = await fixture("startup-fail");
	await writeFile(join(root, "a.py"), "clean\n");
	const language = new Languages(root, config);
	try {
		const files = [await plannedFile(root, "a.py", "broken\n")];
		expect(await language.validatePlan(files, new AbortController().signal)).toMatchObject({
			state: "failed",
			errorsIntroduced: null,
			errorsResolved: null,
			netDelta: null,
		});
		expect(
			await language.validatePlan(
				Array.from({ length: 21 }, () => files[0]).filter((file) => file !== undefined),
				new AbortController().signal,
			),
		).toMatchObject({ state: "unsupported", netDelta: null });
		await writeFile(join(root, "a.txt"), "text");
		expect(
			await language.validatePlan([await plannedFile(root, "a.txt", "other")], new AbortController().signal),
		).toMatchObject({ state: "unsupported", netDelta: null });
	} finally {
		await language.close();
	}
});
it("cancels an in-flight simulation and disposes its child without changing real contents", async () => {
	const { root, config, dir } = await fixture();
	await writeFile(join(root, "a.py"), "clean\n");
	const language = new Languages(root, config);
	const controller = new AbortController();
	const pending = language.validatePlan(
		[await plannedFile(root, "a.py", "broken delayed-reply\n")],
		controller.signal,
	);
	const cancelled = expect(pending).rejects.toThrow("cancel validation");
	try {
		await vi.waitFor(
			async () => {
				const requests = await readFile(join(dir, "requests"), "utf8").catch(() => "");
				expect(requests.split("\n").filter((method) => method === "textDocument/diagnostic")).toHaveLength(2);
			},
			{ timeout: 5000, interval: 20 },
		);
		controller.abort(new Error("cancel validation"));
		await cancelled;
		const pids = (await readFile(join(dir, "spawns"), "utf8")).trim().split("\n").map(Number);
		for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
		expect(await readFile(join(root, "a.py"), "utf8")).toBe("clean\n");
	} finally {
		controller.abort(new Error("cancel validation"));
		await cancelled;
		await language.close();
	}
});
it("preserves confirmed provider findings but leaves aggregate counts unknown for an incomplete scope", async () => {
	const { root, config } = await fixture();
	await writeFile(join(root, "a.py"), "clean\n");
	await writeFile(join(root, "notes.txt"), "unchanged\n");
	const language = new Languages(root, config);
	try {
		const result = await language.validatePlan(
			[await plannedFile(root, "a.py", "broken\n")],
			new AbortController().signal,
			["notes.txt"],
		);
		expect(result).toMatchObject({ state: "partial", errorsIntroduced: null, netDelta: null });
		expect(result.introduced).toHaveLength(1);
		expect(result.checks).toContainEqual(
			expect.objectContaining({ provider: "ty", state: "complete", errorsIntroduced: 1 }),
		);
		expect(result.checks).toContainEqual(expect.objectContaining({ state: "unsupported", paths: ["notes.txt"] }));
		await expect(
			language.validatePlan([await plannedFile(root, "a.py", "broken\n")], new AbortController().signal, [
				"../escape.py",
			]),
		).rejects.toThrow();
	} finally {
		await language.close();
	}
});
it.skipIf(process.env["CODEX_LSP_REAL_TOOLS"] !== "1")(
	"real ty: net zero preserves introduced/resolved findings and multi-file dependencies observe the full overlay",
	async () => {
		const { root, config } = await fixture("pull", true);
		await writeFile(join(root, "a.py"), 'old: int = "wrong"\n');
		await writeFile(join(root, "b.py"), "new: int = 1\n");
		const language = new Languages(root, config);
		try {
			const result = await language.validatePlan(
				[
					await plannedFile(root, "a.py", "old: int = 1\n"),
					await plannedFile(root, "b.py", 'new: int = "wrong"\n'),
				],
				new AbortController().signal,
			);
			expect(result).toMatchObject({ state: "complete", errorsIntroduced: 1, errorsResolved: 1, netDelta: 0 });
			await writeFile(join(root, "values.py"), "value: int = 1\n");
			await writeFile(join(root, "use.py"), "from values import value\nresult: int = value\n");
			const dependent = await language.validatePlan(
				[
					await plannedFile(root, "values.py", 'value: str = "new"\n'),
					await plannedFile(root, "use.py", "from values import value\nresult: str = value\n"),
				],
				new AbortController().signal,
			);
			expect(dependent).toMatchObject({ state: "complete", errorsIntroduced: 0, errorsResolved: 0 });
			expect((await language.check("use.py", new AbortController().signal)).findings).toHaveLength(0);
		} finally {
			await language.close();
		}
	},
	30000,
);
