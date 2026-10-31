import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { BUDGET } from "../src/budgets.js";
import { EditPlans, PlanFailure, plannedFile, workspaceEdits } from "../src/edit-plans.js";
import { Engine } from "../src/engine.js";
import { withExecution } from "../src/environment.js";
import { parseLint } from "../src/lint-output.js";
import { OutputPages } from "../src/output-pages.js";
import { LEGACY_TOOLS, TOOLS } from "../src/protocol.js";
import { outline, position } from "../src/symbols.js";

afterEach(() => vi.unstubAllEnvs());
const signal = () => new AbortController().signal;
async function fixture() {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "codeintel-v10-")));
	const root = join(dir, "project");
	const home = join(dir, "home");
	await mkdir(root);
	await mkdir(home);
	vi.stubEnv("CODEX_HOME", home);
	vi.stubEnv("CODEX_LSP_CACHE", join(dir, "cache"));
	await writeFile(
		join(home, "lsp-client.json"),
		JSON.stringify({
			schemaVersion: 1,
			lsp: {
				fake: {
					command: [process.execPath, resolve("test/fixtures/fake-lsp.mjs")],
					extensions: [".fake"],
					env: { CODEX_LSP_TEST_MODE: "intelligence" },
				},
			},
		}),
	);
	await writeFile(join(root, "a.fake"), `broken\n${"x\n".repeat(100)}`);
	return { root, home };
}
it("advertises ten single-word tools with one write entry point", () => {
	expect(TOOLS.map((tool) => tool.name)).toEqual([
		"check",
		"diagnostics",
		"status",
		"warmup",
		"navigate",
		"rename",
		"format",
		"inspect",
		"actions",
		"apply",
	]);
	expect(TOOLS.filter((tool) => !tool.annotations.readOnlyHint).map((tool) => tool.name)).toEqual(["apply"]);
	expect(Object.keys(LEGACY_TOOLS)).not.toContain("apply");
});
it("retains Unicode, BOM and CRLF positions and rejects ambiguous anchors", async () => {
	const { root } = await fixture();
	const path = join(root, "anchor.fake");
	await writeFile(path, "\ufeff😀中文 call(value)\r\ncall(value)\r\n");
	expect(await position(path, { pattern: "😀中文 @@call" }, async () => [])).toEqual({ line: 1, column: 7 });
	await expect(position(path, { pattern: "@@call(value)" }, async () => [])).rejects.toThrow("ambiguous");
	await expect(position(path, { symbol: "a", line: 1 }, async () => [])).rejects.toThrow("one position");
	const ranges = [0, 1].map((line) => ({ start: { line, character: 0 }, end: { line, character: 4 } }));
	const overloaded = outline(ranges.map((range) => ({ name: "call", kind: 12, range, selectionRange: range })));
	await expect(position(path, { symbol: "call" }, async () => overloaded)).rejects.toThrow("ambiguous");
	expect(await position(path, { symbol: "call[1]" }, async () => overloaded)).toEqual({ line: 2, column: 1 });
});
it("pages nested symbols and long Unicode text losslessly with compact next arguments", () => {
	const pages = new OutputPages();
	const args = { workspace: "workspace", path: "a.fake", operation: "symbols" };
	const text = "😀中文".repeat(6000);
	let output = pages.write(
		{
			operation: "navigate",
			status: "complete",
			source: text,
			symbols: Array.from({ length: 100 }, (_, i) => ({ symbol: `Class.member${i}` })),
		},
		args,
		"one",
	);
	const parts: string[] = [];
	let records = 0;
	while (true) {
		expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(8192);
		for (const item of output["items"] as { field: string; text?: string }[]) {
			records++;
			if (item.field === 'result["source"]') parts.push(item.text ?? "");
		}
		if (!output["next"]) break;
		output = pages.read(output["next"] as Record<string, unknown>, "one");
	}
	expect(parts.join("")).toBe(text);
	expect(records).toBeGreaterThan(20);
	const first = pages.write({ result: Array.from({ length: 30 }, (_, i) => i) }, args, "one");
	awaitless(() => pages.read(first["next"] as Record<string, unknown>, "changed"));
});
function awaitless(fn: () => unknown) {
	expect(fn).toThrow("Cursor invalid");
}
it("previews rename and format without writes, applies once and invalidates stale plans", async () => {
	const { root } = await fixture();
	const engine = new Engine(root);
	try {
		const before = await readFile(join(root, "a.fake"), "utf8");
		const format = await engine.dispatch("format", { path: "a.fake" }, signal());
		expect(await readFile(join(root, "a.fake"), "utf8")).toBe(before);
		const applied = await engine.dispatch("apply", { plan: format["plan"] }, signal());
		expect(applied["modifiedPaths"]).toEqual(["a.fake"]);
		await expect(engine.dispatch("apply", { plan: format["plan"] }, signal())).rejects.toThrow("missing");
		const rename = await engine.dispatch("rename", { path: "a.fake", newName: "renamed" }, signal());
		await writeFile(join(root, "dependency.fake"), "changed");
		await expect(engine.dispatch("apply", { plan: rename["plan"] }, signal())).rejects.toThrow("stale");
		expect(await readFile(join(root, "a.fake"), "utf8")).toContain("fixed!");
	} finally {
		await engine.dispose();
	}
}, 20000);
it("rejects overlapping workspace edits and any resource operation before writing", async () => {
	const { root } = await fixture();
	const uri = new URL(`file:///${join(root, "a.fake").replaceAll("\\", "/")}`).href;
	const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };
	await expect(
		workspaceEdits(root, {
			changes: {
				[uri]: [
					{ range, newText: "a" },
					{ range, newText: "b" },
				],
			},
		}),
	).rejects.toThrow("Overlapping");
	await expect(workspaceEdits(root, { documentChanges: [{ kind: "delete", uri }] })).rejects.toThrow("resource");
});
it("preflights every file before any application", async () => {
	const { root } = await fixture();
	await writeFile(join(root, "b.fake"), "old");
	const plans = new EditPlans();
	const files = [await plannedFile(root, "a.fake", "new"), await plannedFile(root, "b.fake", "new")];
	const plan = plans.create("identity", files);
	await writeFile(join(root, "b.fake"), "conflict");
	await expect(plans.apply(plan.id, "identity", root, signal())).rejects.toThrow("conflict");
	expect(await readFile(join(root, "a.fake"), "utf8")).toContain("broken");
});
it("keeps nonempty plans past service idle without renewing their fixed expiry", async () => {
	const { root } = await fixture();
	let now = Date.now();
	const plans = new EditPlans(() => now);
	const plan = plans.create("identity", [await plannedFile(root, "a.fake", "new")]);
	const expires = plan.expiresAt;
	now += BUDGET.idle + 1;
	expect(plans.hasLivePlans()).toBe(true);
	expect(plans.get(plan.id).expiresAt).toBe(expires);
	now = Date.parse(expires);
	expect(plans.hasLivePlans()).toBe(false);
	expect(() => plans.get(plan.id)).toThrowError(expect.objectContaining({ planFailure: "expired" }));
	expect(await readFile(join(root, "a.fake"), "utf8")).toContain("broken");
	expect(() => new EditPlans().get(plan.id)).toThrowError(expect.objectContaining({ planFailure: "unavailable" }));
});
it("reports capacity eviction and single consumption; empty plans do not keep the service alive", async () => {
	const { root } = await fixture();
	const file = await plannedFile(root, "a.fake", "new");
	const plans = new EditPlans();
	const first = plans.create("identity", [file]);
	for (let index = 0; index < 16; index++) plans.create("identity", [file]);
	expect(() => plans.get(first.id)).toThrowError(expect.objectContaining({ planFailure: "evicted" }));
	const active = plans.create("identity", [file]);
	await plans.apply(active.id, "identity", root, signal());
	expect(() => plans.get(active.id)).toThrow(PlanFailure);
	expect(() => plans.get(active.id)).toThrowError(expect.objectContaining({ planFailure: "consumed" }));
	const empty = new EditPlans();
	empty.create("identity", []);
	expect(empty.hasLivePlans()).toBe(false);
});
it("explicit warmup initializes once with automatic feedback off and never collects diagnostics", async () => {
	const { root, home } = await fixture();
	const log = join(home, "requests");
	await writeFile(
		join(home, "lsp-client.json"),
		JSON.stringify({
			schemaVersion: 1,
			lsp: {
				fake: {
					command: [process.execPath, resolve("test/fixtures/fake-lsp.mjs")],
					extensions: [".fake"],
					env: { CODEX_LSP_TEST_MODE: "pull", CODEX_LSP_TEST_REQUESTS: log },
				},
			},
		}),
	);
	const engine = new Engine(root);
	try {
		const before = await engine.dispatch("status", { path: "a.fake" }, signal());
		expect((before["clients"] as { processStarts: number }).processStarts).toBe(0);
		const first = await engine.dispatch("warmup", { path: "a.fake" }, signal());
		expect(first["status"]).toBe("complete");
		expect(first["items"]).toMatchObject([{ status: "initialized" }]);
		const second = await engine.dispatch("warmup", { paths: ["a.fake", "a.fake"] }, signal());
		expect(second["items"]).toMatchObject([{ status: "reused" }]);
		const requests = await readFile(log, "utf8");
		expect(requests.split("\n").filter((method) => method === "initialize")).toHaveLength(1);
		expect(requests).not.toContain("textDocument/diagnostic");
	} finally {
		await engine.dispose();
	}
});
it("binds additional validation files to plan identity without formatting or applying them", async () => {
	const { root } = await fixture();
	await writeFile(join(root, "watch.fake"), "unchanged\n");
	const engine = new Engine(root);
	try {
		const preview = await engine.dispatch("format", { path: "a.fake", validationPaths: ["watch.fake"] }, signal());
		expect(preview["files"]).toEqual(["a.fake"]);
		expect((preview["validation"] as { paths: string[] }).paths).toContain("watch.fake");
		await writeFile(join(root, "watch.fake"), "changed after preview\n");
		await expect(engine.dispatch("apply", { plan: preview["plan"] }, signal())).rejects.toThrow("stale");
		expect(await readFile(join(root, "a.fake"), "utf8")).toContain("broken");
	} finally {
		await engine.dispose();
	}
});
it("reports the completed files on cancellation and consumes the partial plan", async () => {
	const { root } = await fixture();
	await writeFile(join(root, "b.fake"), "old");
	const plans = new EditPlans();
	const plan = plans.create("identity", [
		await plannedFile(root, "a.fake", "new"),
		await plannedFile(root, "b.fake", "new"),
	]);
	const controller = new AbortController();
	const check = controller.signal.throwIfAborted.bind(controller.signal);
	let checks = 0;
	vi.spyOn(controller.signal, "throwIfAborted").mockImplementation(() => {
		if (++checks === 5) controller.abort();
		check();
	});
	await expect(plans.apply(plan.id, "identity", root, controller.signal)).rejects.toMatchObject({
		modifiedPaths: ["a.fake"],
	});
	expect(await readFile(join(root, "a.fake"), "utf8")).toBe("new");
	expect(await readFile(join(root, "b.fake"), "utf8")).toBe("old");
	expect(() => plans.get(plan.id)).toThrow("consumed");
});
it("binds plans to request environments and original symlink targets even for identical contents", async () => {
	const { root } = await fixture();
	for (const directory of ["left", "right"]) {
		await mkdir(join(root, directory));
		await writeFile(join(root, directory, "a.fake"), "broken\n");
	}
	const alias = join(root, "alias");
	await symlink(join(root, "left"), alias, process.platform === "win32" ? "junction" : "dir");
	const engine = new Engine(root);
	try {
		const env = { ...process.env, CODEX_PLAN_TEST: "first" };
		const preview = await withExecution(env, false, () => engine.dispatch("format", { path: "a.fake" }, signal()));
		await expect(
			withExecution({ ...env, CODEX_PLAN_TEST: "changed" }, false, () =>
				engine.dispatch("apply", { plan: preview["plan"] }, signal()),
			),
		).rejects.toThrow("stale");
		const linked = await engine.dispatch("format", { path: "alias/a.fake" }, signal());
		await rm(alias, { recursive: true });
		await symlink(join(root, "right"), alias, process.platform === "win32" ? "junction" : "dir");
		await expect(engine.dispatch("apply", { plan: linked["plan"] }, signal())).rejects.toThrow("stale");
		expect(await readFile(join(root, "left", "a.fake"), "utf8")).toBe("broken\n");
		expect(await readFile(join(root, "right", "a.fake"), "utf8")).toBe("broken\n");
	} finally {
		await engine.dispose();
	}
}, 20000);
it("preserves vendor applicability and ESLint suggestions without exposing raw edits as public findings", () => {
	const ruff = parseLint(
		"ruff",
		[
			{
				code: "F401",
				message: "unused",
				location: { row: 1, column: 1 },
				fix: {
					applicability: "safe",
					message: "Remove import",
					edits: [{ location: { row: 1, column: 1 }, end_location: { row: 1, column: 2 }, content: "" }],
				},
			},
		],
		"a.py",
		"x\n",
	);
	expect(ruff[0]?.lint?.fixes[0]?.applicability).toBe("safe");
	const eslint = parseLint(
		"eslint",
		[
			{
				messages: [
					{
						ruleId: "rule",
						severity: 2,
						line: 1,
						column: 1,
						message: "issue",
						fix: { range: [0, 1], text: "y" },
						suggestions: [{ desc: "alternative", fix: { range: [0, 1], text: "z" } }],
					},
				],
			},
		],
		"a.js",
		"x",
	);
	expect(eslint[0]?.lint?.fixes.map((fix) => fix.applicability)).toEqual(["unknown", "suggestion"]);
});
it("converts Ruff scalar columns and Biome byte ranges to UTF-16 without losing full ranges", () => {
	const content = '中文 = "😀"; import os\r\n';
	const offset = content.indexOf("import");
	const start = { row: 1, column: Array.from(content.slice(0, offset)).length + 1 };
	const end = { row: 1, column: start.column + 9 };
	const ruff = parseLint(
		"ruff",
		[
			{
				code: "F401",
				message: "unused",
				location: start,
				end_location: end,
				fix: { applicability: "safe", edits: [{ location: start, end_location: end, content: "" }] },
			},
		],
		"a.py",
		content,
	)[0];
	expect(ruff?.column).toBe(offset + 1);
	expect(ruff?.endColumn).toBe(offset + 10);
	expect(ruff?.lint?.fixes[0]?.edits[0]?.range.start.character).toBe(offset);
	const biome = parseLint(
		"biome",
		{
			diagnostics: [
				{
					category: "lint/test",
					severity: "warning",
					description: "issue",
					tags: ["fixable"],
					location: {
						span: [Buffer.byteLength(content.slice(0, offset)), Buffer.byteLength(content.slice(0, offset + 9))],
					},
				},
			],
		},
		"a.js",
		content,
	)[0];
	expect(biome?.column).toBe(offset + 1);
	expect(biome?.endColumn).toBe(offset + 10);
	expect(biome?.fixable).toBe(true);
});

it("resolves LSP text actions, rejects commands and keeps expanded outlines pageable", async () => {
	const { root } = await fixture();
	const engine = new Engine(root);
	try {
		const outline = await engine.dispatch("navigate", { path: "a.fake", operation: "symbols" }, signal());
		expect((outline["result"] as unknown[]).length).toBe(1);
		const impact = await engine.dispatch(
			"inspect",
			{ path: "a.fake", operation: "impact", symbols: ["Container.member0", "missing"] },
			signal(),
		);
		expect(impact["status"]).toBe("partial");
		const affected = impact["symbols"] as { references: { count: number }; callers: { items: unknown[] } }[];
		expect(affected[0]?.references.count).toBe(1);
		expect(affected[0]?.callers.items).toEqual([]);
		expect((impact["issues"] as unknown[]).length).toBe(1);
		const expanded = await engine.dispatch(
			"navigate",
			{ path: "a.fake", operation: "symbols", symbol: "Container" },
			signal(),
		);
		expect(expanded["items"]).toBeDefined();
		expect(expanded["next"]).toBeDefined();
		expect(Buffer.byteLength(JSON.stringify(expanded))).toBeLessThan(8192);
		const listed = await engine.dispatch("actions", { path: "a.fake", source: "lsp", operation: "list" }, signal());
		const items = listed["items"] as { id: string; title: string; status?: string }[];
		const command = items.find((item) => item.title === "Command");
		expect(command?.status).toBe("unsupported");
		await expect(engine.dispatch("actions", { operation: "preview", ids: [command?.id] }, signal())).rejects.toThrow(
			"unsupported",
		);
		const resolved = items.find((item) => item.title === "Resolve");
		const preview = await engine.dispatch("actions", { operation: "preview", ids: [resolved?.id] }, signal());
		expect(await readFile(join(root, "a.fake"), "utf8")).toContain("broken");
		await engine.dispatch("apply", { plan: preview["plan"] }, signal());
		expect(await readFile(join(root, "a.fake"), "utf8")).toContain("fixed!");
	} finally {
		await engine.dispose();
	}
}, 20000);
