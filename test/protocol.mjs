import assert from "node:assert/strict";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** @param {string} text @returns {Record<string, unknown>} */
export function parseRecord(text) {
	/** @type {unknown} */
	const value = JSON.parse(text);
	assert(record(value), "Expected a JSON object");
	return value;
}
/** @template {string} N @param {unknown} value @returns {import("./protocol-types.js").McpResult<N>} */
export function mcpResult(value) {
	assert(record(value), "Expected MCP result object");
	assert(Array.isArray(value["content"]) && value["content"].length > 0, "Expected MCP content");
	for (const item of value["content"]) assert(record(item) && typeof item["text"] === "string");
	assert(record(value["structuredContent"]), "Expected structured MCP output");
	return /** @type {import("./protocol-types.js").McpResult<N>} */ (/** @type {unknown} */ (value));
}

/** @param {unknown} value @returns {import("./protocol-types.js").NavigationItem[]} */
export function navigationArray(value) {
	assert(Array.isArray(value));
	for (const item of value) {
		assert(record(item));
		for (const key of ["path", "symbol", "label"]) assert(item[key] === undefined || typeof item[key] === "string");
		if (item["from"] !== undefined) { assert(record(item["from"])); assert(item["from"]["path"] === undefined || typeof item["from"]["path"] === "string"); }
	}
	return /** @type {import("./protocol-types.js").NavigationItem[]} */ (value);
}
