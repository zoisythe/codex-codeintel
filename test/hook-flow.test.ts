import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { withExecution } from "../src/environment.js";
import { HookCoordinator } from "../src/hook-coordinator.js";
import { acknowledgeDelivery, consumeDelivery, queueDelivery } from "../src/hook-delivery.js";
import { HookEngine, renderHook } from "../src/hook-engine.js";
import { hookSession, normalizeHook } from "../src/hook-events.js";
import { registerHook } from "../src/hook-inbox.js";
import { Metadata } from "../src/metadata.js";
import { writeIntent } from "../src/write-intent.js";

const signal = () => AbortSignal.timeout(10000);
async function until(action: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!(await action())) {
		if (Date.now() > deadline) throw new Error("Hook state did not settle");
		await delay(10);
	}
}
async function fixture(
	action: (root: string, store: Metadata, coordinator: HookCoordinator, calls: string[][]) => Promise<void>,
	slow = 0,
): Promise<void> {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "codeintel-hook-flow-"))),
		root = join(dir, "project"),
		home = join(dir, "home");
	await mkdir(root);
	await mkdir(home);
	await writeFile(
		join(home, "lsp-client.json"),
		JSON.stringify({
			schemaVersion: 1,
			automaticDiagnostics: { postToolUse: "delta", stop: "errors" },
			stopGate: "introduced-errors",
		}),
	);
	await writeFile(join(root, "a.ts"), "clean");
	await writeFile(join(root, "b.ts"), "clean");
	try {
		await withExecution({ ...process.env, CODEX_HOME: home, CODEX_LSP_CACHE: join(dir, "cache") }, true, async () => {
			const store = new Metadata(root),
				calls: string[][] = [];
			const hooks = new HookEngine(root, {
				projects: {
					baseline: async (_id, paths) => ({
						reference: await store.shared({ results: [] }),
						findings: [],
						reliable: {},
						covered: paths ?? [],
						pending: [],
						failures: [],
					}),
					introduced: async () => [],
				},
				check: async (paths, _session, _turn, generation, _wait, requestSignal) => {
					calls.push(paths);
					if (slow) await delay(slow, undefined, { signal: requestSignal });
					return {
						generation,
						note: "",
						results: await Promise.all(
							paths.map(async (path) => ({
								path,
								state: "complete" as const,
								findings: (await readFile(join(root, path), "utf8")).includes("broken")
									? [
											{
												path,
												line: 1,
												column: 1,
												severity: "error" as const,
												source: "fake",
												message: `broken ${path}`,
											},
										]
									: [],
							})),
						),
					};
				},
				end: () => undefined,
			});
			const coordinator = new HookCoordinator(root, hooks);
			try {
				await registerHook(root, { session_id: "s", turn_id: "main", hook_event_name: "SessionStart" }, signal());
				await coordinator.ingest();
				await until(async () => !coordinator.active);
				await action(root, store, coordinator, calls);
			} finally {
				await coordinator.dispose();
			}
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
function post(agent: string, path: string, call: string, turn = agent): Record<string, unknown> {
	return {
		session_id: "s",
		agent_id: agent,
		turn_id: turn,
		tool_use_id: call,
		hook_event_name: "PostToolUse",
		tool_name: "apply_patch",
		tool_input: { path },
	};
}

describe("native Hook routing and transport", () => {
	it("registers exactly six current events and precise tool names", async () => {
		const manifest = JSON.parse(await readFile("hooks/hooks.json", "utf8")) as {
			hooks: Record<
				string,
				{ matcher?: string; hooks: { async?: boolean; timeout: number; statusMessage?: string }[] }[]
			>;
		};
		expect(Object.keys(manifest.hooks).sort()).toEqual([
			"Interrupt",
			"PostToolUse",
			"SessionEnd",
			"SessionStart",
			"Stop",
			"SubagentStop",
		]);
		expect(manifest.hooks["PostToolUse"]?.[0]?.hooks[0]).toMatchObject({ async: true, timeout: 330 });
		expect(new RegExp(manifest.hooks["SessionStart"]?.[0]?.matcher ?? "").test("compact")).toBe(false);
		for (const event of Object.values(manifest.hooks))
			for (const entry of event) for (const hook of entry.hooks) expect(hook.statusMessage).toBeUndefined();
		expect(normalizeHook({ session_id: "s", hook_event_name: "PreToolUse" })).toBeUndefined();
		expect(normalizeHook({ session_id: "s", hook_event_name: "SessionStart", source: "compact" })).toBeUndefined();
		for (const tool of ["check", "diagnostics", "status", "navigate", "rename", "format", "inspect", "actions"])
			expect(writeIntent(process.cwd(), { tool_name: `mcp__lsp__${tool}` }).kind).toBe("read");
		for (const tool of ["mcp__other__rename_write", "mcp__other__check", "mcp__lsp__apply"])
			expect(writeIntent(process.cwd(), { tool_name: tool }).kind).toBe("write");
		expect(
			writeIntent(process.cwd(), {
				tool_name: "mcp__lsp__apply",
				tool_response: { structuredContent: { modifiedPaths: ["a.ts"], status: "partial" } },
			}),
		).toMatchObject({ paths: ["a.ts"] });
		expect(
			writeIntent(process.cwd(), { tool_name: "mcp__lsp__apply", tool_response: { modifiedPaths: [], next: {} } }),
		).toEqual({ kind: "write" });
		expect(renderHook({ kind: "context", event: "SessionStart", context: "model context" })).toMatchObject({
			hookSpecificOutput: { additionalContext: "model context" },
		});
	});
	it("isolates two agents and main Stop; duplicate calls do not analyze twice", async () =>
		fixture(async (root, store, coordinator, calls) => {
			await writeFile(join(root, "a.ts"), "broken a");
			await writeFile(join(root, "b.ts"), "broken b");
			const a = post("a", "a.ts", "1"),
				b = post("b", "b.ts", "1");
			const first = await registerHook(root, a, signal());
			expect(await registerHook(root, a, signal())).toEqual(first);
			await registerHook(root, b, signal());
			await coordinator.ingest();
			await until(async () => !coordinator.active);
			expect(calls).toHaveLength(2);
			expect(calls).toContainEqual(["a.ts"]);
			expect(calls).toContainEqual(["b.ts"]);
			const main = await store.read("s"),
				other = await store.read(hookSession(b));
			const out = await coordinator.request(
				{ session_id: "s", agent_id: "a", turn_id: "a", hook_event_name: "SubagentStop" },
				signal(),
			);
			expect(out.output.kind).toBe("context");
			expect(JSON.stringify(out.output)).toContain("broken a.ts");
			expect(JSON.stringify(out.output)).not.toContain("broken b.ts");
			expect(await store.read("s")).toEqual(main);
			expect(await store.read(hookSession(b))).toEqual(other);
			const retry = await consumeDelivery(root, hookSession(a), "SubagentStop", signal());
			expect(retry.deliveryId).toBe(out.deliveryId);
			await expect(
				acknowledgeDelivery(root, hookSession(a), out.deliveryId ?? "", AbortSignal.abort()),
			).rejects.toThrow();
			expect((await consumeDelivery(root, hookSession(a), "SubagentStop", signal())).deliveryId).toBe(
				out.deliveryId,
			);
			await acknowledgeDelivery(root, hookSession(a), out.deliveryId ?? "", signal());
			expect((await consumeDelivery(root, hookSession(a), "SubagentStop", signal())).output.kind).toBe("silent");
			await registerHook(root, a, signal());
			await coordinator.ingest();
			expect(calls).toHaveLength(2);
		}));
	it("merges writes by current contents and retains other agents during Interrupt", async () =>
		fixture(async (root, store, coordinator, calls) => {
			const a = post("a", "a.ts", "1"),
				a2 = post("a", "b.ts", "2"),
				b = post("b", "b.ts", "3", "other-turn");
			await writeFile(join(root, "a.ts"), "broken old");
			await registerHook(root, a, signal());
			await coordinator.ingest();
			await writeFile(join(root, "a.ts"), "clean current");
			await writeFile(join(root, "b.ts"), "broken new");
			await registerHook(root, a2, signal());
			await registerHook(root, b, signal());
			await coordinator.ingest();
			await until(async () => calls.length === 2);
			const otherBefore = await store.read(hookSession(b));
			const wait = coordinator.wait(
				{
					...a,
					registration: (await registerHook(root, a, signal()))?.id,
					revision: (await coordinator.wait({ ...a, registration: "unknown" }, signal())).revision,
				},
				signal(),
			);
			await coordinator.request({ session_id: "s", turn_id: "a", hook_event_name: "Interrupt" }, signal());
			expect((await wait).state).toBe("cancelled");
			expect((await store.read(hookSession(a))).pending).toContain("b.ts");
			expect((await store.read(hookSession(b))).epoch).toBe(otherBefore.epoch);
			await until(async () => !coordinator.active);
			expect(
				JSON.stringify((await consumeDelivery(root, hookSession(b), "SubagentStop", signal())).output),
			).toContain("broken b.ts");
		}, 700));
	it("unknown Interrupt detaches only shared waits, retains pending, and persists cancellation", async () =>
		fixture(async (root, store, coordinator, calls) => {
			await writeFile(join(root, "a.ts"), "broken a");
			await writeFile(join(root, "b.ts"), "broken b");
			const main = post("", "a.ts", "unknown-main", "main"),
				child = post("b", "b.ts", "unknown-child");
			const registered = await registerHook(root, main, signal()),
				other = await registerHook(root, child, signal());
			await coordinator.ingest();
			await until(async () => calls.length === 2);
			const rootWait = await coordinator.request({ ...main, registration: registered?.id }, signal()),
				childWait = await coordinator.request({ ...child, registration: other?.id }, signal());
			const before = await store.read("s");
			await coordinator.request({ session_id: "s", hook_event_name: "Interrupt" }, signal());
			expect(
				(await coordinator.wait({ ...main, registration: registered?.id, waitToken: rootWait.waitToken }, signal()))
					.state,
			).toBe("cancelled");
			expect(
				(await coordinator.wait({ ...child, registration: other?.id, waitToken: childWait.waitToken }, signal()))
					.state,
			).not.toBe("cancelled");
			expect((await store.read("s")).pending).toEqual(before.pending);
			expect((await store.read("s")).waitEpoch).toBe(before.waitEpoch + 1);
			await until(async () => !coordinator.active);
		}, 700));
	it("retains pending when a different writer changes the analyzed snapshot", async () =>
		fixture(async (root, store, coordinator, calls) => {
			await writeFile(join(root, "a.ts"), "broken old");
			const a = post("a", "a.ts", "race");
			await registerHook(root, a, signal());
			await coordinator.ingest();
			await until(async () => calls.length === 1);
			await writeFile(join(root, "a.ts"), "clean current");
			await until(async () => !coordinator.active);
			expect((await store.read(hookSession(a))).pending).toContain("a.ts");
			const result = await consumeDelivery(root, hookSession(a), "SubagentStop", signal());
			expect(JSON.stringify(result.output)).toContain("pending=1");
			expect(JSON.stringify(result.output)).not.toContain("broken a.ts");
		}, 500));
	it("ends epochs before late results, and resumes without resetting a valid baseline", async () =>
		fixture(async (root, store, coordinator) => {
			const before = await store.read("s");
			await registerHook(root, { session_id: "s", hook_event_name: "SessionStart", source: "resume" }, signal());
			expect((await store.read("s")).epoch).toBe(before.epoch);
			await writeFile(join(root, "a.ts"), "broken");
			const a = post("a", "a.ts", "end");
			await registerHook(root, a, signal());
			await coordinator.ingest();
			await coordinator.request({ session_id: "s", hook_event_name: "SessionEnd" }, signal());
			await until(async () => !coordinator.active);
			expect((await store.read("s")).turn).toBe("__ended__");
			expect((await store.read("s")).epoch).not.toBe(before.epoch);
			expect((await consumeDelivery(root, hookSession(a), "SubagentStop", signal())).output.kind).toBe("silent");
		}));
	it("bounds UTF-8 feedback and turn budgets, retries one ID, invalidates changed snapshots", async () =>
		fixture(async (root, store, coordinator) => {
			const config = (await import("../src/config.js")).configuration;
			const version = (await config(root)).version;
			for (let index = 0; index < 12; index++) {
				await store.update("s", signal(), async (state) => {
					await queueDelivery(
						store,
						state,
						{ kind: "context", event: "PostToolUse", context: `${index}: ${'中文😀"\\\n'.repeat(1000)}` },
						{},
						version,
						"",
					);
				});
			}
			const state = await store.read("s");
			expect(state.feedback["main"]?.bytes).toBeLessThanOrEqual(7680);
			expect(Object.keys(state.outbox).length).toBeLessThanOrEqual(5);
			const first = await consumeDelivery(root, "s", "PostToolUse", signal());
			expect(Buffer.byteLength(JSON.stringify(renderHook(first.output)))).toBeLessThanOrEqual(2048);
			expect(JSON.stringify(first.output)).not.toContain("�");
			expect((await consumeDelivery(root, "s", "PostToolUse", signal())).deliveryId).toBe(first.deliveryId);
			await acknowledgeDelivery(root, "s", first.deliveryId ?? "", signal());
			await store.update("s", signal(), (current) => {
				current.outbox = {};
				current.feedback = {};
			});
			await writeFile(join(root, "a.ts"), "broken");
			const a = post("a", "a.ts", "freshness");
			await registerHook(root, a, signal());
			await coordinator.ingest();
			await until(async () => !coordinator.active);
			await writeFile(join(root, "a.ts"), "clean now");
			expect((await consumeDelivery(root, hookSession(a), "SubagentStop", signal())).output.kind).toBe("silent");
			expect((await store.read(hookSession(a))).pending).toContain("a.ts");
		}));
});
