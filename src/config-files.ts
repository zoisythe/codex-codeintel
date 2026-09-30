import { basename } from "node:path";

export type Impact = "types" | "lint" | "format";
const exact: Record<string, readonly Impact[]> = {
	"package.json": ["types", "lint"],
	"package-lock.json": ["types", "lint"],
	"pnpm-lock.yaml": ["types", "lint"],
	"yarn.lock": ["types", "lint"],
	"Cargo.toml": ["types"],
	"Cargo.lock": ["types"],
	"rust-toolchain": ["types"],
	"rust-toolchain.toml": ["types"],
	"pyproject.toml": ["types", "lint", "format"],
	"uv.lock": ["types", "lint"],
	"ty.toml": ["types"],
	"pyrightconfig.json": ["types"],
	"ruff.toml": ["lint", "format"],
	".ruff.toml": ["lint", "format"],
	"biome.json": ["lint", "format"],
	"biome.jsonc": ["lint", "format"],
	".clangd": ["types"],
	"compile_commands.json": ["types"],
	"compile_flags.txt": ["types"],
	".clang-format": ["format"],
	"rustfmt.toml": ["format"],
	".rustfmt.toml": ["format"],
	"go.mod": ["types"],
	"go.sum": ["types"],
	"lsp-client.json": ["types", "lint", "format"],
};
export function configurationImpact(path: string): readonly Impact[] {
	const name = basename(path);
	if (/^(?:tsconfig|jsconfig)(?:\.[^.]+)*\.json$/.test(name)) return ["types"];
	if (/^(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.(?:json|ya?ml|[cm]?js))?)$/.test(name)) return ["lint"];
	return exact[name] ?? [];
}
export function configNames(): string[] {
	return Object.keys(exact);
}

export function configurationLanguages(path: string): readonly string[] {
	const name = basename(path);
	if (configurationImpact(path).length === 0) return [];
	if (/^(?:eslint\.config\.|\.eslintrc|biome\.json)/.test(name)) return ["typescript"];
	if (["ruff.toml", ".ruff.toml"].includes(name)) return ["python"];
	if (["rustfmt.toml", ".rustfmt.toml"].includes(name)) return ["rust"];
	if (name === ".clang-format") return ["cpp"];
	if (/^(?:Cargo\.|rust-toolchain)/.test(name)) return ["rust"];
	if (/^(?:tsconfig|jsconfig|package|pnpm-lock|yarn\.lock)/.test(name)) return ["typescript"];
	if (["pyproject.toml", "uv.lock", "ty.toml", "pyrightconfig.json"].includes(name)) return ["python"];
	if ([".clangd", "compile_commands.json", "compile_flags.txt"].includes(name)) return ["cpp"];
	if (["go.mod", "go.sum"].includes(name)) return ["go"];
	return [];
}
