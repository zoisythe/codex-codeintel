import { readFile } from "node:fs/promises";
import { configuration } from "./config.js";
import { hash, workspacePath } from "./files.js";
import type { HookOutput } from "./hook-engine.js";
import { rootSession } from "./hook-events.js";
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

export function utf8(value: string, bytes: number): string {
	const buffer = Buffer.from(value);
	if (buffer.length <= bytes) return value;
	let end = Math.max(0, bytes);
	while (end > 0) {
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, end));
		} catch {
			end--;
		}
	}
	return "";
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
	const signature = hash(JSON.stringify([output.kind, content]));
	const turn = state.turn || "unknown";
	const budget = state.feedback[turn] ?? { bytes: 0, signatures: [] };
	if (budget.signatures.includes(signature)) return;
	const final = output.kind === "block" || output.event === "Stop" || output.event === "SubagentStop";
	const available = (final ? 8192 : 7680) - budget.bytes;
	if (available < 350) return;
	let value = utf8(content, Math.min(1550, available - 250));
	const suffix = value !== content ? "\nDetails: diagnostics(run=cached, scope=session)." : "";
	const marker = `[Codex CodeIntel automatic diagnostics] deliveryId=${"x".repeat(30)}; sourceTurn=${utf8(state.turn || "unknown", 64)}\n`;
	const bytes = (body: string) =>
		Buffer.byteLength(
			JSON.stringify(
				output.kind === "block"
					? { decision: "block", reason: marker + body }
					: { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: marker + body } },
			),
		);
	// Count the complete JSON wire representation, including escaping and marker.
	while (bytes(value + suffix) > Math.min(2048, available) && value.length)
		value = utf8(value, Buffer.byteLength(value) - 20);
	value += suffix;
	{
		const delivery: Delivery = {
			epoch: state.epoch,
			generation: state.generation,
			turn: state.turn,
			configuration,
			analysis,
			bindings,
			output: output.kind === "context" ? { ...output, context: value } : { ...output, reason: value },
		};
		const id = `${output.kind === "block" ? "block-" : ""}${hash(JSON.stringify(delivery)).slice(0, 24)}`;
		state.outbox[id] = await store.shared(delivery);
		state.feedback[turn] = {
			bytes: budget.bytes + bytes(value),
			signatures: [...budget.signatures.slice(-127), signature],
		};
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
	const parent = await store.read(rootSession(session));
	const config = await configuration(root);
	if (
		!config.valid ||
		state.turn === "__ended__" ||
		parent.turn === "__ended__" ||
		parent.epoch !== state.epoch ||
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
		if (event === "PostToolUse" && item.output.kind === "context" && item.output.event === "SessionStart") continue;
		const paths = Object.keys(item.bindings);
		let fresh = item.epoch === state.epoch && item.configuration === config.version;
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
		if (
			item.output.kind === "block" &&
			(state.turn !== item.turn || config.stopGate !== "introduced-errors" || session !== rootSession(session))
		) {
			await acknowledgeDelivery(root, session, id, signal);
			continue;
		}
		if (item.output.kind === "block" && event !== "Stop") continue;
		const current = await store.read(session);
		if (current.epoch !== state.epoch || current.generation !== state.generation || current.outbox[id] !== reference)
			return { output: { kind: "silent" } };
		const marker = `[Codex CodeIntel automatic diagnostics] deliveryId=${id}; sourceTurn=${utf8(item.turn || "unknown", 64)}\n`;
		return {
			deliveryId: id,
			output:
				item.output.kind === "block"
					? { kind: "block", reason: marker + item.output.reason }
					: item.output.kind === "context"
						? { ...item.output, event, context: marker + item.output.context }
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
