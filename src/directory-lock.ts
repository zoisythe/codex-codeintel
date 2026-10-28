import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BUDGET } from "./budgets.js";
import { record } from "./results.js";

export function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		if (process.platform === "linux") {
			const state = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)?.split(" ")[0];
			if (state === "Z" || state === "X") return false;
		}
		return true;
	} catch (error) {
		return !(record(error) && ["ESRCH", "ENOENT"].includes(String(error["code"])));
	}
}
export async function renameWithRetry(source: string, target: string, signal?: AbortSignal): Promise<void> {
	const deadline = Date.now() + BUDGET.cleanup;
	for (;;) {
		signal?.throwIfAborted();
		try {
			await rename(source, target);
			return;
		} catch (error) {
			if (!record(error) || !["EPERM", "EACCES", "EBUSY"].includes(String(error["code"])) || Date.now() >= deadline)
				throw error;
			await delay(20, undefined, signal ? { signal } : {});
		}
	}
}
export async function directoryLock(
	lock: string,
	signal: AbortSignal,
	budget: number = BUDGET.lock,
): Promise<() => Promise<void>> {
	const nonce = randomUUID();
	const candidate = `${lock}.claim-${nonce}`;
	await mkdir(candidate, { mode: 0o700 });
	await writeFile(join(candidate, "owner"), JSON.stringify({ pid: process.pid, nonce }), { mode: 0o600 });
	const deadline = Date.now() + budget;
	try {
		while (true) {
			signal.throwIfAborted();
			try {
				await rename(candidate, lock);
				break;
			} catch (error) {
				if (!record(error) || !["EEXIST", "ENOTEMPTY", "EPERM"].includes(String(error["code"]))) throw error;
				const raw = await readFile(join(lock, "owner"), "utf8").catch(() => "{}");
				const owner: unknown = JSON.parse(raw);
				if (
					record(owner) &&
					typeof owner["pid"] === "number" &&
					typeof owner["nonce"] === "string" &&
					!alive(owner["pid"]) &&
					(await readFile(join(lock, "owner"), "utf8").catch(() => "")) === raw
				)
					await rename(lock, `${lock}.abandoned-${owner["nonce"]}`).catch(() => undefined);
				if (Date.now() >= deadline) throw new Error("Directory lock busy; retry");
				await delay(10, undefined, { signal });
			}
		}
	} finally {
		await rm(candidate, { recursive: true, force: true });
	}
	return async () => {
		const released = `${lock}.released-${nonce}`;
		// Release ownership even if the request was cancelled during its write.
		await renameWithRetry(lock, released);
		await rm(released, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
	};
}
