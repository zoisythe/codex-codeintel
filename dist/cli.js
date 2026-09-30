#!/usr/bin/env node

// src/codex-hook.ts
import { realpath as realpath7 } from "node:fs/promises";
import { stdin } from "node:process";

// src/hook-engine.ts
import { readFile as readFile13 } from "node:fs/promises";

// src/config.ts
import { readFile as readFile3 } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute as isAbsolute3, join as join2 } from "node:path";

// packages/lsp-tools-mcp/dist/lsp/server-definitions.js
var BUILTIN_SERVERS = {
  typescript: {
    command: ["typescript-language-server", "--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]
  },
  deno: { command: ["deno", "lsp"], extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"] },
  vue: { command: ["vue-language-server", "--stdio"], extensions: [".vue"] },
  eslint: {
    command: ["vscode-eslint-language-server", "--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue"]
  },
  oxlint: {
    command: ["oxlint", "--lsp"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".astro", ".svelte"]
  },
  biome: {
    command: ["biome", "lsp-proxy", "--stdio"],
    extensions: [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".mts",
      ".cts",
      ".json",
      ".jsonc",
      ".vue",
      ".astro",
      ".svelte",
      ".css",
      ".graphql",
      ".gql",
      ".html"
    ]
  },
  gopls: { command: ["gopls"], extensions: [".go"] },
  "ruby-lsp": {
    command: ["rubocop", "--lsp"],
    extensions: [".rb", ".rake", ".gemspec", ".ru"]
  },
  basedpyright: {
    command: ["basedpyright-langserver", "--stdio"],
    extensions: [".py", ".pyi"]
  },
  pyright: { command: ["pyright-langserver", "--stdio"], extensions: [".py", ".pyi"] },
  ty: { command: ["ty", "server"], extensions: [".py", ".pyi"] },
  ruff: { command: ["ruff", "server"], extensions: [".py", ".pyi"] },
  "elixir-ls": { command: ["elixir-ls"], extensions: [".ex", ".exs"] },
  zls: { command: ["zls"], extensions: [".zig", ".zon"] },
  csharp: { command: ["csharp-ls"], extensions: [".cs"] },
  fsharp: { command: ["fsautocomplete"], extensions: [".fs", ".fsi", ".fsx", ".fsscript"] },
  "sourcekit-lsp": { command: ["sourcekit-lsp"], extensions: [".swift", ".objc", ".objcpp"] },
  rust: { command: ["rust-analyzer"], extensions: [".rs"] },
  clangd: {
    command: ["clangd", "--background-index", "--clang-tidy"],
    extensions: [".c", ".cpp", ".cc", ".cxx", ".c++", ".h", ".hpp", ".hh", ".hxx", ".h++"]
  },
  svelte: { command: ["svelteserver", "--stdio"], extensions: [".svelte"] },
  astro: { command: ["astro-ls", "--stdio"], extensions: [".astro"] },
  bash: {
    command: ["bash-language-server", "start"],
    extensions: [".sh", ".bash", ".zsh", ".ksh"]
  },
  "bash-ls": {
    command: ["bash-language-server", "start"],
    extensions: [".sh", ".bash", ".zsh", ".ksh"]
  },
  jdtls: { command: ["jdtls"], extensions: [".java"] },
  "yaml-ls": { command: ["yaml-language-server", "--stdio"], extensions: [".yaml", ".yml"] },
  "lua-ls": { command: ["lua-language-server"], extensions: [".lua"] },
  php: { command: ["intelephense", "--stdio"], extensions: [".php"] },
  dart: { command: ["dart", "language-server", "--lsp"], extensions: [".dart"] },
  terraform: { command: ["terraform-ls", "serve"], extensions: [".tf", ".tfvars"] },
  "terraform-ls": { command: ["terraform-ls", "serve"], extensions: [".tf", ".tfvars"] },
  prisma: { command: ["prisma", "language-server"], extensions: [".prisma"] },
  "ocaml-lsp": { command: ["ocamllsp"], extensions: [".ml", ".mli"] },
  texlab: { command: ["texlab"], extensions: [".tex", ".bib"] },
  dockerfile: { command: ["docker-langserver", "--stdio"], extensions: [".dockerfile"] },
  gleam: { command: ["gleam", "lsp"], extensions: [".gleam"] },
  "clojure-lsp": {
    command: ["clojure-lsp", "listen"],
    extensions: [".clj", ".cljs", ".cljc", ".edn"]
  },
  nixd: { command: ["nixd"], extensions: [".nix"] },
  tinymist: { command: ["tinymist"], extensions: [".typ", ".typc"] },
  "haskell-language-server": {
    command: ["haskell-language-server-wrapper", "--lsp"],
    extensions: [".hs", ".lhs"]
  },
  "kotlin-ls": { command: ["kotlin-lsp"], extensions: [".kt", ".kts"] }
};

// src/environment.ts
import { AsyncLocalStorage } from "node:async_hooks";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
function restoreInstalledHome(script = fileURLToPath(import.meta.url)) {
  if (process.env["CODEX_HOME"]) return;
  let child = dirname(script);
  for (let parent = dirname(child); parent !== child; parent = dirname(child)) {
    if (basename(parent) === "plugins" && basename(child) === "cache") {
      process.env["CODEX_HOME"] = dirname(parent);
      return;
    }
    child = parent;
  }
}
var executions = new AsyncLocalStorage();
function executionEnvironment() {
  return executions.getStore()?.environment ?? process.env;
}
function automaticExecution() {
  return executions.getStore()?.automatic ?? false;
}
function withExecution(environment, automatic, action) {
  return executions.run({ environment, automatic }, action);
}

// src/files.ts
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

// src/metrics.ts
var samples = /* @__PURE__ */ new Map();
async function measured(name, action) {
  const start = performance.now();
  try {
    return await action();
  } finally {
    const values = samples.get(name) ?? [];
    values.push(performance.now() - start);
    if (values.length > 128) values.shift();
    samples.set(name, values);
  }
}
function timings() {
  return Object.fromEntries(
    [...samples].map(([name, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return [
        name,
        {
          count: values.length,
          medianMs: sorted[Math.floor(sorted.length / 2)],
          p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]
        }
      ];
    })
  );
}

// src/files.ts
var exec = promisify(execFile);
var SKIP = /* @__PURE__ */ new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  ".canon",
  ".venv",
  ".ruff_cache",
  ".mypy_cache",
  ".pytest_cache",
  "__pycache__",
  "vendor",
  "target"
]);
var hash = (text2) => createHash("sha256").update(text2).digest("hex");
function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
async function workspacePath(root, path) {
  const absolute = resolve(root, path);
  if (!inside(root, absolute)) throw new Error("Path is outside workspace");
  const actual = await realpath(absolute);
  if (!inside(root, actual)) throw new Error("Symlink is outside workspace");
  return actual;
}
async function inventory(...args) {
  return measured("discovery/hash", () => scanInventory(...args));
}
async function scanInventory(root, maxFiles = 1e4, signal, exclude = [], scope2 = root, dependencyOnly = false) {
  signal?.throwIfAborted();
  const included = (name) => !name.split(/[\\/]/).some((part) => SKIP.has(part)) && !exclude.some((pattern) => matchesGlob(name.split(sep).join("/"), pattern));
  let names;
  let complete = true;
  try {
    const { stdout } = await exec(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."],
      {
        cwd: scope2,
        env: executionEnvironment(),
        timeout: 5e3,
        maxBuffer: 4 * 1024 * 1024,
        ...signal ? { signal } : {}
      }
    );
    names = [
      ...new Set(
        stdout.split("\0").filter(Boolean).map((name) => relative(root, join(scope2, name)))
      )
    ].filter(included);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Error && "killed" in error && error.killed)
      throw new Error("Git discovery timed out; baseline retained");
    names = [];
    const walk = async (dir) => {
      for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name)
      )) {
        signal?.throwIfAborted();
        if (names.length > maxFiles) {
          complete = false;
          break;
        }
        if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && included(relative(root, path))) names.push(relative(root, path));
      }
    };
    await walk(scope2);
  }
  const files = /* @__PURE__ */ new Map();
  names.sort();
  if (names.length > maxFiles) complete = false;
  if (!complete && dependencyOnly) return { files, complete: false, version: hash(JSON.stringify(names)) };
  for (const name of names.slice(0, maxFiles)) {
    signal?.throwIfAborted();
    if (name.split(/[\\/]/).some((part) => SKIP.has(part))) continue;
    try {
      const path = await workspacePath(root, name);
      const stat6 = await lstat(path);
      if (!stat6.isFile()) continue;
      if (stat6.size > 1024 * 1024) {
        complete = false;
        continue;
      }
      files.set(
        relative(root, path),
        hash(await readFile(path, { encoding: "utf8", ...signal ? { signal } : {} }))
      );
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) complete = false;
    }
  }
  return { files, version: hash(JSON.stringify([...files])), complete };
}
function applyTextChanges(text2, edits) {
  const lines = text2.split("\n");
  const offset = (line, character) => {
    if (!Number.isInteger(line) || !Number.isInteger(character) || line < 0 || character < 0 || line >= lines.length || character > (lines[line]?.length ?? 0))
      throw new Error("Invalid edit range");
    return lines.slice(0, line).reduce((n, part) => n + part.length + 1, 0) + character;
  };
  const sorted = edits.map((edit) => ({
    start: offset(edit.range.start.line, edit.range.start.character),
    end: offset(edit.range.end.line, edit.range.end.character),
    text: edit.newText
  })).sort((a, b) => b.start - a.start || b.end - a.end);
  let boundary = text2.length;
  for (const edit of sorted) {
    if (edit.start > edit.end || edit.end > boundary) throw new Error("Overlapping edit ranges");
    text2 = text2.slice(0, edit.start) + edit.text + text2.slice(edit.end);
    boundary = edit.start;
  }
  return text2;
}

// src/results.ts
var WriteFailure = class extends Error {
  constructor(reason, modifiedPaths) {
    super(reason);
    this.modifiedPaths = modifiedPaths;
  }
};
function message(error) {
  return error instanceof Error ? error.message : String(error);
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}
function number(value, fallback, min = 0, max = 1e4) {
  if (value === void 0) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new Error(`Expected integer ${min}..${max}`);
  return value;
}
function render(results, limit = 50, byteLimit = 8192, offset = 0) {
  const lines = [
    ...new Set(
      results.flatMap((result) => [
        ...result.channels ? [
          `${result.path} channels: lsp=${result.channels.lsp} lint=${result.channels.lint}${result.note ? `; ${result.note.replace(/\s+/g, " ").slice(0, 300)}` : ""}`
        ] : [],
        ...result.findings.map(
          (finding) => `${finding.path}:${finding.line}:${finding.column} ${finding.severity} [${finding.source}] ${finding.message.replace(/\s+/g, " ")}`
        ),
        ...result.state === "complete" ? [] : [
          `${result.path} ${result.state}${result.note ? `: ${result.note.replace(/\s+/g, " ").slice(0, 300)}` : ""}`
        ]
      ])
    )
  ].sort((a, b) => Number(!a.includes(" error [")) - Number(!b.includes(" error [")) || a.localeCompare(b));
  const complete = results.every((result) => result.state === "complete");
  const header = `${complete ? "complete" : "partial"}; checked=${results.filter((result) => result.state === "complete").length} pending=${results.filter((result) => result.state === "pending" || result.state === "stale").length} skipped=${results.filter((result) => result.state === "skipped").length} failed=${results.filter((result) => result.state === "failed").length}`;
  let output = header;
  let shown = 0;
  for (const line of lines.slice(offset, offset + limit)) {
    const clipped = line.slice(0, 1e3);
    if (Buffer.byteLength(output + clipped) > byteLimit - 180) break;
    output += `
${clipped}`;
    shown++;
  }
  if (offset + shown < lines.length)
    output += `
${lines.length - offset - shown} omitted; next offset=${offset + shown}`;
  return output;
}
function mergeFindings(findings) {
  const entries = /* @__PURE__ */ new Map();
  for (const finding of findings) {
    const key = JSON.stringify([finding.path, finding.line, finding.column, finding.severity, finding.message]);
    const old = entries.get(key);
    if (old) old.sources = [.../* @__PURE__ */ new Set([...old.sources ?? [old.source], finding.source])];
    else entries.set(key, { ...finding });
  }
  return [...entries.values()].sort((a, b) => Number(a.severity !== "error") - Number(b.severity !== "error"));
}
function failureKind(reason) {
  if (/Migration|configuration|schemaVersion|Extension conflict|Unknown built-in|Invalid (?:lsp|lint|formatting)|lsp\.\w+.*(?:must be|requires)|trustedWorkspaces requires|exclude requires/i.test(
    reason
  ))
    return "configuration_error";
  if (/disabled or unsupported|unsupported:/i.test(reason)) return "unsupported";
  if (/timeout|time.*budget/i.test(reason)) return "timeout";
  if (/cancel|abort/i.test(reason)) return "cancelled";
  if (/missing|unavailable|NOT INSTALLED/i.test(reason)) return "tool_missing";
  if (/offline|download|failed to fetch/i.test(reason)) return "temporary_launch_failed";
  if (/initializ/i.test(reason)) return "initialization_failed";
  return "execution_failed";
}

// src/trust.ts
import { readFile as readFile2, realpath as realpath2 } from "node:fs/promises";
import { isAbsolute as isAbsolute2 } from "node:path";

// node_modules/smol-toml/dist/date.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
var DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})?[T ]?(?:(\d{2}):\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|[-+]\d{2}:\d{2})?$/i;
var TomlDate = class _TomlDate extends Date {
  #hasDate = false;
  #hasTime = false;
  #offset = null;
  constructor(date) {
    let hasDate = true;
    let hasTime = true;
    let offset = "Z";
    if (typeof date === "string") {
      let match = date.match(DATE_TIME_RE);
      if (match) {
        if (!match[1]) {
          hasDate = false;
          date = `0000-01-01T${date}`;
        }
        hasTime = !!match[2];
        hasTime && date[10] === " " && (date = date.replace(" ", "T"));
        if (match[2] && +match[2] > 23) {
          date = "";
        } else {
          offset = match[3] || null;
          date = date.toUpperCase();
          if (!offset && hasTime)
            date += "Z";
        }
      } else {
        date = "";
      }
    }
    super(date);
    if (!isNaN(this.getTime())) {
      this.#hasDate = hasDate;
      this.#hasTime = hasTime;
      this.#offset = offset;
    }
  }
  isDateTime() {
    return this.#hasDate && this.#hasTime;
  }
  isLocal() {
    return !this.#hasDate || !this.#hasTime || !this.#offset;
  }
  isDate() {
    return this.#hasDate && !this.#hasTime;
  }
  isTime() {
    return this.#hasTime && !this.#hasDate;
  }
  isValid() {
    return this.#hasDate || this.#hasTime;
  }
  toISOString() {
    let iso = super.toISOString();
    if (this.isDate())
      return iso.slice(0, 10);
    if (this.isTime())
      return iso.slice(11, 23);
    if (this.#offset === null)
      return iso.slice(0, -1);
    if (this.#offset === "Z")
      return iso;
    let offset = +this.#offset.slice(1, 3) * 60 + +this.#offset.slice(4, 6);
    offset = this.#offset[0] === "-" ? offset : -offset;
    let offsetDate = new Date(this.getTime() - offset * 6e4);
    return offsetDate.toISOString().slice(0, -1) + this.#offset;
  }
  static wrapAsOffsetDateTime(jsDate, offset = "Z") {
    let date = new _TomlDate(jsDate);
    date.#offset = offset;
    return date;
  }
  static wrapAsLocalDateTime(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#offset = null;
    return date;
  }
  static wrapAsLocalDate(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#hasTime = false;
    date.#offset = null;
    return date;
  }
  static wrapAsLocalTime(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#hasDate = false;
    date.#offset = null;
    return date;
  }
};

// node_modules/smol-toml/dist/error.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
function getLineColFromPtr(string2, ptr) {
  let lines = string2.slice(0, ptr).split(/\r\n|\n|\r/g);
  return [lines.length, lines.pop().length + 1];
}
function makeCodeBlock(string2, line, column) {
  let lines = string2.split(/\r\n|\n|\r/g);
  let codeblock = "";
  let numberLen = (Math.log10(line + 1) | 0) + 1;
  for (let i = line - 1; i <= line + 1; i++) {
    let l = lines[i - 1];
    if (!l)
      continue;
    codeblock += i.toString().padEnd(numberLen, " ");
    codeblock += ":  ";
    codeblock += l;
    codeblock += "\n";
    if (i === line) {
      codeblock += " ".repeat(numberLen + column + 2);
      codeblock += "^\n";
    }
  }
  return codeblock;
}
var TomlError = class extends Error {
  line;
  column;
  codeblock;
  constructor(message2, options) {
    const [line, column] = getLineColFromPtr(options.toml, options.ptr);
    const codeblock = makeCodeBlock(options.toml, line, column);
    super(`Invalid TOML document: ${message2}

${codeblock}`, options);
    this.line = line;
    this.column = column;
    this.codeblock = codeblock;
  }
};

// node_modules/smol-toml/dist/primitive.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
var INT_REGEX = /^((0x[0-9a-fA-F](_?[0-9a-fA-F])*)|(([+-]|0[ob])?\d(_?\d)*))$/;
var FLOAT_REGEX = /^[+-]?\d(_?\d)*(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/;
var LEADING_ZERO = /^[+-]?0[0-9_]/;
function parseString(str, ptr) {
  let c = str[ptr++];
  let first = c;
  let isLiteral = c === "'";
  let isMultiline = c === str[ptr] && c === str[ptr + 1];
  if (isMultiline) {
    if (str[ptr += 2] === "\n")
      ptr++;
    else if (str[ptr] === "\r" && str[ptr + 1] === "\n")
      ptr += 2;
  }
  let parsed = "";
  let sliceStart = ptr;
  let state = 0;
  for (let i = ptr; i < str.length; i++) {
    c = str[i];
    if (isMultiline && (c === "\n" || c === "\r" && str[i + 1] === "\n")) {
      state = state && 3;
    } else if (c < " " && c !== "	" || c === "\x7F") {
      throw new TomlError("control characters are not allowed in strings", {
        toml: str,
        ptr: i
      });
    } else if ((!state || state === 3) && c === first && (!isMultiline || str[i + 1] === first && str[i + 2] === first)) {
      if (isMultiline) {
        if (str[i + 3] === first)
          i++;
        if (str[i + 3] === first)
          i++;
      }
      return [
        // If we're in a newline escape still, then there's nothing to add.
        // Also try to avoid concat if there's nothing to add to parsed, or nothing has been added to parsed.
        state ? parsed : parsed + str.slice(sliceStart, i),
        i + (isMultiline ? 3 : 1)
      ];
    } else if (!state) {
      if (!isLiteral && c === "\\") {
        parsed += str.slice(sliceStart, sliceStart = i);
        state = 1;
      }
    } else if (state === 1) {
      if (c === "x" || c === "u" || c === "U") {
        let value = 0;
        let len = c === "x" ? 2 : c === "u" ? 4 : 8;
        for (let j = 0; j < len; j++, i++) {
          let hex = str.charCodeAt(i + 1);
          let digit = (
            /* 0-9 */
            hex >= 48 && hex <= 57 ? hex - 48 : (
              /* A-F */
              hex >= 65 && hex <= 70 ? hex - 65 + 10 : (
                /* a-f */
                hex >= 97 && hex <= 102 ? hex - 97 + 10 : -1
              )
            )
          );
          if (digit < 0)
            throw new TomlError("invalid non-hex character in unicode escape", { toml: str, ptr: i + 1 });
          value = value << 4 | digit;
        }
        if (value < 0 || value > 1114111 || value >= 55296 && value <= 57343) {
          throw new TomlError("invalid unicode escape", { toml: str, ptr: i });
        }
        parsed += String.fromCodePoint(value);
        sliceStart = i + 1;
        state = 0;
      } else if (c === " " || c === "	") {
        state = 2;
      } else {
        if (c === "b")
          parsed += "\b";
        else if (c === "t")
          parsed += "	";
        else if (c === "n")
          parsed += "\n";
        else if (c === "f")
          parsed += "\f";
        else if (c === "r")
          parsed += "\r";
        else if (c === "e")
          parsed += "\x1B";
        else if (c === '"')
          parsed += '"';
        else if (c === "\\")
          parsed += "\\";
        else
          throw new TomlError("unrecognized escape sequence", { toml: str, ptr: i });
        sliceStart = i + 1;
        state = 0;
      }
    } else if (c !== " " && c !== "	") {
      if (state === 2) {
        throw new TomlError("invalid escape: only line-ending whitespace may be escaped", {
          toml: str,
          ptr: sliceStart
        });
      }
      state = !isLiteral && c === "\\" ? 1 : 0;
      sliceStart = i;
    }
  }
  throw new TomlError("unfinished string", { toml: str, ptr });
}
function parseValue(value, toml, ptr, integersAsBigInt) {
  if (value === "true")
    return true;
  if (value === "false")
    return false;
  if (value === "-inf")
    return -Infinity;
  if (value === "inf" || value === "+inf")
    return Infinity;
  if (value === "nan" || value === "+nan" || value === "-nan")
    return NaN;
  if (value === "-0")
    return integersAsBigInt ? 0n : 0;
  let isInt = INT_REGEX.test(value);
  if (isInt || FLOAT_REGEX.test(value)) {
    if (LEADING_ZERO.test(value)) {
      throw new TomlError("leading zeroes are not allowed", {
        toml,
        ptr
      });
    }
    value = value.replace(/_/g, "");
    let numeric = +value;
    if (isNaN(numeric)) {
      throw new TomlError("invalid number", {
        toml,
        ptr
      });
    }
    if (isInt) {
      if ((isInt = !Number.isSafeInteger(numeric)) && !integersAsBigInt) {
        throw new TomlError("integer value cannot be represented losslessly", {
          toml,
          ptr
        });
      }
      if (isInt || integersAsBigInt === true)
        numeric = BigInt(value);
    }
    return numeric;
  }
  const date = new TomlDate(value);
  if (!date.isValid()) {
    throw new TomlError("invalid value", {
      toml,
      ptr
    });
  }
  return date;
}

// node_modules/smol-toml/dist/util.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
function indexOfNewline(str, start = 0, end = str.length) {
  let idx = str.indexOf("\n", start);
  if (str[idx - 1] === "\r")
    idx--;
  return idx <= end ? idx : -1;
}
function skipComment(str, ptr) {
  for (let i = ptr; i < str.length; i++) {
    let c = str[i];
    if (c === "\n")
      return i;
    if (c === "\r" && str[i + 1] === "\n")
      return i + 1;
    if (c < " " && c !== "	" || c === "\x7F") {
      throw new TomlError("control characters are not allowed in comments", {
        toml: str,
        ptr
      });
    }
  }
  return str.length;
}
function skipVoid(str, ptr, banNewLines, banComments) {
  let c;
  while (1) {
    while ((c = str[ptr]) === " " || c === "	" || !banNewLines && (c === "\n" || c === "\r" && str[ptr + 1] === "\n"))
      ptr++;
    if (banComments || c !== "#")
      break;
    ptr = skipComment(str, ptr);
  }
  return ptr;
}
function skipUntil(str, ptr, sep3, end, banNewLines = false) {
  if (!end) {
    ptr = indexOfNewline(str, ptr);
    return ptr < 0 ? str.length : ptr;
  }
  for (let i = ptr; i < str.length; i++) {
    let c = str[i];
    if (c === "#") {
      i = indexOfNewline(str, i);
    } else if (c === sep3) {
      return i + 1;
    } else if (c === end || banNewLines && (c === "\n" || c === "\r" && str[i + 1] === "\n")) {
      return i;
    }
  }
  throw new TomlError("cannot find end of structure", {
    toml: str,
    ptr
  });
}

// node_modules/smol-toml/dist/extract.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
function sliceAndTrimEndOf(str, startPtr, endPtr) {
  let value = str.slice(startPtr, endPtr);
  let commentIdx = value.indexOf("#");
  if (commentIdx > -1) {
    skipComment(str, commentIdx);
    value = value.slice(0, commentIdx);
  }
  return [value.trimEnd(), commentIdx];
}
function extractValue(str, ptr, end, depth, integersAsBigInt) {
  if (depth === 0) {
    throw new TomlError("document contains excessively nested structures. aborting.", {
      toml: str,
      ptr
    });
  }
  let c = str[ptr];
  if (c === "[" || c === "{") {
    let [value, endPtr2] = c === "[" ? parseArray(str, ptr, depth, integersAsBigInt) : parseInlineTable(str, ptr, depth, integersAsBigInt);
    if (end) {
      endPtr2 = skipVoid(str, endPtr2);
      if (str[endPtr2] === ",")
        endPtr2++;
      else if (str[endPtr2] !== end) {
        throw new TomlError("expected comma or end of structure", {
          toml: str,
          ptr: endPtr2
        });
      }
    }
    return [value, endPtr2];
  }
  if (c === '"' || c === "'") {
    let [parsed, endPtr2] = parseString(str, ptr);
    if (end) {
      endPtr2 = skipVoid(str, endPtr2);
      if (str[endPtr2] && str[endPtr2] !== "," && str[endPtr2] !== end && str[endPtr2] !== "\n" && str[endPtr2] !== "\r") {
        throw new TomlError("unexpected character encountered", {
          toml: str,
          ptr: endPtr2
        });
      }
      if (str[endPtr2] === ",")
        endPtr2++;
    }
    return [parsed, endPtr2];
  }
  let endPtr = skipUntil(str, ptr, ",", end);
  let slice = sliceAndTrimEndOf(str, ptr, endPtr - (str[endPtr - 1] === "," ? 1 : 0));
  if (!slice[0]) {
    throw new TomlError("incomplete key-value declaration: no value specified", {
      toml: str,
      ptr
    });
  }
  if (end && slice[1] > -1) {
    endPtr = skipVoid(str, ptr + slice[1]);
    if (str[endPtr] === ",")
      endPtr++;
  }
  return [
    parseValue(slice[0], str, ptr, integersAsBigInt),
    endPtr
  ];
}

// node_modules/smol-toml/dist/struct.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
var KEY_PART_RE = /^[a-zA-Z0-9-_]+[ \t]*$/;
function parseKey(str, ptr, end = "=") {
  let dot = ptr - 1;
  let parsed = [];
  let endPtr = str.indexOf(end, ptr);
  if (endPtr < 0) {
    throw new TomlError("incomplete key-value: cannot find end of key", {
      toml: str,
      ptr
    });
  }
  do {
    let c = str[ptr = ++dot];
    if (c !== " " && c !== "	") {
      if (c === '"' || c === "'") {
        if (c === str[ptr + 1] && c === str[ptr + 2]) {
          throw new TomlError("multiline strings are not allowed in keys", {
            toml: str,
            ptr
          });
        }
        let [part, eos] = parseString(str, ptr);
        dot = str.indexOf(".", eos);
        let strEnd = str.slice(eos, dot < 0 || dot > endPtr ? endPtr : dot);
        let newLine = indexOfNewline(strEnd);
        if (newLine > -1) {
          throw new TomlError("newlines are not allowed in keys", {
            toml: str,
            ptr: ptr + dot + newLine
          });
        }
        if (strEnd.trimStart()) {
          throw new TomlError("found extra tokens after the string part", {
            toml: str,
            ptr: eos
          });
        }
        if (endPtr < eos) {
          endPtr = str.indexOf(end, eos);
          if (endPtr < 0) {
            throw new TomlError("incomplete key-value: cannot find end of key", {
              toml: str,
              ptr
            });
          }
        }
        parsed.push(part);
      } else {
        dot = str.indexOf(".", ptr);
        let part = str.slice(ptr, dot < 0 || dot > endPtr ? endPtr : dot);
        if (!KEY_PART_RE.test(part)) {
          throw new TomlError("only letter, numbers, dashes and underscores are allowed in keys", {
            toml: str,
            ptr
          });
        }
        parsed.push(part.trimEnd());
      }
    }
  } while (dot + 1 && dot < endPtr);
  return [parsed, skipVoid(str, endPtr + 1, true, true)];
}
function parseInlineTable(str, ptr, depth, integersAsBigInt) {
  let res = {};
  let seen = /* @__PURE__ */ new Set();
  let c;
  ptr++;
  while ((c = str[ptr++]) !== "}" && c) {
    if (c === ",") {
      throw new TomlError("expected value, found comma", {
        toml: str,
        ptr: ptr - 1
      });
    } else if (c === "#")
      ptr = skipComment(str, ptr);
    else if (c !== " " && c !== "	" && c !== "\n" && c !== "\r") {
      let k;
      let t = res;
      let hasOwn = false;
      let [key, keyEndPtr] = parseKey(str, ptr - 1);
      for (let i = 0; i < key.length; i++) {
        if (i)
          t = hasOwn ? t[k] : t[k] = {};
        k = key[i];
        if ((hasOwn = Object.hasOwn(t, k)) && (typeof t[k] !== "object" || seen.has(t[k]))) {
          throw new TomlError("trying to redefine an already defined value", {
            toml: str,
            ptr
          });
        }
        if (!hasOwn && k === "__proto__") {
          Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
        }
      }
      if (hasOwn) {
        throw new TomlError("trying to redefine an already defined value", {
          toml: str,
          ptr
        });
      }
      let [value, valueEndPtr] = extractValue(str, keyEndPtr, "}", depth - 1, integersAsBigInt);
      seen.add(value);
      t[k] = value;
      ptr = valueEndPtr;
    }
  }
  if (!c) {
    throw new TomlError("unfinished table encountered", {
      toml: str,
      ptr
    });
  }
  return [res, ptr];
}
function parseArray(str, ptr, depth, integersAsBigInt) {
  let res = [];
  let c;
  ptr++;
  while ((c = str[ptr++]) !== "]" && c) {
    if (c === ",") {
      throw new TomlError("expected value, found comma", {
        toml: str,
        ptr: ptr - 1
      });
    } else if (c === "#")
      ptr = skipComment(str, ptr);
    else if (c !== " " && c !== "	" && c !== "\n" && c !== "\r") {
      let e = extractValue(str, ptr - 1, "]", depth - 1, integersAsBigInt);
      res.push(e[0]);
      ptr = e[1];
    }
  }
  if (!c) {
    throw new TomlError("unfinished array encountered", {
      toml: str,
      ptr
    });
  }
  return [res, ptr];
}

// node_modules/smol-toml/dist/parse.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
function peekTable(key, table, meta, type) {
  let t = table;
  let m = meta;
  let k;
  let hasOwn = false;
  let state;
  for (let i = 0; i < key.length; i++) {
    if (i) {
      t = hasOwn ? t[k] : t[k] = {};
      m = (state = m[k]).c;
      if (type === 0 && (state.t === 1 || state.t === 2)) {
        return null;
      }
      if (state.t === 2) {
        let l = t.length - 1;
        t = t[l];
        m = m[l].c;
      }
    }
    k = key[i];
    if ((hasOwn = Object.hasOwn(t, k)) && m[k]?.t === 0 && m[k]?.d) {
      return null;
    }
    if (!hasOwn) {
      if (k === "__proto__") {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
        Object.defineProperty(m, k, { enumerable: true, configurable: true, writable: true });
      }
      m[k] = {
        t: i < key.length - 1 && type === 2 ? 3 : type,
        d: false,
        i: 0,
        c: {}
      };
    }
  }
  state = m[k];
  if (state.t !== type && !(type === 1 && state.t === 3)) {
    return null;
  }
  if (type === 2) {
    if (!state.d) {
      state.d = true;
      t[k] = [];
    }
    t[k].push(t = {});
    state.c[state.i++] = state = { t: 1, d: false, i: 0, c: {} };
  }
  if (state.d) {
    return null;
  }
  state.d = true;
  if (type === 1) {
    t = hasOwn ? t[k] : t[k] = {};
  } else if (type === 0 && hasOwn) {
    return null;
  }
  return [k, t, state.c];
}
function parse(toml, { maxDepth = 1e3, integersAsBigInt } = {}) {
  let res = {};
  let meta = {};
  let tbl = res;
  let m = meta;
  for (let ptr = skipVoid(toml, 0); ptr < toml.length; ) {
    if (toml[ptr] === "[") {
      let isTableArray = toml[++ptr] === "[";
      let k = parseKey(toml, ptr += +isTableArray, "]");
      if (isTableArray) {
        if (toml[k[1] - 1] !== "]") {
          throw new TomlError("expected end of table declaration", {
            toml,
            ptr: k[1] - 1
          });
        }
        k[1]++;
      }
      let p = peekTable(
        k[0],
        res,
        meta,
        isTableArray ? 2 : 1
        /* Type.EXPLICIT */
      );
      if (!p) {
        throw new TomlError("trying to redefine an already defined table or value", {
          toml,
          ptr
        });
      }
      m = p[2];
      tbl = p[1];
      ptr = k[1];
    } else {
      let k = parseKey(toml, ptr);
      let p = peekTable(
        k[0],
        tbl,
        m,
        0
        /* Type.DOTTED */
      );
      if (!p) {
        throw new TomlError("trying to redefine an already defined table or value", {
          toml,
          ptr
        });
      }
      let v = extractValue(toml, k[1], void 0, maxDepth, integersAsBigInt);
      p[1][p[0]] = v[0];
      ptr = v[1];
    }
    ptr = skipVoid(toml, ptr, true);
    if (toml[ptr] && toml[ptr] !== "\n" && toml[ptr] !== "\r") {
      throw new TomlError("each key-value declaration must be followed by an end-of-line", {
        toml,
        ptr
      });
    }
    ptr = skipVoid(toml, ptr);
  }
  return res;
}

// node_modules/smol-toml/dist/stringify.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

// node_modules/smol-toml/dist/index.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

// src/trust.ts
async function workspaceTrust(root, path) {
  const workspace = await realpath2(root);
  let content;
  try {
    content = await readFile2(path, "utf8");
  } catch (error) {
    if (record(error) && error["code"] === "ENOENT") return { path, workspace, level: "unset" };
    throw new Error(`Cannot read Codex user trust configuration: ${path}`);
  }
  let config;
  try {
    config = parse(content);
  } catch {
    throw new Error(`Invalid TOML in Codex user trust configuration: ${path}`);
  }
  const projects = record(config) ? config["projects"] : void 0;
  if (projects === void 0) return { path, workspace, level: "unset" };
  if (!record(projects)) throw new Error(`Invalid projects table in Codex user trust configuration: ${path}`);
  const levels = await Promise.all(
    Object.entries(projects).map(async ([candidate, entry]) => {
      if (!isAbsolute2(candidate) || !record(entry)) return void 0;
      if (await realpath2(candidate).catch(() => void 0) !== workspace) return void 0;
      return entry["trust_level"];
    })
  );
  const level = levels.includes("untrusted") ? "untrusted" : levels.includes("trusted") ? "trusted" : "unset";
  return { path, workspace, level };
}

// src/config.ts
function configPaths(root) {
  for (const key of Object.keys(executionEnvironment()))
    if (key.startsWith("LSP_TOOLS_MCP_") && key.endsWith("_CONFIG") || key === "CODEX_LSP_TRUST_PROJECT")
      throw new Error(
        `Migration required: remove ${key}; use $CODEX_HOME/lsp-client.json (schemaVersion: 1) and <workspace>/.codex/lsp-client.json; trust comes from $CODEX_HOME/config.toml. See docs/migration-0.5.md`
      );
  return {
    user: join2(executionEnvironment()["CODEX_HOME"] ?? join2(homedir(), ".codex"), "lsp-client.json"),
    project: join2(root, ".codex", "lsp-client.json"),
    codex: join2(executionEnvironment()["CODEX_HOME"] ?? join2(homedir(), ".codex"), "config.toml")
  };
}
async function read(path) {
  try {
    const value = JSON.parse(await readFile3(path, "utf8"));
    if (!record(value) || value["schemaVersion"] !== 1)
      throw new Error(
        `Migration required: ${path} requires schemaVersion: 1 and language-keyed lsp entries; see docs/migration-0.5.md`
      );
    for (const key of Object.keys(value))
      if (![
        "schemaVersion",
        "trustedWorkspaces",
        "lsp",
        "lint",
        "exclude",
        "formatting",
        "automaticDiagnostics"
      ].includes(key))
        throw new Error(`Unknown configuration field ${key} in ${path}`);
    return value;
  } catch (error) {
    if (record(error) && error["code"] === "ENOENT") return {};
    throw new Error(`Configuration error in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
var defaults = {
  python: "ty",
  typescript: "typescript",
  cpp: "clangd",
  rust: "rust",
  bash: "bash",
  yaml: "yaml-ls",
  svelte: "svelte",
  astro: "astro",
  go: "gopls",
  lua: "lua-ls",
  java: "jdtls",
  html: "html",
  css: "css",
  json: "json"
};
var web = {
  html: { command: ["vscode-html-language-server", "--stdio"], extensions: [".html", ".htm"] },
  css: { command: ["vscode-css-language-server", "--stdio"], extensions: [".css", ".scss", ".less"] },
  json: { command: ["vscode-json-language-server", "--stdio"], extensions: [".json", ".jsonc"] }
};
var builtins = {
  ...BUILTIN_SERVERS,
  ...web,
  tsc: { command: ["tsc", "--lsp", "--stdio"], extensions: BUILTIN_SERVERS["typescript"]?.extensions },
  tsgo: { command: ["tsgo", "--lsp", "--stdio"], extensions: BUILTIN_SERVERS["typescript"]?.extensions }
};
function server(value, language, source) {
  if (value === false) return false;
  const builtin = typeof value === "string" ? builtins[value] : void 0;
  if (typeof value === "string" && !builtin) throw new Error(`Unknown built-in server ${value} for ${language}`);
  const item = builtin ?? value;
  if (!record(item)) throw new Error(`lsp.${language} must be a built-in name, custom server or false`);
  for (const key of Object.keys(item))
    if (!["command", "extensions", "env", "initialization"].includes(key))
      throw new Error(`Invalid lsp.${language}.${key}; priority/disabled were removed; use false to disable`);
  const command = item["command"];
  const extensions = item["extensions"];
  if (!Array.isArray(command) || !command.length || !command.every((v) => typeof v === "string" && !!v))
    throw new Error(`lsp.${language}.command requires a nonempty string array`);
  if (!Array.isArray(extensions) || !extensions.length || !extensions.every((v) => typeof v === "string" && /^\.[^/\\]+$/.test(v)))
    throw new Error(`lsp.${language}.extensions requires dot-prefixed extensions`);
  const env = item["env"];
  const initialization = item["initialization"];
  if (env !== void 0 && (!record(env) || !Object.values(env).every((v) => typeof v === "string")))
    throw new Error(`Invalid lsp.${language}.env`);
  if (initialization !== void 0 && !record(initialization))
    throw new Error(`Invalid lsp.${language}.initialization`);
  return {
    id: typeof value === "string" ? value : language,
    command,
    extensions,
    explicit: !builtin,
    source,
    ...env ? { env } : {},
    ...initialization ? { initialization } : {}
  };
}
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
async function configuration(root) {
  const paths = configPaths(root);
  const user = await read(paths.user);
  const trust = await workspaceTrust(root, paths.codex);
  const project = trust.level === "trusted" ? await read(paths.project) : {};
  const servers = {};
  for (const [language, name] of Object.entries(defaults)) servers[language] = server(name, language, "builtin");
  for (const [data, source] of [
    [user, paths.user],
    [project, paths.project]
  ]) {
    if (data["lsp"] !== void 0 && !record(data["lsp"])) throw new Error(`Invalid lsp in ${source}`);
    if (record(data["lsp"]))
      for (const [language, value] of Object.entries(data["lsp"]))
        servers[language] = server(value, language, source);
    for (const key of ["lint", "formatting", "automaticDiagnostics"])
      if (data[key] !== void 0 && !record(data[key])) throw new Error(`Invalid ${key} in ${source}`);
  }
  const extensions = {};
  for (const [language, name] of Object.entries(defaults)) {
    const entry = server(name, language, "builtin");
    if (entry) extensions[language] = entry.extensions;
  }
  for (const [language, entry] of Object.entries(servers)) if (entry) extensions[language] = entry.extensions;
  const used = /* @__PURE__ */ new Map();
  for (const [language, entry] of Object.entries(servers))
    if (entry)
      for (const extension of entry.extensions) {
        if (used.has(extension))
          throw new Error(
            `Extension conflict ${extension}: ${used.get(extension)} and ${language}; disable or replace the original language entry`
          );
        used.set(extension, language);
      }
  const lint2 = { ...record(user["lint"]) ? user["lint"] : {}, ...record(project["lint"]) ? project["lint"] : {} };
  const javascript = lint2["javascript"] ?? "auto";
  const python = lint2["python"] ?? "auto";
  if (javascript !== "auto" && javascript !== "biome" && javascript !== "eslint" && javascript !== "off")
    throw new Error("Invalid lint.javascript");
  if (python !== "auto" && python !== "ruff" && python !== "off") throw new Error("Invalid lint.python");
  const exclude = project["exclude"] ?? user["exclude"] ?? [];
  if (!Array.isArray(exclude) || !exclude.every(
    (item) => typeof item === "string" && !item.startsWith("!") && !item.includes("\\") && !isAbsolute3(item) && !item.split("/").includes("..")
  ))
    throw new Error("exclude requires relative forward-slash globs without negation");
  const formatting = {
    tabSize: 4,
    insertSpaces: true,
    ...record(user["formatting"]) ? user["formatting"] : {},
    ...record(project["formatting"]) ? project["formatting"] : {}
  };
  if (!Number.isInteger(formatting.tabSize) || formatting.tabSize < 1 || formatting.tabSize > 16 || typeof formatting.insertSpaces !== "boolean")
    throw new Error("Invalid formatting.tabSize or formatting.insertSpaces");
  const automaticDiagnostics = {
    postToolUse: "delta",
    stop: "full",
    ...record(user["automaticDiagnostics"]) ? user["automaticDiagnostics"] : {},
    ...record(project["automaticDiagnostics"]) ? project["automaticDiagnostics"] : {}
  };
  for (const [key, value] of Object.entries(automaticDiagnostics))
    if (!["postToolUse", "stop"].includes(key) || !["delta", "full", "off"].includes(value))
      throw new Error(`Invalid automaticDiagnostics.${key}`);
  return freeze({
    schemaVersion: 1,
    automaticDiagnostics,
    javascript,
    python,
    exclude,
    trusted: trust.level === "trusted",
    trust,
    ...paths,
    extensions,
    servers,
    formatting,
    version: hash(JSON.stringify([user, project, trust, paths]))
  });
}

// src/metadata.ts
import { randomUUID } from "node:crypto";
import { lstat as lstat2, mkdir, readdir as readdir2, readFile as readFile5, realpath as realpath4, rename, rm, writeFile } from "node:fs/promises";
import { homedir as homedir3, tmpdir } from "node:os";
import { join as join3 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// src/service-identity.ts
import { readFile as readFile4, realpath as realpath3 } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { resolve as resolve2 } from "node:path";
var SERVICE_PROTOCOL = 1;
var bundle;
function bundleIdentity() {
  bundle ??= readFile4(new URL(import.meta.url), "utf8").then(hash);
  return bundle;
}
async function workspaceIdentity(root) {
  const home = resolve2(executionEnvironment()["CODEX_HOME"] ?? resolve2(homedir2(), ".codex"));
  return hash(
    JSON.stringify([
      process.getuid?.() ?? homedir2(),
      await realpath3(root),
      await realpath3(home).catch(() => home),
      await bundleIdentity(),
      SERVICE_PROTOCOL
    ])
  );
}

// src/metadata.ts
var empty = (id) => ({
  id,
  version: 0,
  generation: 0,
  configuration: "",
  pendingChannels: { lsp: [], lint: [] },
  automaticScope: "delta",
  turn: "",
  baseline: null,
  touched: [],
  current: [],
  pending: [],
  delivery: [],
  shown: {},
  blocked: []
});
var Metadata = class {
  constructor(root) {
    this.root = root;
  }
  async dir() {
    const user = process.getuid?.() ?? hash(homedir3()).slice(0, 10);
    const base = join3(
      executionEnvironment()["CODEX_LSP_CACHE"] ?? join3(tmpdir(), `codex-lsp-${user}`),
      `metadata-v6-${user}`
    );
    await mkdir(base, { recursive: true, mode: 448 });
    const info = await lstat2(base);
    if (info.isSymbolicLink() || process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 63) !== 0))
      throw new Error("Unsafe metadata permissions");
    const dir = join3(base, await workspaceIdentity(await realpath4(this.root)));
    await mkdir(dir, { recursive: true, mode: 448 });
    if ((await lstat2(dir)).isSymbolicLink()) throw new Error("Unsafe metadata directory");
    return dir;
  }
  async load(path, id) {
    try {
      const data = JSON.parse(await readFile5(path, "utf8"));
      if (!record(data) || data["id"] !== id || typeof data["version"] !== "number" || typeof data["turn"] !== "string" || typeof data["generation"] !== "number" || typeof data["configuration"] !== "string" || !record(data["pendingChannels"]) || !["delta", "full"].includes(String(data["automaticScope"])))
        throw new Error("Invalid metadata");
      for (const key of ["touched", "current", "pending", "delivery", "blocked"])
        if (!Array.isArray(data[key]) || !data[key].every((item) => typeof item === "string"))
          throw new Error("Invalid metadata");
      for (const key of ["shown", "baseline"])
        if (!(key === "baseline" && data[key] === null) && (!record(data[key]) || !Object.values(data[key]).every((item) => typeof item === "string")))
          throw new Error("Invalid metadata");
      const channels = data["pendingChannels"];
      if (!record(channels) || ![channels["lsp"], channels["lint"]].every(
        (paths) => Array.isArray(paths) && paths.every((path2) => typeof path2 === "string")
      ))
        throw new Error("Invalid channel metadata");
      return data;
    } catch (error) {
      if (record(error) && error["code"] === "ENOENT") return empty(id);
      throw error;
    }
  }
  async read(id) {
    return this.load(join3(await this.dir(), `${hash(id)}.json`), id);
  }
  async ids() {
    const dir = await this.dir();
    const ids = [];
    for (const file of await readdir2(dir))
      if (file.endsWith(".json")) {
        try {
          const value = JSON.parse(await readFile5(join3(dir, file), "utf8"));
          if (record(value) && typeof value["id"] === "string" && value["turn"] !== "__ended__")
            ids.push(value["id"]);
        } catch {
        }
      }
    return ids.sort();
  }
  async reclaim(lock) {
    let owner;
    try {
      owner = JSON.parse(await readFile5(join3(lock, "owner"), "utf8"));
    } catch {
      return;
    }
    if (!record(owner) || typeof owner["pid"] !== "number" || typeof owner["nonce"] !== "string") return;
    try {
      process.kill(owner["pid"], 0);
      return;
    } catch (error) {
      if (!record(error) || error["code"] !== "ESRCH") return;
    }
    try {
      const current = JSON.parse(await readFile5(join3(lock, "owner"), "utf8"));
      if (!record(current) || current["nonce"] !== owner["nonce"]) return;
    } catch {
      return;
    }
    await rename(lock, `${lock}.abandoned-${hash(owner["nonce"])}`).catch((error) => {
      if (!record(error) || !["ENOENT", "EEXIST", "ENOTEMPTY", "EPERM"].includes(String(error["code"]))) throw error;
    });
  }
  async update(id, signal, change) {
    signal.throwIfAborted();
    const dir = await this.dir();
    const path = join3(dir, `${hash(id)}.json`);
    const lock = `${path}.lock`;
    const nonce = randomUUID();
    const candidate = `${lock}.claim-${nonce}`;
    const released = `${lock}.released-${nonce}`;
    const temp = `${path}.${nonce}.tmp`;
    const deadline = Date.now() + 1e3;
    let acquired = false;
    try {
      await mkdir(candidate, { mode: 448 });
      await writeFile(join3(candidate, "owner"), JSON.stringify({ pid: process.pid, nonce }), { mode: 384 });
      while (!acquired) {
        signal.throwIfAborted();
        try {
          await rename(candidate, lock);
          acquired = true;
        } catch (error) {
          if (!record(error) || !["EEXIST", "ENOTEMPTY", "EPERM"].includes(String(error["code"]))) throw error;
          await this.reclaim(lock);
          if (Date.now() >= deadline) throw new Error("Metadata update busy; retry");
          await delay(10, void 0, { signal });
        }
      }
      const state = await this.load(path, id);
      signal.throwIfAborted();
      if (change(state) === false) return state;
      state.version++;
      for (const key of ["touched", "current", "pending", "delivery", "blocked"])
        state[key] = [...new Set(state[key])];
      await writeFile(temp, JSON.stringify(state), { mode: 384 });
      await rename(temp, path);
      return state;
    } finally {
      await rm(temp, { force: true });
      await rm(candidate, { recursive: true, force: true });
      if (acquired) {
        await rename(lock, released);
        await rm(released, { recursive: true, force: true });
      }
    }
  }
  async end(id, signal) {
    await this.update(id, signal, (state) => {
      Object.assign(state, { ...empty(id), version: state.version, generation: state.generation + 1 });
      state.turn = "__ended__";
    });
  }
};

// src/runtime.ts
import { realpath as realpath6 } from "node:fs/promises";
import { isAbsolute as isAbsolute7 } from "node:path";

// src/engine.ts
import { randomUUID as randomUUID4 } from "node:crypto";
import { readFile as readFile11, stat as stat5 } from "node:fs/promises";
import { relative as relative4 } from "node:path";

// src/identity.ts
import { readFile as readFile8, stat as stat4 } from "node:fs/promises";
import { dirname as dirname4, extname as extname3, join as join9, resolve as resolve4 } from "node:path";

// src/runners.ts
import { spawn as spawn2 } from "node:child_process";
import { access as access3, readFile as readFile7, realpath as realpath5, stat as stat3, writeFile as writeFile3 } from "node:fs/promises";
import { basename as basename3, dirname as dirname3, extname as extname2, join as join8 } from "node:path";

// packages/lsp-tools-mcp/dist/lsp/process.js
import * as childProcess from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, join as join4 } from "node:path";

// packages/lsp-tools-mcp/dist/lsp/cleanup-errors.js
function reportBestEffortCleanupError(operation, error) {
  if (process.env["CODEX_LSP_DEBUG_CLEANUP"] !== "1")
    return;
  const message2 = error instanceof Error ? error.message : String(error);
  console.error(`[codex-lsp] ignored ${operation} failure during cleanup: ${message2}`);
}

// packages/lsp-tools-mcp/dist/lsp/errors.js
var LspConnectionClosedError = class extends Error {
  constructor(serverId, root, message2) {
    super(message2 ?? `LSP connection closed for ${serverId} at ${root}`);
    this.serverId = serverId;
    this.root = root;
    this.name = "LspConnectionClosedError";
  }
};
var LspProcessExitedError = class extends Error {
  constructor(serverId, root, exitCode, stderrTail) {
    const stderrSuffix = stderrTail ? `
stderr tail: ${stderrTail}` : "";
    super(`LSP server ${serverId} at ${root} exited with code ${exitCode ?? "null"}${stderrSuffix}`);
    this.serverId = serverId;
    this.root = root;
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
    this.name = "LspProcessExitedError";
  }
};
var LspRequestTimeoutError = class extends Error {
  constructor(method, stderrTail) {
    const stderrSuffix = stderrTail ? `
recent stderr: ${stderrTail}` : "";
    super(`LSP request timeout (method: ${method})${stderrSuffix}`);
    this.method = method;
    this.stderrTail = stderrTail;
    this.name = "LspRequestTimeoutError";
  }
};
var LspInvalidPathError = class extends Error {
  constructor() {
    super(...arguments);
    this.name = "LspInvalidPathError";
  }
};
var LspProcessSpawnError = class extends Error {
  constructor() {
    super(...arguments);
    this.name = "LspProcessSpawnError";
  }
};

// packages/lsp-tools-mcp/dist/lsp/process.js
function isMissingProcessError(error) {
  if (!(error instanceof Error) || !("code" in error))
    return false;
  return error.code === "ESRCH";
}
function reportKillError(context, error) {
  if (!isMissingProcessError(error)) {
    reportBestEffortCleanupError(context, error);
  }
}
function validateCwd(cwd) {
  try {
    if (!existsSync(cwd)) {
      return { valid: false, error: `Working directory does not exist: ${cwd}` };
    }
    const stats = statSync(cwd);
    if (!stats.isDirectory()) {
      return { valid: false, error: `Path is not a directory: ${cwd}` };
    }
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error: `Cannot access working directory: ${cwd} (${err instanceof Error ? err.message : String(err)})`
    };
  }
}
function wrap(proc) {
  const exitedPromise = new Promise((resolve8) => {
    proc.once("close", (code) => resolve8(code ?? 0));
    proc.once("error", () => resolve8(1));
  });
  if (!proc.stdin || !proc.stdout || !proc.stderr) {
    throw new LspProcessSpawnError("Spawned process is missing one of stdin/stdout/stderr pipes");
  }
  return {
    stdin: proc.stdin,
    stdout: proc.stdout,
    stderr: proc.stderr,
    get pid() {
      return proc.pid ?? void 0;
    },
    get exitCode() {
      return proc.exitCode;
    },
    get killed() {
      return proc.killed;
    },
    exited: exitedPromise,
    kill(signal) {
      terminateProcessTree(proc, signal ?? "SIGTERM");
    }
  };
}
function terminateProcessTree(proc, signal = "SIGTERM", options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32" && proc.pid) {
    const args = ["/pid", String(proc.pid), "/f", "/t"];
    const result = options.spawnSync === void 0 ? childProcess.spawnSync("taskkill", args, { stdio: "ignore" }) : options.spawnSync("taskkill", args, { stdio: "ignore" });
    if (!result.error && result.status === 0)
      return;
    if (result.error)
      reportKillError("windows process tree kill", result.error);
  }
  if (platform !== "win32" && proc.pid) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch (error) {
      reportKillError("process group kill", error);
    }
    const descendants = findDescendantProcessIds(proc.pid);
    try {
      proc.kill(signal);
    } catch (error) {
      reportKillError("process kill", error);
    }
    for (const pid of descendants) {
      try {
        process.kill(pid, signal);
      } catch (error) {
        reportKillError("descendant process kill", error);
      }
    }
    return;
  }
  try {
    proc.kill(signal);
  } catch (error) {
    reportKillError("process kill", error);
  }
}
function findDescendantProcessIds(rootPid) {
  const result = childProcess.spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  if (result.error) {
    reportKillError("process tree inspection", result.error);
    return [];
  }
  if (result.status !== 0 || typeof result.stdout !== "string")
    return [];
  const childrenByParent = /* @__PURE__ */ new Map();
  for (const line of result.stdout.split("\n")) {
    const [pidText, parentPidText] = line.trim().split(/\s+/, 2);
    if (pidText === void 0 || parentPidText === void 0)
      continue;
    const pid = Number(pidText);
    const parentPid = Number(parentPidText);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid))
      continue;
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }
  const descendants = [];
  const pendingParents = [rootPid];
  while (pendingParents.length > 0) {
    const parentPid = pendingParents.pop();
    if (parentPid === void 0)
      break;
    for (const childPid of childrenByParent.get(parentPid) ?? []) {
      descendants.push(childPid);
      pendingParents.push(childPid);
    }
  }
  return descendants.reverse();
}
function isWindowsShellShim(command) {
  const lowerCommand = command.toLowerCase();
  return lowerCommand.endsWith(".cmd") || lowerCommand.endsWith(".bat");
}
function splitPath(pathValue, platform) {
  const separator = platform === "win32" ? ";" : delimiter;
  return pathValue.split(separator).filter(Boolean);
}
function getWindowsPathExtensions(env) {
  const rawExtensions = env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD";
  const extensions = rawExtensions.split(";").map((extension) => extension.trim()).filter(Boolean).map((extension) => extension.startsWith(".") ? extension : `.${extension}`);
  return [.../* @__PURE__ */ new Set(["", ...extensions, ".exe", ".cmd", ".bat"])];
}
function resolveWindowsCommand(command, env) {
  const hasPathSeparator = command.includes("/") || command.includes("\\");
  const pathValue = env["PATH"] ?? env["Path"] ?? "";
  const baseDirectories = hasPathSeparator ? [""] : splitPath(pathValue, "win32");
  const extensions = getWindowsPathExtensions(env);
  for (const baseDirectory of baseDirectories) {
    for (const extension of extensions) {
      const candidate = baseDirectory ? join4(baseDirectory, `${command}${extension}`) : `${command}${extension}`;
      if (existsSync(candidate))
        return candidate;
    }
  }
  return command;
}
function createSpawnCommand(command, platform = process.platform, commandProcessor = process.env["ComSpec"] ?? "cmd.exe", env = process.env) {
  const [cmd, ...args] = command;
  if (!cmd) {
    throw new LspProcessSpawnError("[lsp] empty command");
  }
  if (platform !== "win32") {
    return { command: cmd, args, shell: false };
  }
  const resolvedCommand = resolveWindowsCommand(cmd, env);
  if (!isWindowsShellShim(resolvedCommand)) {
    return { command: resolvedCommand, args, shell: false };
  }
  return {
    command: commandProcessor,
    args: ["/d", "/s", "/c", resolvedCommand, ...args],
    shell: false
  };
}
function spawnProcess(command, options) {
  const cwdValidation = validateCwd(options.cwd);
  if (!cwdValidation.valid) {
    throw new LspInvalidPathError(`[lsp] ${cwdValidation.error}`);
  }
  const [cmd] = command;
  if (!cmd) {
    throw new LspProcessSpawnError("[lsp] empty command");
  }
  const preparedCommand = createSpawnCommand(command, process.platform, process.env["ComSpec"] ?? "cmd.exe", options.env);
  const proc = childProcess.spawn(preparedCommand.command, preparedCommand.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: preparedCommand.shell,
    detached: process.platform !== "win32"
  });
  return wrap(proc);
}

// src/lint-output.ts
function position(value, content) {
  const location = record(value["location"]) ? value["location"] : {};
  const span = location["span"];
  if (Array.isArray(span) && typeof span[0] === "number") {
    const before = Buffer.from(content).subarray(0, span[0]).toString("utf8").split("\n");
    return { line: before.length, column: (before.at(-1)?.length ?? 0) + 1 };
  }
  const start = record(location["start"]) ? location["start"] : {};
  const line = value["line"] ?? location["row"] ?? start["line"];
  const column = value["column"] ?? location["column"] ?? start["column"];
  return { line: typeof line === "number" ? line : 1, column: typeof column === "number" ? column : 1 };
}
function items(runner, data) {
  if (runner === "eslint" && Array.isArray(data))
    return data.flatMap((file) => record(file) && Array.isArray(file["messages"]) ? file["messages"] : []);
  if (runner === "ruff" && Array.isArray(data)) return data;
  if (runner === "biome" && record(data) && Array.isArray(data["diagnostics"])) {
    const summary = data["summary"];
    if (record(summary) && Number(summary["diagnosticsNotPrinted"]) > 0)
      throw new Error("Lint result truncated; narrow file scope");
    return data["diagnostics"];
  }
  throw new Error("Unexpected lint output");
}
function parseLint(runner, data, path, content) {
  const findings = [];
  for (const value of items(runner, data)) {
    if (!record(value)) throw new Error("Malformed lint finding");
    const severity = value["severity"];
    if (severity !== void 0 && ![1, 2, "error", "warning", "fatal"].includes(severity))
      continue;
    findings.push({
      path,
      ...position(value, content),
      severity: severity === 1 || severity === "warning" ? "warning" : "error",
      source: `${runner}/${text(value["ruleId"], text(value["code"], text(value["category"], "lint")))}`,
      message: text(value["description"], text(value["message"], "Lint finding"))
    });
  }
  return findings;
}

// src/log.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { appendFile, mkdir as mkdir2, rename as rename2, rm as rm2, stat } from "node:fs/promises";
import { homedir as homedir4, tmpdir as tmpdir2 } from "node:os";
import { join as join5 } from "node:path";
var instance = `${process.pid}-${randomUUID2()}`;
var queue = Promise.resolve();
function logEvent(event) {
  queue = queue.then(async () => {
    const dir = join5(
      executionEnvironment()["CODEX_LSP_CACHE"] ?? join5(tmpdir2(), `codex-lsp-${process.getuid?.() ?? hash(homedir4()).slice(0, 10)}`),
      "logs-v5"
    );
    await mkdir2(dir, { recursive: true, mode: 448 });
    const path = join5(dir, `${instance}.log`);
    if ((await stat(path).catch(() => ({ size: 0 }))).size + 100 > 1024 * 1024) {
      await rm2(`${path}.1`, { force: true });
      await rename2(path, `${path}.1`);
    }
    await appendFile(path, `${(/* @__PURE__ */ new Date()).toISOString()} ${event}
`, { mode: 384 });
  }).catch(() => void 0);
  return queue;
}

// src/prepared-tools.ts
import { randomUUID as randomUUID3 } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat as lstat3, mkdir as mkdir3, readFile as readFile6, rename as rename3, writeFile as writeFile2 } from "node:fs/promises";
import { homedir as homedir5 } from "node:os";
import { isAbsolute as isAbsolute4, join as join6 } from "node:path";
function directory() {
  return join6(executionEnvironment()["CODEX_HOME"] ?? join6(homedir5(), ".codex"), "cache", "codex-lsp-v5", "tools");
}
async function preparedRuff() {
  try {
    const value = JSON.parse(await readFile6(join6(directory(), "ruff.json"), "utf8"));
    if (!record(value) || typeof value["executable"] !== "string" || !isAbsolute4(value["executable"]))
      return void 0;
    await access(value["executable"], constants.X_OK);
    return value["executable"];
  } catch {
    return void 0;
  }
}
async function rememberRuff(executable3) {
  if (!isAbsolute4(executable3)) throw new Error("Invalid prepared Ruff path");
  await access(executable3, constants.X_OK);
  const dir = directory();
  await mkdir3(dir, { recursive: true, mode: 448 });
  const info = await lstat3(dir);
  if (info.isSymbolicLink() || process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 63) !== 0))
    throw new Error("Unsafe prepared-tool directory");
  const temporary2 = join6(dir, `${randomUUID3()}.tmp`);
  await writeFile2(temporary2, JSON.stringify({ executable: executable3 }), { mode: 384 });
  await rename3(temporary2, join6(dir, "ruff.json"));
}

// src/tool-resolution.ts
import { AsyncLocalStorage as AsyncLocalStorage2 } from "node:async_hooks";
import { constants as constants2 } from "node:fs";
import { access as access2, stat as stat2 } from "node:fs/promises";
import { basename as basename2, delimiter as delimiter2, dirname as dirname2, extname, isAbsolute as isAbsolute5, join as join7, resolve as resolve3 } from "node:path";
var temporary = {
  ty: { ecosystem: "python", packages: ["ty"] },
  ruff: { ecosystem: "python", packages: ["ruff"] },
  "pyright-langserver": { ecosystem: "python", packages: ["pyright"] },
  "basedpyright-langserver": { ecosystem: "python", packages: ["basedpyright"] },
  "typescript-language-server": { ecosystem: "npm", packages: ["typescript-language-server", "typescript@5.9.3"] },
  tsc: { ecosystem: "npm", packages: ["typescript@7.0.2"] },
  "bash-language-server": { ecosystem: "npm", packages: ["bash-language-server"] },
  "yaml-language-server": { ecosystem: "npm", packages: ["yaml-language-server"] },
  "vscode-html-language-server": { ecosystem: "npm", packages: ["vscode-langservers-extracted"] },
  "vscode-css-language-server": { ecosystem: "npm", packages: ["vscode-langservers-extracted"] },
  "vscode-json-language-server": { ecosystem: "npm", packages: ["vscode-langservers-extracted"] },
  svelteserver: { ecosystem: "npm", packages: ["svelte-language-server"] },
  "astro-ls": { ecosystem: "npm", packages: ["@astrojs/language-server", "typescript"] }
};
async function executable(path) {
  try {
    await access2(path, constants2.X_OK);
    return (await stat2(path)).isFile();
  } catch {
    return false;
  }
}
function suffixes(name) {
  return process.platform === "win32" && !/\.(?:exe|com|cmd|bat)$/i.test(name) ? [".exe", ".com", ".cmd", ".bat", ""] : [""];
}
async function pathExecutable(name) {
  for (const dir of (executionEnvironment()["PATH"] ?? "").split(delimiter2).filter(Boolean)) {
    for (const suffix of suffixes(name)) {
      const path = resolve3(dir, name + suffix);
      if (await executable(path)) return path;
    }
  }
  return void 0;
}
async function resolution(command, source, note) {
  const info = await stat2(command[0] ?? "").catch(() => void 0);
  return {
    command,
    source,
    identity: hash(JSON.stringify([command, source, info?.size, info?.mtimeMs, executionEnvironment()])),
    ...note ? { note } : {}
  };
}
var requestTools = new AsyncLocalStorage2();
function withToolResolution(action) {
  return requestTools.run(/* @__PURE__ */ new Map(), action);
}
function resolveTool(...args) {
  const cache = requestTools.getStore();
  const key = JSON.stringify([args[0], dirname2(resolve3(args[0], args[1])), ...args.slice(2)]);
  const existing = cache?.get(key);
  if (existing) return existing;
  const task = findTool(...args);
  cache?.set(key, task);
  return task;
}
async function findTool(root, path, command, explicit = false, allowTemporary = true) {
  const name = command[0];
  if (!name) throw new Error("Empty command");
  const executableName = basename2(name).replace(/\.(?:exe|cmd|bat)$/i, "");
  if (automaticExecution() && (["uvx", "npx", "pipx"].includes(executableName) || executableName === "uv" && command[1] === "tool" && command[2] === "run"))
    return resolution(
      [...command],
      "missing",
      `Automatic temporary launcher disabled: ${name}; install a local server or use explicit active MCP`
    );
  if (explicit) {
    const entry = isAbsolute5(name) || name.includes("/") || name.includes("\\") ? resolve3(root, name) : await pathExecutable(name);
    return resolution(
      [entry ?? name, ...command.slice(1)],
      entry && await executable(entry) ? "explicit" : "missing",
      entry && await executable(entry) ? void 0 : `Explicit command missing: ${name}; no fallback`
    );
  }
  let dir = dirname2(resolve3(root, path));
  while (inside(root, dir)) {
    for (const candidate of [
      ...suffixes(name).map(
        (suffix) => join7(dir, ".venv", process.platform === "win32" ? "Scripts" : "bin", name + suffix)
      ),
      ...suffixes(name).map((suffix) => join7(dir, "node_modules", ".bin", name + suffix))
    ])
      if (await executable(candidate)) return resolution([candidate, ...command.slice(1)], "project");
    if (dir === root) break;
    dir = dirname2(dir);
  }
  const local = await pathExecutable(name);
  if (local) return resolution([local, ...command.slice(1)], "PATH");
  const plan = temporary[name];
  if (allowTemporary && !automaticExecution() && plan) {
    if (plan.ecosystem === "python") {
      for (const [launcher, prefix] of [
        ["uvx", ["--isolated", "--from", plan.packages[0] ?? name]],
        ["uv", ["tool", "run", "--isolated", "--from", plan.packages[0] ?? name]],
        ["pipx", ["run", "--spec", plan.packages[0] ?? name]]
      ]) {
        const found = await pathExecutable(launcher);
        if (found)
          return resolution(
            [found, ...prefix, ...command],
            "temporary",
            "Available to attempt; initialization not verified"
          );
      }
    } else {
      const npx = await pathExecutable("npx");
      if (npx)
        return resolution(
          [npx, "--yes", ...plan.packages.flatMap((pkg) => ["--package", pkg]), "--", ...command],
          "temporary",
          "Available to attempt; initialization not verified"
        );
    }
  }
  return resolution(
    [...command],
    "missing",
    `Tool missing: ${name}; install locally and retry or use lsp_status refresh=true`
  );
}
function languageFor(config, path) {
  for (const [language, server2] of Object.entries(config.servers))
    if (server2 !== false && server2.extensions.includes(extname(path))) return { language, server: server2 };
  return void 0;
}
async function resolveServer(root, path, config) {
  const entry = languageFor(config, path);
  if (!entry) throw new Error(`Language disabled or unsupported: ${extname(path) || path}`);
  const tool2 = await resolveTool(root, path, entry.server.command, entry.server.explicit);
  return {
    language: entry.language,
    tool: tool2,
    server: {
      id: entry.server.id,
      command: tool2.command,
      extensions: [...entry.server.extensions],
      priority: 0,
      ...entry.server.env ? { env: { ...entry.server.env } } : {},
      ...entry.server.initialization ? { initialization: { ...entry.server.initialization } } : {}
    }
  };
}
function codeLanguage(config, path) {
  return languageFor(config, path)?.language ?? Object.entries(config.extensions).find(([, extensions]) => extensions.includes(extname(path)))?.[0];
}

// src/runners.ts
async function run(command, args, cwd, signal, input) {
  signal.throwIfAborted();
  return new Promise((resolve8, reject) => {
    const prepared = createSpawnCommand([command, ...args]);
    const child = spawn2(prepared.command, prepared.args, {
      cwd,
      env: executionEnvironment(),
      shell: prepared.shell,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const cancel = () => terminateProcessTree(child, "SIGKILL");
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    let stdout = "";
    let stderr = "";
    let exceeded = false;
    const timer = setTimeout(() => {
      exceeded = true;
      void logEvent("timeout");
      terminateProcessTree(child, "SIGKILL");
    }, 2e4);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 4 * 1024 * 1024) {
        exceeded = true;
        terminateProcessTree(child, "SIGKILL");
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4e3);
    });
    child.once("error", (error) => {
      void logEvent("startup-failure");
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      if (code !== 0 && code !== 1 && !signal.aborted) void logEvent("abnormal-exit");
      if (signal.aborted) reject(new Error("Runner cancelled"));
      else if (exceeded) reject(new Error("Runner exceeded time/output budget"));
      else resolve8({ stdout, stderr, code: code ?? -1 });
    });
    child.stdin.on("error", () => {
    });
    child.stdin.end(input);
  });
}
async function exists(path) {
  try {
    await access3(path);
    return true;
  } catch {
    return false;
  }
}
async function configured(root, path, names) {
  let dir = dirname3(path);
  while (inside(root, dir)) {
    for (const name of names) if (await exists(join8(dir, name))) return true;
    if (dir === root) break;
    dir = dirname3(dir);
  }
  return false;
}
async function executable2(root, target, packageName, entry) {
  let dir = dirname3(target);
  while (inside(root, dir)) {
    const path = join8(dir, "node_modules", packageName, entry);
    if (await exists(path)) return realpath5(path);
    const parent = dirname3(dir);
    if (dir === root) break;
    dir = parent;
  }
  return void 0;
}
async function javascriptRunner(root, path, name, packageName, entry) {
  const tool2 = await resolveTool(root, path, [name], false, false);
  if (tool2.source === "project") return { name, command: tool2.command[0] ?? name, prefix: [], source: "project" };
  const script = await executable2(root, path, packageName, entry);
  if (script) return { name, command: process.execPath, prefix: [script], source: "project" };
  if (tool2.source === "PATH") return { name, command: tool2.command[0] ?? name, prefix: [], source: "PATH" };
  throw new Error(`${name}: configured tool is not installed`);
}
async function select(root, path, formatting = false, provided, active = false, signal = new AbortController().signal) {
  const config = provided ?? await configuration(root);
  const extension = extname2(path);
  const choice = formatting ? "auto" : /\.pyi?$/.test(extension) ? config.python : config.javascript;
  if (choice === "off") return void 0;
  if (/\.pyi?$/.test(extension)) {
    let tool2 = await resolveTool(root, path, ["ruff"], false, false);
    if (tool2.source === "missing") {
      const prepared = await preparedRuff();
      if (prepared) return { name: "ruff", command: prepared, prefix: [], source: "prepared" };
      if (!active || automaticExecution() || !config.trusted)
        throw new Error(
          "Ruff unavailable: no local or prepared executable; run trusted active MCP diagnostics to prepare it. Hook never downloads tools"
        );
      tool2 = await resolveTool(root, path, ["ruff"]);
      if (tool2.source === "missing") throw new Error(tool2.note);
      const launcher = tool2.command[0] ?? "";
      if (/^uvx?(?:\.exe)?$/.test(basename3(launcher))) {
        const prepared2 = await run(
          launcher,
          [...tool2.command.slice(1, -1), "python", "-c", "import shutil; print(shutil.which('ruff') or '')"],
          root,
          signal
        );
        if (prepared2.code !== 0 || !prepared2.stdout.trim())
          throw new Error(`Ruff preparation failed: ${prepared2.stderr}`);
        await rememberRuff(prepared2.stdout.trim());
        return { name: "ruff", command: prepared2.stdout.trim(), prefix: [], source: "prepared" };
      }
    }
    return { name: "ruff", command: tool2.command[0] ?? "ruff", prefix: tool2.command.slice(1), source: tool2.source };
  }
  if (!/\.(?:[cm]?[jt]sx?|jsonc?|css)$/.test(path)) return void 0;
  if ((choice === "auto" || choice === "biome") && await configured(root, path, ["biome.json", "biome.jsonc"]))
    return javascriptRunner(root, path, "biome", "@biomejs/biome", "bin/biome");
  if ((choice === "auto" || choice === "eslint") && await configured(root, path, [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    "eslint.config.ts",
    ".eslintrc.json",
    ".eslintrc.cjs"
  ]))
    return javascriptRunner(root, path, "eslint", "eslint", "bin/eslint.js");
  if (choice !== "auto") throw new Error(`${choice}: matching project configuration missing`);
  return void 0;
}
async function runnerIdentity(root, path, provided) {
  const config = provided ?? await configuration(root);
  if (!config.trusted) return "untrusted";
  try {
    const runner = await select(root, path, false, config);
    if (!runner) return "none";
    const identities = await Promise.all(
      [runner.command, ...runner.prefix.filter((value) => value.includes("/"))].map(async (command) => {
        const info = await stat3(command).catch(() => void 0);
        return [command, info?.size, info?.mtimeMs, info?.ino];
      })
    );
    return JSON.stringify([runner, identities]);
  } catch {
    return "unavailable";
  }
}
async function lint(root, path, signal, provided, active = false) {
  const config = provided ?? await configuration(root);
  if (!config.trusted) return void 0;
  try {
    const absolute = await workspacePath(root, path);
    if (!languageFor(config, path))
      return { path, state: "skipped", findings: [], note: "Language disabled or unsupported" };
    const runner = await select(root, absolute, false, config, active, signal);
    if (!runner)
      return { path, state: "skipped", findings: [], note: "lint off or no matching Runner configuration" };
    const args = runner.name === "biome" ? ["lint", "--reporter=json", "--max-diagnostics=1000", absolute] : runner.name === "eslint" ? ["--format", "json", absolute] : ["check", "--no-cache", "--output-format", "json", "--", absolute];
    const result = await measured(
      "lint",
      () => run(runner.command, [...runner.prefix, ...args], dirname3(absolute), signal)
    );
    if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || `Runner exit ${result.code}`);
    const data = JSON.parse(result.stdout);
    const findings = parseLint(runner.name, data, path, await readFile7(absolute, "utf8"));
    return { path, state: "complete", findings };
  } catch (error) {
    return { path, state: signal.aborted ? "pending" : "failed", findings: [], note: `lint: ${message(error)}` };
  }
}
async function formatWithRunner(root, path, signal, provided) {
  const config = provided ?? await configuration(root);
  if (!config.trusted) return void 0;
  const absolute = await workspacePath(root, path);
  const runner = await select(root, absolute, true, config, true, signal);
  if (!runner || runner.name === "eslint") return void 0;
  const before = await readFile7(absolute, "utf8");
  const args = runner.name === "biome" ? ["format", `--stdin-file-path=${absolute}`] : ["format", "--no-cache", "--stdin-filename", absolute, "-"];
  const result = await run(runner.command, [...runner.prefix, ...args], dirname3(absolute), signal, before);
  if (result.code !== 0) throw new Error(result.stderr || "Format failed");
  if (await readFile7(absolute, "utf8") !== before) throw new Error("File changed during format; retry");
  if (before === result.stdout) return `Unchanged: ${path}`;
  signal.throwIfAborted();
  await writeFile3(absolute, result.stdout);
  return `Formatted: ${path}`;
}
async function preflightRunner(root, path, config, signal) {
  if (!config.trusted) {
    if (/\.pyi?$/.test(path)) throw new Error("Python formatting with Ruff requires workspace trust");
    return false;
  }
  const runner = await select(root, await workspacePath(root, path), true, config, true, signal);
  if (!runner || runner.name === "eslint") return false;
  const result = await run(runner.command, [...runner.prefix, "--version"], root, signal);
  if (result.code !== 0) throw new Error(`${runner.name} preflight failed: ${result.stderr}`);
  return true;
}

// src/identity.ts
var CONFIGS = [
  "ty.toml",
  ".clangd",
  "compile_commands.json",
  "build/compile_commands.json",
  "compile_flags.txt",
  ".clang-format",
  "Cargo.lock",
  "rust-toolchain",
  "rust-toolchain.toml",
  "rustfmt.toml",
  ".rustfmt.toml",
  "biome.json",
  "biome.jsonc",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  ".eslintrc.json",
  ".eslintrc.cjs",
  "pyproject.toml",
  "ruff.toml",
  ".ruff.toml",
  "tsconfig.json",
  "jsconfig.json",
  "pyrightconfig.json",
  "package.json",
  "Cargo.toml",
  "go.mod"
];
async function analysisIdentity(root, paths, config, signal, lsp = true) {
  const dirs = /* @__PURE__ */ new Set();
  const runners = /* @__PURE__ */ new Map();
  for (const path of paths) {
    signal.throwIfAborted();
    const absolute = resolve4(root, path);
    const key = `${dirname4(absolute)}:${extname3(path)}`;
    if (!runners.has(key)) runners.set(key, await runnerIdentity(root, absolute, config));
    let dir = dirname4(absolute);
    while (inside(root, dir)) {
      dirs.add(dir);
      if (dir === root) break;
      dir = dirname4(dir);
    }
  }
  const contents = [];
  for (const dir of [...dirs].sort())
    for (const name of CONFIGS) {
      signal.throwIfAborted();
      const path = join9(dir, name);
      try {
        if ((await stat4(path)).size > 1024 * 1024) throw new Error("Tool configuration exceeds 1 MiB");
        contents.push(path, hash(await readFile8(path, { encoding: "utf8", signal })));
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
  const representatives = [...new Map(paths.map((path) => [`${dirname4(path)}:${extname3(path)}`, path])).values()];
  const servers = lsp ? await Promise.all(
    representatives.map((path) => resolveServer(root, path, config).catch((error) => String(error)))
  ) : [];
  return hash(JSON.stringify([config.version, executionEnvironment(), contents, [...runners].sort(), servers]));
}

// src/language.ts
import { readFile as readFile10, writeFile as writeFile4 } from "node:fs/promises";
import { dirname as dirname8, extname as extname5, relative as relative3, resolve as resolve7 } from "node:path";
import { fileURLToPath as fileURLToPath2, pathToFileURL as pathToFileURL3 } from "node:url";

// packages/lsp-tools-mcp/dist/lsp/client.js
import { readFileSync } from "node:fs";
import { extname as extname4, resolve as resolve5 } from "node:path";
import { pathToFileURL as pathToFileURL2 } from "node:url";

// packages/lsp-tools-mcp/dist/lsp/connection.js
import { pathToFileURL } from "node:url";

// packages/lsp-tools-mcp/dist/lsp/transport.js
import { delimiter as delimiter4 } from "node:path";

// packages/lsp-tools-mcp/dist/lsp/constants.js
var REQUEST_TIMEOUT_MS = 15e3;
var INIT_TIMEOUT_MS = 6e4;
var IDLE_TIMEOUT_MS = 5 * 6e4;
var REAPER_INTERVAL_MS = 6e4;
var STOP_HARD_KILL_TIMEOUT_MS = 5e3;
var STOP_SIGKILL_GRACE_MS = 1e3;

// packages/lsp-tools-mcp/dist/lsp/json-rpc-connection.js
var HEADER_SEPARATOR = "\r\n\r\n";
var PARSE_ERROR = -32700;
var INVALID_REQUEST = -32600;
var METHOD_NOT_FOUND = -32601;
var INTERNAL_ERROR = -32603;
var JsonRpcConnection = class {
  constructor(reader, writer) {
    this.reader = reader;
    this.writer = writer;
    this.pendingRequests = /* @__PURE__ */ new Map();
    this.notificationHandlers = /* @__PURE__ */ new Map();
    this.requestHandlers = /* @__PURE__ */ new Map();
    this.closeHandlers = [];
    this.errorHandlers = [];
    this.inputBuffer = Buffer.alloc(0);
    this.nextRequestId = 1;
    this.listening = false;
    this.disposed = false;
    this.handleData = (chunk) => {
      const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      this.inputBuffer = Buffer.concat([this.inputBuffer, chunkBuffer]);
      this.drainInputBuffer();
    };
    this.handleClose = () => {
      for (const handler of this.closeHandlers) {
        handler();
      }
    };
    this.handleStreamError = (error) => {
      this.emitError(error);
    };
  }
  listen() {
    if (this.listening)
      return;
    this.listening = true;
    this.reader.on("data", this.handleData);
    this.reader.on("close", this.handleClose);
    this.reader.on("end", this.handleClose);
    this.reader.on("error", this.handleStreamError);
    this.writer.on("error", this.handleStreamError);
  }
  onNotification(method, handler) {
    this.notificationHandlers.set(method, handler);
  }
  onRequest(method, handler) {
    this.requestHandlers.set(method, handler);
  }
  onClose(handler) {
    this.closeHandlers.push(handler);
  }
  onError(handler) {
    this.errorHandlers.push(handler);
  }
  async sendRequest(method, params) {
    if (this.disposed)
      throw new Error("JSON-RPC connection is disposed");
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const message2 = params === void 0 ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };
    const responsePromise = new Promise((resolve8, reject) => {
      this.pendingRequests.set(String(id), {
        resolve(result) {
          resolve8(result);
        },
        reject
      });
    });
    try {
      await this.writeMessage(message2);
    } catch (error) {
      this.pendingRequests.delete(String(id));
      throw error;
    }
    return responsePromise;
  }
  async sendNotification(method, params) {
    if (this.disposed)
      return;
    const message2 = params === void 0 ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
    await this.writeMessage(message2);
  }
  dispose() {
    if (this.disposed)
      return;
    this.disposed = true;
    this.reader.off("data", this.handleData);
    this.reader.off("close", this.handleClose);
    this.reader.off("end", this.handleClose);
    this.reader.off("error", this.handleStreamError);
    this.writer.off("error", this.handleStreamError);
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error("JSON-RPC connection disposed"));
    }
    this.pendingRequests.clear();
    this.notificationHandlers.clear();
    this.requestHandlers.clear();
  }
  drainInputBuffer() {
    while (true) {
      const headerEnd = this.inputBuffer.indexOf(HEADER_SEPARATOR);
      if (headerEnd === -1)
        return;
      const headers = this.inputBuffer.subarray(0, headerEnd).toString("ascii");
      const contentLength = parseContentLength(headers);
      if (contentLength === null) {
        this.inputBuffer = Buffer.alloc(0);
        this.emitError(new Error("JSON-RPC message is missing Content-Length header"));
        return;
      }
      const bodyStart = headerEnd + Buffer.byteLength(HEADER_SEPARATOR);
      const bodyEnd = bodyStart + contentLength;
      if (this.inputBuffer.length < bodyEnd)
        return;
      const body = this.inputBuffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.inputBuffer = this.inputBuffer.subarray(bodyEnd);
      this.dispatchBody(body);
    }
  }
  dispatchBody(body) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      void this.writeError(null, PARSE_ERROR, error instanceof Error ? error.message : "Parse error").catch((writeError) => this.emitError(toError(writeError)));
      return;
    }
    if (!isJsonRpcObject(parsed)) {
      void this.writeError(null, INVALID_REQUEST, "Invalid JSON-RPC message").catch((error) => this.emitError(toError(error)));
      return;
    }
    if ("id" in parsed && ("result" in parsed || "error" in parsed)) {
      this.handleResponse(parsed);
      return;
    }
    if (typeof parsed["method"] !== "string") {
      const id = getMessageId(parsed) ?? null;
      void this.writeError(id, INVALID_REQUEST, "Invalid JSON-RPC method").catch((error) => this.emitError(toError(error)));
      return;
    }
    if ("id" in parsed) {
      this.handleRequest(parsed);
      return;
    }
    this.handleNotification(parsed["method"], parsed["params"]);
  }
  handleResponse(message2) {
    const id = getMessageId(message2);
    if (id === void 0)
      return;
    const pending = this.pendingRequests.get(String(id));
    if (!pending)
      return;
    this.pendingRequests.delete(String(id));
    if ("error" in message2) {
      pending.reject(jsonRpcErrorToError(message2["error"]));
      return;
    }
    pending.resolve(message2["result"]);
  }
  handleNotification(method, params) {
    const handler = this.notificationHandlers.get(method);
    if (!handler)
      return;
    try {
      handler(params);
    } catch (error) {
      this.emitError(toError(error));
    }
  }
  handleRequest(message2) {
    const id = getMessageId(message2);
    if (id === void 0) {
      void this.writeError(null, INVALID_REQUEST, "Invalid JSON-RPC id").catch((error) => this.emitError(toError(error)));
      return;
    }
    const method = typeof message2["method"] === "string" ? message2["method"] : "";
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      void this.writeError(id, METHOD_NOT_FOUND, `Method not found: ${method}`).catch((error) => this.emitError(toError(error)));
      return;
    }
    Promise.resolve().then(() => handler(message2["params"])).then((result) => this.writeMessage({ jsonrpc: "2.0", id, result }), (error) => this.writeError(id, INTERNAL_ERROR, toError(error).message)).catch((error) => this.emitError(toError(error)));
  }
  async writeError(id, code, message2) {
    await this.writeMessage({ jsonrpc: "2.0", id, error: { code, message: message2 } });
  }
  writeMessage(message2) {
    const body = JSON.stringify(message2);
    const payload = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r
\r
${body}`;
    return new Promise((resolve8, reject) => {
      this.writer.write(payload, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve8();
      });
    });
  }
  emitError(error) {
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }
};
function parseContentLength(headers) {
  for (const line of headers.split("\r\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1)
      continue;
    const name = line.slice(0, separatorIndex).trim().toLowerCase();
    if (name !== "content-length")
      continue;
    const value = Number.parseInt(line.slice(separatorIndex + 1).trim(), 10);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  return null;
}
function isJsonRpcObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function getMessageId(message2) {
  const id = message2["id"];
  if (typeof id === "number" || typeof id === "string" || id === null)
    return id;
  return void 0;
}
function jsonRpcErrorToError(value) {
  if (!isJsonRpcObject(value))
    return new Error("JSON-RPC request failed");
  const message2 = typeof value["message"] === "string" ? value["message"] : "JSON-RPC request failed";
  const error = new Error(message2);
  if (typeof value["code"] === "number") {
    error.name = `JsonRpcError(${value["code"]})`;
  }
  return error;
}
function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

// packages/lsp-tools-mcp/dist/lsp/server-installation.js
import { delimiter as delimiter3, join as join10 } from "node:path";
function getAdditionalPathBases(workingDirectory) {
  return [join10(workingDirectory, "node_modules", ".bin")];
}

// packages/lsp-tools-mcp/dist/lsp/transport.js
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseConfigurationItems(params) {
  if (!isRecord(params) || !Array.isArray(params["items"]))
    return [];
  const items2 = [];
  for (const item of params["items"]) {
    if (!isRecord(item))
      continue;
    const section = item["section"];
    items2.push(section === void 0 || typeof section !== "string" ? {} : { section });
  }
  return items2;
}
function parseDiagnosticsParams(params) {
  if (!isRecord(params) || typeof params["uri"] !== "string")
    return null;
  const diagnostics = Array.isArray(params["diagnostics"]) ? params["diagnostics"].filter(isDiagnostic) : [];
  return { uri: params["uri"], diagnostics };
}
var LspClientTransport = class {
  constructor(root, server2) {
    this.root = root;
    this.server = server2;
    this.proc = null;
    this.connection = null;
    this.stderrBuffer = [];
    this.processExited = false;
    this.diagnosticsStore = /* @__PURE__ */ new Map();
  }
  pid() {
    return this.proc?.pid;
  }
  command() {
    return [...this.server.command];
  }
  async start() {
    const env = {
      ...process.env,
      ...this.server.env
    };
    const pathValue = process.platform === "win32" ? env["PATH"] ?? env["Path"] ?? "" : env["PATH"] ?? "";
    const spawnPath = [pathValue, ...getAdditionalPathBases(this.root)].filter(Boolean).join(delimiter4);
    if (process.platform === "win32" && env["Path"] !== void 0) {
      env["Path"] = spawnPath;
    }
    env["PATH"] = spawnPath;
    this.proc = spawnProcess(this.server.command, {
      cwd: this.root,
      env
    });
    this.startStderrReading();
    await new Promise((resolve8) => setTimeout(resolve8, 100));
    if (this.proc.exitCode !== null) {
      const stderr = this.stderrBuffer.join("\n");
      throw new LspProcessExitedError(this.server.id, this.root, this.proc.exitCode, stderr.slice(-2e3));
    }
    this.connection = new JsonRpcConnection(this.proc.stdout, this.proc.stdin);
    this.connection.onNotification("textDocument/publishDiagnostics", (params) => {
      const diagnosticsParams = parseDiagnosticsParams(params);
      if (diagnosticsParams?.uri) {
        this.diagnosticsStore.set(diagnosticsParams.uri, diagnosticsParams.diagnostics);
      }
    });
    this.connection.onRequest("workspace/configuration", (params) => {
      const items2 = parseConfigurationItems(params);
      return items2.map((item) => {
        if (item.section === "json")
          return { validate: { enable: true } };
        return {};
      });
    });
    this.connection.onRequest("client/registerCapability", () => null);
    this.connection.onRequest("window/workDoneProgress/create", () => null);
    this.connection.onClose(() => {
      this.processExited = true;
    });
    this.connection.onError((error) => {
      reportBestEffortCleanupError("connection error notification", error);
    });
    this.connection.listen();
  }
  startStderrReading() {
    if (!this.proc)
      return;
    this.proc.stderr.setEncoding("utf-8");
    this.proc.stderr.on("data", (chunk) => {
      this.stderrBuffer.push(chunk);
      if (this.stderrBuffer.length > 100) {
        this.stderrBuffer.shift();
      }
    });
  }
  isConnectionClosedError(error) {
    if (!(error instanceof Error)) {
      return false;
    }
    const code = "code" in error && typeof error.code === "string" ? error.code : void 0;
    return code === "ERR_STREAM_DESTROYED" || /connection closed|connection is disposed|stream was destroyed/i.test(error.message);
  }
  async sendRequest(method, ...args) {
    if (!this.connection)
      throw new Error("LSP client not started");
    if (this.processExited || this.proc && this.proc.exitCode !== null) {
      const stderrTail = this.stderrBuffer.slice(-10).join("\n");
      throw new LspProcessExitedError(this.server.id, this.root, this.proc?.exitCode ?? null, stderrTail || void 0);
    }
    let timeoutHandle = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        const stderrTail = this.stderrBuffer.slice(-5).join("\n");
        reject(new LspRequestTimeoutError(method, stderrTail || void 0));
      }, REQUEST_TIMEOUT_MS);
    });
    try {
      const requestPromise = args.length === 0 ? this.connection.sendRequest(method) : this.connection.sendRequest(method, args[0]);
      const result = await Promise.race([requestPromise, timeoutPromise]);
      if (timeoutHandle !== null)
        clearTimeout(timeoutHandle);
      return result;
    } catch (error) {
      if (timeoutHandle !== null)
        clearTimeout(timeoutHandle);
      if (this.processExited || this.proc && this.proc.exitCode !== null) {
        throw new LspProcessExitedError(this.server.id, this.root, this.proc?.exitCode ?? null, this.stderrBuffer.slice(-10).join("\n") || void 0);
      }
      if (this.isConnectionClosedError(error)) {
        throw new LspConnectionClosedError(this.server.id, this.root, error.message);
      }
      throw error;
    }
  }
  async sendNotification(method, ...args) {
    if (!this.connection)
      return;
    if (this.processExited || this.proc && this.proc.exitCode !== null)
      return;
    try {
      if (args.length === 0) {
        await this.connection.sendNotification(method);
      } else {
        await this.connection.sendNotification(method, args[0]);
      }
    } catch (error) {
      if (this.isConnectionClosedError(error)) {
        throw new LspConnectionClosedError(this.server.id, this.root, error.message);
      }
      throw error;
    }
  }
  isAlive() {
    return this.proc !== null && !this.processExited && this.proc.exitCode === null;
  }
  async stop() {
    if (this.connection) {
      try {
        await this.sendRequest("shutdown");
      } catch (error) {
        reportBestEffortCleanupError("shutdown request", error);
      }
      try {
        await this.sendNotification("exit");
      } catch (error) {
        reportBestEffortCleanupError("exit notification", error);
      }
      try {
        this.connection.dispose();
      } catch (error) {
        reportBestEffortCleanupError("connection dispose", error);
      }
      this.connection = null;
    }
    const proc = this.proc;
    if (proc) {
      this.proc = null;
      let exitedBeforeTimeout = false;
      try {
        proc.kill();
        let timeoutId;
        const timeoutPromise = new Promise((resolve8) => {
          timeoutId = setTimeout(resolve8, STOP_HARD_KILL_TIMEOUT_MS);
        });
        await Promise.race([
          proc.exited.then(() => {
            exitedBeforeTimeout = true;
          }).finally(() => {
            if (timeoutId)
              clearTimeout(timeoutId);
          }),
          timeoutPromise
        ]);
        if (!exitedBeforeTimeout) {
          try {
            proc.kill("SIGKILL");
            await Promise.race([
              proc.exited,
              new Promise((resolve8) => setTimeout(resolve8, STOP_SIGKILL_GRACE_MS))
            ]);
          } catch (error) {
            reportBestEffortCleanupError("hard process kill", error);
          }
        }
      } catch (error) {
        reportBestEffortCleanupError("process stop", error);
      }
    }
    this.processExited = true;
    this.diagnosticsStore.clear();
  }
  getStoredDiagnostics(uri) {
    return this.diagnosticsStore.get(uri) ?? [];
  }
};
function isDiagnostic(value) {
  return isRecord(value) && isRange(value["range"]) && typeof value["message"] === "string";
}
function isRange(value) {
  return isRecord(value) && isPosition(value["start"]) && isPosition(value["end"]);
}
function isPosition(value) {
  return isRecord(value) && typeof value["line"] === "number" && typeof value["character"] === "number";
}

// packages/lsp-tools-mcp/dist/lsp/connection.js
var INITIALIZE_SETTLE_MS = 300;
var LspClientConnection = class extends LspClientTransport {
  async initialize() {
    const rootUri = pathToFileURL(this.root).href;
    await this.sendRequest("initialize", {
      processId: process.pid,
      rootUri,
      rootPath: this.root,
      workspaceFolders: [{ uri: rootUri, name: "workspace" }],
      capabilities: {
        textDocument: {
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: true },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: {},
          rename: {
            prepareSupport: true,
            prepareSupportDefaultBehavior: 1,
            honorsChangeAnnotations: true
          },
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: [
                  "quickfix",
                  "refactor",
                  "refactor.extract",
                  "refactor.inline",
                  "refactor.rewrite",
                  "source",
                  "source.organizeImports",
                  "source.fixAll"
                ]
              }
            },
            isPreferredSupport: true,
            disabledSupport: true,
            dataSupport: true,
            resolveSupport: {
              properties: ["edit", "command"]
            }
          }
        },
        workspace: {
          symbol: {},
          workspaceFolders: true,
          configuration: true,
          applyEdit: true,
          workspaceEdit: {
            documentChanges: true
          }
        }
      },
      initializationOptions: this.server.initialization
    });
    await this.sendNotification("initialized");
    await this.sendNotification("workspace/didChangeConfiguration", {
      settings: { json: { validate: { enable: true } } }
    });
    await new Promise((r) => setTimeout(r, INITIALIZE_SETTLE_MS));
  }
};

// packages/lsp-tools-mcp/dist/lsp/language-mappings.js
var EXT_TO_LANG = {
  ".abap": "abap",
  ".bat": "bat",
  ".bib": "bibtex",
  ".bibtex": "bibtex",
  ".clj": "clojure",
  ".cljs": "clojure",
  ".cljc": "clojure",
  ".edn": "clojure",
  ".coffee": "coffeescript",
  ".c": "c",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".cc": "cpp",
  ".c++": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".d": "d",
  ".pas": "pascal",
  ".pascal": "pascal",
  ".diff": "diff",
  ".patch": "diff",
  ".dart": "dart",
  ".dockerfile": "dockerfile",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".hrl": "erlang",
  ".fs": "fsharp",
  ".fsi": "fsharp",
  ".fsx": "fsharp",
  ".fsscript": "fsharp",
  ".gitcommit": "git-commit",
  ".gitrebase": "git-rebase",
  ".go": "go",
  ".groovy": "groovy",
  ".gleam": "gleam",
  ".hbs": "handlebars",
  ".handlebars": "handlebars",
  ".hs": "haskell",
  ".html": "html",
  ".htm": "html",
  ".ini": "ini",
  ".java": "java",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".json": "json",
  ".jsonc": "jsonc",
  ".tex": "latex",
  ".latex": "latex",
  ".less": "less",
  ".lua": "lua",
  ".makefile": "makefile",
  makefile: "makefile",
  ".md": "markdown",
  ".markdown": "markdown",
  ".m": "objective-c",
  ".mm": "objective-cpp",
  ".pl": "perl",
  ".pm": "perl",
  ".pm6": "perl6",
  ".php": "php",
  ".ps1": "powershell",
  ".psm1": "powershell",
  ".pug": "jade",
  ".jade": "jade",
  ".py": "python",
  ".pyi": "python",
  ".r": "r",
  ".cshtml": "razor",
  ".razor": "razor",
  ".rb": "ruby",
  ".rake": "ruby",
  ".gemspec": "ruby",
  ".ru": "ruby",
  ".erb": "erb",
  ".html.erb": "erb",
  ".js.erb": "erb",
  ".css.erb": "erb",
  ".json.erb": "erb",
  ".rs": "rust",
  ".scss": "scss",
  ".sass": "sass",
  ".scala": "scala",
  ".shader": "shaderlab",
  ".sh": "shellscript",
  ".bash": "shellscript",
  ".zsh": "shellscript",
  ".ksh": "shellscript",
  ".sql": "sql",
  ".svelte": "svelte",
  ".swift": "swift",
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".mts": "typescript",
  ".cts": "typescript",
  ".mtsx": "typescriptreact",
  ".ctsx": "typescriptreact",
  ".xml": "xml",
  ".xsl": "xsl",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".vue": "vue",
  ".zig": "zig",
  ".zon": "zig",
  ".astro": "astro",
  ".ml": "ocaml",
  ".mli": "ocaml",
  ".tf": "terraform",
  ".tfvars": "terraform-vars",
  ".hcl": "hcl",
  ".nix": "nix",
  ".typ": "typst",
  ".typc": "typst",
  ".ets": "typescript",
  ".lhs": "haskell",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".prisma": "prisma",
  ".h": "c",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".hxx": "cpp",
  ".h++": "cpp",
  ".objc": "objective-c",
  ".objcpp": "objective-cpp",
  ".fish": "fish",
  ".graphql": "graphql",
  ".gql": "graphql"
};
function getLanguageId(ext) {
  return EXT_TO_LANG[ext] ?? "plaintext";
}

// packages/lsp-tools-mcp/dist/lsp/client.js
var POST_OPEN_DELAY_MS = 1e3;
var POST_DIAGNOSTICS_WAIT_MS = 500;
var LspClient = class extends LspClientConnection {
  constructor() {
    super(...arguments);
    this.openedFiles = /* @__PURE__ */ new Set();
    this.documentVersions = /* @__PURE__ */ new Map();
    this.lastSyncedText = /* @__PURE__ */ new Map();
    this.diagnosticPullErrors = [];
  }
  getDiagnosticPullErrors() {
    return this.diagnosticPullErrors;
  }
  async openFile(filePath) {
    const absPath = resolve5(filePath);
    const uri = pathToFileURL2(absPath).href;
    const text2 = readFileSync(absPath, "utf-8");
    if (!this.openedFiles.has(absPath)) {
      const ext = extname4(absPath);
      const languageId = getLanguageId(ext);
      const version = 1;
      await this.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId,
          version,
          text: text2
        }
      });
      this.openedFiles.add(absPath);
      this.documentVersions.set(uri, version);
      this.lastSyncedText.set(uri, text2);
      await new Promise((r) => setTimeout(r, POST_OPEN_DELAY_MS));
      return;
    }
    const prevText = this.lastSyncedText.get(uri);
    if (prevText === text2) {
      return;
    }
    const nextVersion = (this.documentVersions.get(uri) ?? 1) + 1;
    this.documentVersions.set(uri, nextVersion);
    this.lastSyncedText.set(uri, text2);
    await this.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: nextVersion },
      contentChanges: [{ text: text2 }]
    });
    await this.sendNotification("textDocument/didSave", {
      textDocument: { uri },
      text: text2
    });
  }
  async definition(filePath, line, character) {
    const absPath = resolve5(filePath);
    await this.openFile(absPath);
    return this.sendRequest("textDocument/definition", {
      textDocument: { uri: pathToFileURL2(absPath).href },
      position: { line: line - 1, character }
    });
  }
  async references(filePath, line, character, includeDeclaration = true) {
    const absPath = resolve5(filePath);
    await this.openFile(absPath);
    return this.sendRequest("textDocument/references", {
      textDocument: { uri: pathToFileURL2(absPath).href },
      position: { line: line - 1, character },
      context: { includeDeclaration }
    });
  }
  async documentSymbols(filePath) {
    const absPath = resolve5(filePath);
    await this.openFile(absPath);
    return this.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri: pathToFileURL2(absPath).href }
    });
  }
  async workspaceSymbols(query) {
    return this.sendRequest("workspace/symbol", { query });
  }
  isUnsupportedDiagnosticPullError(error) {
    if (!(error instanceof Error))
      return false;
    const code = "code" in error && typeof error.code === "number" ? error.code : void 0;
    if (code === -32601)
      return true;
    return /unsupported|not supported|method not found|unknown request/i.test(error.message);
  }
  async diagnostics(filePath) {
    const absPath = resolve5(filePath);
    const uri = pathToFileURL2(absPath).href;
    await this.openFile(absPath);
    await new Promise((r) => setTimeout(r, POST_DIAGNOSTICS_WAIT_MS));
    try {
      const result = await this.sendRequest("textDocument/diagnostic", {
        textDocument: { uri }
      });
      if (result.items) {
        return { items: result.items };
      }
    } catch (error) {
      if (!this.isUnsupportedDiagnosticPullError(error)) {
        this.diagnosticPullErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return { items: this.getStoredDiagnostics(uri) };
  }
  async prepareRename(filePath, line, character) {
    const absPath = resolve5(filePath);
    await this.openFile(absPath);
    return this.sendRequest("textDocument/prepareRename", {
      textDocument: { uri: pathToFileURL2(absPath).href },
      position: { line: line - 1, character }
    });
  }
  async rename(filePath, line, character, newName) {
    const absPath = resolve5(filePath);
    await this.openFile(absPath);
    return this.sendRequest("textDocument/rename", {
      textDocument: { uri: pathToFileURL2(absPath).href },
      position: { line: line - 1, character },
      newName
    });
  }
};

// packages/lsp-tools-mcp/dist/lsp/process-signal-cleanup.js
import { constants as constants3 } from "node:os";
var PROCESS_SIGNALS = process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
var registrations = /* @__PURE__ */ new Set();
var signalHandlers = /* @__PURE__ */ new Map();
var handlersInstalled = false;
var handlingSignal = false;
function removeSignalHandlers() {
  if (!handlersInstalled)
    return;
  for (const [signal, handler] of signalHandlers)
    process.removeListener(signal, handler);
  signalHandlers.clear();
  handlersInstalled = false;
}
function signalExitCode(signal) {
  return 128 + (constants3.signals[signal] ?? 1);
}
function terminateParent(signal) {
  if (process.platform === "win32" && signal === "SIGBREAK") {
    process.exit(signalExitCode(signal));
  }
  try {
    process.kill(process.pid, signal);
  } catch (error) {
    reportBestEffortCleanupError("signal re-delivery", error);
    process.exit(signalExitCode(signal));
  }
}
async function runCleanup(registration) {
  try {
    await registration.cleanup();
  } catch (error) {
    reportBestEffortCleanupError("signal cleanup", error);
  }
}
function handleSignal(signal) {
  if (handlingSignal)
    return;
  handlingSignal = true;
  const activeRegistrations = [...registrations];
  const shouldTerminateParent = activeRegistrations.some((registration) => registration.terminatesParent);
  void Promise.all(activeRegistrations.map(runCleanup)).then(() => {
    removeSignalHandlers();
    if (shouldTerminateParent) {
      terminateParent(signal);
      return;
    }
    handlingSignal = false;
    if (registrations.size > 0)
      ensureSignalHandlers();
  });
}
function ensureSignalHandlers() {
  if (handlersInstalled)
    return;
  for (const signal of PROCESS_SIGNALS) {
    const handler = () => handleSignal(signal);
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  handlersInstalled = true;
}
function installProcessSignalCleanup(cleanup, options = {}) {
  const registration = {
    cleanup,
    terminatesParent: options.terminateParent ?? false
  };
  registrations.add(registration);
  ensureSignalHandlers();
  return () => {
    registrations.delete(registration);
    if (registrations.size === 0 && !handlingSignal)
      removeSignalHandlers();
  };
}

// packages/lsp-tools-mcp/dist/lsp/manager.js
async function stopClientBestEffort(client) {
  try {
    await client.stop();
  } catch (error) {
    reportBestEffortCleanupError("client stop", error);
  }
}
function awaitWithSignal(promise, signal) {
  if (!signal)
    return promise;
  return new Promise((resolve8, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled)
        return;
      settled = true;
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => {
      if (settled)
        return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve8(value);
    }, (err) => {
      if (settled)
        return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(err);
    });
  });
}
var LspManager = class {
  constructor(options = {}) {
    this.clients = /* @__PURE__ */ new Map();
    this.reaperHandle = null;
    this.signalDisposer = null;
    this.disposed = false;
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.initTimeoutMs = options.initTimeoutMs ?? INIT_TIMEOUT_MS;
    this.reaperIntervalMs = options.reaperIntervalMs ?? REAPER_INTERVAL_MS;
    this.clientFactory = options.clientFactory ?? ((root, server2) => new LspClient(root, server2));
    this.now = options.now ?? (() => Date.now());
    this.startReaper();
    this.signalDisposer = installProcessSignalCleanup(() => this.stopAll());
  }
  startReaper() {
    if (this.reaperHandle)
      return;
    this.reaperHandle = setInterval(() => {
      this.reapStale();
    }, this.reaperIntervalMs);
    if (typeof this.reaperHandle.unref === "function") {
      this.reaperHandle.unref();
    }
  }
  getKey(root, serverId) {
    return `${root}::${serverId}`;
  }
  reapStale() {
    const t = this.now();
    for (const [key, managed] of this.clients) {
      if (managed.isInitializing && managed.initializingSince !== null && t - managed.initializingSince > this.initTimeoutMs) {
        void stopClientBestEffort(managed.client);
        this.clients.delete(key);
        continue;
      }
      if (!managed.isInitializing && managed.refCount === 0 && managed.pendingWaiters === 0 && t - managed.lastUsedAt > this.idleTimeoutMs) {
        void stopClientBestEffort(managed.client);
        this.clients.delete(key);
      }
    }
  }
  async tryDeleteIfOrphaned(key, managed) {
    if (managed.refCount === 0 && managed.pendingWaiters === 0 && !managed.isInitializing && this.clients.get(key) === managed) {
      this.clients.delete(key);
      await stopClientBestEffort(managed.client);
    }
  }
  async getClient(root, server2, signal) {
    if (this.disposed) {
      throw new Error("LspManager has been disposed");
    }
    signal?.throwIfAborted();
    const key = this.getKey(root, server2.id);
    let managed = this.clients.get(key);
    if (managed) {
      const t = this.now();
      if (managed.isInitializing && managed.initializingSince !== null && t - managed.initializingSince > this.initTimeoutMs) {
        await stopClientBestEffort(managed.client);
        this.clients.delete(key);
        managed = void 0;
      }
    }
    if (managed) {
      if (managed.initPromise) {
        managed.pendingWaiters++;
        try {
          await awaitWithSignal(managed.initPromise, signal);
        } catch (err) {
          managed.pendingWaiters--;
          await this.tryDeleteIfOrphaned(key, managed);
          throw err;
        }
        managed.pendingWaiters--;
      }
      if (signal?.aborted) {
        await this.tryDeleteIfOrphaned(key, managed);
        signal.throwIfAborted();
      }
      if (!managed.client.isAlive()) {
        await stopClientBestEffort(managed.client);
        this.clients.delete(key);
        return this.getClient(root, server2, signal);
      }
      managed.refCount++;
      managed.lastUsedAt = this.now();
      return managed.client;
    }
    const client = this.clientFactory(root, server2);
    const initStartedAt = this.now();
    const initPromise = (async () => {
      await client.start();
      await client.initialize();
    })();
    const newManaged = {
      client,
      refCount: 0,
      pendingWaiters: 1,
      lastUsedAt: initStartedAt,
      initPromise,
      isInitializing: true,
      initializingSince: initStartedAt
    };
    this.clients.set(key, newManaged);
    try {
      await awaitWithSignal(initPromise, signal);
    } catch (err) {
      newManaged.pendingWaiters--;
      if (this.clients.get(key) === newManaged) {
        this.clients.delete(key);
      }
      await stopClientBestEffort(client);
      throw err;
    }
    newManaged.pendingWaiters--;
    newManaged.isInitializing = false;
    newManaged.initializingSince = null;
    newManaged.initPromise = null;
    if (signal?.aborted) {
      await this.tryDeleteIfOrphaned(key, newManaged);
      signal.throwIfAborted();
    }
    newManaged.refCount++;
    newManaged.lastUsedAt = this.now();
    return client;
  }
  releaseClient(root, serverId) {
    const key = this.getKey(root, serverId);
    const managed = this.clients.get(key);
    if (managed && managed.refCount > 0) {
      managed.refCount--;
      managed.lastUsedAt = this.now();
    }
  }
  invalidateClient(root, serverId, client) {
    const key = this.getKey(root, serverId);
    const managed = this.clients.get(key);
    if (!managed)
      return;
    if (client && managed.client !== client)
      return;
    this.clients.delete(key);
    void stopClientBestEffort(managed.client);
  }
  warmupClient(root, server2) {
    if (this.disposed)
      return;
    const key = this.getKey(root, server2.id);
    if (this.clients.has(key))
      return;
    const client = this.clientFactory(root, server2);
    const initStartedAt = this.now();
    const initPromise = (async () => {
      await client.start();
      await client.initialize();
    })();
    const managed = {
      client,
      refCount: 0,
      pendingWaiters: 0,
      lastUsedAt: initStartedAt,
      initPromise,
      isInitializing: true,
      initializingSince: initStartedAt
    };
    this.clients.set(key, managed);
    initPromise.then(() => {
      managed.isInitializing = false;
      managed.initializingSince = null;
      managed.initPromise = null;
      managed.lastUsedAt = this.now();
    }, () => {
      if (this.clients.get(key) === managed) {
        this.clients.delete(key);
      }
      void stopClientBestEffort(client);
    });
  }
  isServerInitializing(root, serverId) {
    const managed = this.clients.get(this.getKey(root, serverId));
    return managed?.isInitializing ?? false;
  }
  getSnapshot() {
    const snapshots = [];
    for (const [key, managed] of this.clients) {
      const [root, serverId] = key.split("::");
      snapshots.push({
        root,
        serverId,
        refCount: managed.refCount,
        pendingWaiters: managed.pendingWaiters,
        lastUsedAt: managed.lastUsedAt,
        isInitializing: managed.isInitializing,
        alive: managed.client.isAlive(),
        command: managed.client.command()
      });
    }
    return snapshots;
  }
  hasClient(root, serverId) {
    return this.clients.has(this.getKey(root, serverId));
  }
  clientCount() {
    return this.clients.size;
  }
  async stopAll() {
    this.disposed = true;
    if (this.reaperHandle) {
      clearInterval(this.reaperHandle);
      this.reaperHandle = null;
    }
    if (this.signalDisposer) {
      this.signalDisposer();
      this.signalDisposer = null;
    }
    const stopPromises = [];
    for (const managed of this.clients.values()) {
      stopPromises.push(stopClientBestEffort(managed.client));
    }
    this.clients.clear();
    await Promise.allSettled(stopPromises);
  }
};

// packages/lsp-tools-mcp/dist/lsp/workspace-root.js
import { existsSync as existsSync3, statSync as statSync3 } from "node:fs";
import { dirname as dirname7, join as join14, resolve as resolve6 } from "node:path";

// packages/lsp-tools-mcp/dist/lsp/cargo-workspace-root.js
import { existsSync as existsSync2, realpathSync as realpathSync2 } from "node:fs";
import { dirname as dirname6, join as join13 } from "node:path";

// packages/lsp-tools-mcp/dist/lsp/abortable-shared-operation.js
function abortReason(signal) {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}
function releaseSharedOperationWaiter(operation) {
  operation.waiterCount -= 1;
  if (operation.waiterCount > 0 || operation.settled)
    return;
  operation.controller.abort();
  operation.onAbandoned();
  void operation.promise.catch(() => void 0);
}
function createSharedAbortableOperation(run2, onSettled, onAbandoned) {
  const controller = new AbortController();
  let operation;
  const promise = run2(controller.signal).finally(() => {
    operation.settled = true;
    onSettled();
  });
  operation = {
    controller,
    promise,
    onAbandoned,
    waiterCount: 0,
    settled: false
  };
  void promise.catch(() => void 0);
  return operation;
}
function awaitSharedAbortableOperation(operation, signal) {
  signal?.throwIfAborted();
  operation.waiterCount += 1;
  return new Promise((resolve8, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled)
        return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      releaseSharedOperationWaiter(operation);
      reject(signal === void 0 ? new DOMException("Aborted", "AbortError") : abortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    operation.promise.then((value) => {
      if (settled)
        return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      releaseSharedOperationWaiter(operation);
      resolve8(value);
    }, (error) => {
      if (settled)
        return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      releaseSharedOperationWaiter(operation);
      reject(error);
    });
  });
}

// packages/lsp-tools-mcp/dist/lsp/cargo-manifest-snapshot.js
import { readFileSync as readFileSync2 } from "node:fs";
import { dirname as dirname5, join as join11 } from "node:path";
function isMissingManifestError(error) {
  if (!(error instanceof Error))
    return false;
  const code = "code" in error ? error.code : void 0;
  return code === "ENOENT" || code === "ENOTDIR";
}
function readManifestSnapshot(path, allowMissing = false) {
  try {
    return { path, exists: true, content: readFileSync2(path, "utf8") };
  } catch (error) {
    if (allowMissing && isMissingManifestError(error)) {
      return { path, exists: false, content: void 0 };
    }
    return void 0;
  }
}
function snapshotsAreFresh(snapshots) {
  for (const snapshot of snapshots) {
    const candidate = readManifestSnapshot(snapshot.path, true);
    if (candidate === void 0)
      return false;
    if (candidate.exists !== snapshot.exists)
      return false;
    if (!candidate.exists)
      continue;
    if (candidate.content !== snapshot.content)
      return false;
  }
  return true;
}
function ancestorManifestPaths(manifestDir) {
  const paths = [];
  const seen = /* @__PURE__ */ new Set();
  let dir = manifestDir;
  let prev = "";
  while (dir !== prev) {
    const manifestPath = join11(dir, "Cargo.toml");
    if (!seen.has(manifestPath)) {
      seen.add(manifestPath);
      paths.push(manifestPath);
    }
    prev = dir;
    dir = dirname5(dir);
  }
  return paths;
}
function readAncestorManifestSnapshots(manifestDir) {
  const snapshots = [];
  const manifestPaths = ancestorManifestPaths(manifestDir);
  for (const [index, manifestPath] of manifestPaths.entries()) {
    const snapshot = readManifestSnapshot(manifestPath, true);
    if (snapshot === void 0)
      return void 0;
    if (index === 0 && !snapshot.exists)
      return void 0;
    snapshots.push(snapshot);
  }
  return snapshots.length === 0 ? void 0 : snapshots;
}

// packages/lsp-tools-mcp/dist/lsp/cargo-metadata-parser.js
import { readFileSync as readFileSync3, realpathSync, statSync as statSync2 } from "node:fs";
import { isAbsolute as isAbsolute6, join as join12, relative as relative2, sep as sep2 } from "node:path";
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function canonicalDirectory(path) {
  try {
    const canonicalPath = realpathSync.native(path);
    return statSync2(canonicalPath).isDirectory() ? canonicalPath : void 0;
  } catch {
    return void 0;
  }
}
function canonicalManifest(path) {
  try {
    const canonicalPath = realpathSync.native(path);
    return statSync2(canonicalPath).isFile() ? canonicalPath : void 0;
  } catch {
    return void 0;
  }
}
function readFile9(path) {
  try {
    return readFileSync3(path, "utf8");
  } catch {
    return void 0;
  }
}
function readCargoManifestKind(path) {
  const content = readFile9(path);
  if (content === void 0)
    return void 0;
  try {
    return Object.hasOwn(parse(content), "workspace") ? "workspace" : "ordinary";
  } catch {
    return "invalid";
  }
}
function isContainedPath(root, path) {
  const relativePath = relative2(root, path);
  return relativePath === "" || !isAbsolute6(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep2}`);
}
function parseCargoMetadata(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return void 0;
  }
  if (!isRecord2(parsed))
    return void 0;
  const workspaceRoot = parsed["workspace_root"];
  const workspaceMembers = parsed["workspace_members"];
  const packages = parsed["packages"];
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0)
    return void 0;
  if (!Array.isArray(workspaceMembers) || !Array.isArray(packages))
    return void 0;
  const memberIds = /* @__PURE__ */ new Set();
  for (const id of workspaceMembers) {
    if (typeof id !== "string")
      return void 0;
    memberIds.add(id);
  }
  const memberManifestPaths = [];
  for (const pkg of packages) {
    if (!isRecord2(pkg))
      return void 0;
    const id = pkg["id"];
    const manifestPath = pkg["manifest_path"];
    if (typeof id !== "string" || typeof manifestPath !== "string")
      return void 0;
    if (memberIds.has(id))
      memberManifestPaths.push(manifestPath);
  }
  if (memberManifestPaths.length !== memberIds.size)
    return void 0;
  return { workspaceRoot, memberManifestPaths };
}
function validateCargoMetadata(requestedManifestPath, metadata) {
  const workspaceRoot = canonicalDirectory(metadata.workspaceRoot);
  if (workspaceRoot === void 0)
    return void 0;
  const rootManifestPath = canonicalManifest(join12(workspaceRoot, "Cargo.toml"));
  const requestedManifest = canonicalManifest(requestedManifestPath);
  if (rootManifestPath === void 0 || requestedManifest === void 0)
    return void 0;
  if (!isContainedPath(workspaceRoot, requestedManifest))
    return void 0;
  const rootManifestKind = readCargoManifestKind(rootManifestPath);
  const requestedManifestKind = requestedManifest === rootManifestPath ? rootManifestKind : readCargoManifestKind(requestedManifest);
  if (rootManifestKind === void 0 || rootManifestKind === "invalid")
    return void 0;
  if (requestedManifestKind === void 0 || requestedManifestKind === "invalid")
    return void 0;
  if (requestedManifest !== rootManifestPath && requestedManifestKind === "workspace")
    return void 0;
  const memberManifestPaths = [];
  const members = /* @__PURE__ */ new Set();
  for (const manifestPath of metadata.memberManifestPaths) {
    const canonicalPath = canonicalManifest(manifestPath);
    if (canonicalPath === void 0)
      return void 0;
    if (!isContainedPath(workspaceRoot, canonicalPath))
      return void 0;
    const manifestKind = canonicalPath === rootManifestPath ? rootManifestKind : readCargoManifestKind(canonicalPath);
    if (manifestKind === void 0)
      return void 0;
    if (canonicalPath !== rootManifestPath && manifestKind !== "ordinary")
      continue;
    if (!members.has(canonicalPath)) {
      members.add(canonicalPath);
      memberManifestPaths.push(canonicalPath);
    }
  }
  if (requestedManifest !== rootManifestPath && !members.has(requestedManifest))
    return void 0;
  return { workspaceRoot, rootManifestPath, memberManifestPaths };
}
function parseTrustedCargoMetadata(requestedManifestPath, output) {
  const parsed = parseCargoMetadata(output);
  return parsed === void 0 ? void 0 : validateCargoMetadata(requestedManifestPath, parsed);
}

// packages/lsp-tools-mcp/dist/lsp/cargo-metadata-process.js
import { spawn as spawn3 } from "node:child_process";
var CARGO_METADATA_MAX_BUFFER = 64 * 1024 * 1024;
var CARGO_METADATA_TIMEOUT_MS = 1e4;
var CARGO_METADATA_FORCE_KILL_DELAY_MS = 250;
var activeCargoMetadataCleanups = /* @__PURE__ */ new Set();
var removeProcessSignalHandlers;
async function abortActiveCargoMetadata() {
  const cleanups = [...activeCargoMetadataCleanups];
  for (const cleanup of cleanups) {
    if (!cleanup.controller.signal.aborted)
      cleanup.controller.abort();
  }
  await Promise.all(cleanups.map((cleanup) => cleanup.waitForTermination()));
}
function ensureProcessSignalHandlers() {
  if (removeProcessSignalHandlers !== void 0)
    return;
  removeProcessSignalHandlers = installProcessSignalCleanup(abortActiveCargoMetadata);
}
function registerCargoMetadataCleanup(controller, waitForTermination) {
  activeCargoMetadataCleanups.add({ controller, waitForTermination });
}
function releaseCargoMetadataController(controller) {
  for (const cleanup of activeCargoMetadataCleanups) {
    if (cleanup.controller === controller)
      activeCargoMetadataCleanups.delete(cleanup);
  }
  if (activeCargoMetadataCleanups.size > 0)
    return;
  removeProcessSignalHandlers?.();
  removeProcessSignalHandlers = void 0;
}
function linkParentSignal(controller, signal) {
  if (signal === void 0)
    return () => {
    };
  const abortFromParent = () => controller.abort(signal.reason);
  if (signal.aborted) {
    abortFromParent();
    return () => {
    };
  }
  signal.addEventListener("abort", abortFromParent, { once: true });
  return () => signal.removeEventListener("abort", abortFromParent);
}
async function defaultCargoMetadataLoader(manifestPath, signal) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const unlinkParentSignal = linkParentSignal(controller, signal);
  ensureProcessSignalHandlers();
  try {
    controller.signal.throwIfAborted();
    return await new Promise((resolveLoader, rejectLoader) => {
      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let cargoProcess;
      let cleanupStarted = false;
      let forceKillTimeout;
      let timeoutError;
      let terminationError;
      let settled = false;
      let resolveTermination;
      const terminationComplete = new Promise((resolve8) => {
        resolveTermination = resolve8;
      });
      const finishTermination = () => {
        resolveTermination?.();
        resolveTermination = void 0;
      };
      const terminateCargoProcessTree = (terminationSignal) => {
        if (cargoProcess !== void 0)
          terminateProcessTree(cargoProcess, terminationSignal);
      };
      const beginCargoCleanup = () => {
        if (cleanupStarted)
          return;
        cleanupStarted = true;
        terminateCargoProcessTree("SIGTERM");
        forceKillTimeout = setTimeout(() => {
          forceKillTimeout = void 0;
          terminateCargoProcessTree("SIGKILL");
          finishTermination();
        }, CARGO_METADATA_FORCE_KILL_DELAY_MS);
      };
      const clearCleanupTracking = () => {
        clearTimeout(timeout);
        controller.signal.removeEventListener("abort", beginCargoCleanup);
        if (!cleanupStarted) {
          if (forceKillTimeout !== void 0) {
            clearTimeout(forceKillTimeout);
            forceKillTimeout = void 0;
          }
          finishTermination();
          return;
        }
        if (forceKillTimeout === void 0)
          finishTermination();
      };
      const timeout = setTimeout(() => {
        timeoutError = new Error(`cargo metadata timed out after ${CARGO_METADATA_TIMEOUT_MS}ms`);
        timeoutError.name = "TimeoutError";
        beginCargoCleanup();
      }, CARGO_METADATA_TIMEOUT_MS);
      controller.signal.addEventListener("abort", beginCargoCleanup, { once: true });
      registerCargoMetadataCleanup(controller, () => terminationComplete);
      const commandArgs = ["metadata", "--no-deps", "--format-version", "1", "--manifest-path", manifestPath];
      const rejectWithCurrentReason = (error) => {
        rejectLoader(controller.signal.aborted ? controller.signal.reason : error);
      };
      const settle = (callback) => {
        if (settled)
          return;
        settled = true;
        callback();
      };
      const appendChunk = (chunks, chunk, currentBytes) => {
        const nextBytes = currentBytes + Buffer.byteLength(chunk, "utf8");
        if (nextBytes > CARGO_METADATA_MAX_BUFFER && terminationError === void 0) {
          terminationError = new RangeError("cargo metadata output exceeded maxBuffer");
          beginCargoCleanup();
        }
        chunks.push(chunk);
        return nextBytes;
      };
      cargoProcess = spawn3("cargo", commandArgs, {
        detached: process.platform !== "win32",
        signal: controller.signal,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      cargoProcess.stdout?.setEncoding("utf8");
      cargoProcess.stderr?.setEncoding("utf8");
      cargoProcess.stdout?.on("data", (chunk) => {
        stdoutBytes = appendChunk(stdoutChunks, chunk, stdoutBytes);
      });
      cargoProcess.stderr?.on("data", (chunk) => {
        stderrBytes = appendChunk(stderrChunks, chunk, stderrBytes);
      });
      cargoProcess.once("error", (error) => {
        settle(() => {
          clearCleanupTracking();
          if (controller.signal.aborted) {
            rejectWithCurrentReason(error);
            return;
          }
          rejectLoader(error);
        });
      });
      cargoProcess.once("close", (code, closeSignal) => {
        settle(() => {
          clearCleanupTracking();
          if (controller.signal.aborted) {
            rejectWithCurrentReason(timeoutError);
            return;
          }
          if (timeoutError !== void 0) {
            rejectLoader(timeoutError);
            return;
          }
          if (terminationError !== void 0) {
            rejectLoader(terminationError);
            return;
          }
          if (code === 0 && closeSignal === null) {
            resolveLoader(stdoutChunks.join(""));
            return;
          }
          const stderrOutput = stderrChunks.join("").trim();
          const exitDetail = closeSignal === null ? `exit code ${code ?? 0}` : `signal ${closeSignal}`;
          rejectLoader(new Error(stderrOutput.length > 0 ? `cargo metadata failed with ${exitDetail}: ${stderrOutput}` : `cargo metadata failed with ${exitDetail}`));
        });
      });
    });
  } finally {
    unlinkParentSignal();
    releaseCargoMetadataController(controller);
  }
}

// packages/lsp-tools-mcp/dist/lsp/cargo-workspace-root.js
var CARGO_METADATA_FAILURE_BACKOFF_MS = 1e3;
var cargoWorkspaceRootCache = /* @__PURE__ */ new Map();
var cargoWorkspaceRootFailures = /* @__PURE__ */ new Map();
var cargoWorkspaceRootInFlight = /* @__PURE__ */ new Map();
function realpathSafe(path) {
  try {
    return realpathSync2.native(path);
  } catch {
    return path;
  }
}
function nearestCargoManifestDir(startDir) {
  let dir = startDir;
  let prev = "";
  while (dir !== prev) {
    if (existsSync2(join13(dir, "Cargo.toml")))
      return dir;
    prev = dir;
    dir = dirname6(dir);
  }
  return void 0;
}
function cacheEntryFor(root, memberManifestDir) {
  const snapshots = readAncestorManifestSnapshots(memberManifestDir);
  return snapshots === void 0 ? void 0 : { root, snapshots };
}
function prepareCargoWorkspaceCache(manifestDir, metadata) {
  const entries = /* @__PURE__ */ new Map();
  for (const manifestPath of metadata.memberManifestPaths) {
    const manifestDir2 = dirname6(manifestPath);
    const entry = cacheEntryFor(metadata.workspaceRoot, manifestDir2);
    if (entry === void 0)
      return void 0;
    entries.set(manifestDir2, entry);
  }
  const requestedManifestPath = canonicalManifest(join13(manifestDir, "Cargo.toml"));
  if (requestedManifestPath === void 0)
    return void 0;
  const requestedEntry = cacheEntryFor(metadata.workspaceRoot, dirname6(requestedManifestPath));
  if (requestedEntry === void 0)
    return void 0;
  entries.set(manifestDir, requestedEntry);
  return { root: metadata.workspaceRoot, entries };
}
function preparedCacheIsFresh(prepared) {
  for (const entry of prepared.entries.values()) {
    if (!snapshotsAreFresh(entry.snapshots))
      return false;
  }
  return true;
}
function commitCargoWorkspaceCache(prepared) {
  for (const [manifestDir, entry] of prepared.entries) {
    cargoWorkspaceRootCache.set(manifestDir, entry);
  }
}
function cacheCargoWorkspaceFailure(manifestDir, nowMs, snapshots) {
  cargoWorkspaceRootFailures.set(manifestDir, {
    expiresAtMs: nowMs + CARGO_METADATA_FAILURE_BACKOFF_MS,
    snapshots
  });
}
function cacheCargoWorkspaceLoadFailure(request) {
  cacheCargoWorkspaceFailure(request.manifestDir, request.now(), request.generation.snapshots);
}
function cachedCargoWorkspaceFailure(manifestDir, nowMs) {
  const cached = cargoWorkspaceRootFailures.get(manifestDir);
  if (cached === void 0)
    return false;
  if (nowMs >= cached.expiresAtMs) {
    cargoWorkspaceRootFailures.delete(manifestDir);
    return false;
  }
  if (snapshotsAreFresh(cached.snapshots))
    return true;
  cargoWorkspaceRootFailures.delete(manifestDir);
  return false;
}
function isAbortError(error) {
  if (error instanceof DOMException && error.name === "AbortError")
    return true;
  return error instanceof Error && error.name === "AbortError";
}
function sameCargoWorkspaceGeneration(left, right) {
  if (left.snapshots.length !== right.snapshots.length)
    return false;
  return left.snapshots.every((snapshot, index) => {
    const candidate = right.snapshots[index];
    return candidate !== void 0 && candidate.path === snapshot.path && candidate.exists === snapshot.exists && candidate.content === snapshot.content;
  });
}
function deleteInFlight(manifestDir, inFlight) {
  if (cargoWorkspaceRootInFlight.get(manifestDir)?.operation === inFlight) {
    cargoWorkspaceRootInFlight.delete(manifestDir);
  }
}
function createInFlightCargoWorkspaceRoot(request) {
  let inFlight;
  inFlight = createSharedAbortableOperation((signal) => loadCargoWorkspaceRoot({ ...request, signal }), () => {
    deleteInFlight(request.manifestDir, inFlight);
  }, () => {
    deleteInFlight(request.manifestDir, inFlight);
  });
  return inFlight;
}
async function loadCargoWorkspaceRoot(request) {
  try {
    request.signal?.throwIfAborted();
    const manifestPath = join13(request.manifestDir, "Cargo.toml");
    const output = await request.loader(manifestPath, request.signal);
    request.signal?.throwIfAborted();
    if (!snapshotsAreFresh(request.generation.snapshots)) {
      cacheCargoWorkspaceLoadFailure(request);
      return void 0;
    }
    const metadata = parseTrustedCargoMetadata(manifestPath, output);
    if (metadata === void 0 || !snapshotsAreFresh(request.generation.snapshots)) {
      cacheCargoWorkspaceLoadFailure(request);
      return void 0;
    }
    const prepared = prepareCargoWorkspaceCache(request.manifestDir, metadata);
    if (prepared === void 0 || !snapshotsAreFresh(request.generation.snapshots) || !preparedCacheIsFresh(prepared)) {
      cacheCargoWorkspaceLoadFailure(request);
      return void 0;
    }
    commitCargoWorkspaceCache(prepared);
    cargoWorkspaceRootFailures.delete(request.manifestDir);
    return prepared.root;
  } catch (error) {
    if (request.signal?.aborted || isAbortError(error))
      throw error;
    cacheCargoWorkspaceLoadFailure(request);
    return void 0;
  }
}
function cachedCargoWorkspaceRoot(manifestDir) {
  const cached = cargoWorkspaceRootCache.get(manifestDir);
  if (cached === void 0)
    return void 0;
  if (snapshotsAreFresh(cached.snapshots))
    return cached.root;
  cargoWorkspaceRootCache.delete(manifestDir);
  return void 0;
}
async function cargoWorkspaceRoot(request) {
  request.signal?.throwIfAborted();
  const cached = cachedCargoWorkspaceRoot(request.manifestDir);
  if (cached !== void 0)
    return cached;
  const nowMs = request.now();
  if (cachedCargoWorkspaceFailure(request.manifestDir, nowMs))
    return void 0;
  const snapshots = readAncestorManifestSnapshots(request.manifestDir);
  if (snapshots === void 0)
    return void 0;
  const generation = { snapshots };
  const inFlight = cargoWorkspaceRootInFlight.get(request.manifestDir);
  if (inFlight !== void 0 && sameCargoWorkspaceGeneration(inFlight.generation, generation)) {
    return awaitSharedAbortableOperation(inFlight.operation, request.signal);
  }
  const newInFlight = createInFlightCargoWorkspaceRoot({ ...request, generation });
  cargoWorkspaceRootInFlight.set(request.manifestDir, { generation, operation: newInFlight });
  return awaitSharedAbortableOperation(newInFlight, request.signal);
}
async function resolveCargoWorkspaceRoot(startDir, options = {}) {
  const manifestDir = nearestCargoManifestDir(realpathSafe(startDir));
  if (manifestDir === void 0)
    return void 0;
  const canonicalManifestDir = realpathSafe(manifestDir);
  const root = await cargoWorkspaceRoot({
    manifestDir: canonicalManifestDir,
    loader: options.cargoMetadataLoader ?? defaultCargoMetadataLoader,
    now: options.now ?? Date.now,
    signal: options.signal
  });
  return root ?? canonicalManifestDir;
}

// packages/lsp-tools-mcp/dist/lsp/workspace-root.js
var WORKSPACE_MARKERS = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle"];
function isDirectoryPath(filePath) {
  try {
    return statSync3(filePath).isDirectory();
  } catch {
    return false;
  }
}
async function findWorkspaceRoot(filePath, server2, options = {}) {
  const abs = resolve6(filePath);
  let dir = abs;
  if (!isDirectoryPath(dir)) {
    dir = dirname7(dir);
  }
  if (server2?.id === "rust") {
    const cargoRoot = await resolveCargoWorkspaceRoot(dir, options);
    if (cargoRoot !== void 0)
      return cargoRoot;
  }
  let prevDir = "";
  while (dir !== prevDir) {
    for (const marker of WORKSPACE_MARKERS) {
      if (existsSync3(join14(dir, marker))) {
        return dir;
      }
    }
    prevDir = dir;
    dir = dirname7(dir);
  }
  return dirname7(abs);
}

// src/language.ts
function diagnosticUriKey(uri) {
  try {
    const path = fileURLToPath2(uri);
    return pathToFileURL3(
      process.platform === "win32" ? path.replace(/^[A-Z]:/, (drive) => drive.toLowerCase()) : path
    ).href;
  } catch {
    return uri;
  }
}
var Client = class extends LspClient {
  constructor() {
    super(...arguments);
    this.stopping = false;
    this.published = /* @__PURE__ */ new Map();
    this.capabilities = {};
    this.progress = /* @__PURE__ */ new Set();
    this.progressAt = 0;
    this.pulls = /* @__PURE__ */ new Map();
    this.proven = /* @__PURE__ */ new Set();
    this.versions = /* @__PURE__ */ new Map();
  }
  serverIdentity() {
    return this.server.id;
  }
  stop() {
    if (this.stopTask) return this.stopTask;
    this.stopping = true;
    const proc = this.proc;
    const timer = setTimeout(() => {
      proc?.kill("SIGKILL");
      this.connection?.dispose();
    }, 500);
    this.stopTask = super.stop().finally(() => clearTimeout(timer));
    return this.stopTask;
  }
  supports(operation) {
    if (operation === "prepare_rename") {
      const provider = this.capabilities["renameProvider"];
      return record(provider) && provider["prepareProvider"] === true;
    }
    const names = {
      definition: "definitionProvider",
      references: "referencesProvider",
      symbols: "documentSymbolProvider",
      prepare_rename: "renameProvider",
      rename: "renameProvider",
      format: "documentFormattingProvider"
    };
    return Boolean(this.capabilities[names[operation] ?? operation]);
  }
  async sendNotification(method, params) {
    await super.sendNotification(method, method === "initialized" ? params ?? {} : params);
  }
  async sendRequest(method, params) {
    if (method === "initialize" && record(params) && record(params["capabilities"])) {
      const capabilities = params["capabilities"];
      capabilities["window"] = { workDoneProgress: true };
      if (record(capabilities["textDocument"])) {
        capabilities["textDocument"]["publishDiagnostics"] = { versionSupport: true };
        capabilities["textDocument"]["diagnostic"] = { dynamicRegistration: false };
      }
    }
    let result;
    if (method === "initialize" && this.connection) {
      let timer;
      try {
        result = await Promise.race([
          this.connection.sendRequest(method, params),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(
                new Error(`LSP initialization/download timeout: ${this.stderrBuffer.slice(-5).join("\n")}`)
              ),
              35e3
            );
          })
        ]);
      } finally {
        clearTimeout(timer);
      }
    } else result = await super.sendRequest(method, params);
    if (method === "initialize" && record(result) && record(result["capabilities"]))
      this.capabilities = result["capabilities"];
    return result;
  }
  async navigation(method, path, line, character) {
    const capability = {
      hover: "hoverProvider",
      typeDefinition: "typeDefinitionProvider",
      implementation: "implementationProvider",
      signatureHelp: "signatureHelpProvider"
    };
    if (!this.capabilities[capability[method] ?? ""]) return { status: "unsupported", operation: method };
    await this.openFile(path);
    return this.sendRequest(`textDocument/${method}`, {
      textDocument: { uri: pathToFileURL3(path).href },
      position: { line: line - 1, character }
    });
  }
  async start() {
    try {
      const inherited = process.env;
      let starting;
      try {
        process.env = { ...executionEnvironment() };
        starting = super.start();
      } finally {
        process.env = inherited;
      }
      await starting;
    } catch (error) {
      await logEvent("startup-failure");
      throw error;
    }
    void this.proc?.exited.then(() => {
      if (!this.stopping) return logEvent("abnormal-exit");
      return void 0;
    });
    this.connection?.onNotification("$/progress", (value) => {
      if (!record(value) || !record(value["value"])) return;
      const token = String(value["token"]);
      if (value["value"]["kind"] === "end") this.progress.delete(token);
      else this.progress.add(token);
      this.progressAt = Date.now();
    });
    this.connection?.onNotification("textDocument/publishDiagnostics", (value) => {
      if (!record(value) || typeof value["uri"] !== "string" || !Array.isArray(value["diagnostics"])) return;
      const items2 = value["diagnostics"];
      const version = value["version"];
      this.published.set(
        diagnosticUriKey(value["uri"]),
        typeof version === "number" ? { version, items: items2, time: Date.now() } : { items: items2, time: Date.now() }
      );
    });
  }
  async openFile(path) {
    const uri = pathToFileURL3(path).href;
    const content = await readFile10(path, "utf8");
    const previous = this.versions.get(uri);
    if (previous?.content === content) return;
    this.published.delete(diagnosticUriKey(uri));
    const version = (previous?.version ?? 0) + 1;
    this.versions.set(uri, { content, version });
    if (previous) {
      await this.sendNotification("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text: content }]
      });
    } else {
      await this.sendNotification("textDocument/didOpen", {
        textDocument: { uri, version, languageId: getLanguageId(extname5(path)), text: content }
      });
    }
  }
  async refresh(changes) {
    for (const uri of this.versions.keys())
      await this.sendNotification("textDocument/didClose", { textDocument: { uri } });
    this.versions.clear();
    this.published.clear();
    this.pulls.clear();
    await this.sendNotification("workspace/didChangeWatchedFiles", {
      changes: changes.map(({ path, type }) => ({ uri: pathToFileURL3(path).href, type }))
    });
  }
  async collect(path, signal) {
    const uri = pathToFileURL3(path).href;
    const cold = !this.versions.has(uri);
    await this.openFile(path);
    await this.sendNotification("textDocument/didSave", { textDocument: { uri } });
    const settling = Date.now() + (cold ? 5e3 : 2e3);
    while ((this.progress.size || Date.now() - this.progressAt < 200) && Date.now() < settling) {
      signal.throwIfAborted();
      await new Promise((resolve8) => setTimeout(resolve8, 25));
    }
    if (this.progress.size) return { items: [], ready: false };
    if (this.capabilities["diagnosticProvider"]) {
      const previous = this.pulls.get(uri);
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, settling - Date.now()))]);
      const result = await new Promise(
        (resolve8, reject) => {
          const abort = () => {
            void this.stop();
            reject(new Error(signal.aborted ? "Diagnostics cancelled" : "Diagnostic request timeout"));
          };
          requestSignal.addEventListener("abort", abort, { once: true });
          if (requestSignal.aborted) {
            abort();
            return;
          }
          void this.sendRequest(
            "textDocument/diagnostic",
            { textDocument: { uri }, ...previous ? { previousResultId: previous.resultId } : {} }
          ).then(resolve8, reject).finally(() => requestSignal.removeEventListener("abort", abort));
        }
      );
      if (result.kind === "unchanged" && previous)
        return { items: previous.items, ready: true, evidence: "pull-unchanged" };
      if (Array.isArray(result.items)) {
        if (result.resultId) this.pulls.set(uri, { resultId: result.resultId, items: result.items });
        return { items: result.items, ready: true, evidence: "pull-full" };
      }
      return { items: [], ready: false };
    }
    const deadline = settling;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const result = this.published.get(diagnosticUriKey(uri));
      if (result && Date.now() - result.time >= 200 && !this.progress.size && Date.now() - this.progressAt >= 200 && (result.version === void 0 || result.version === this.versions.get(uri)?.version)) {
        if (!(result.version === void 0 && result.items.length === 0 && !this.proven.has(uri))) {
          this.proven.add(uri);
          return {
            items: result.items,
            ready: true,
            evidence: result.version === void 0 ? "push-unversioned (weak freshness evidence)" : "push-versioned"
          };
        }
      }
      await new Promise((resolve8) => setTimeout(resolve8, 25));
    }
    return { items: [], ready: false };
  }
  async formatting(path, options) {
    if (!this.supports("format")) throw new Error("unsupported: document formatting");
    await this.openFile(path);
    return await this.sendRequest("textDocument/formatting", {
      textDocument: { uri: pathToFileURL3(path).href },
      options
    }) ?? [];
  }
};
var Languages = class {
  constructor(root, config) {
    this.root = root;
    this.config = config;
    this.clients = /* @__PURE__ */ new Set();
    this.processStarts = 0;
    this.snapshot = /* @__PURE__ */ new Map();
    this.failures = /* @__PURE__ */ new Map();
    this.manager = new LspManager({
      idleTimeoutMs: 12e4,
      clientFactory: (root2, server2) => {
        if (!inside(this.root, root2))
          throw new Error("LSP root outside workspace; choose the enclosing project as workspace");
        this.processStarts++;
        const client = new Client(root2, server2);
        this.clients.add(client);
        return client;
      }
    });
  }
  statistics() {
    return {
      processStarts: this.processStarts,
      running: [...this.clients].filter((client) => client.isAlive()).length
    };
  }
  async sync(files) {
    const changed = [.../* @__PURE__ */ new Set([...files.keys(), ...this.snapshot.keys()])].filter(
      (path) => files.get(path) !== this.snapshot.get(path)
    );
    const events = changed.map((path) => ({
      path: resolve7(this.root, path),
      type: !files.has(path) ? 3 : !this.snapshot.has(path) ? 1 : 2
    }));
    this.snapshot = new Map(files);
    for (const client of this.clients) {
      if (!client.isAlive()) {
        this.clients.delete(client);
        continue;
      }
      await client.refresh(events);
    }
  }
  async status(path) {
    const resolved = await resolveServer(this.root, path, this.config);
    const failure = this.failures.get(`${resolved.language}:${resolved.tool.identity}`);
    return {
      ...resolved,
      lint: this.config.trusted ? await select(this.root, resolve7(this.root, path), false, this.config).catch((error) => ({
        unavailable: message(error)
      })) ?? { unavailable: "No configured lint runner" } : { unavailable: "Workspace trust required" },
      running: [...this.clients].some(
        (client) => client.isAlive() && client.serverIdentity() === `${resolved.server.id}:${hash(JSON.stringify([resolved.server, resolved.tool.identity])).slice(0, 16)}`
      ),
      failure: failure && failure.identity === resolved.tool.identity && Date.now() - failure.at < 3e4 ? failure.reason : void 0,
      recovery: "Install or repair the selected local tool, then lsp_status refresh=true; failures retry after 30 seconds"
    };
  }
  async preflight(path, signal, operation) {
    await this.withLspClient(
      await workspacePath(this.root, path),
      async (client) => {
        if (operation && client instanceof Client && !client.supports(operation))
          throw new Error(`unsupported: ${operation}`);
      },
      "preflight",
      {
        manager: this.manager,
        signal
      }
    );
  }
  async withLspClient(path, fn, _tool, options) {
    const resolved = await resolveServer(this.root, path, this.config);
    if (resolved.tool.source === "missing") throw new Error(resolved.tool.note);
    if (resolved.tool.source === "temporary" && !this.config.trusted)
      throw new Error("Temporary tool execution requires workspace trust in Codex user config.toml");
    const failureKey = `${resolved.language}:${resolved.tool.identity}`;
    const failed = this.failures.get(failureKey);
    if (failed && failed.identity === resolved.tool.identity && Date.now() - failed.at < 3e4)
      throw new Error(failed.reason);
    let root = await findWorkspaceRoot(path, resolved.server, { signal: options.signal });
    if (!inside(this.root, root)) root = this.root;
    if (resolved.language === "python" && resolved.tool.source === "project" && resolved.tool.command[0]?.includes(".venv"))
      root = dirname8(dirname8(dirname8(resolved.tool.command[0])));
    resolved.server.id += `:${hash(JSON.stringify([resolved.server, resolved.tool.identity])).slice(0, 16)}`;
    let client;
    try {
      client = await measured(
        "startup/acquire",
        () => options.manager.getClient(root, resolved.server, options.signal)
      );
    } catch (error) {
      for (const [key, failure] of this.failures) if (Date.now() - failure.at >= 3e4) this.failures.delete(key);
      this.failures.set(failureKey, {
        identity: resolved.tool.identity,
        at: Date.now(),
        reason: (resolved.tool.source === "temporary" ? "Temporary launch/download or initialization failed: " : "Local initialization failed (no fallback): ") + message(error)
      });
      const reason = this.failures.get(failureKey)?.reason;
      while (this.failures.size > 64) this.failures.delete(this.failures.keys().next().value ?? "");
      throw new Error(reason);
    }
    this.failures.delete(failureKey);
    try {
      return await fn(client);
    } finally {
      options.manager.releaseClient(root, resolved.server.id);
    }
  }
  async check(path, signal) {
    try {
      return await this.withLspClient(
        await workspacePath(this.root, path),
        async (client) => {
          if (!(client instanceof Client)) throw new Error("Unexpected LSP client");
          const absolute = await workspacePath(this.root, path);
          const result = await measured("diagnostics/wait", () => client.collect(absolute, signal));
          return {
            path,
            state: result.ready ? "complete" : "pending",
            findings: result.items.filter((item) => item.severity === 1 || item.severity === 2).map((item) => ({
              path,
              line: item.range.start.line + 1,
              column: item.range.start.character + 1,
              severity: item.severity === 1 ? "error" : "warning",
              source: `${item.source ?? "lsp"}${item.code === void 0 ? "" : `/${item.code}`}`,
              message: item.message
            })),
            note: result.ready ? result.evidence ?? "fresh diagnostics" : "No fresh diagnostics published yet"
          };
        },
        "diagnostics",
        { manager: this.manager, signal }
      );
    } catch (error) {
      const note = message(error);
      if (/server cancelled|content modified/i.test(note) || record(error) && [-32801, -32802].includes(Number(error["code"])))
        return { path, state: "pending", findings: [], note: "Server is updating its analysis; retry" };
      if (!/No LSP server|NOT INSTALLED/.test(note))
        await logEvent(/timeout/i.test(note) ? "timeout" : "startup-failure");
      return {
        path,
        state: /disabled or unsupported|Tool missing|Explicit command missing/.test(note) ? "skipped" : "failed",
        findings: [],
        note
      };
    }
  }
  async navigate(args, signal) {
    const path = await workspacePath(this.root, text(args["path"]));
    const operation = text(args["operation"]);
    const line = number(args["line"], 1, 1, 1e7);
    const column = number(args["column"], 1, 1, 1e6) - 1;
    const before = operation === "rename" ? await inventory(this.root, 1e4, signal) : void 0;
    return this.withLspClient(
      path,
      async (client) => {
        if (client instanceof Client && ["definition", "references", "symbols", "prepare_rename"].includes(operation) && !client.supports(operation === "symbols" && args["query"] ? "workspaceSymbolProvider" : operation))
          return JSON.stringify({ status: "unsupported", operation });
        let result;
        switch (operation) {
          case "hover":
          case "typeDefinition":
          case "implementation":
          case "signatureHelp":
            if (!(client instanceof Client)) throw new Error("Unexpected client");
            result = await client.navigation(operation, path, line, column);
            break;
          case "definition":
            result = await client.definition(path, line, column);
            break;
          case "references":
            result = await client.references(path, line, column);
            break;
          case "symbols":
            result = args["query"] ? await client.workspaceSymbols(text(args["query"])) : await client.documentSymbols(path);
            break;
          case "prepare_rename":
            result = await client.prepareRename(path, line, column);
            break;
          case "rename": {
            if (!before?.complete) throw new Error("Cannot safely snapshot workspace for rename");
            const name = text(args["newName"]);
            if (!name) throw new Error("newName required");
            const edit = await client.rename(path, line, column, name);
            return this.applyRename(edit, before.version, signal);
          }
          default:
            throw new Error("Unknown navigation operation");
        }
        const output = JSON.stringify(result ?? []);
        if (output.length <= 8e3) return output;
        if (!Array.isArray(result)) return JSON.stringify({ status: "too_large", note: "Narrow query/path" });
        const items2 = [];
        for (const item of result) {
          if (JSON.stringify([...items2, item]).length > 7600) break;
          items2.push(item);
        }
        return JSON.stringify({ items: items2, omitted: result.length - items2.length, note: "Narrow query/path" });
      },
      operation,
      { manager: this.manager, signal }
    );
  }
  async applyRename(edit, version, signal) {
    if (!edit) return "No rename edits";
    const changes = /* @__PURE__ */ new Map();
    for (const [uri, edits] of Object.entries(edit.changes ?? {})) changes.set(uri, edits);
    for (const change of edit.documentChanges ?? []) {
      if ("kind" in change) throw new Error("Resource operations are not permitted by rename");
      if (changes.has(change.textDocument.uri)) throw new Error("Duplicate rename target");
      changes.set(change.textDocument.uri, change.edits);
    }
    const pending = [];
    for (const [uri, edits] of changes) {
      const path = await workspacePath(this.root, fileURLToPath2(uri));
      await this.preflight(path, signal);
      const before = await readFile10(path, "utf8");
      pending.push({ path, before, after: applyTextChanges(before, edits) });
    }
    if ((await inventory(this.root, 1e4, signal)).version !== version)
      throw new Error("Workspace changed during rename; retry");
    for (const item of pending)
      if (await readFile10(item.path, "utf8") !== item.before) throw new Error("Rename conflict");
    signal.throwIfAborted();
    const modified = [];
    try {
      for (const item of pending) {
        signal.throwIfAborted();
        await writeFile4(item.path, item.after);
        modified.push(relative3(this.root, item.path));
      }
    } catch (error) {
      throw new WriteFailure(`${message(error)}; modified paths: ${JSON.stringify(modified)}`, modified);
    }
    return JSON.stringify({
      text: `Renamed: ${modified.join(", ")}`.slice(0, 8e3),
      modifiedPaths: modified
    });
  }
  async format(path, signal) {
    const absolute = await workspacePath(this.root, path);
    const before = await readFile10(absolute, "utf8");
    const edits = await this.withLspClient(
      absolute,
      async (client) => {
        if (!(client instanceof Client)) throw new Error("Unexpected LSP client");
        return client.formatting(absolute, this.config.formatting);
      },
      "format",
      { manager: this.manager, signal }
    );
    const after = applyTextChanges(before, edits);
    if (await readFile10(absolute, "utf8") !== before) throw new Error("File changed during formatting; retry");
    if (after === before) return `Unchanged: ${path}`;
    signal.throwIfAborted();
    await writeFile4(absolute, after);
    return `Formatted: ${path}`;
  }
  async close() {
    await this.manager.stopAll();
  }
};

// src/engine.ts
var Engine = class {
  constructor(root, checker) {
    this.root = root;
    this.identities = /* @__PURE__ */ new Map();
    this.cache = /* @__PURE__ */ new Map();
    this.sessions = /* @__PURE__ */ new Map();
    this.configVersion = "";
    this.queue = Promise.resolve();
    this.source = "both";
    this.lastResults = [];
    this.generation = 0;
    this.pages = /* @__PURE__ */ new Map();
    this.checker = checker ?? (async (path, signal, lspOnly) => {
      this.language ??= new Languages(root, this.requestConfig ?? await configuration(root));
      const lsp = this.source === "lint" ? { path, state: "skipped", findings: [] } : await this.language.check(path, signal);
      if (lspOnly) return lsp;
      const runner = await lint(root, path, signal, this.requestConfig, !automaticExecution());
      this.lastChannels = {
        lsp,
        lint: runner ?? { path, state: "skipped", findings: [], note: "lint requires workspace trust" }
      };
      if (this.source === "lint")
        return runner ?? { path, state: "skipped", findings: [], note: "lint requires workspace trust" };
      if (!runner)
        return {
          ...lsp,
          channels: { lsp: lsp.state, lint: "skipped" },
          note: [lsp.note, "lint requires workspace trust"].filter(Boolean).join("; ")
        };
      return {
        path,
        state: lsp.state === "complete" ? runner.state === "skipped" ? "complete" : runner.state : lsp.state,
        channels: { lsp: lsp.state, lint: runner.state },
        findings: mergeFindings([...lsp.findings, ...runner.findings]),
        ...lsp.note || runner.note ? { note: [lsp.note, runner.note].filter(Boolean).join("; ") } : {}
      };
    });
  }
  channelResults() {
    return this.lastChannels;
  }
  session(id, turn) {
    let session = this.sessions.get(id);
    if (!session) {
      session = {
        turn: turn ?? "",
        touched: /* @__PURE__ */ new Set(),
        current: /* @__PURE__ */ new Set()
      };
      this.sessions.set(id, session);
    }
    if (turn && session.turn !== turn) {
      session.turn = turn;
      session.current.clear();
    }
    return session;
  }
  id(value) {
    if (typeof value === "string" && value) return value;
    if (this.sessions.size === 1) return this.sessions.keys().next().value ?? "manual";
    if (this.sessions.size > 1)
      throw new Error(
        "Multiple sessions: provide session from Hook feedback, or a new unique session for manual checks"
      );
    return "manual";
  }
  async synchronize(snapshot) {
    if (!snapshot.complete) await this.close();
    const previous = this.previousSnapshot;
    if (previous?.version !== snapshot.version && this.language) {
      const configChanged = [.../* @__PURE__ */ new Set([...snapshot.files.keys(), ...previous?.files.keys() ?? []])].some(
        (path) => /(?:config|lock|manifest|Cargo\.toml|package\.json|go\.mod|pyproject|ty\.toml|ruff\.toml|\.clangd|compile_commands\.json|compile_flags\.txt|\.clang-format|rust-toolchain|rustfmt)/i.test(
          path
        ) && previous?.files.get(path) !== snapshot.files.get(path)
      );
      if (configChanged) {
        await this.language.close();
        this.language = void 0;
      } else await this.language.sync(snapshot.files);
    }
    for (const key of this.cache.keys()) {
      const path = key.replace(/^(?:lsp|lint):/, "");
      if (previous?.files.has(path) && !snapshot.files.has(path)) this.cache.delete(key);
    }
    this.previousSnapshot = snapshot;
  }
  async check(paths, id, turn, lspOnly = false, signal = new AbortController().signal, offset = 0, baseline) {
    const config = this.requestConfig ?? await configuration(this.root);
    const snapshot = baseline ?? await inventory(this.root, 1e4, signal, config.exclude, this.root, true);
    if (!baseline) snapshot.version = hash(snapshot.version + config.version);
    await this.synchronize(snapshot);
    const session = this.session(id, turn);
    const results = [];
    const deadline = Date.now() + 45e3;
    for (const requested of [...new Set(paths)]) {
      signal.throwIfAborted();
      let path = requested;
      try {
        path = relative4(this.root, await workspacePath(this.root, requested));
      } catch (error) {
        results.push({ path, state: "skipped", findings: [], note: message(error) });
        this.cache.delete(path);
        session.touched.delete(path);
        continue;
      }
      session.touched.add(path);
      session.current.add(path);
      if (Date.now() >= deadline || results.length >= 200) {
        this.cache.delete(path);
        this.cache.delete(`lsp:${path}`);
        results.push({ path, state: "pending", findings: [], note: "Scan time budget reached" });
        continue;
      }
      const key = `${lspOnly ? "lsp:" : this.source === "lint" ? "lint:" : ""}${path}`;
      const cached = this.cache.get(key);
      const identity = await analysisIdentity(this.root, [path], config, signal);
      if (this.identities.has(path) && this.identities.get(path) !== identity) {
        await this.close();
        this.cache.clear();
      }
      this.identities.set(path, identity);
      const absolute = await workspacePath(this.root, path);
      if ((await stat5(absolute)).size > 1024 * 1024) {
        results.push({ path, state: "skipped", findings: [], note: "File exceeds 1 MiB" });
        continue;
      }
      const content = hash(await readFile11(absolute, { encoding: "utf8", signal }));
      if (snapshot.complete && cached?.version === snapshot.version && cached.identity === identity && cached.content === content && cached.result.state === "complete") {
        results.push(cached.result);
        continue;
      }
      this.lastChannels = void 0;
      const result = await this.checker(path, signal, lspOnly);
      signal.throwIfAborted();
      if (hash(await readFile11(await workspacePath(this.root, path), { encoding: "utf8", signal })) !== content || await analysisIdentity(this.root, [path], await configuration(this.root), signal) !== identity) {
        result.state = "stale";
        result.note = "File changed during diagnostics; retry";
      }
      if (lspOnly) result.channels ??= { lsp: result.state, lint: "skipped" };
      if (JSON.stringify(this.cache.get(key)?.result) !== JSON.stringify(result)) this.generation++;
      this.cache.set(key, { version: snapshot.version, identity, content, result });
      const channels = this.channelResults();
      if (channels)
        for (const channel of ["lsp", "lint"]) {
          if (channel === "lsp" && this.source === "lint" || channel === "lint" && lspOnly) continue;
          const channelResult = { ...channels[channel] };
          if (result.state === "stale") {
            channelResult.state = "stale";
            channelResult.note = result.note ?? "Stale diagnostics";
          }
          this.cache.set(`${channel}:${path}`, {
            version: snapshot.version,
            identity,
            content,
            result: channelResult
          });
        }
      results.push(result);
    }
    const after = await inventory(this.root, 1e4, signal, config.exclude, this.root, true);
    after.version = hash(after.version + (await configuration(this.root)).version);
    if (after.version !== snapshot.version) {
      for (const entry of this.cache.values())
        if (entry.version === snapshot.version) {
          entry.result.state = "stale";
          entry.result.note = "Workspace changed or snapshot incomplete; retry";
        }
      for (const result of results) {
        result.state = "stale";
        result.note = "Workspace changed or snapshot incomplete; retry";
      }
    }
    if (paths.length > 200)
      results.push({
        path: ".",
        state: "pending",
        findings: [],
        note: "File/snapshot budget exceeded; narrow paths"
      });
    this.lastResults = results;
    return render(results, 50, 8192, offset) + (!snapshot.complete ? "\nDependency inventory incomplete; workspace dependency freshness unverified" : "");
  }
  dispatch(operation, args, signal) {
    const writes = operation === "lsp_format" || operation === "lsp_rename";
    let started = false;
    const task = this.queue.then(() => {
      started = true;
      signal.throwIfAborted();
      return withToolResolution(() => this.execute(operation, args, signal));
    });
    this.queue = task.catch(() => void 0);
    return new Promise((resolve8, reject) => {
      const abort = () => {
        if (!started || !writes) reject(new Error("Request cancelled while queued or executing"));
        if (started) void this.close().catch(() => logEvent("cancel-cleanup-failure"));
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void task.then(resolve8, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
  async paths(args, signal) {
    const config = await configuration(this.root);
    const values = Array.isArray(args["paths"]) ? args["paths"] : [text(args["path"], ".")];
    if (values.length > 200 || !values.every((value) => typeof value === "string"))
      throw new Error("paths must contain at most 200 strings");
    const paths = /* @__PURE__ */ new Set();
    let complete = true;
    for (const value of values) {
      if (typeof value !== "string") continue;
      signal.throwIfAborted();
      const absolute = await workspacePath(this.root, value);
      if ((await stat5(absolute)).isFile()) paths.add(relative4(this.root, absolute));
      else {
        const scoped = await inventory(this.root, 1e4, signal, config.exclude, absolute);
        complete &&= scoped.complete;
        for (const path of scoped.files.keys()) {
          paths.add(path);
          if (paths.size > 1e4) {
            complete = false;
            break;
          }
        }
      }
      if (paths.size > 1e4) break;
    }
    return { paths: [...paths].sort().slice(0, 1e4), complete };
  }
  async execute(operation, args, signal) {
    if (operation === "release") {
      await this.close();
      this.cache.clear();
      return "";
    }
    const config = await configuration(this.root);
    if (this.configVersion !== config.version || args["refresh"] === true) {
      await this.close();
      this.cache.clear();
      this.pages.clear();
      this.configVersion = config.version;
    }
    const store = new Metadata(this.root);
    const ids = await store.ids();
    for (const id2 of this.sessions.keys())
      if (!ids.includes(id2) && (await store.read(id2)).turn === "__ended__") this.sessions.delete(id2);
    for (const id2 of ids) {
      const state = await store.read(id2);
      if (state.turn === "__ended__") {
        this.sessions.delete(id2);
        continue;
      }
      const session = this.session(id2, state.turn);
      session.touched = new Set(state.touched);
      session.current = new Set(state.current);
    }
    this.requestConfig = config;
    if (operation === "lsp_status") {
      this.language ??= new Languages(this.root, config);
      const targets = args["path"] ? [text(args["path"])] : Object.values(config.servers).filter((server2) => !!server2).map((server2) => server2 ? `status${server2.extensions[0]}` : "");
      return JSON.stringify({
        workspace: this.root,
        trusted: config.trusted,
        configuration: config,
        tools: await Promise.all(
          targets.map((path) => this.language?.status(path).catch((error) => ({ path, reason: message(error) })))
        ),
        timings: timings(),
        cache: this.cache.size,
        clients: this.language.statistics(),
        sessions: [...this.sessions.keys()]
      });
    }
    if (operation === "automatic_batch") {
      if (!config.trusted)
        throw new Error("Automatic LSP/lint requires workspace trust; lint requires workspace trust");
      this.source = "both";
      const paths2 = Array.isArray(args["paths"]) ? args["paths"].filter((path) => typeof path === "string") : [];
      await this.check(paths2.slice(0, 50), text(args["session"]), text(args["turn"]), false, signal);
      return JSON.stringify(this.lastResults);
    }
    const id = args["scope"] === "paths" || args["scope"] === void 0 ? text(args["session"], "manual") : this.id(args["session"]);
    if (operation === "check_diagnostics") return this.diagnostics(args, id, signal, config, store);
    if (operation === "lsp_rename") args = { ...args, operation: "rename" };
    if (operation === "lsp_navigation" || operation === "lsp_rename") {
      const path = relative4(this.root, await workspacePath(this.root, text(args["path"])));
      const identity = await analysisIdentity(this.root, [path], config, signal);
      if (this.identities.has(path) && this.identities.get(path) !== identity) {
        await this.close();
        this.cache.clear();
      }
      this.identities.set(path, identity);
      const snapshot = await inventory(this.root, 1e4, signal, config.exclude, this.root, true);
      snapshot.version = hash(snapshot.version + config.version);
      await this.synchronize(snapshot);
      this.language ??= new Languages(this.root, config);
      const before = args["operation"] === "rename" ? await inventory(this.root, 1e4, signal) : void 0;
      let output;
      try {
        output = await this.language.navigate(args, signal);
      } finally {
        if (before) this.cache.clear();
      }
      if (before) {
        let modifiedPaths = [];
        try {
          const result = JSON.parse(output);
          if (record(result) && Array.isArray(result["modifiedPaths"]))
            modifiedPaths = result["modifiedPaths"].filter((path2) => typeof path2 === "string");
        } catch {
        }
        this.cache.clear();
        const after = await inventory(this.root, 1e4, signal).catch((error) => {
          throw new WriteFailure(`${message(error)}; ${output}`, modifiedPaths);
        });
        const changed = [...after.files].filter(([path2, version]) => before.files.get(path2) !== version).map(([path2]) => path2);
        try {
          await this.check(
            [.../* @__PURE__ */ new Set([text(args["path"]), ...changed])],
            id,
            this.session(id).turn,
            false,
            signal
          );
        } catch (error) {
          throw new WriteFailure(`${message(error)}; ${output}`, modifiedPaths);
        }
      }
      return output;
    }
    const scope2 = await this.paths(args, signal);
    const paths = scope2.paths;
    if (operation === "lsp_format") {
      if (!args["paths"] && !args["path"]) throw new Error("Explicit formatting paths required");
      if (paths.length > 200) throw new Error("Format at most 200 explicitly scoped files");
      this.language ??= new Languages(this.root, config);
      for (const path of paths) {
        const runner = await preflightRunner(this.root, path, config, signal);
        await this.language.preflight(path, signal, runner ? void 0 : "format");
      }
      const lines = [];
      const modifiedPaths = [];
      try {
        for (const path of paths) {
          signal.throwIfAborted();
          lines.push(
            await formatWithRunner(this.root, path, signal, config) ?? await this.language.format(path, signal)
          );
          if (lines.at(-1)?.startsWith("Formatted:")) modifiedPaths.push(path);
        }
        await this.check(paths, id, "manual", false, signal);
      } catch (error) {
        throw new WriteFailure(`${message(error)}; completed writes: ${JSON.stringify(lines)}`, modifiedPaths);
      } finally {
        this.cache.clear();
      }
      return JSON.stringify({ text: lines.join("\n").slice(0, 8e3) || "No files", modifiedPaths, results: lines });
    }
    throw new Error("Unknown tool");
  }
  async diagnostics(args, id, signal, config, store) {
    for (const key of ["mode", "start", "offset", "revision"])
      if (args[key] !== void 0)
        throw new Error("Migration required: use scope/source/run/cursor; see docs/migration-0.5.md");
    const scope2 = text(args["scope"], "paths");
    const source = text(args["source"], "both");
    const run2 = text(args["run"], "active");
    if (!["paths", "turn", "session"].includes(scope2) || !["both", "lsp", "lint"].includes(source) || !["active", "cached"].includes(run2))
      throw new Error("Invalid scope/source/run");
    this.source = source;
    const snapshot = await inventory(this.root, 1e4, signal, config.exclude, this.root, true);
    snapshot.version = hash(snapshot.version + config.version);
    const token = text(args["cursor"]);
    let results;
    let index = 0;
    let identity;
    if (token) {
      const page = this.pages.get(token);
      if (!page || page.generation !== this.generation || page.version !== snapshot.version || hash(
        JSON.stringify(
          Object.entries(args).filter(([key]) => key !== "cursor" && key !== "workspace" && key !== "refresh").sort()
        )
      ) !== hash(
        JSON.stringify(
          Object.entries(page.args).filter(([key]) => key !== "cursor" && key !== "workspace" && key !== "refresh").sort()
        )
      ))
        throw new Error("Cursor invalid or stale; restart without cursor");
      identity = await this.pageIdentity(
        page.results.map((result) => result.path),
        config,
        snapshot,
        signal
      );
      if (identity !== page.identity) throw new Error("Cursor invalid: tool/configuration changed");
      results = [...page.results];
      index = page.index;
      if (run2 === "active") {
        const pending = results.slice(index, index + 50);
        if (pending.some((result) => result.note === "Continue cursor for active analysis")) {
          await this.check(
            pending.map((result) => result.path),
            id,
            this.session(id).turn,
            source === "lsp",
            signal,
            0,
            snapshot
          );
          results.splice(index, pending.length, ...this.lastResults);
        }
      }
    } else {
      let paths;
      if (scope2 === "paths") {
        const values = Array.isArray(args["paths"]) ? args["paths"] : [text(args["path"], ".")];
        const selected2 = /* @__PURE__ */ new Set();
        for (const value of values) {
          if (typeof value !== "string") throw new Error("paths requires strings");
          const absolute = await workspacePath(this.root, value);
          const path = relative4(this.root, absolute);
          if ((await stat5(absolute)).isFile()) {
            if (!languageFor(config, path)) throw new Error(`Language disabled or unsupported: ${path}`);
            selected2.add(path);
          } else
            for (const candidate of (snapshot.complete ? snapshot : await inventory(this.root, 1e4, signal, config.exclude, absolute)).files.keys())
              if ((!path || candidate.startsWith(`${path}/`)) && codeLanguage(config, candidate))
                selected2.add(candidate);
        }
        paths = [...selected2].sort();
      } else
        paths = [...scope2 === "turn" ? this.session(id).current : this.session(id).touched].filter((path) => snapshot.files.has(path)).sort();
      identity = await this.pageIdentity(paths, config, snapshot, signal);
      if (run2 === "cached") {
        results = [];
        for (const path of paths) {
          const entry = this.cache.get((source === "lsp" ? "lsp:" : source === "lint" ? "lint:" : "") + path);
          results.push(
            !entry ? { path, state: "pending", findings: [] } : entry.version === snapshot.version && entry.content === await this.contentIdentity(path, snapshot, signal) && snapshot.complete && entry.identity === await analysisIdentity(this.root, [path], config, signal) ? entry.result : { ...entry.result, state: "stale", note: "Run active diagnostics" }
          );
        }
      } else {
        await store.update(id, signal, (state) => {
          state.touched.push(...paths);
          state.current.push(...paths);
        });
        await this.check(paths.slice(0, 50), id, this.session(id).turn, source === "lsp", signal, 0, snapshot);
        results = [
          ...this.lastResults,
          ...paths.slice(50).map((path) => ({
            path,
            state: "pending",
            findings: [],
            note: "Continue cursor for active analysis"
          }))
        ];
      }
    }
    const selected = [];
    let size = 0;
    for (const result of results.slice(index)) {
      const bytes = JSON.stringify(result).length;
      if (selected.length && (size + bytes > 24e3 || selected.length >= 50)) break;
      selected.push(result);
      size += bytes;
    }
    let next;
    if (index + selected.length < results.length) {
      const cursor = randomUUID4();
      this.pages.set(cursor, {
        version: snapshot.version,
        results,
        index: index + selected.length,
        args,
        identity,
        generation: this.generation
      });
      while (this.pages.size > 32) this.pages.delete(this.pages.keys().next().value ?? "");
      next = { ...args, refresh: void 0, workspace: this.root, cursor };
    }
    const partial = !snapshot.complete || results.some((result) => result.state !== "complete");
    return JSON.stringify({
      text: ((partial ? render(selected).replace(/^complete;/, "partial;") : render(selected)) + (next ? "\nMore results: follow the structured next arguments." : "") + (!snapshot.complete ? "\nDependency inventory incomplete; workspace dependency freshness unverified" : "")).replace(/\n.*omitted; next offset=.*$/, ""),
      scope: scope2,
      source,
      run: run2,
      partial,
      errors: results.flatMap((result) => result.findings).filter((item) => item.severity === "error").length,
      warnings: results.flatMap((result) => result.findings).filter((item) => item.severity === "warning").length,
      results: selected,
      unavailable: Object.fromEntries(
        [
          ...new Set(
            results.filter((result) => result.state === "failed" || result.state === "skipped").map((result) => codeLanguage(config, result.path) ?? "unsupported")
          )
        ].map((language) => [
          language,
          [
            ...new Set(
              results.filter(
                (result) => (codeLanguage(config, result.path) ?? "unsupported") === language && result.note && (result.state === "failed" || result.state === "skipped")
              ).map((result) => result.note)
            )
          ]
        ])
      ),
      ...next ? { next } : {},
      isError: run2 === "active" && results.length > 0 && results.every(
        (result) => (result.state === "failed" || result.state === "skipped") && result.channels?.lsp !== "complete" && result.channels?.lint !== "complete"
      )
    });
  }
  async contentIdentity(path, snapshot, signal) {
    const existing = snapshot.files.get(path);
    if (existing) return existing;
    try {
      const absolute = await workspacePath(this.root, path);
      const info = await stat5(absolute);
      if (info.size > 1024 * 1024) return "oversized";
      return hash(await readFile11(absolute, { encoding: "utf8", signal }));
    } catch {
      signal.throwIfAborted();
      return "unavailable";
    }
  }
  async pageIdentity(paths, config, snapshot, signal) {
    const contents = [];
    for (const path of paths) contents.push([path, await this.contentIdentity(path, snapshot, signal)]);
    return hash(JSON.stringify([await analysisIdentity(this.root, paths, config, signal), contents]));
  }
  async dispose() {
    await this.close();
    await this.queue;
    await this.close();
  }
  async close() {
    const language = this.language;
    this.language = void 0;
    await language?.close();
  }
};

// src/ipc.ts
import { spawn as spawn4 } from "node:child_process";
import { randomUUID as randomUUID5 } from "node:crypto";
import { readFileSync as readFileSync4 } from "node:fs";
import { chmod, lstat as lstat4, mkdir as mkdir4, readFile as readFile12, rename as rename4, rm as rm3, writeFile as writeFile5 } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir as homedir6, tmpdir as tmpdir3 } from "node:os";
import { join as join15 } from "node:path";
import { setTimeout as delay2 } from "node:timers/promises";
import { fileURLToPath as fileURLToPath3 } from "node:url";
async function serviceLocation(root) {
  const user = process.getuid?.() ?? hash(homedir6()).slice(0, 10);
  const directory2 = join15(tmpdir3(), `clsp6-${user}`);
  await mkdir4(directory2, { recursive: true, mode: 448 });
  const info = await lstat4(directory2);
  if (info.isSymbolicLink() || process.platform !== "win32" && (info.uid !== process.getuid?.() || info.mode & 63))
    throw new Error("Unsafe service directory permissions");
  const identity = await workspaceIdentity(root);
  const address = process.platform === "win32" ? `\\\\.\\pipe\\codex-lsp-${user}-${identity}` : join15(directory2, `${identity.slice(0, 32)}.sock`);
  return { directory: directory2, identity, address, endpoint: join15(directory2, `${identity}.endpoint`) };
}
async function readEndpoint(location) {
  try {
    const info = await lstat4(location.endpoint);
    if (info.isSymbolicLink() || process.platform !== "win32" && (info.uid !== process.getuid?.() || info.mode & 63))
      throw new Error("Unsafe service endpoint permissions");
    const value = JSON.parse(await readFile12(location.endpoint, "utf8"));
    if (!record(value) || value["identity"] !== location.identity || value["protocol"] !== SERVICE_PROTOCOL || typeof value["pid"] !== "number" || typeof value["token"] !== "string" || value["address"] !== location.address)
      throw new Error("Invalid service endpoint");
    return value;
  } catch (error) {
    if (record(error) && error["code"] === "ENOENT") return void 0;
    throw error;
  }
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const state = readFileSync4(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)?.split(" ")[0];
      if (state === "Z" || state === "X") return false;
    }
    return true;
  } catch (error) {
    return !(record(error) && ["ESRCH", "ENOENT"].includes(String(error["code"])));
  }
}
async function exchange(endpoint, operation, args, signal) {
  signal.throwIfAborted();
  return new Promise((resolve8, reject) => {
    const socket = createConnection(endpoint.address);
    let received = "";
    let settled = false;
    const writes = operation === "lsp_rename" || operation === "lsp_format";
    const finish = (error, output = "") => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", cancel);
      socket.destroy();
      if (error) reject(error);
      else resolve8(output);
    };
    const cancel = () => {
      if (writes) socket.write(`${JSON.stringify({ cancel: true })}
`);
      else finish(new Error("Request cancelled while waiting for service; automatic work remains pending"));
    };
    signal.addEventListener("abort", cancel, { once: true });
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({
          token: endpoint.token,
          identity: endpoint.identity,
          protocol: SERVICE_PROTOCOL,
          operation,
          args,
          environment: executionEnvironment()
        })}
`
      );
      if (signal.aborted) cancel();
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      received += chunk;
      if (received.length > 8 * 1024 * 1024) {
        finish(new Error("Service response exceeds limit"));
        return;
      }
      const end = received.indexOf("\n");
      if (end < 0) return;
      try {
        const response = JSON.parse(received.slice(0, end));
        if (!record(response)) throw new Error("Invalid service response");
        if (typeof response["error"] === "string") {
          const paths = response["modifiedPaths"];
          finish(
            Array.isArray(paths) ? new WriteFailure(
              response["error"],
              paths.filter((path) => typeof path === "string")
            ) : new Error(response["error"])
          );
        } else finish(void 0, text(response["output"]));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once(
      "close",
      () => finish(
        new Error(
          writes ? "Service connection lost; write outcome unknown; do not replay" : "Service connection lost; retry read request"
        )
      )
    );
  });
}
async function existingService(root, signal) {
  const location = await serviceLocation(root);
  const endpoint = await readEndpoint(location);
  if (!endpoint || !alive(endpoint.pid)) return void 0;
  const handshake = JSON.parse(
    await exchange(endpoint, "handshake", {}, AbortSignal.any([signal, AbortSignal.timeout(750)]))
  );
  if (!record(handshake) || handshake["protocol"] !== SERVICE_PROTOCOL || handshake["identity"] !== location.identity || handshake["pid"] !== endpoint.pid)
    throw new Error("Service handshake identity mismatch");
  return endpoint;
}
async function ensureService(root, signal) {
  const location = await serviceLocation(root);
  const lock = `${location.endpoint}.lock`;
  const nonce = randomUUID5();
  const candidate = `${lock}.${nonce}`;
  await mkdir4(candidate, { mode: 448 });
  await writeFile5(join15(candidate, "owner"), JSON.stringify({ pid: process.pid, nonce }), { mode: 384 });
  let acquired = false;
  try {
    while (!acquired) {
      signal.throwIfAborted();
      const existing = await existingService(root, signal);
      if (existing) return existing;
      try {
        await rename4(candidate, lock);
        acquired = true;
      } catch (error) {
        if (!record(error) || !["EEXIST", "ENOTEMPTY", "EPERM"].includes(String(error["code"]))) throw error;
        const raw = await readFile12(join15(lock, "owner"), "utf8").catch(() => "{}");
        const owner = JSON.parse(raw);
        if (record(owner) && typeof owner["pid"] === "number" && typeof owner["nonce"] === "string" && !alive(owner["pid"]) && await readFile12(join15(lock, "owner"), "utf8").catch(() => "") === raw)
          await rename4(lock, `${lock}.abandoned-${owner["nonce"]}`).catch(() => void 0);
        await delay2(25, void 0, { signal });
      }
    }
    const connected = await existingService(root, signal);
    if (connected) return connected;
    const previous = await readEndpoint(location);
    if (previous && alive(previous.pid))
      throw new Error("Service process alive but handshake unavailable; retry later");
    await rm3(location.endpoint, { force: true });
    if (process.platform !== "win32") await rm3(location.address, { force: true });
    const token = randomUUID5();
    const cli = fileURLToPath3(import.meta.url);
    const child = spawn4(process.execPath, [...process.execArgv, cli, "service", root, location.identity, token], {
      cwd: root,
      env: executionEnvironment(),
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    let startupError;
    child.once("error", (error) => {
      startupError = error;
    });
    child.unref();
    const startup = AbortSignal.timeout(8e3);
    while (!startup.aborted) {
      if (startupError) throw startupError;
      const endpoint = await readEndpoint(location);
      if (endpoint) {
        await exchange(endpoint, "handshake", {}, startup);
        return endpoint;
      }
      if (child.exitCode !== null) throw new Error("Shared service failed to start");
      await delay2(25);
    }
    throw new Error("Shared service startup timeout");
  } finally {
    await rm3(candidate, { recursive: true, force: true });
    if (acquired) {
      const released = `${lock}.released-${nonce}`;
      await rename4(lock, released);
      await rm3(released, { recursive: true, force: true });
    }
  }
}
async function publishEndpoint(location, token) {
  if (process.platform !== "win32") await chmod(location.address, 384);
  const temporary2 = `${location.endpoint}.${randomUUID5()}`;
  await writeFile5(
    temporary2,
    JSON.stringify({
      pid: process.pid,
      token,
      identity: location.identity,
      protocol: SERVICE_PROTOCOL,
      address: location.address
    }),
    { mode: 384 }
  );
  await rename4(temporary2, location.endpoint);
}

// src/runtime.ts
var Runtime = class {
  constructor() {
    this.active = /* @__PURE__ */ new Set();
  }
  async request(root, operation, args, signal) {
    if (!isAbsolute7(root)) throw new Error("workspace must be an absolute project directory");
    root = await realpath6(root);
    const controller = new AbortController();
    this.active.add(controller);
    signal = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(45e3)]);
    try {
      const existing = await existingService(root, signal);
      const passive = operation === "lsp_status" || operation === "check_diagnostics" && args["run"] === "cached" || operation === "session_end";
      if (!existing && passive) {
        if (operation === "session_end") return "";
        const engine = new Engine(root);
        try {
          const output = await engine.dispatch(operation, args, signal);
          return operation === "lsp_status" ? JSON.stringify({
            ...JSON.parse(output),
            service: { state: "stopped" },
            automaticDiagnostics: JSON.parse(output).configuration.automaticDiagnostics,
            automaticTasks: []
          }) : output;
        } finally {
          await engine.dispose();
        }
      }
      const endpoint = existing ?? await ensureService(root, signal);
      return await exchange(endpoint, operation, args, signal);
    } finally {
      this.active.delete(controller);
    }
  }
  async close() {
    for (const controller of this.active) controller.abort();
    this.active.clear();
  }
};

// src/hook-engine.ts
var HookEngine = class {
  constructor(root, checker) {
    this.root = root;
    this.checker = checker;
    this.store = new Metadata(root);
  }
  async hook(input, signal) {
    const began = Date.now();
    signal.throwIfAborted();
    const id = text(input["session_id"]);
    if (!id)
      return JSON.stringify({
        systemMessage: "Codex CodeIntel: missing session_id; automatic checking unavailable"
      });
    const event = text(input["hook_event_name"], "PostToolUse");
    const stopping = event === "Stop" || event === "SubagentStop";
    const output = (context) => JSON.stringify(
      stopping ? { systemMessage: context } : { hookSpecificOutput: { hookEventName: event, additionalContext: context } }
    );
    if (event === "SessionEnd") {
      await this.store.end(id, signal);
      if (!this.checker) {
        const runtime = new Runtime();
        try {
          await runtime.request(this.root, "session_end", { session: id }, signal);
        } catch {
        } finally {
          await runtime.close();
        }
      }
      return "";
    }
    if (stopping && input["stop_hook_active"] === true) return "";
    const initial = await this.store.read(id);
    if (initial.turn === "__ended__" && event !== "SessionStart") return "";
    const config = await configuration(this.root);
    const baselineOnly = event === "SessionStart" || event === "PreToolUse";
    if (event === "PreToolUse" && initial.baseline) {
      await this.store.update(id, signal, (state2) => {
        const turn = text(input["turn_id"]);
        if (turn && turn !== state2.turn) {
          state2.turn = turn;
          state2.current = [];
        }
      });
      return "";
    }
    const snapshot = await inventory(this.root, 1e4, signal, config.exclude);
    if (!snapshot.complete)
      return output(
        "Codex CodeIntel: partial; change discovery/file limit exceeded (10000 files / 1 MiB per file); baseline retained, unfinished workspace range pending. Narrow scope with check_diagnostics scope=paths run=active."
      );
    const changed = [...snapshot.files].filter(([path, content]) => initial.baseline?.[path] !== content).map(([path]) => path);
    const deleted = Object.keys(initial.baseline ?? {}).filter((path) => !snapshot.files.has(path));
    const configured2 = stopping ? config.automaticDiagnostics.stop : config.automaticDiagnostics.postToolUse;
    const mode = !initial.baseline && !baselineOnly && configured2 !== "off" ? "full" : configured2;
    let registered = false;
    const state = await this.store.update(id, signal, (state2) => {
      if (state2.version !== initial.version && state2.generation !== initial.generation) return false;
      if (state2.turn === "__ended__" && event !== "SessionStart") return false;
      if (state2.turn === "__ended__") state2.turn = "";
      const turn = text(input["turn_id"]);
      if (turn && turn !== state2.turn) {
        state2.turn = turn;
        state2.current = [];
      }
      if (baselineOnly) {
        state2.baseline ??= Object.fromEntries(snapshot.files);
        state2.configuration = config.version;
        registered = true;
        return true;
      }
      const configChanged = state2.configuration !== config.version || changed.some(
        (path) => /(?:config|lock|manifest|Cargo\.toml|package\.json|pyproject|ty\.toml|ruff\.toml|\.clangd|compile_commands|compile_flags|rust-toolchain)/i.test(
          path
        )
      );
      const paths2 = (mode === "full" || configChanged ? [...snapshot.files.keys()] : changed).filter(
        (path) => languageFor(config, path)
      );
      if (changed.length || deleted.length || configChanged || mode === "full" && state2.automaticScope !== "full")
        state2.generation++;
      state2.configuration = config.version;
      state2.baseline = Object.fromEntries(snapshot.files);
      state2.touched = [
        .../* @__PURE__ */ new Set([...state2.touched, ...changed.filter((path) => languageFor(config, path))])
      ].filter((path) => snapshot.files.has(path));
      state2.current = [
        .../* @__PURE__ */ new Set([...state2.current, ...changed.filter((path) => languageFor(config, path))])
      ].filter((path) => snapshot.files.has(path));
      state2.pending = [.../* @__PURE__ */ new Set([...state2.pending, ...paths2])].filter((path) => snapshot.files.has(path));
      state2.delivery = [.../* @__PURE__ */ new Set([...state2.delivery, ...paths2])].filter((path) => snapshot.files.has(path));
      for (const channel of ["lsp", "lint"])
        state2.pendingChannels[channel] = [.../* @__PURE__ */ new Set([...state2.pendingChannels[channel], ...paths2])].filter(
          (path) => snapshot.files.has(path)
        );
      state2.automaticScope = mode === "full" ? "full" : "delta";
      registered = true;
      return true;
    });
    if (!registered || baselineOnly || mode === "off") return "";
    if (!config.trusted && !this.checker)
      return output(
        `session=${id}
Codex CodeIntel: automatic LSP/lint requires workspace trust; lint requires workspace trust. pending=${state.pending.length}`
      );
    const paths = mode === "full" ? [...snapshot.files.keys()].filter((path) => languageFor(config, path)) : [.../* @__PURE__ */ new Set([...state.pending, ...state.delivery])];
    if (!paths.length && !deleted.length && !stopping) return "";
    let result;
    if (this.checker) {
      const results = [];
      for (const path of paths) {
        if (signal.aborted) break;
        results.push(await this.checker(path, signal));
      }
      result = {
        generation: state.generation,
        scope: mode,
        total: paths.length,
        state: signal.aborted ? "pending" : "complete",
        results,
        pending: paths.filter(
          (path) => !results.some((entry) => entry.path === path && entry.state === "complete")
        ),
        note: ""
      };
    } else {
      const runtime = new Runtime();
      try {
        result = JSON.parse(
          await runtime.request(
            this.root,
            "automatic",
            {
              session: id,
              generation: state.generation,
              scope: mode,
              paths,
              waitMs: Math.max(1, (stopping ? 42500 : 3600) - (Date.now() - began))
            },
            signal
          )
        );
      } catch (error) {
        return output(
          `session=${id}
Codex CodeIntel ${mode}: partial; pending=${paths.length}; unfinished paths=${paths.slice(0, 10).join(", ")}. ${message(error)}. Background checks continue; later Hook/MCP can retrieve results.`
        );
      } finally {
        await runtime.close();
      }
    }
    if (result.generation !== state.generation) return "";
    const commitSignal = AbortSignal.timeout(750);
    if ((await configuration(this.root)).version !== config.version)
      return output("Codex CodeIntel: stale; configuration/trust changed; pending retained");
    const valid = [];
    for (const entry of result.results) {
      try {
        if (hash(
          await readFile13(await workspacePath(this.root, entry.path), {
            encoding: "utf8",
            signal: commitSignal
          })
        ) === snapshot.files.get(entry.path))
          valid.push(entry);
      } catch {
      }
    }
    let feedback = "";
    await this.store.update(id, commitSignal, (current) => {
      if (current.generation !== state.generation || current.turn === "__ended__") return false;
      const fresh = [];
      const cleared = [];
      for (const path of deleted) {
        if (current.shown[`issues:${path}`] === "yes")
          cleared.push(`${path} removed; previous diagnostics cleared`);
        delete current.shown[path];
        delete current.shown[`issues:${path}`];
      }
      for (const entry of valid) {
        if (signal.aborted && this.checker) continue;
        if (entry.state === "complete") current.pending = current.pending.filter((path) => path !== entry.path);
        const fingerprint = hash(
          JSON.stringify([
            entry.state,
            entry.findings,
            entry.channels,
            entry.state === "complete" ? void 0 : entry.note
          ])
        );
        if (entry.state === "complete" && !entry.findings.length && current.shown[`issues:${entry.path}`] === "yes")
          cleared.push(`${entry.path}: previous diagnostics cleared`);
        const environment = !entry.findings.length && (entry.state === "failed" || entry.state === "skipped");
        const environmentKey = `environment:${languageFor(config, entry.path)?.language}:${hash(entry.note ?? "unavailable")}`;
        if (current.shown[entry.path] !== fingerprint && (entry.findings.length || entry.state !== "complete") && (!environment || current.shown[environmentKey] !== fingerprint))
          fresh.push(entry);
        if (environment) current.shown[environmentKey] = fingerprint;
        current.shown[entry.path] = fingerprint;
        current.shown[`issues:${entry.path}`] = entry.findings.length ? "yes" : "no";
      }
      const pending = paths.filter(
        (path) => !valid.some((entry) => entry.path === path && entry.state === "complete")
      );
      const errors = valid.flatMap((entry) => entry.findings).filter((finding) => finding.severity === "error").length;
      const summary = `session=${id}
Automatic ${mode}: ${pending.length ? "partial" : "complete"}; checked=${paths.length - pending.length}/${paths.length} errors=${errors} pending=${pending.length}${pending.length ? `
Unfinished range: ${pending.slice(0, 10).join(", ")}${pending.length > 10 ? ` (+${pending.length - 10})` : ""}` : ""}${result.note ? `
${result.note}` : ""}`;
      const signature = hash(
        JSON.stringify([
          state.generation,
          summary,
          valid.map((entry) => [entry.path, entry.state, entry.findings, entry.channels]),
          cleared
        ])
      );
      if (stopping ? current.shown["stop"] !== signature : fresh.length || cleared.length || pending.length && current.shown["post"] !== signature) {
        feedback = `${summary}${fresh.length ? `
LSP/lint channels: ${render(fresh, 15, 3500)}` : ""}${cleared.length ? `
${cleared.join("\n")}` : ""}${pending.length && result.state === "running" ? "\nBackground analysis continues; retrieve on a later Hook or cached MCP query." : ""}`;
      }
      if (stopping) current.shown["stop"] = signature;
      else current.shown["post"] = signature;
      current.delivery = current.delivery.filter(
        (path) => !valid.some((entry) => entry.path === path && entry.state !== "pending" && entry.state !== "stale")
      );
      return true;
    });
    return feedback ? output(feedback) : "";
  }
};

// src/codex-hook.ts
async function runHookCli() {
  stdin.setEncoding("utf8");
  let raw = "";
  for await (const chunk of stdin) {
    raw += chunk;
    if (raw.length > 1024 * 1024) throw new Error("Hook input too large");
  }
  if (!raw.trim()) return;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid Hook JSON");
  }
  if (!record(parsed)) throw new Error("Hook input must be an object");
  const event = text(parsed["hook_event_name"], "PostToolUse");
  const budget = event === "SessionEnd" ? 1600 : event === "Stop" || event === "SubagentStop" ? 44e3 : 4400;
  const signal = AbortSignal.timeout(budget);
  const root = await realpath7(text(parsed["cwd"], process.cwd()));
  try {
    const output = await new HookEngine(root).hook(parsed, signal);
    if (output) process.stdout.write(`${output}
`);
  } catch (error) {
    const context = signal.aborted ? "Codex CodeIntel: Hook budget reached; unfinished checks remain pending. Background tasks already registered continue; later Hooks or MCP queries can retrieve results." : `Codex CodeIntel unavailable: ${message(error).slice(0, 300)}`;
    process.stdout.write(
      `${JSON.stringify(event === "PostToolUse" ? { hookSpecificOutput: { hookEventName: event, additionalContext: context } } : { systemMessage: context })}
`
    );
  }
}

// src/protocol.ts
import { createInterface } from "node:readline";
var string = { type: "string" };
var scope = {
  workspace: { type: "string", description: "Absolute user repository path, never the plugin directory." },
  session: {
    type: "string",
    description: "Codex session id for turn/session scopes; required when multiple sessions share this workspace."
  },
  path: string,
  paths: { type: "array", items: string, maxItems: 200 }
};
var paging = { cursor: string, refresh: { type: "boolean", description: "Force tool and client revalidation" } };
function tool(name, description, properties, required, readOnly) {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required: ["workspace", ...required], additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false }
  };
}
var TOOLS = [
  tool(
    "check_diagnostics",
    "Check paths (workspace by default), current turn or session. Active runs LSP/lint; cached never starts analysis and shares automatic Hook results. Continue with complete next arguments.",
    {
      ...scope,
      ...paging,
      scope: { type: "string", enum: ["paths", "turn", "session"] },
      source: { type: "string", enum: ["lsp", "lint", "both"] },
      run: { type: "string", enum: ["active", "cached"] }
    },
    [],
    true
  ),
  tool(
    "lsp_status",
    "Explain configuration, trust, local tool selection, launchability and running clients without starting LSP. Refresh clears failures and clients.",
    { workspace: scope.workspace, path: string, refresh: { type: "boolean" } },
    [],
    true
  ),
  tool(
    "lsp_navigation",
    "Read-only LSP navigation. Positions are 1-based; unsupported capabilities are reported explicitly.",
    {
      ...scope,
      operation: {
        type: "string",
        enum: [
          "definition",
          "references",
          "symbols",
          "prepare_rename",
          "hover",
          "typeDefinition",
          "implementation",
          "signatureHelp"
        ]
      },
      line: { type: "integer", minimum: 1 },
      column: { type: "integer", minimum: 1 },
      query: string
    },
    ["path", "operation"],
    true
  ),
  tool(
    "lsp_rename",
    "Rename across workspace files. Preflight all targets, detect conflicts, write sequentially; never replay partial writes.",
    { ...scope, line: { type: "integer", minimum: 1 }, column: { type: "integer", minimum: 1 }, newName: string },
    ["path", "newName"],
    false
  ),
  tool(
    "lsp_format",
    "Format explicit paths using Ruff for Python or project formatter/LSP. Preflight before writes.",
    scope,
    [],
    false
  )
];
function validateArguments(name, args) {
  if (args["refresh"] !== void 0 && !(name === "lsp_status" || name === "check_diagnostics" && args["run"] !== "cached"))
    throw new Error("refresh requires active diagnostics or lsp_status");
  const definition = TOOLS.find((entry) => entry.name === name);
  if (!definition) throw new Error("Unknown tool");
  for (const key of definition.inputSchema.required) if (args[key] === void 0) throw new Error(`${key} required`);
  for (const [key, value] of Object.entries(args)) {
    const schema = definition.inputSchema.properties[key];
    if (!record(schema))
      throw new Error(
        ["mode", "start", "offset", "revision"].includes(key) ? "Migration required: use scope/source/run/cursor; see docs/migration-0.5.md" : `Unknown argument: ${key}`
      );
    if (schema["type"] === "boolean" && typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
    if (schema["type"] === "string" && typeof value !== "string") throw new Error(`${key} must be a string`);
    if (schema["type"] === "integer") {
      if (typeof value !== "number" || !Number.isInteger(value) || typeof schema["minimum"] === "number" && value < schema["minimum"] || typeof schema["maximum"] === "number" && value > schema["maximum"])
        throw new Error(`Invalid integer: ${key}`);
    }
    if (schema["type"] === "array" && (!Array.isArray(value) || value.length > 200 || !value.every((item) => typeof item === "string")))
      throw new Error(`${key} must contain at most 200 strings`);
    if (Array.isArray(schema["enum"]) && !schema["enum"].includes(value)) throw new Error(`Invalid ${key}`);
  }
}
async function runMcp(input = process.stdin, output = process.stdout) {
  const runtime = new Runtime();
  const controllers = /* @__PURE__ */ new Map();
  const pending = /* @__PURE__ */ new Set();
  const send = (value) => output.write(`${JSON.stringify(value)}
`);
  const handle = async (value) => {
    if (!record(value)) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      return;
    }
    const id = value["id"];
    const method = value["method"];
    const params = record(value["params"]) ? value["params"] : {};
    if (method === "notifications/cancelled") {
      const target = params["requestId"];
      if (typeof target === "string" || typeof target === "number") controllers.get(target)?.abort();
      return;
    }
    if (id === void 0) return;
    if (typeof id !== "string" && typeof id !== "number") {
      send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid id" } });
      return;
    }
    const ok = (result) => send({ jsonrpc: "2.0", id, result });
    if (method === "initialize") {
      ok({
        protocolVersion: text(params["protocolVersion"], "2024-11-05"),
        serverInfo: { name: "codex-codeintel", version: "0.6.0" },
        // keep in sync with package.json
        capabilities: { tools: { listChanged: false } }
      });
      return;
    }
    if (method === "ping") {
      ok({});
      return;
    }
    if (method === "tools/list") {
      ok({ tools: TOOLS });
      return;
    }
    if (method === "resources/list") {
      ok({ resources: [] });
      return;
    }
    if (method === "resources/templates/list") {
      ok({ resourceTemplates: [] });
      return;
    }
    if (method !== "tools/call") {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    if (controllers.size >= 16 || controllers.has(id)) {
      send({ jsonrpc: "2.0", id, error: { code: -32600, message: "Too many or duplicate requests" } });
      return;
    }
    const controller = new AbortController();
    controllers.set(id, controller);
    try {
      const name = text(params["name"]);
      if (name === "lsp_diagnostics")
        throw new Error("Migration required: use check_diagnostics source=lsp; see docs/migration-0.5.md");
      if (!TOOLS.some((entry) => entry.name === name)) throw new Error("Unknown tool");
      if (!record(params["arguments"])) throw new Error("Tool arguments required");
      const args = params["arguments"];
      validateArguments(name, args);
      const result = await runtime.request(text(args["workspace"]), name, args, controller.signal);
      let structured;
      try {
        structured = JSON.parse(result);
      } catch {
        structured = { summary: result, operation: name, workspace: args["workspace"] };
      }
      if (Array.isArray(structured)) structured = { items: structured };
      ok({
        ...record(structured) ? { structuredContent: structured, ...structured["isError"] === true ? { isError: true } : {} } : {},
        content: [
          {
            type: "text",
            text: record(structured) && typeof structured["text"] === "string" ? structured["text"] : result
          }
        ]
      });
    } catch (error) {
      ok({
        isError: true,
        structuredContent: {
          status: failureKind(message(error)),
          reason: message(error),
          ...error instanceof WriteFailure ? { modifiedPaths: error.modifiedPaths } : {}
        },
        content: [{ type: "text", text: message(error).slice(0, 2e3) }]
      });
    } finally {
      controllers.delete(id);
    }
  };
  const shutdown = () => {
    for (const controller of controllers.values()) controller.abort();
  };
  const exit = () => {
    shutdown();
    lines.close();
    input.pause();
  };
  process.once("SIGTERM", exit);
  process.once("SIGINT", exit);
  output.on("error", exit);
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      if (line.length > 1024 * 1024) {
        send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } });
        continue;
      }
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } });
        continue;
      }
      const task = handle(value);
      pending.add(task);
      void task.finally(() => pending.delete(task));
    }
  } finally {
    shutdown();
    await Promise.allSettled(pending);
    await runtime.close();
    process.removeListener("SIGTERM", exit);
    process.removeListener("SIGINT", exit);
    output.removeListener("error", exit);
  }
}

// src/service.ts
import { rm as rm4 } from "node:fs/promises";
import { createServer } from "node:net";

// src/automatic.ts
import { setTimeout as delay3, setImmediate as yieldBatch } from "node:timers/promises";
var Automatic = class {
  constructor(root, engine) {
    this.root = root;
    this.engine = engine;
    this.jobs = /* @__PURE__ */ new Map();
  }
  get active() {
    return [...this.jobs.values()].some((job) => job.state === "running");
  }
  status() {
    return [...this.jobs.values()].map((job) => ({
      session: job.session,
      generation: job.generation,
      scope: job.scope,
      state: job.state,
      total: job.paths.length,
      processed: job.results.size,
      checked: [...job.results.values()].filter((result) => result.state === "complete").length,
      remaining: job.paths.filter((path) => job.results.get(path)?.state !== "complete"),
      note: job.note
    }));
  }
  cancel(session) {
    for (const job of this.jobs.values())
      if (!session || job.session === session) {
        job.controller.abort();
        job.state = "cancelled";
        this.jobs.delete(job.session);
      }
  }
  result(job) {
    return {
      generation: job.generation,
      scope: job.scope,
      state: job.state,
      total: job.paths.length,
      results: [...job.results.values()],
      pending: job.paths.filter((path) => {
        const result = job.results.get(path);
        return result?.state !== "complete";
      }),
      note: job.note
    };
  }
  async request(args, environment, signal) {
    const session = text(args["session"]);
    const store = new Metadata(this.root);
    const state = await store.read(session);
    if (state.turn === "__ended__" || state.generation !== args["generation"])
      return JSON.stringify({ generation: -1, results: [], pending: [], state: "stale" });
    const config = await configuration(this.root);
    if (!config.trusted) {
      this.cancel();
      throw new Error("Automatic LSP/lint requires workspace trust; lint requires workspace trust");
    }
    let job = this.jobs.get(session);
    if (job && (job.generation !== state.generation || job.configuration !== config.version || hash(JSON.stringify(job.environment)) !== hash(JSON.stringify(environment)))) {
      this.cancel(session);
      job = void 0;
    }
    if (job?.state !== "running") {
      const paths = Array.isArray(args["paths"]) ? args["paths"].filter((path) => typeof path === "string") : state.pending;
      job = {
        session,
        generation: state.generation,
        scope: text(args["scope"], state.automaticScope),
        configuration: config.version,
        environment,
        paths: [...new Set(paths)],
        results: /* @__PURE__ */ new Map(),
        controller: new AbortController(),
        started: Date.now(),
        state: "running",
        note: "",
        done: Promise.resolve()
      };
      this.jobs.set(session, job);
      const target2 = job;
      job.done = withExecution(environment, true, () => this.run(target2));
    }
    const target = job;
    const wait = typeof args["waitMs"] === "number" ? Math.max(0, Math.min(43e3, args["waitMs"])) : 3500;
    const waiting = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, wait))]);
    await Promise.race([target.done, delay3(wait, void 0, { signal: waiting }).catch(() => void 0)]);
    return JSON.stringify(this.result(target));
  }
  async run(job) {
    const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(3e5)]);
    const store = new Metadata(this.root);
    try {
      let remaining = [...job.paths];
      if (!remaining.length)
        await this.engine.dispatch("automatic_batch", { paths: [], session: job.session }, signal);
      while (remaining.length && !signal.aborted) {
        const retry = [];
        for (let start = 0; start < remaining.length; start += 50) {
          signal.throwIfAborted();
          const state = await store.read(job.session);
          const config = await configuration(this.root);
          if (state.turn === "__ended__" || state.generation !== job.generation || config.version !== job.configuration || !config.trusted) {
            job.state = "cancelled";
            job.note = "Generation/configuration/trust changed; results stale";
            return;
          }
          const paths = remaining.slice(start, start + 50);
          const output = await this.engine.dispatch(
            "automatic_batch",
            { paths, session: job.session, turn: state.turn },
            signal
          );
          const results = JSON.parse(output);
          await store.update(job.session, signal, (current) => {
            if (current.generation !== job.generation || current.turn === "__ended__") return false;
            for (const result of results) {
              job.results.set(result.path, result);
              const channels = result.channels ?? { lsp: result.state, lint: result.state };
              for (const channel of ["lsp", "lint"]) {
                current.pendingChannels[channel] = current.pendingChannels[channel].filter(
                  (path) => path !== result.path
                );
                if (channels[channel] === "pending" || channels[channel] === "stale" || channels[channel] === "failed" || channel === "lsp" && channels[channel] === "skipped")
                  current.pendingChannels[channel].push(result.path);
              }
              if (result.state === "complete")
                current.pending = current.pending.filter((path) => path !== result.path);
              if (result.state === "pending" || result.state === "stale") retry.push(result.path);
            }
            return true;
          });
          await yieldBatch();
        }
        remaining = retry;
        if (remaining.length) await delay3(1e3, void 0, { signal });
      }
      job.state = job.paths.every((path) => job.results.get(path)?.state === "complete") ? "complete" : "pending";
    } catch (error) {
      job.state = job.controller.signal.aborted ? "cancelled" : "pending";
      job.note = signal.aborted && !job.controller.signal.aborted ? "Automatic analysis exceeded five-minute budget; unfinished range retained" : message(error);
    }
  }
  async revalidate() {
    for (const job of this.jobs.values()) {
      if (job.state !== "running") continue;
      await withExecution(job.environment, true, async () => {
        try {
          const config = await configuration(this.root);
          const state = await new Metadata(this.root).read(job.session);
          if (!config.trusted || config.version !== job.configuration || state.generation !== job.generation || state.turn === "__ended__")
            this.cancel(job.session);
        } catch {
          this.cancel(job.session);
        }
      });
    }
  }
  async dispose() {
    const tasks = [...this.jobs.values()].map((job) => job.done);
    this.cancel();
    await Promise.allSettled(tasks);
  }
};

// src/service.ts
async function runService(root, identity, token) {
  const location = await serviceLocation(root);
  if (location.identity !== identity || !token) throw new Error("Invalid service startup identity");
  const engine = new Engine(root);
  const automatic = new Automatic(root, engine);
  const sockets = /* @__PURE__ */ new Set();
  let lastActivity = Date.now();
  let requests = 0;
  let stopping = false;
  const server2 = createServer((socket) => {
    sockets.add(socket);
    const controller = new AbortController();
    let input = "";
    let started = false;
    let authenticated = false;
    socket.setEncoding("utf8");
    socket.setTimeout(5e3, () => {
      if (!authenticated) socket.destroy();
    });
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      sockets.delete(socket);
      controller.abort();
    });
    const handle = async (value) => {
      if (started) {
        if (authenticated && record(value) && value["cancel"] === true) controller.abort();
        return;
      }
      started = true;
      if (!record(value) || value["token"] !== token || value["identity"] !== identity || value["protocol"] !== SERVICE_PROTOCOL || !record(value["args"]) || !record(value["environment"]) || !Object.values(value["environment"]).every((entry) => typeof entry === "string")) {
        socket.destroy();
        return;
      }
      authenticated = true;
      requests++;
      lastActivity = Date.now();
      const operation = text(value["operation"]);
      const args = value["args"];
      const environment = value["environment"];
      try {
        const output = await withExecution(environment, operation === "automatic", async () => {
          if (operation === "handshake")
            return JSON.stringify({ protocol: SERVICE_PROTOCOL, identity, pid: process.pid });
          if (operation === "session_end") {
            automatic.cancel(text(args["session"]));
            return "";
          }
          if (operation === "automatic") return automatic.request(args, environment, controller.signal);
          if (!["lsp_status", "check_diagnostics", "lsp_navigation", "lsp_rename", "lsp_format"].includes(operation))
            throw new Error("Unknown service operation");
          const config = await configuration(root);
          if (!config.trusted) automatic.cancel();
          const output2 = await engine.dispatch(operation, args, controller.signal);
          if (operation === "lsp_status")
            return JSON.stringify({
              ...JSON.parse(output2),
              service: { state: "running", pid: process.pid, identity, protocol: SERVICE_PROTOCOL },
              automaticDiagnostics: config.automaticDiagnostics,
              automaticTasks: automatic.status()
            });
          return output2;
        });
        if (!socket.destroyed) socket.end(`${JSON.stringify({ output })}
`);
      } catch (error) {
        if (!socket.destroyed)
          socket.end(
            `${JSON.stringify({ error: message(error), ...error instanceof WriteFailure ? { modifiedPaths: error.modifiedPaths } : {} })}
`
          );
      } finally {
        requests--;
        lastActivity = Date.now();
      }
    };
    socket.on("data", (chunk) => {
      input += chunk;
      if (Buffer.byteLength(input) > 1024 * 1024) {
        socket.destroy();
        return;
      }
      let end = input.indexOf("\n");
      while (end >= 0) {
        const line = input.slice(0, end);
        input = input.slice(end + 1);
        try {
          void handle(JSON.parse(line));
        } catch {
          socket.destroy();
        }
        end = input.indexOf("\n");
      }
    });
  });
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(idle);
    server2.close();
    for (const socket of sockets) socket.destroy();
    await automatic.dispose();
    await engine.dispose();
    if ((await readEndpoint(location).catch(() => void 0))?.token === token)
      await rm4(location.endpoint, { force: true });
  };
  const idle = setInterval(() => {
    void automatic.revalidate();
    if (requests || automatic.active) lastActivity = Date.now();
    else if (Date.now() - lastActivity >= 12e4) void stop();
  }, 1e3);
  process.once("SIGTERM", () => {
    void stop();
  });
  process.once("SIGINT", () => {
    void stop();
  });
  await new Promise((resolve8, reject) => {
    server2.once("error", reject);
    server2.listen(location.address, resolve8);
  });
  await publishEndpoint(location, token);
}

// src/cli.ts
async function main() {
  restoreInstalledHome();
  const [command = "mcp"] = process.argv.slice(2);
  if (command === "mcp") await runMcp();
  else if (command === "hook") await runHookCli();
  else if (command === "service")
    await runService(process.argv[3] ?? "", process.argv[4] ?? "", process.argv[5] ?? "");
  else throw new Error("Usage: codex-codeintel [mcp | hook]");
}
main().catch((error) => {
  process.stderr.write(`${message(error)}
`);
  process.exitCode = 1;
});
