import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { directoryLock } from "../src/directory-lock.js";
import { withExecution } from "../src/environment.js";
import { Metadata } from "../src/metadata.js";

const fault = vi.hoisted(() => ({ remaining: 0, attempts: 0, suffix: "" }));
vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	return {
		...fs,
		rename: async (...args: Parameters<typeof fs.rename>) => {
			if (fault.suffix ? String(args[1]).endsWith(fault.suffix) : String(args[1]).includes(".released-")) {
				fault.attempts++;
				if (fault.remaining > 0) {
					fault.remaining--;
					throw Object.assign(new Error("temporary Windows sharing denial"), { code: "EPERM" });
				}
			}
			return fs.rename(...args);
		},
	};
});

it("persists metadata atomically through transient replacement denials", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "codeintel-metadata-replace-")));
	try {
		await withExecution(
			{ ...process.env, CODEX_LSP_CACHE: join(root, "cache"), CODEX_HOME: root },
			false,
			async () => {
				const store = new Metadata(root);
				fault.suffix = ".json";
				fault.remaining = 2;
				fault.attempts = 0;
				await store.update("s", AbortSignal.timeout(2000), (state) => {
					state.turn = "committed";
				});
				expect(fault.attempts).toBe(3);
				expect((await store.read("s")).turn).toBe("committed");
			},
		);
	} finally {
		fault.suffix = "";
		fault.remaining = 0;
		await rm(root, { recursive: true, force: true });
	}
});

it("releases through transient sharing denials so a competing waiter can acquire", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "codeintel-lock-")));
	try {
		const lock = join(root, "state.lock");
		const release = await directoryLock(lock, AbortSignal.timeout(2000));
		const waiting = directoryLock(lock, AbortSignal.timeout(2000));
		fault.remaining = 2;
		fault.attempts = 0;
		await release();
		expect(fault.attempts).toBe(3);
		const releaseNext = await waiting;
		await releaseNext();
		expect(fault.attempts).toBe(4);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
