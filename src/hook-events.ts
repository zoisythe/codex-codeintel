import { text } from "./results.js";

export const HOOK_EVENTS = ["SessionStart", "PostToolUse", "Stop", "SubagentStop", "SessionEnd", "Interrupt"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];
const separator = "\u0000codeintel:";

export function hookEvent(input: Record<string, unknown>): HookEvent | undefined {
	const event = text(input["hook_event_name"], "PostToolUse");
	if (!HOOK_EVENTS.some((name) => name === event)) return;
	if (event === "SessionStart" && !["startup", "resume", "clear", "fork"].includes(text(input["source"], "startup")))
		return;
	return event as HookEvent;
}
export function normalizeHook(input: Record<string, unknown>): Record<string, unknown> | undefined {
	const event = hookEvent(input),
		session = text(input["session_id"]);
	if (!event || !session || session.includes("\u0000")) return;
	return { ...input, hook_event_name: event };
}

export function rootSession(session: string): string {
	return session.split(separator)[0] ?? session;
}

export function hookSession(input: Record<string, unknown>): string {
	const parent = text(input["session_id"]);
	const event = text(input["hook_event_name"]);
	const agent = text(input["agent_id"]);
	if (event === "SessionStart" || event === "SessionEnd" || event === "Stop" || event === "Interrupt") return parent;
	if (event === "PostToolUse" && !agent) return parent; // Unknown ownership is shared; only the main Stop aggregates it.
	return `${parent}${separator}${agent ? `agent:${agent}` : "shared"}`;
}

export function internalHook(input: Record<string, unknown>): Record<string, unknown> {
	return { ...input, session_id: hookSession(input), parent_session_id: text(input["session_id"]) };
}

export function isActorSession(session: string): boolean {
	return session.includes(separator);
}

export function actorLabel(session: string): string {
	return session.split(separator)[1] ?? "main";
}
