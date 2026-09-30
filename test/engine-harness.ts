// Dependency adapters for the production Engine/HookEngine paths.
import { Engine as ProductionEngine } from "../src/engine.js";
import { HookEngine as ProductionHook, renderHook } from "../src/hook-engine.js";
import { Metadata } from "../src/metadata.js";
import { type FileResult, render } from "../src/results.js";

type Checker = (path: string, signal: AbortSignal, lspOnly: boolean) => Promise<FileResult>;
export class Engine {
	private readonly engine: ProductionEngine;
	constructor(root: string, checker?: Checker) {
		this.engine = new ProductionEngine(
			root,
			checker
				? {
						checkBatch: async (paths, _config, source, signal) =>
							Promise.all(
								paths.map(async (path) => {
									const result = await checker(path, signal, source === "lsp");
									return { result, lsp: result, lint: result };
								}),
							),
					}
				: undefined,
		);
	}
	async dispatch(...args: Parameters<ProductionEngine["dispatch"]>): Promise<string> {
		const result = await this.engine.dispatch(...args);
		return JSON.stringify({
			...result,
			...(Array.isArray(result["results"])
				? {
						text: `${result["partial"] ? "partial; " : ""}${render(result["results"] as FileResult[])}${result["inventoryComplete"] === false ? " Dependency inventory incomplete; workspace dependency freshness unverified" : ""}`,
					}
				: {}),
		});
	}
	close(): Promise<void> {
		return this.engine.close();
	}
	dispose(): Promise<void> {
		return this.engine.dispose();
	}
}
export class HookEngine {
	private readonly engine: ProductionHook;
	constructor(root: string, checker: Checker = async (path) => ({ path, state: "complete", findings: [] })) {
		const store = new Metadata(root);
		this.engine = new ProductionHook(root, {
			projects: {
				baseline: async (session) => {
					const reference = await store.shared({ results: [], identity: "test baseline" });
					await store.update(session, new AbortController().signal, (state) => {
						state.diagnosticBaseline = reference;
					});
					return { reference, findings: [], failures: [], pending: [] };
				},
			},
			check: async (paths, _session, _turn, generation, _wait, signal) => {
				const results = await Promise.all(paths.map((path) => checker(path, signal, false)));
				return {
					generation,
					results: signal.aborted ? results.map((result) => ({ ...result, state: "pending" })) : results,
					note: "",
				};
			},
			end: () => undefined,
		});
	}
	async hook(...args: Parameters<ProductionHook["hook"]>): Promise<string> {
		const output = renderHook(await this.engine.hook(...args));
		return output ? JSON.stringify(output) : "";
	}
}
