import { readFile } from "node:fs/promises";
import { configuration } from "./config.js";
import { hash, workspacePath } from "./files.js";
import type { HookOutput } from "./hook-engine.js";
import { analysisIdentity } from "./identity.js";
import { Metadata, type SessionState } from "./metadata.js";
import { record } from "./results.js";

interface Delivery {
	epoch: string;
	generation: number;
	turn: string;
	configuration: string;
	analysis: string;
	bindings: Record<string, string>;
	output: HookOutput;
}

// Called under the session metadata lock, with the ledger change it describes.
export async function queueDelivery(
	store: Metadata,
	state: SessionState,
	output: HookOutput,
	bindings: Record<string, string>,
	configuration: string,
	analysis: string,
): Promise<void> {
	if (output.kind !== "context" && output.kind !== "block") return;
	const content = output.kind === "context" ? output.context : output.reason;
	const pages: string[] = output.kind === "block" ? [content.slice(0, 8000)] : [];
	let page = "";
	for (const line of output.kind === "block" ? [] : content.split("\n")) {
		if (page && Buffer.byteLength(`${page}\n${line}`) > 3500) {
			pages.push(page);
			page = "";
		}
		page += `${page ? "\n" : ""}${line}`;
	}
	if (page) pages.push(page);
	for (const [index, value] of pages.entries()) {
		const delivery: Delivery = {
			epoch: state.epoch,
			generation: state.generation,
			turn: state.turn,
			configuration,
			analysis,
			bindings,
			output: output.kind === "context" ? { ...output, context: value } : { ...output, reason: value },
		};
		const id = `${output.kind === "block" ? "block-" : ""}${hash(JSON.stringify([delivery, index])).slice(0, 24)}`;
		state.outbox[id] = await store.shared(delivery);
	}
}

export async function consumeDelivery(
	root: string,
	session: string,
	event: string,
	signal: AbortSignal,
): Promise<{ output: HookOutput; deliveryId?: string }> {
	const store = new Metadata(root);
	const state = await store.read(session);
	const config = await configuration(root);
	if (
		!config.valid ||
		state.turn === "__ended__" ||
		(event === "Stop" || event === "SubagentStop"
			? config.automaticDiagnostics.stop
			: config.automaticDiagnostics.postToolUse) === "off"
	)
		return { output: { kind: "silent" } };
	const entries = Object.entries(state.outbox);
	// Stop decisions take precedence over informational pages.
	if (event === "Stop" || event === "SubagentStop")
		entries.sort(([a], [b]) => Number(!a.startsWith("block-")) - Number(!b.startsWith("block-")));
	for (const [id, reference] of entries) {
		signal.throwIfAborted();
		const value = await store.readShared(reference);
		if (!record(value) || !record(value["bindings"]) || !record(value["output"]))
			throw new Error("Invalid diagnostic delivery");
		const item = value as unknown as Delivery;
		const paths = Object.keys(item.bindings);
		let fresh =
			item.epoch === state.epoch && item.generation === state.generation && item.configuration === config.version;
		if (fresh && paths.length) {
			for (const path of paths) {
				signal.throwIfAborted();
				try {
					if (
						hash(await readFile(await workspacePath(root, path), { encoding: "utf8", signal })) !==
						item.bindings[path]
					)
						fresh = false;
				} catch (error) {
					signal.throwIfAborted();
					if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
					fresh = false;
				}
			}
			if (fresh) fresh = item.analysis === (await analysisIdentity(root, paths, config, signal));
		}
		if (!fresh) {
			await store.update(session, signal, (current) => {
				if (current.outbox[id] !== reference) return false;
				delete current.outbox[id];
				if (current.epoch === item.epoch && current.turn !== "__ended__") current.pending.push(...paths);
				return true;
			});
			continue;
		}
		if (item.output.kind === "block" && (state.turn !== item.turn || config.stopGate !== "introduced-errors")) {
			await acknowledgeDelivery(root, session, id, signal);
			continue;
		}
		if (item.output.kind === "block" && event !== "Stop" && event !== "SubagentStop") continue;
		const current = await store.read(session);
		if (current.epoch !== state.epoch || current.generation !== state.generation || current.outbox[id] !== reference)
			return { output: { kind: "silent" } };
		const marker = `[Codex CodeIntel automatic diagnostics] deliveryId=${id}; sourceTurn=${item.turn || "unknown"}\n`;
		return {
			deliveryId: id,
			output:
				item.output.kind === "block"
					? { kind: "block", reason: marker + item.output.reason }
					: item.output.kind === "context"
						? { kind: "context", event, context: marker + item.output.context }
						: item.output,
		};
	}
	return { output: { kind: "silent" } };
}

export async function acknowledgeDelivery(
	root: string,
	session: string,
	id: string,
	signal: AbortSignal,
): Promise<void> {
	await new Metadata(root).update(session, signal, (state) => {
		if (!state.outbox[id]) return false;
		delete state.outbox[id];
		return true;
	});
}
