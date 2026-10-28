import { randomUUID } from "node:crypto";
import { hash } from "./files.js";
import { record } from "./results.js";

const LIMIT = 6200;
function bytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value));
}
function bounded(value: unknown): boolean {
	if (Array.isArray(value)) return value.length <= 20 && value.every(bounded);
	if (record(value)) return Object.values(value).every(bounded);
	return true;
}
// Large values are represented losslessly by field paths and ordered text parts.
function fragments(value: unknown, field = "result"): unknown[] {
	if (bytes(value) < 3000 && bounded(value)) return [{ field, value }];
	if (Array.isArray(value)) return value.flatMap((item, index) => fragments(item, `${field}[${index}]`));
	if (record(value))
		return Object.entries(value).flatMap(([key, item]) => fragments(item, `${field}[${JSON.stringify(key)}]`));
	if (typeof value === "string") {
		const characters = Array.from(value);
		return Array.from({ length: Math.ceil(characters.length / 400) }, (_, part) => ({
			field,
			part,
			text: characters.slice(part * 400, (part + 1) * 400).join(""),
		}));
	}
	return [{ field, value }];
}
interface Page {
	identity: string;
	query: string;
	args: Record<string, unknown>;
	header: Record<string, unknown>;
	items: unknown[];
	index: number;
	weight: number;
	continuation?: Record<string, unknown>;
}
export class OutputPages {
	private readonly pages = new Map<string, Page>();
	constructor(private readonly prefix = "") {}
	clear(): void {
		this.pages.clear();
	}
	arguments(cursor: string): Record<string, unknown> {
		return this.pages.get(cursor)?.args ?? {};
	}
	private query(args: Record<string, unknown>): string {
		return hash(
			JSON.stringify(
				Object.entries(args)
					.filter(([key, value]) => key !== "cursor" && key !== "refresh" && value !== undefined)
					.sort(([a], [b]) => a.localeCompare(b)),
			),
		);
	}
	read(args: Record<string, unknown>, identity: string, operation?: string): Record<string, unknown> {
		const page = this.pages.get(String(args["cursor"]));
		if (
			!page ||
			page.identity !== identity ||
			page.query !== this.query({ ...page.args, ...args }) ||
			(operation !== undefined && page.header["operation"] !== operation)
		)
			throw new Error("Cursor invalid: query, workspace, configuration or tools changed; repeat the original query");
		return this.emit({ ...page });
	}
	write(output: Record<string, unknown>, args: Record<string, unknown>, identity: string): Record<string, unknown> {
		if (bytes(output) > 32 * 1024 * 1024) throw new Error("Output exceeds retained page budget; narrow query");
		if (bytes(output) <= LIMIT && bounded(output)) return output;
		const header: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(output))
			if (
				[
					"operation",
					"status",
					"state",
					"job",
					"plan",
					"partial",
					"errors",
					"warnings",
					"isError",
					"configuration",
					"clients",
					"service",
				].includes(key) &&
				bytes(value) < 700 &&
				bytes(header) + bytes(value) < 1800
			)
				header[key] = value;
		return this.emit({
			identity,
			query: this.query(args),
			args,
			header,
			items: fragments(
				Object.fromEntries(Object.entries(output).filter(([key]) => !(key in header) && key !== "next")),
			),
			index: 0,
			weight: bytes(output),
			...(record(output["next"]) ? { continuation: output["next"] } : {}),
		});
	}
	private emit(page: Page): Record<string, unknown> {
		const items: unknown[] = [];
		while (page.index < page.items.length && items.length < 20) {
			const item = page.items[page.index];
			if (bytes({ ...page.header, items: [...items, item] }) > LIMIT - 1000) break;
			items.push(item);
			page.index++;
		}
		if (!items.length && page.index < page.items.length) throw new Error("Output item exceeds page budget");
		let next: Record<string, unknown> | undefined;
		if (page.index < page.items.length) {
			const cursor = this.prefix + randomUUID();
			this.pages.set(cursor, { ...page, index: page.index });
			const memory = () => {
				const unique = new Map<unknown[], number>();
				for (const page of this.pages.values()) unique.set(page.items, page.weight);
				return [...unique.values()].reduce((sum, size) => sum + size, 0);
			};
			while (this.pages.size > 32 || memory() > 32 * 1024 * 1024)
				this.pages.delete(this.pages.keys().next().value ?? "");
			next = {
				workspace: page.args["workspace"],
				...(page.args["operation"] ? { operation: page.args["operation"] } : {}),
				cursor,
			};
		} else next = page.continuation;
		return { ...page.header, paged: true, items, total: page.items.length, ...(next ? { next } : {}) };
	}
}
