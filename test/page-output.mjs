import assert from "node:assert/strict";
import { mcpResult, record } from "./protocol.mjs";

// Reconstruct field fragments for assertions. Every traversed JSON node is checked.
/** @template {string} N @param {import("./protocol-types.js").McpResult<N>} first @param {(args: import("./protocol-types.js").Arguments) => Promise<import("./protocol-types.js").McpResult<N>>} nextPage @returns {Promise<import("./protocol-types.js").McpResult<N>>} */
export async function completeOutput(first, nextPage) {
	if (!first.structuredContent.paged) return first;
	/** @type {Record<string, unknown>} */
	const output = {};
	let page = first;
	for (;;) {
		const data = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (page.structuredContent));
		for (const [key, value] of Object.entries(data)) if (!["items", "total", "next", "paged"].includes(key)) output[key] = value;
		assert(Array.isArray(data["items"]));
		for (const item of data["items"]) {
			assert(record(item) && typeof item["field"] === "string");
			/** @type {(string | number)[]} */
			const path = [];
			for (const match of item["field"].slice("result".length).matchAll(/\[("(?:\\.|[^"\\])*"|\d+)\]/g)) {
				assert(match[1] !== undefined);
				/** @type {unknown} */ const key = JSON.parse(match[1]);
				assert(typeof key === "string" || typeof key === "number"); path.push(key);
			}
			if (!path.length) { assert(record(item["value"])); Object.assign(output, item["value"]); continue; }
			/** @type {object} */ let target = output;
			for (let index = 0; index < path.length - 1; index++) {
				const key = path[index]; assert(key !== undefined);
				/** @type {unknown} */ let child = Reflect.get(target, key);
				if (child === undefined) { child = typeof path[index + 1] === "number" ? [] : {}; Reflect.set(target, key, child); }
				assert(record(child) || Array.isArray(child)); target = child;
			}
			const key = path.at(-1); assert(key !== undefined);
			if ("text" in item) {
				const previous = Reflect.get(target, key) ?? "";
				assert(typeof previous === "string" && typeof item["text"] === "string");
				Reflect.set(target, key, previous + item["text"]);
			} else Reflect.set(target, key, item["value"]);
		}
		const next = data["next"];
		if (!record(next) || !/^(view|detail):/.test(String(next["cursor"]))) {
			if (next) output["next"] = next;
			return mcpResult({ ...first, structuredContent: output });
		}
		page = await nextPage(next);
		if (page.isError && !page.structuredContent.paged) return page;
	}
}
