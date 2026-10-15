#!/usr/bin/env node
// PROVE module memory loads — for every module, in a real headless Claude Code session.
//
//   node scripts/module-memory/proof.mjs [--only payroll,crm] [--model sonnet]
//
// For each module it picks a real tracked file matched by the module's FIRST glob (most use `{a,b}`
// braces, so this also proves the loader's glob dialect), starts a fresh headless session in this
// checkout, has it Read that one file, and asks it to copy the module's **Scope:** line from its context. PASS =
// that line came back — it exists only in the module file. It runs with project settings only (no personal hooks) and
// with the module-memory hook switched off (PHX_MODULE_MEMORY_HOOK_OFF=1 — the prompt names the
// file, which the hook would otherwise match), so only Claude Code's own `paths:` loading can
// have delivered it.
//
// Re-run after a Claude Code update: the loader is Claude Code's, not ours, and its behaviour is
// exactly what a version bump can change. Local only (CI has no Claude Code); it costs one short
// Sonnet session per module. Exit 1 if any module failed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MODULES, globToRegExp } from "./modules.mjs";

import { refuseUnknownFlags } from "../lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "module-memory/proof",
  entry: import.meta.url,
  known: ["--model", "--only", "--save"],
  hints: [
    "--only <id> narrows the run; --save writes the result",
  ],
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : fallback;
};
const only = arg("--only", "").split(",").filter(Boolean);
const model = arg("--model", "sonnet");
const saveDir = arg("--save", ""); // write each session's stream to <dir>/<module>.jsonl for inspection

function claudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const dir = path.join(os.homedir(), "AppData", "Roaming", "Claude", "claude-code");
  if (fs.existsSync(dir)) {
    const versions = fs.readdirSync(dir).filter((v) => /^\d+\.\d+\.\d+$/.test(v))
      .sort((a, b) => a.split(".").map(Number).reduce((r, n, i) => r || n - b.split(".").map(Number)[i], 0));
    const exe = versions.length ? path.join(dir, versions[versions.length - 1], "claude.exe") : null;
    if (exe && fs.existsSync(exe)) return exe;
  }
  return "claude";
}

const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 }).split("\n").filter(Boolean);
const bin = claudeBin();
const version = spawnSync(bin, ["--version"], { encoding: "utf8" }).stdout.trim();
console.log(`proof: ${bin} (${version}), model ${model}`);

let failed = 0;
for (const mod of MODULES) {
  if (only.length && !only.includes(mod.id)) continue;
  const re = globToRegExp(mod.globs[0]);
  const sample = files.find((f) => re.test(f) && /\.(ts|tsx|mjs|js|md|sql)$/.test(f)) || files.find((f) => re.test(f));
  if (!sample) {
    console.log(`FAIL ${mod.id}: no tracked file matches ${mod.globs[0]}`);
    failed++;
    continue;
  }
  const prompt = `Step 1 (mandatory): call the Read tool on ${sample}. Step 2: from your own instructions and context, NOT the file you read, copy the line that begins with **Scope:** exactly. Reply with that line only, or NONE.`;
  const r = spawnSync(bin, ["-p", prompt, "--model", model, "--max-turns", "4", "--setting-sources", "project,local", "--output-format", "stream-json", "--verbose"], {
    cwd: ROOT, encoding: "utf8", input: "", timeout: 180_000, maxBuffer: 1 << 26,
    // The prompt names the file, and the module-memory hook matches paths in a prompt — so the hook
    // is switched off here, or a PASS could be the hook's pointer instead of Claude Code's loader.
    env: { ...process.env, PHX_MODULE_MEMORY_HOOK_OFF: "1" },
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  if (saveDir) {
    fs.mkdirSync(saveDir, { recursive: true });
    fs.writeFileSync(path.join(saveDir, `${mod.id}.jsonl`), out);
  }
  const read = /"name":"Read"/.test(out);
  // The Scope line exists ONLY in the module file — never in the hook pointer, never in AGENTS.md.
  const needle = mod.scope.slice(0, 48).replace(/"/g, '\\"');
  const ok = read && out.includes(needle);
  console.log(`${ok ? "PASS" : "FAIL"} ${mod.id.padEnd(17)} read ${sample}${read ? "" : " (the session never opened it)"}`);
  if (!ok) failed++;
}
console.log(failed ? `proof: ${failed} module(s) FAILED` : "proof: every module loaded on demand");
process.exit(failed ? 1 : 0);
