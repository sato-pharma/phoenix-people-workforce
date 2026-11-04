#!/usr/bin/env node
// claude-config-review.mjs — a READ-ONLY review of every file that controls Claude Code on this machine.
//
// Covers: user / project / local / parent / managed settings (keys checked against the INSTALLED
// Claude Code binary), permissions, auto-mode grants, hooks and the scripts they call, the status line,
// MCP servers (user, project, local, desktop), skills, subagents, plugins, skill overrides, memory
// indexes, ~/.claude.json, the desktop app config, context footprint, transcript retention, backup
// sprawl, plaintext secrets (logs included), the Windows scheduled jobs around Claude, the desktop app's own
// scheduled tasks, free disk space, memory descriptions that stop mid-sentence or still carry a superseded
// rule, one repository split across memory folders, and whether the Phoenix primary checkout serves the
// same control files as main.
//
// It writes ONE Markdown report and ONE JSON snapshot under ~/.claude/reviews/ (plus a small cache of
// what the installed binary knows) and changes nothing else. The snapshot is what makes it a REGULAR
// review: every run diffs against the previous one, so a permission, hook, MCP server, skill or grant
// that a session added quietly shows up by name.
//
// Settled findings go in ~/.claude/reviews/accepted.json as {"<finding id>": "why"} — they are counted,
// never raised again. Keys starting with "_" are ignored.
//
// Usage: node claude-config-review.mjs [--quiet] [--out <dir>]

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const argValue = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const QUIET = argv.includes("--quiet");
// --alert: in addition to the normal report, diff this run against a PERSISTED baseline
// (~/.claude/reviews/.alert-baseline.json, separate from snapshots/ so ad-hoc runs between
// weekly runs cannot erode the weekly delta) and write a machine-readable payload the
// Telegram watcher reads. Opt-in only; the default path is unchanged.
const ALERT = argv.includes("--alert");

const fwd = (p) => String(p).replace(/\\/g, "/").replace(/^\/([a-zA-Z])\//, "$1:/");
const HOME = fwd(os.homedir());
const CLAUDE = `${HOME}/.claude`;
const APPDATA = fwd(process.env.APPDATA || `${HOME}/AppData/Roaming`);
const OUT = fwd(argValue("--out") || `${CLAUDE}/reviews`);
const PHOENIX = "F:/Phoenix Workforce/phoenix-workforce";
const LOADER_CLIFF = 24400; // MEMORY.md is truncated here, silently
const INDEX_BUDGET = 22000; // AGENTS.md §2.2
// b345e47e left this list 2026-10-09: the owner allowed it on 2026-10-05 (phoenix AGENTS.md §8, "It stays
// allowed"), and keeping it here raised a false HIGH every morning against his own decision.
const DENIED_CONNECTORS = ["mcp__45bb6356-8105-4482-9464-25bfd754baec"];
const started = Date.now();
const SNAP = {}; // what the next run diffs against; filled by the sections below

// ---------------------------------------------------------------------------------------------- helpers
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const statOf = (p) => { try { return fs.statSync(p); } catch { return null; } };
const readText = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
function loadJson(p) {
  const raw = readText(p);
  if (raw === null) return { missing: true };
  const bom = raw.charCodeAt(0) === 0xfeff;
  try { return { data: JSON.parse(bom ? raw.slice(1) : raw), bom, bytes: Buffer.byteLength(raw), raw }; }
  catch (e) { return { error: e.message, bom, bytes: Buffer.byteLength(raw), raw }; }
}
const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 12);
const cairo = (d) => new Date(d).toLocaleString("en-GB", { timeZone: "Africa/Cairo", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const size = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e3).toFixed(1)} KB`);
const q = (s, max = 90) => { const t = String(s).replace(/`/g, "'").replace(/\s+/g, " "); return "`" + (t.length > max ? t.slice(0, max - 3) + "..." : t) + "`"; };
const days = (ms) => Math.floor((Date.now() - ms) / 86400000);
function walk(dir, opts = {}, depth = 0, out = []) {
  const { maxDepth = 12, skipDir = () => false } = opts;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) { if (depth < maxDepth && !skipDir(p, e.name)) walk(p, opts, depth + 1, out); }
    else if (e.isFile()) { const s = statOf(p); if (s) out.push({ path: p, name: e.name, size: s.size, mtimeMs: s.mtimeMs }); }
  }
  return out;
}
const listDir = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
// NAMES of the Windows user + machine environment variables (values are never read into the report)
const USER_ENV = (() => {
  const names = new Set();
  for (const key of ["HKCU\\Environment", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"]) {
    try {
      const out = execFileSync("reg", ["query", key], { encoding: "utf8", windowsHide: true, timeout: 15000 });
      for (const line of out.split(/\r?\n/)) { const m = line.match(/^ {4}(\S+) {4}REG_/); if (m) names.add(m[1].toUpperCase()); }
    } catch { /* not Windows or no access */ }
  }
  return names;
})();

const accepted = (() => {
  const a = loadJson(`${OUT}/accepted.json`).data || {};
  return Object.fromEntries(Object.entries(a).filter(([k]) => !k.startsWith("_")));
})();
const findings = [];
const passed = [];
const notes = []; // plain facts worth printing (footprint, versions)
const SEV_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2, INFO: 3 };
function add(sev, area, id, title, detail = "") {
  if (findings.some((f) => f.id === id)) return;
  findings.push({ sev, area, id, title, detail, accepted: Object.hasOwn(accepted, id) ? accepted[id] : null });
}
const ok = (area, text) => passed.push({ area, text });
function section(area, fn) {
  try { fn(); } catch (e) { add("MEDIUM", area, `review-error:${area}`, `The review could not finish its ${area} checks`, String(e?.stack || e).split("\n").slice(0, 2).join(" ")); }
}

// ------------------------------------------------------------------------------------ discover layers
const claudeJson = loadJson(`${HOME}/.claude.json`);
const projectKeys = Object.keys(claudeJson.data?.projects || {});
const norm = (p) => fwd(p).replace(/\/+$/, "");
const isWorktreePath = (p) => /\/\.claude\/worktrees\/[^/]+$|\/_wt-[^/]+$/i.test(norm(p));
const label = (root) => {
  if (!root) return "user";
  const r = root.toLowerCase();
  if (r === PHOENIX.toLowerCase()) return "Phoenix";
  if (r === "f:/phoenix workforce") return "Phoenix parent folder";
  return path.basename(root) || root;
};
const roots = new Map();
for (const p of [PHOENIX, ...projectKeys]) {
  const n = norm(p);
  if (!n || isWorktreePath(n)) continue;
  if (!roots.has(n.toLowerCase())) roots.set(n.toLowerCase(), n);
}

const layers = [];
function addLayer(name, kind, file, root = null) {
  const j = loadJson(file);
  if (j.missing) return;
  layers.push({ name, kind, file, root, ...j });
}
addLayer("user settings", "user", `${CLAUDE}/settings.json`);
addLayer("user local settings", "user", `${CLAUDE}/settings.local.json`);
addLayer("managed settings", "managed", "C:/Program Files/ClaudeCode/managed-settings.json");
addLayer("managed settings", "managed", "C:/ProgramData/ClaudeCode/managed-settings.json");
for (const root of roots.values()) {
  if (root.toLowerCase() === HOME.toLowerCase() || !exists(root)) continue;
  addLayer(`${label(root)} project settings`, "project", `${root}/.claude/settings.json`, root);
  addLayer(`${label(root)} local settings`, "local", `${root}/.claude/settings.local.json`, root);
}
const userLayer = layers.find((l) => l.file === `${CLAUDE}/settings.json`);
const U = userLayer?.data || {};
const phoenixProject = layers.find((l) => l.kind === "project" && l.root?.toLowerCase() === PHOENIX.toLowerCase());
const phoenixLocal = layers.find((l) => l.kind === "local" && l.root?.toLowerCase() === PHOENIX.toLowerCase());

// ------------------------------------------------------------------------ installed Claude Code binary
function cmpVer(a, b) { const pa = a.split(".").map(Number), pb = b.split(".").map(Number); for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); return 0; }
function findBinaries() {
  let desktop = null;
  for (const v of listDir(`${APPDATA}/Claude/claude-code`)) {
    const exe = `${APPDATA}/Claude/claude-code/${v}/claude.exe`;
    if (/^\d+\.\d+\.\d+$/.test(v) && exists(exe) && (!desktop || cmpVer(v, desktop.version) > 0)) desktop = { exe, version: v };
  }
  const npmDir = `${APPDATA}/npm/node_modules/@anthropic-ai/claude-code`;
  const cli = exists(`${npmDir}/bin/claude.exe`) ? { exe: `${npmDir}/bin/claude.exe`, version: loadJson(`${npmDir}/package.json`).data?.version || "?" } : null;
  return { desktop, cli };
}
const BIN = findBinaries();
const probeExe = BIN.desktop || BIN.cli;
// Search the binary for needles, in 16 MB windows. Results are cached per binary (path + size + mtime).
function probeBinary(probes) {
  if (!probeExe) return null;
  const st = statOf(probeExe.exe);
  const cacheFile = `${OUT}/.cache/binary-probes.json`;
  let cache = loadJson(cacheFile).data || {};
  const key = `${probeExe.exe}|${st.size}|${Math.round(st.mtimeMs)}`;
  if (cache.key !== key) cache = { key, results: {} };
  const todo = probes.filter((p) => !Object.hasOwn(cache.results, p.id));
  if (todo.length) {
    const found = new Set();
    const fd = fs.openSync(probeExe.exe, "r");
    const CHUNK = 16 * 1024 * 1024, OVERLAP = 8192;
    const buf = Buffer.allocUnsafe(CHUNK + OVERLAP);
    for (let pos = 0; pos < st.size && found.size < todo.length; pos += CHUNK) {
      const n = fs.readSync(fd, buf, 0, CHUNK + OVERLAP, pos);
      if (n <= 0) break;
      const s = buf.toString("latin1", 0, n);
      for (const p of todo) {
        if (found.has(p.id)) continue;
        search: for (const needle of p.needles) {
          let i = s.indexOf(needle), guard = 0;
          while (i !== -1 && guard++ < 20000) {
            if (!p.near || s.slice(i, i + 900).includes(p.near)) { found.add(p.id); break search; }
            i = s.indexOf(needle, i + needle.length);
          }
        }
      }
    }
    fs.closeSync(fd);
    for (const p of todo) cache.results[p.id] = found.has(p.id);
    fs.mkdirSync(`${OUT}/.cache`, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
  }
  return cache.results;
}
const keyProbe = (k) => ({ id: `key:${k}`, needles: [`,${k}:`, `{${k}:`], near: ".describe(" });
const eventProbe = (e) => ({ id: `event:${e}`, needles: [`"${e}"`] });

// ------------------------------------------------------------------------------------ 1. file health
section("Settings files", () => {
  if (!userLayer) add("HIGH", "Settings files", "user-settings-missing", "~/.claude/settings.json is missing — every owner setting and hook is gone");
  for (const l of layers) {
    if (l.error) add("HIGH", "Settings files", `json-broken:${l.file}`, `${l.file} is not valid JSON, so Claude Code ignores the whole file`, l.error);
    if (l.bom) add("LOW", "Settings files", `json-bom:${l.file}`, `${l.file} starts with a byte-order mark`, "Rewrite it as UTF-8 without BOM.");
  }
  const managed = layers.filter((l) => l.kind === "managed");
  if (managed.length) add("INFO", "Settings files", "managed-present", `Managed (policy) settings exist and override everything: ${managed.map((m) => m.file).join(", ")}`);
  ok("Settings files", `${layers.length} settings files parsed: ${layers.map((l) => l.name).join(", ")}`);
});

// ------------------------------------------------------------------- 2. keys the installed build knows
section("Setting names", () => {
  if (!probeExe) { add("LOW", "Setting names", "binary-missing", "Could not find the installed Claude Code binary, so setting names were not verified"); return; }
  const want = new Map(); // probe id -> [{file, where}]
  const note = (id, file, where) => { if (!want.has(id)) want.set(id, []); want.get(id).push({ file, where }); };
  const HOOK_ENTRY_KEYS = ["type", "command", "args", "if", "shell", "timeout", "statusMessage", "once", "async", "asyncRewake", "rewakeMessage", "rewakeSummary", "prompt", "model", "server", "tool", "input", "url", "headers"];
  for (const l of layers) {
    if (!l.data || typeof l.data !== "object") continue;
    const real = (o) => Object.keys(o && typeof o === "object" ? o : {}).filter((k) => !k.startsWith("$")); // "$schema" / "$comment…" are annotations
    for (const k of real(l.data)) note(`key:${k}`, l.file, k);
    for (const k of real(l.data.permissions)) note(`key:${k}`, l.file, `permissions.${k}`);
    for (const k of real(l.data.autoMode)) note(`key:${k}`, l.file, `autoMode.${k}`);
    for (const k of real(l.data.statusLine)) note(`key:${k}`, l.file, `statusLine.${k}`);
    for (const ev of real(l.data.hooks)) {
      const groups = l.data.hooks[ev];
      note(`event:${ev}`, l.file, `hooks.${ev}`);
      for (const g of Array.isArray(groups) ? groups : []) {
        for (const k of real(g)) if (!["matcher", "hooks"].includes(k)) add("MEDIUM", "Setting names", `hook-group-key:${l.file}:${ev}:${k}`, `hooks.${ev} has an unknown group field ${q(k)} in ${l.file}`);
        for (const h of g.hooks || []) for (const k of real(h)) if (!HOOK_ENTRY_KEYS.includes(k)) note(`key:${k}`, l.file, `hooks.${ev}[].${k}`);
      }
    }
  }
  const results = probeBinary([...want.keys()].map((id) => (id.startsWith("event:") ? eventProbe(id.slice(6)) : keyProbe(id.slice(4)))));
  let unknown = 0;
  for (const [id, uses] of want) {
    if (results[id]) continue;
    unknown++;
    const what = id.startsWith("event:") ? "hook event" : "setting";
    for (const u of uses) add("MEDIUM", "Setting names", `unknown:${id}:${u.file}`, `${q(u.where)} in ${u.file} is not a ${what} Claude Code ${probeExe.version} knows — it is silently ignored`, "Check the spelling, or remove it.");
  }
  if (!unknown) ok("Setting names", `All ${want.size} setting names and hook events in use are known to Claude Code ${probeExe.version}`);
});

// ------------------------------------------------------------------------------- 3. owner invariants
section("Owner rules", () => {
  if (U.env?.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION === "true") ok("Owner rules", "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=true is in the user settings env block");
  else add("HIGH", "Owner rules", "invariant-prompt-suggestion-env", "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION is missing from the env block of ~/.claude/settings.json", "Owner rule (CLAUDE.md, 2026-09-15): it must stay there — only the variable keeps suggestions on near the usage limit.");
  if (U.permissions?.defaultMode === "auto") ok("Owner rules", "Default permission mode is auto");
  else add("MEDIUM", "Owner rules", "invariant-default-mode", `Default permission mode is ${q(U.permissions?.defaultMode ?? "unset")}, not auto — AGENTS.md rule 1.5 assumes auto`);
  const userDeny = U.permissions?.deny || [];
  for (const c of DENIED_CONNECTORS) {
    if (userDeny.includes(c)) ok("Owner rules", `${c.slice(5, 13)}… claude.ai Supabase connector is denied everywhere`);
    else add("HIGH", "Owner rules", `invariant-connector-deny:${c}`, `The claude.ai Supabase connector ${q(c)} is no longer denied in user settings`, "Owner decision (AGENTS.md §8): it stays denied.");
  }
  if (phoenixProject?.data) {
    const d = phoenixProject.data.permissions?.deny || [];
    for (const r of ["Bash(gh pr merge *--auto*)", "PowerShell(gh pr merge *--auto*)", "Bash(railway service source connect*)", "PowerShell(railway service source connect*)"]) {
      if (!d.includes(r)) add("HIGH", "Owner rules", `invariant-phoenix-deny:${r}`, `Phoenix project settings no longer deny ${q(r)}`, "AGENTS.md §2 / §2.3 hard rule.");
    }
    const askList = phoenixProject.data.permissions?.ask || [];
    if (askList.length) add("LOW", "Owner rules", "phoenix-ask-not-empty", `Phoenix permissions.ask now has ${askList.length} rule(s) — AGENTS.md rule 1.5 says it is empty; update one or the other`);
  }
  const mcp = loadJson(`${PHOENIX}/.mcp.json`).data;
  if (mcp?.mcpServers?.["supabase-staging"]) {
    if (/project_ref=cifwmndunmlxjhyjugxa/.test(mcp.mcpServers["supabase-staging"].url || "")) ok("Owner rules", "supabase-staging MCP is pinned to the staging project");
    else add("HIGH", "Owner rules", "invariant-staging-pin", "The supabase-staging MCP server is no longer pinned to the staging project (project_ref missing from its URL)");
  }
  // CLAUDE.md (2026-09-17): the owner wants the variable in BOTH places — settings.json (checked above) AND the Windows user environment
  if (USER_ENV.has("CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION")) ok("Owner rules", "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION is also a Windows user variable, so a plain terminal shows it");
  else add("LOW", "Owner rules", "prompt-suggestion-windows-copy-missing", "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION is not set as a Windows user variable, so env | grep in a plain terminal comes back empty", "Owner rule (CLAUDE.md, 2026-09-17): keep it in the Windows user environment as well as in ~/.claude/settings.json. Never remove either copy.");
});

// ------------------------------------------------------------------------------------ 4. permissions
function isOneOff(rule) {
  const m = rule.match(/^(Bash|PowerShell)\(([\s\S]*)\)$/);
  if (!m) return false;
  const spec = m[2];
  if (/\*\s*$|:\*$/.test(spec)) return false;
  return spec.length > 70 || /["']/.test(spec) || /\d{4}-\d{2}-\d{2}|\b\d+,\d+p\b/.test(spec);
}
const RISKY = [
  [/^(Bash|PowerShell)(\(\*\))?$/, "every shell command is pre-approved", "HIGH"],
  [/^(Bash|PowerShell)\(env\)$|^PowerShell\((Get-ChildItem|gci|dir|ls) env:.*\)$/i, "one call prints every environment variable, including the production Supabase, OpenAI and Cloudflare tokens, into the transcript (the same exposure as the .env reads the owner allows)", "LOW"],
  [/^(Bash|PowerShell)\(railway run[ :]/i, "runs ANY command with the production Railway secrets injected — the path that sends real email — without the auto-mode classifier looking at it", "MEDIUM"],
  [/^(Bash|PowerShell)\(node -e ?['"]? ?\*\)$|^(Bash|PowerShell)\(node -e:\*\)$/i, "any inline JavaScript runs without review", "MEDIUM"],
  [/^(Bash|PowerShell)\(python3? -c ?['"]? ?\*\)$|^(Bash|PowerShell)\(python3? -c:\*\)$/i, "any inline Python runs without review", "MEDIUM"],
  [/^(Bash|PowerShell)\((bash|sh|zsh) -c ?['"]? ?\*\)$/i, "any inline shell script runs without review", "MEDIUM"],
  [/^(Bash|PowerShell)\((pnpm|npm) exec[ :]\*\)$|^(Bash|PowerShell)\(npx[ :]\*\)$/i, "any package binary runs without review", "LOW"],
  [/^Read\(\/\/c\/Users\/[^/)]+\/(\.claude\/)?\*\*\)$/i, "covers .credentials.json, the Claude login token", "LOW"],
];
section("Permissions", () => {
  for (const l of layers) {
    const p = l.data?.permissions;
    if (!p) continue;
    const allow = p.allow || [], deny = p.deny || [], ask = p.ask || [];
    for (const [name, list] of [["allow", allow], ["deny", deny], ["ask", ask]]) {
      const seen = new Set(), dups = new Set();
      for (const r of list) { if (seen.has(r)) dups.add(r); seen.add(r); }
      if (dups.size) add("LOW", "Permissions", `perm-dup:${l.file}:${name}`, `${dups.size} duplicated ${name} rule(s) in ${l.name}`, [...dups].slice(0, 4).map((r) => q(r)).join(" · "));
    }
    for (const r of deny) {
      if (!/^mcp__[^()]*__\*$/.test(r)) continue;
      const coveredByUser = (U.permissions?.deny || []).includes(r.slice(0, -3));
      add(coveredByUser ? "LOW" : "HIGH", "Permissions", `perm-deny-suffix:${l.file}:${r}`, `Deny rule ${q(r)} in ${l.name} matches nothing — a \`__*\` suffix is not a wildcard${coveredByUser ? " (harmless: user settings deny the bare server name)" : "; write the bare server name"}`);
    }
    const oneOff = allow.filter(isOneOff);
    if (oneOff.length >= 8) add("LOW", "Permissions", `perm-oneoff:${l.file}`, `${oneOff.length} of ${allow.length} allow rules in ${l.name} are one-off approvals of an exact command that will not recur`, oneOff.slice(0, 3).map((r) => q(r, 70)).join(" · "));
    const dead = allow.filter((r) => {
      const m = r.match(/^(Bash|PowerShell)\(([\s\S]*)\)$/);
      if (!m) return false;
      const cmd = m[2].trim();
      return m[1] === "Bash"
        ? /^(Get|Set|Select|Remove|Write|New|Test|Measure|Invoke|Export|Import|ConvertTo|ConvertFrom|Start|Stop)-[A-Z]/.test(cmd)
        : /^(grep|sed|awk|head|tail|xargs|wc|cat) /.test(cmd);
    });
    if (dead.length) add("INFO", "Permissions", `perm-dead:${l.file}`, `${dead.length} allow rule(s) in ${l.name} can never match (a PowerShell cmdlet under Bash, or a bash tool under PowerShell)`, dead.slice(0, 4).map((r) => q(r, 60)).join(" · "));
    for (const r of allow) for (const [re, why, sev] of RISKY) if (re.test(r)) add(sev, "Permissions", `perm-risky:${l.file}:${r}`, `${q(r)} is auto-approved in ${l.name}: ${why}`);
    // contradictions: allowed here, denied by the same scope or by the user layer
    const denies = [...(U.permissions?.deny || []), ...layers.filter((o) => o.root && o.root === l.root).flatMap((o) => o.data?.permissions?.deny || [])];
    const contra = allow.filter((a) => denies.some((d) => a === d || (!d.includes("(") && d.startsWith("mcp__") && a.startsWith(`${d}__`))));
    if (contra.length) add("LOW", "Permissions", `perm-contra:${l.file}`, `${contra.length} allow rule(s) in ${l.name} are also denied, so they do nothing (deny wins)`, contra.slice(0, 4).map((r) => q(r, 70)).join(" · "));
    const legacy = [...allow, ...deny].filter((r) => /:\*\)$/.test(r)).length;
    if (legacy) notes.push(`${l.name}: ${legacy} rule(s) use the legacy \`:*\` prefix syntax (still honoured).`);
  }
  // the same rule repeated in a project's settings.json and its settings.local.json
  for (const root of new Set(layers.filter((l) => l.root).map((l) => l.root))) {
    const proj = layers.find((l) => l.root === root && l.kind === "project")?.data?.permissions;
    const loc = layers.find((l) => l.root === root && l.kind === "local")?.data?.permissions;
    if (!proj || !loc) continue;
    const both = [...(loc.allow || []), ...(loc.deny || [])].filter((r) => (proj.allow || []).includes(r) || (proj.deny || []).includes(r));
    if (both.length) add("INFO", "Permissions", `perm-redundant-local:${root}`, `${both.length} rule(s) in ${label(root)} local settings repeat the project settings`, both.slice(0, 3).map((r) => q(r, 60)).join(" · "));
  }
  if (U.autoMode?.classifyAllShell !== true) notes.push("Auto mode: shell allow rules skip the classifier (autoMode.classifyAllShell is off), so every Bash/PowerShell allow rule above is a true bypass.");
});

// ------------------------------------------------------------------------------------ 5. auto mode
section("Auto mode", () => {
  const am = U.autoMode;
  if (!am) { notes.push("No autoMode block in user settings."); return; }
  for (const sec of ["allow", "soft_deny", "hard_deny", "environment"]) {
    const list = am[sec];
    if (Array.isArray(list) && list.length && !list.includes("$defaults")) add("MEDIUM", "Auto mode", `automode-no-defaults:${sec}`, `autoMode.${sec} has no "$defaults" entry, so Claude Code's built-in ${sec} rules are dropped`);
  }
  const grants = (am.allow || []).filter((g) => g !== "$defaults");
  const bytes = Buffer.byteLength(grants.join(""));
  notes.push(`Auto mode grants: ${grants.length} custom allow entr${grants.length === 1 ? "y" : "ies"}, ${size(bytes)} of text the classifier reads on every judged action.`);
  if (bytes > 12000) add("LOW", "Auto mode", "automode-size", `The auto-mode grant text is ${size(bytes)} — long grants are slower and easier to contradict`);
  // A grant that names a date older than a newer contradicting CLAUDE.md rule cannot be judged by a
  // script — the weekly Claude run does that semantic pass. Here: surface the grants' dates.
  const dated = grants.map((g) => (g.match(/20\d\d-\d\d-\d\d/g) || []).sort().pop()).filter(Boolean).sort();
  if (dated.length) notes.push(`Newest date named in an auto-mode grant: ${dated.pop()}.`);
});

// ------------------------------------------------------------------ 5b. rule texts that contradict CLAUDE.md
// Known owner rules, checked mechanically so a restored old text shows up. The weekly Claude pass does the
// open-ended version of this; these are the contradictions already found once.
function HOOK_TEXT_RAW() {
  return [
    ...layers.flatMap((l) => Object.values(l.data?.hooks || {}).flatMap((gs) => (Array.isArray(gs) ? gs : []).flatMap((g) => (g.hooks || []).map((h) => [h.command, ...(h.args || [])].join(" "))))),
    // Since 2026-10-08 the TASK RULES words live in a file task-rules-reminder.mjs sends, not in an echo.
    readText(`${CLAUDE}/hooks/task-rules.txt`) || "",
  ];
}
section("Rule texts", () => {
  const claudeMd = readText(`${CLAUDE}/CLAUDE.md`) || "";
  const autoPR = /Commit, push and open the PR automatically/i.test(claudeMd); // owner rule 2026-09-16
  const noPlaceholders = /Never put a placeholder like/i.test(claudeMd); // owner rule 2026-09-17
  if (autoPR) {
    // judged per SENTENCE: the aligned grant (17 Sept) keeps "force-pushing ... still require approval" in a sentence with no PR in it
    const grant = (U.autoMode?.allow || []).find((g) => g.split(/(?<=\.)\s+/).some((s) => /require[sd]?\s+approval/i.test(s) && /PR creation|pull request|\bPR\b/.test(s) && /\bpush/i.test(s) && !/pre-?authori[sz]ed|^So are/i.test(s)));
    if (grant) add("MEDIUM", "Rule texts", "automode-push-pr-approval", "An auto-mode grant still says pushing and opening a PR need approval, but CLAUDE.md (owner rule, 16 Sept) makes them automatic — the classifier can stop a push the owner pre-approved", q(grant, 160));
    const echo = HOOK_TEXT_RAW().find((c) => /TASK RULES/.test(c) && /approval \((?:[^)]*\b)?commit\b/i.test(c));
    if (echo) add("MEDIUM", "Rule texts", "task-rules-commit-approval", "The TASK RULES text injected on every prompt still lists commit and PR as approvals the owner must give (CLAUDE.md, 16 Sept: they are automatic)");
    const ns = readText(`${CLAUDE}/skills/next-step/SKILL.md`) || "";
    if (/an approval \(commit, PR/i.test(ns) || /“commit and open the PR”/.test(ns)) add("LOW", "Rule texts", "next-step-commit-approval", "The next-step skill still offers commit and PR as approvals / suggestions (CLAUDE.md, 16 Sept: they are automatic)");
  }
  if (noPlaceholders) {
    for (const f of [`${CLAUDE}/hooks/suggestion-context.mjs`, `${CLAUDE}/skills/next-step/SKILL.md`]) {
      const t = readText(f) || "";
      const hits = [...new Set(t.match(/(?:“|")[^"”\n]{0,40}<(?:thing|PR number|name|x)>[^"”\n]{0,40}(?:”|")|(?:fix the|merge) <(?:thing|PR number)>/g) || [])];
      if (hits.length) add("LOW", "Rule texts", `placeholder-suggestions:${f}`, `${f} still models suggestions with placeholders, which CLAUDE.md (17 Sept) bans because the ghost text echoes them verbatim`, hits.slice(0, 3).map((h) => q(h, 60)).join(" · "));
    }
  }
});

// ------------------------------------------------------------------------------------------ 6. hooks
function scriptRefs(command, root) {
  const refs = [];
  const re = /(?:^|[\s;&|(])(?:node|node\.exe)\s+(?:--[\w-]+(?:=\S+)?\s+)*(?:"([^"]+?\.(?:mjs|cjs|js))"|'([^']+?\.(?:mjs|cjs|js))'|([^\s"';|&]+?\.(?:mjs|cjs|js)))(?=[\s"';|&)]|$)/g;
  let m;
  while ((m = re.exec(command))) {
    let p = fwd(m[1] || m[2] || m[3]).replace(/^(~|\$\{?HOME\}?|%USERPROFILE%)\//i, `${HOME}/`);
    if (/\$\{?(DIR|CLAUDE_PROJECT_DIR)\}?/.test(p)) { if (!root) continue; p = p.replace(/\$\{?(DIR|CLAUDE_PROJECT_DIR)\}?/g, root); }
    if (p.includes("$")) continue;
    if (!/^[A-Za-z]:\//.test(p)) { if (!root) continue; p = `${root}/${p}`; }
    refs.push(p);
  }
  return refs;
}
const HOOK_TEXT = [];
section("Hooks", () => {
  const referenced = new Set(); // full script paths, lower-case
  const viaBash = new Set();
  let perPrompt = 0, perStart = 0;
  let shellHooksUser = 0, shellHooksProject = 0;
  for (const l of layers) {
    const hooks = l.data?.hooks;
    if (!hooks) continue;
    for (const [ev, groups] of Object.entries(hooks)) {
      if (ev.startsWith("$")) continue;
      for (const g of Array.isArray(groups) ? groups : []) {
        let matcherRe = null;
        try { matcherRe = g.matcher ? new RegExp(`^(?:${g.matcher})$`) : null; } catch { add("MEDIUM", "Hooks", `hook-bad-matcher:${l.file}:${ev}:${g.matcher}`, `hooks.${ev} matcher ${q(g.matcher)} in ${l.name} is not a valid pattern`); }
        for (const h of g.hooks || []) {
          if (h.type !== "command") continue;
          const cmd = [h.command, ...(h.args || [])].join(" ");
          HOOK_TEXT.push(cmd);
          if (ev === "PreToolUse" && (!g.matcher || matcherRe?.test("Bash"))) { if (l.kind === "user") shellHooksUser++; else if (l.root?.toLowerCase() === PHOENIX.toLowerCase()) shellHooksProject++; }
          const refs = scriptRefs(cmd, l.root);
          for (const ref of refs) {
            referenced.add(ref.toLowerCase());
            if (!exists(ref)) add("HIGH", "Hooks", `hook-missing:${l.file}:${ev}:${ref}`, `${ev} hook in ${l.name} runs ${q(ref)}, which does not exist${/\|\|\s*true/.test(cmd) ? " — and the command swallows the failure, so the guard is silently OFF" : ""}`);
          }
          if (refs.length && !h.args && /^node\s/.test(h.command || "") && !/[;&|$`]/.test(h.command) && (l.kind === "user" || l.root?.toLowerCase() === PHOENIX.toLowerCase())) viaBash.add(path.basename(refs[0]));
          if (!refs.length && /\b(echo|printf|cat)\b/.test(h.command || "")) {
            if (ev === "UserPromptSubmit") perPrompt += Buffer.byteLength(h.command || ""); else if (ev === "SessionStart") perStart += Buffer.byteLength(h.command || "");
          }
        }
      }
    }
    if (l.data?.statusLine?.command) {
      const refs = scriptRefs(l.data.statusLine.command, l.root);
      for (const ref of refs) { referenced.add(ref.toLowerCase()); if (!exists(ref)) add("MEDIUM", "Hooks", `statusline-missing:${ref}`, `The status line runs ${q(ref)}, which does not exist`); }
    }
  }
  notes.push(`Every shell command starts ${shellHooksUser} user-level and ${shellHooksProject} Phoenix PreToolUse hook process(es) before it runs.`);
  if (viaBash.size) notes.push(`${viaBash.size} hooks start node through bash; the exec form ("command": "node", "args": [...]) would save ~60 ms per run each: ${[...viaBash].join(", ")}.`);
  if (perPrompt) notes.push(`Fixed hook text added to EVERY prompt: ${size(perPrompt)} (inline echo in UserPromptSubmit).`);
  if (perStart) notes.push(`Fixed hook text added at every session start: ${size(perStart)} (inline echo in SessionStart).`);
  // hook files nobody registers — a file imported or run by another hook, script, skill or task is in use
  const codeFiles = [
    ...[`${CLAUDE}/hooks`, `${PHOENIX}/.claude/hooks`, `${CLAUDE}/scripts`, `${PHOENIX}/scripts`].flatMap((d) => listDir(d).filter((f) => /\.(mjs|cjs|js|ps1|sh|cmd|vbs)$/i.test(f)).map((f) => `${d}/${f}`)),
    ...walk(`${CLAUDE}/skills`, { maxDepth: 3 }).filter((f) => f.name === "SKILL.md").map((f) => f.path),
    ...walk(`${PHOENIX}/.claude/skills`, { maxDepth: 3 }).filter((f) => f.name === "SKILL.md").map((f) => f.path),
    ...listDir(`${CLAUDE}/scheduled-tasks`).map((t) => `${CLAUDE}/scheduled-tasks/${t}/SKILL.md`),
  ];
  const codeText = new Map(codeFiles.map((p) => [p, (readText(p) || "").split("\\\\").join("/").split("\\").join("/")]));
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const [dir, kind] of [[`${CLAUDE}/hooks`, "user"], [`${PHOENIX}/.claude/hooks`, "project"]]) {
    for (const f of listDir(dir).filter((n) => /\.(mjs|cjs|js|ps1|sh)$/i.test(n))) {
      const full = `${dir}/${f}`;
      if (referenced.has(full.toLowerCase())) continue;
      // In use = imported from its own folder, or named WITH THIS FOLDER'S PATH by another hook, script,
      // skill or task. A same-named file in the other hooks folder does not count (that hid a dead copy).
      const qualified = kind === "user"
        ? new RegExp(`(?:~|/users/[^/"'\\s]+|\\$\\{?home\\}?|%userprofile%|\\$env:userprofile)/\\.claude/hooks/${esc(f)}`, "i")
        : new RegExp(`(?:phoenix-workforce/|\\$\\{?claude_project_dir\\}?/|(?:^|[\\s"'(=\`])\\.?/?)\\.claude/hooks/${esc(f)}`, "i");
      const sibling = new RegExp(`["'\`/]${esc(f)}["'\`]|\\./${esc(f.replace(/\.(mjs|cjs|js)$/i, ""))}\\b`);
      const usedBy = [...codeText].find(([p, t]) => p.toLowerCase() !== full.toLowerCase() && ((path.dirname(p).toLowerCase() === dir.toLowerCase() && sibling.test(t)) || qualified.test(t)));
      if (usedBy || HOOK_TEXT.some((c) => qualified.test(c.split("\\").join("/")))) continue;
      add("LOW", "Hooks", `hook-unregistered:${full}`, `${full} is not registered by any settings file, and no hook, script, skill or task uses it`, "Dead copy — move it into ~/.claude/backups/ or register it.");
    }
    const baks = listDir(dir).filter((f) => /\.bak/i.test(f));
    if (baks.length) add("INFO", "Hooks", `hook-baks:${dir}`, `${baks.length} backup file(s) sit inside ${dir}`, baks.slice(0, 4).join(", "));
  }
  // logs written next to hooks that nothing rotates
  for (const f of [`${PHOENIX}/.claude/worktree-exit.log`, ...listDir(CLAUDE).filter((n) => /\.log$/i.test(n)).map((n) => `${CLAUDE}/${n}`)]) {
    const s = statOf(f);
    if (s && s.size > 512 * 1024) add("LOW", "Hooks", `log-growth:${f}`, `${f} has grown to ${size(s.size)} and nothing rotates it`);
  }
  // worktrees serve their OWN branch's hooks
  const primaryHash = sha1(readText(`${PHOENIX}/.claude/settings.json`) || "");
  const wts = [...listDir(`${PHOENIX}/.claude/worktrees`).map((n) => `${PHOENIX}/.claude/worktrees/${n}`), ...listDir("F:/Phoenix Workforce").filter((n) => n.startsWith("_wt-")).map((n) => `F:/Phoenix Workforce/${n}`)].filter((p) => exists(`${p}/.claude/settings.json`));
  const stale = wts.filter((p) => sha1(readText(`${p}/.claude/settings.json`) || "") !== primaryHash);
  if (stale.length) add("INFO", "Hooks", `worktrees-differ:${stale.length}`, `${stale.length} of ${wts.length} Phoenix worktrees carry a different .claude/settings.json than the primary (their branch's copy — hooks and rules differ there)`, stale.slice(0, 4).map((p) => path.basename(p)).join(", "));
  // guard hooks a worktree runs from its OWN branch: flag the ones that differ from origin/main
  const guards = ["bash-guard.mjs", "autorun-guard.mjs", "trap-injector.mjs", "session-lock.mjs"];
  let mainGuards = {};
  try { for (const g of guards) mainGuards[g] = sha1(execFileSync("git", ["-C", PHOENIX, "show", `origin/main:.claude/hooks/${g}`], { encoding: "utf8", windowsHide: true, timeout: 20000, stdio: ["ignore", "pipe", "ignore"] })); } catch { mainGuards = null; }
  if (mainGuards) {
    const old = [];
    for (const wt of [PHOENIX, ...wts]) {
      const differ = guards.filter((g) => { const t = readText(`${wt}/.claude/hooks/${g}`); return t !== null && sha1(t.replace(/\r\n/g, "\n")) !== mainGuards[g] && sha1(t) !== mainGuards[g]; });
      if (differ.length) old.push(`${path.basename(wt)}: ${differ.join(", ")}`);
    }
    if (old.length) add("LOW", "Hooks", `stale-guards:${sha1(old.join("|"))}`, `${old.length} Phoenix folder(s) run guard hooks that differ from main (an older copy, or a change not merged yet) — a session there is guarded by that copy`, old.slice(0, 5).join(" · "));
  }
  // AUTORUN armings left on disk: resuming that session pre-approves merges and production migrations
  // Stale = the armed session has written nothing for 24 hours (or, with no transcript found, armed over 48 hours ago).
  const armings = [];
  const lastWrite = (session) => Math.max(0, ...listDir(`${CLAUDE}/projects`).map((slug) => statOf(`${CLAUDE}/projects/${slug}/${session}.jsonl`)?.mtimeMs || 0));
  for (const wt of [PHOENIX, ...wts]) for (const f of listDir(`${wt}/.claude/.autorun`).filter((n) => n.endsWith(".json"))) {
    const session = f.replace(/\.json$/, "");
    const at = Date.parse(loadJson(`${wt}/.claude/.autorun/${f}`).data?.armedAt || "");
    const seen = lastWrite(session);
    const stale = seen ? Date.now() - seen > 24 * 3600e3 : Number.isFinite(at) && Date.now() - at > 48 * 3600e3;
    if (stale) armings.push({ folder: path.basename(wt), session, at, seen });
  }
  if (armings.length) add("MEDIUM", "Hooks", `stale-autorun:${[...new Set(armings.map((a) => a.session))].sort().join(",")}`, `${armings.length} AUTORUN arming file(s) belong to a session that has been idle for over a day — resuming it would pre-approve merges and production migrations again`, [...new Set(armings.map((a) => `session ${a.session.slice(0, 8)} armed ${Number.isFinite(a.at) ? cairo(a.at) : "?"}, last active ${a.seen ? cairo(a.seen) : "unknown"}`))].join(" · ") + ` — in ${armings.map((a) => a.folder).join(", ")}`);
  // relay folders: relay-capture.mjs prunes them (advice/runmode/batons past 14 days, state past 30) at most every 6 h,
  // and stamps relay/.last-prune when it does (since 2026-09-17)
  const relayCounts = ["advice", "runmode", "batons"].map((d) => [d, listDir(`${CLAUDE}/relay/${d}`).length]);
  let lastPrune = null;
  try { lastPrune = fs.statSync(`${CLAUDE}/relay/.last-prune`).mtimeMs; } catch {}
  if (relayCounts.some(([, n]) => n > 1000)) add("INFO", "Hooks", `relay-growth:${relayCounts.map(([, n]) => Math.floor(n / 1000)).join("-")}`, `Relay hook folders hold over 1,000 files: ${relayCounts.map(([d, n]) => `${d} ${n}`).join(", ")}${lastPrune ? ` (last prune ${cairo(lastPrune)})` : " (never pruned)"}`);
  notes.push(`Relay hook folders: ${relayCounts.map(([d, n]) => `${d} ${n} files`).join(", ")} (${lastPrune ? `pruned past 14 days; last prune ${cairo(lastPrune)}` : "never pruned"}).`);
});

// ------------------------------------------------------------------------------------------ 7. MCP
const looksSecret = (v) => /^(sk-|sbp_|gh[pousr]_|github_pat_|eyJ|xox[baprs]-|AKIA|AIza|re_[A-Za-z0-9]{8}_)/.test(v) || (/^Bearer\s+[A-Za-z0-9._-]{16,}$/.test(v));
section("MCP servers", () => {
  const servers = [];
  const push = (scope, name, cfg, root = null) => servers.push({ scope, name, cfg: cfg || {}, root });
  for (const [n, c] of Object.entries(claudeJson.data?.mcpServers || {})) push("user (~/.claude.json)", n, c);
  for (const [p, v] of Object.entries(claudeJson.data?.projects || {})) for (const [n, c] of Object.entries(v.mcpServers || {})) push(`local to ${norm(p)}`, n, c, norm(p));
  for (const root of roots.values()) { const m = loadJson(`${root}/.mcp.json`); for (const [n, c] of Object.entries(m.data?.mcpServers || {})) push(`${label(root)} .mcp.json`, n, c, root); if (m.error) add("HIGH", "MCP servers", `mcpjson-broken:${root}`, `${root}/.mcp.json is not valid JSON`, m.error); }
  const desk = loadJson(`${APPDATA}/Claude/claude_desktop_config.json`);
  for (const [n, c] of Object.entries(desk.data?.mcpServers || {})) push("desktop chat app", n, c);
  const settingsEnv = new Set(layers.flatMap((l) => Object.keys(l.data?.env || {}).map((k) => k.toUpperCase())));
  for (const s of servers) {
    const { cfg } = s;
    const where = `${s.name} (${s.scope})`;
    const vals = [...Object.entries(cfg.env || {}), ...Object.entries(cfg.headers || {}), ...(cfg.args || []).map((a, i) => [`args[${i}]`, a])];
    for (const [k, v] of vals) {
      if (typeof v !== "string") continue;
      for (const ref of v.matchAll(/\$\{([A-Za-z0-9_]+)(?::-[^}]*)?\}/g)) {
        if (!USER_ENV.has(ref[1].toUpperCase()) && !settingsEnv.has(ref[1].toUpperCase()) && !(ref[1] in process.env) && !/:-/.test(ref[0])) add("MEDIUM", "MCP servers", `mcp-env-missing:${where}:${ref[1]}`, `MCP server ${q(where)} needs \${${ref[1]}}, which is set neither in the Windows environment nor in any settings env block — it cannot authenticate`);
      }
      if (!v.includes("${") && looksSecret(v)) add("HIGH", "MCP servers", `mcp-hardcoded:${where}:${k}`, `MCP server ${q(where)} has a credential written in plain text in ${q(k)} (${v.length} chars)`, "Move it to a Windows user environment variable and reference it as ${NAME}.");
    }
    if (cfg.command) {
      const cmdPath = fwd(cfg.command);
      if (/^[A-Za-z]:\//.test(cmdPath) && !exists(cmdPath)) add("MEDIUM", "MCP servers", `mcp-cmd-missing:${where}`, `MCP server ${q(where)} starts ${q(cmdPath)}, which does not exist`);
      for (const a of cfg.args || []) {
        const ap = fwd(a);
        if (/\.(mjs|cjs|js|py|ps1)$/i.test(ap) && !ap.startsWith("-")) {
          const abs = /^[A-Za-z]:\//.test(ap) ? ap : s.root ? `${s.root}/${ap}` : null;
          if (abs && s.root && !exists(s.root)) continue;
          if (abs && !exists(abs)) add("MEDIUM", "MCP servers", `mcp-script-missing:${where}:${ap}`, `MCP server ${q(where)} runs ${q(ap)}, which does not exist`);
        }
      }
      // a package fetched at start-up with no version pin, handed a credential: a bad publish runs with that token
      const argv0 = [cfg.command, ...(cfg.args || [])].map(String);
      const at = argv0.findIndex((a) => /(^|[\\/])(npx|bunx|pnpx|uvx)(\.cmd|\.exe)?$/i.test(a) || a === "dlx");
      if (at >= 0) {
        const pkg = argv0.slice(at + 1).find((a) => !a.startsWith("-") && !/^\/[a-z]$/i.test(a));
        const pinned = pkg && /^(@[^/@]+\/)?[^@]+@\d/.test(pkg);
        const cred = Object.keys(cfg.env || {}).some((k) => /TOKEN|KEY|SECRET|PASSWORD|PAT\b/i.test(k)) || Object.keys(cfg.headers || {}).some((k) => /authorization|token|key/i.test(k)) || argv0.some((a) => /--(access-token|api-key|token|password)\b/i.test(a));
        if (pkg && !pinned && cred) add("MEDIUM", "MCP servers", `mcp-unpinned-cred:${where}`, `MCP server ${q(where)} downloads ${q(pkg, 60)} unpinned at every start-up and hands it a credential`, "Pin an exact version (package@x.y.z) so a bad publish of that package cannot run with the token.");
      }
    }
  }
  // .mcp.json servers that no layer enables or disables are prompted for at session start
  const enabled = new Set(layers.flatMap((l) => l.data?.enabledMcpjsonServers || []));
  const disabled = new Set(layers.flatMap((l) => l.data?.disabledMcpjsonServers || []));
  const enableAll = layers.some((l) => l.data?.enableAllProjectMcpServers === true);
  for (const s of servers.filter((x) => x.scope.endsWith(".mcp.json"))) if (!enableAll && !enabled.has(s.name) && !disabled.has(s.name)) add("LOW", "MCP servers", `mcpjson-undecided:${s.name}`, `.mcp.json server ${q(s.name)} (${s.scope}) is neither enabled nor disabled in any settings file`);
  const needsAuth = loadJson(`${CLAUDE}/mcp-needs-auth-cache.json`).data || {};
  const na = Object.keys(needsAuth);
  if (na.length) add("INFO", "MCP servers", `mcp-needs-auth:${na.sort().join(",")}`, `${na.length} MCP server(s) are waiting for sign-in and fail at every session start: ${na.join(", ")}`, "Sign in once, or disable the plugin/connector that brings them.");
  notes.push(`MCP servers configured: ${servers.length} (${[...new Set(servers.map((s) => s.scope))].map((sc) => `${servers.filter((s) => s.scope === sc).length} ${sc}`).join("; ")}).`);
  SNAP.mcp = Object.fromEntries(servers.map((s) => [`${s.scope} :: ${s.name}`, [s.cfg.type || (s.cfg.command ? "stdio" : "?"), s.cfg.url || [s.cfg.command, ...(s.cfg.args || [])].join(" ")].join(" ")]));
});

// ---------------------------------------------------------------------- 8. skills, agents, plugins
function frontmatter(text) {
  const m = (text || "").match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return null;
  const fm = {};
  let last = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) { last = kv[1]; fm[last] = kv[2].replace(/^(["'])(.*)\1$/, "$2"); }
    else if (last && /^\s+\S/.test(line)) fm[last] = `${fm[last]} ${line.trim()}`.trim();
  }
  return fm;
}
section("Skills and agents", () => {
  const skillSets = [["user", `${CLAUDE}/skills`], ["Phoenix project", `${PHOENIX}/.claude/skills`]];
  const byName = new Map();
  let listingBytes = 0;
  SNAP.skills = {};
  for (const [level, dir] of skillSets) {
    for (const folder of listDir(dir)) {
      const file = `${dir}/${folder}/SKILL.md`;
      const text = readText(file);
      if (text === null) continue;
      const fm = frontmatter(text);
      if (!fm) { add("MEDIUM", "Skills and agents", `skill-no-frontmatter:${file}`, `${level} skill ${q(folder)} has no frontmatter, so it never loads`); continue; }
      if (!fm.description) add("MEDIUM", "Skills and agents", `skill-no-description:${file}`, `${level} skill ${q(folder)} has no description, so the model never picks it`);
      const name = fm.name || folder;
      if (fm.name && fm.name !== folder) add("LOW", "Skills and agents", `skill-name-mismatch:${file}`, `${level} skill folder ${q(folder)} declares name ${q(fm.name)}`);
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push({ level, file, hash: sha1(text) });
      const hidden = /^true$/i.test(fm["disable-model-invocation"] || "");
      if (!hidden) listingBytes += Buffer.byteLength(`${name}${fm.description || ""}`);
      SNAP.skills[`${level}:${name}`] = sha1(text);
      const baks = walk(`${dir}/${folder}`, { maxDepth: 3 }).filter((f) => /\.bak/i.test(f.name));
      if (baks.length) add("INFO", "Skills and agents", `skill-baks:${dir}/${folder}`, `${baks.length} backup file(s) inside ${level} skill ${q(folder)}`);
    }
  }
  for (const [name, copies] of byName) {
    if (copies.length < 2) continue;
    const same = new Set(copies.map((c) => c.hash)).size === 1;
    // Claude Code runs the PERSONAL copy when a personal and a project skill share a name (docs: "Resolve skills that share a name")
    add(same ? "INFO" : "MEDIUM", "Skills and agents", `skill-dup:${name}:${same ? "same" : copies.map((c) => c.hash).join("-")}`, same ? `Skill ${q(name)} exists at user and Phoenix level as identical copies` : `Skill ${q(name)} differs between the user and Phoenix copies, and the USER copy is the one that loads — the Phoenix copy's text never reaches a session on this machine`, copies.map((c) => c.file).join(" · "));
  }
  // the same skill also uploaded to claude.ai (listed a second time as anthropic-skills:<name>)
  const cloud = walk(`${APPDATA}/Claude/local-agent-mode-sessions/skills-plugin`, { maxDepth: 6 }).filter((f) => f.name === "SKILL.md");
  const cloudByName = new Map();
  for (const f of cloud) { const n = frontmatter(readText(f.path))?.name; if (n) { if (!cloudByName.has(n)) cloudByName.set(n, new Set()); cloudByName.get(n).add(sha1(readText(f.path))); } }
  for (const [name, copies] of byName) {
    const c = cloudByName.get(name);
    if (!c) continue;
    const local = copies.find((x) => x.level === "user") || copies[0];
    const differs = !c.has(local.hash);
    add(differs ? "LOW" : "INFO", "Skills and agents", `skill-cloud-dup:${name}:${differs ? "differs" : "same"}`, `Skill ${q(name)} is listed twice — the local copy and anthropic-skills:${name} from claude.ai${differs ? ", and the two texts differ, so a session may follow either" : " (identical)"}`, "Only the owner can remove or re-upload the claude.ai copy.");
  }
  // skill overrides: plugin-namespaced keys are ignored by Claude Code (verified in 2.1.271 source)
  for (const l of layers) {
    for (const [k, v] of Object.entries(l.data?.skillOverrides || {})) {
      if (k.includes(":")) add("LOW", "Skills and agents", `override-plugin:${l.file}:${k}`, `skillOverrides ${q(`${k}: ${v}`)} in ${l.name} has no effect — Claude Code always lists plugin skills`, "Only disabling the plugin (or the claude.ai skill) hides it.");
      else if (!byName.has(k)) add("INFO", "Skills and agents", `override-stale:${l.file}:${k}`, `skillOverrides names ${q(k)} in ${l.name}, which is not a user or Phoenix skill (fine if it is a built-in one)`);
    }
  }
  SNAP.agents = {};
  const MODEL_OK = /^(sonnet|opus|haiku|fable|inherit|default|claude-[a-z0-9.-]+)$/i;
  for (const [level, dir] of [["user", `${CLAUDE}/agents`], ["Phoenix project", `${PHOENIX}/.claude/agents`]]) {
    for (const f of listDir(dir).filter((n) => n.endsWith(".md"))) {
      const text = readText(`${dir}/${f}`);
      const fm = frontmatter(text);
      if (!fm?.name || !fm?.description) { add("MEDIUM", "Skills and agents", `agent-bad:${dir}/${f}`, `${level} subagent ${q(f)} is missing name or description frontmatter, so it never loads`); continue; }
      if (fm.model && !MODEL_OK.test(fm.model)) add("MEDIUM", "Skills and agents", `agent-model:${dir}/${f}`, `${level} subagent ${q(fm.name)} asks for model ${q(fm.model)}, which is not a model alias Claude Code accepts`);
      listingBytes += Buffer.byteLength(`${fm.name}${fm.description}`);
      SNAP.agents[`${level}:${fm.name}`] = sha1(text);
    }
  }
  notes.push(`Skill and subagent descriptions from user and Phoenix folders add ${size(listingBytes)} to every session's listing (plugin and built-in skills come on top).`);
  const installed = loadJson(`${CLAUDE}/plugins/installed_plugins.json`).data;
  const ids = Object.keys(installed?.plugins || {});
  const ep = U.enabledPlugins || {};
  const onButMissing = Object.entries(ep).filter(([id, v]) => v === true && !id.endsWith("@inline") && !ids.includes(id)).map(([id]) => id);
  if (onButMissing.length) add("LOW", "Skills and agents", `plugin-enabled-missing:${onButMissing.join(",")}`, `Plugins enabled in settings but not installed: ${onButMissing.join(", ")}`);
  const brokenInstall = Object.entries(installed?.plugins || {}).filter(([, v]) => [].concat(v).some((e) => e?.installPath && !exists(fwd(e.installPath)))).map(([k]) => k);
  if (brokenInstall.length) add("LOW", "Skills and agents", `plugin-installpath-missing:${brokenInstall.join(",")}`, `installed_plugins.json points ${brokenInstall.join(", ")} at a folder that no longer exists`, "Uninstall it, or reinstall it if it is wanted.");
  // desktop-provided plugins (name@inline) are ON unless enabledPlugins says false; their MCP servers show up as plugin:<name>:<server>
  const needsAuthPlugins = [...new Set(Object.keys(loadJson(`${CLAUDE}/mcp-needs-auth-cache.json`).data || {}).map((k) => k.match(/^plugin:([^:]+):/)?.[1]).filter(Boolean))];
  const silentOn = needsAuthPlugins.filter((p) => !Object.keys(ep).some((id) => id.startsWith(`${p}@`)));
  if (silentOn.length) add("LOW", "Skills and agents", `plugin-default-on:${silentOn.sort().join(",")}`, `Plugin(s) ${silentOn.join(", ")} are on by default (not named in enabledPlugins) and their MCP servers wait for a sign-in at every session start`, `Add "<name>@inline": false to enabledPlugins in ~/.claude/settings.json to turn one off.`);
  SNAP.plugins = { installed: ids.sort(), enabled: Object.entries(ep).filter(([, v]) => v).map(([k]) => k).sort() };
  for (const d of ["commands", "output-styles", "rules"]) for (const base of [CLAUDE, `${PHOENIX}/.claude`]) if (exists(`${base}/${d}`)) notes.push(`${base}/${d} exists (${listDir(`${base}/${d}`).length} entries).`);
});

// ------------------------------------------------------------------------------------------ 9. memory
section("Memory", () => {
  for (const slug of listDir(`${CLAUDE}/projects`)) {
    const mem = `${CLAUDE}/projects/${slug}/memory`;
    const idx = readText(`${mem}/MEMORY.md`);
    const files = listDir(mem).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
    if (idx === null && !files.length) continue;
    const bytes = Buffer.byteLength(idx || "");
    const who = slug === "F--Phoenix-Workforce-phoenix-workforce" ? "Phoenix memory index" : `memory index ${q(slug, 60)}`;
    if (idx === null) add("LOW", "Memory", `memory-no-index:${slug}`, `${files.length} memory file(s) under ${q(slug, 60)} have no MEMORY.md, so no session is told they exist`);
    if (bytes > LOADER_CLIFF) add("HIGH", "Memory", `memory-cliff:${slug}`, `${who} is ${bytes.toLocaleString("en-US")} bytes — past the ${LOADER_CLIFF.toLocaleString("en-US")}-byte loader cliff, so its tail is silently cut off every session`);
    else if (slug === "F--Phoenix-Workforce-phoenix-workforce" && bytes > INDEX_BUDGET) add("MEDIUM", "Memory", `memory-budget:${slug}`, `${who} is ${bytes.toLocaleString("en-US")} bytes, over its ${INDEX_BUDGET.toLocaleString("en-US")}-byte budget`);
    const links = [...(idx || "").matchAll(/\]\(([^)\s]+?\.md)\)/g)].map((m) => decodeURIComponent(m[1]));
    const broken = [...new Set(links.filter((l) => !/^https?:/.test(l) && !exists(`${mem}/${l}`)))];
    if (broken.length) add("MEDIUM", "Memory", `memory-broken:${slug}:${broken.length}`, `${who} links to ${broken.length} memory file(s) that do not exist`, broken.slice(0, 4).join(", "));
    // (orphaned memory files are the repo's own check: node scripts/memory-index-reachability.mjs)
    let badFm = 0;
    for (const f of files) {
      if (f === "MEMORY-ARCHIVE.md") continue;
      const fm = readText(`${mem}/${f}`)?.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/)?.[1] || "";
      if (!/^name:\s*\S/m.test(fm) || !/^description:\s*\S/m.test(fm) || !/^\s*type:\s*(user|feedback|project|reference)\s*$/m.test(fm)) badFm++;
    }
    if (badFm) add("LOW", "Memory", `memory-frontmatter:${slug}`, `${badFm} memory file(s) in ${who.replace(" index", "")} lack name, description or a valid type — recall reads the description`);
    ok("Memory", `${who}: ${bytes.toLocaleString("en-US")} bytes, ${files.length} files`);
    SNAP.memory = SNAP.memory || {};
    SNAP.memory[slug] = { bytes, files: files.length };
  }
  // context footprint of a Phoenix session, per request
  const parts = [
    ["user CLAUDE.md", statOf(`${CLAUDE}/CLAUDE.md`)?.size || 0],
    ["Phoenix CLAUDE.md", statOf(`${PHOENIX}/CLAUDE.md`)?.size || 0],
    ["AGENTS.md", statOf(`${PHOENIX}/AGENTS.md`)?.size || 0],
    ["MEMORY.md", Math.min(statOf(`${CLAUDE}/projects/F--Phoenix-Workforce-phoenix-workforce/memory/MEMORY.md`)?.size || 0, LOADER_CLIFF)],
  ];
  const total = parts.reduce((a, [, b]) => a + b, 0);
  notes.push(`A Phoenix session carries ${size(total)} of instructions on every request (${parts.map(([n, b]) => `${n} ${size(b)}`).join(" + ")}), before hook text.`);
  SNAP.footprint = Object.fromEntries(parts);
});

// ------------------------------------------------------------------------------ 10. ~/.claude.json
section("~/.claude.json", () => {
  if (claudeJson.error) { add("HIGH", "~/.claude.json", "claudejson-broken", "~/.claude.json is not valid JSON", claudeJson.error); return; }
  const projects = claudeJson.data?.projects || {};
  const keys = Object.keys(projects);
  const gone = keys.filter((p) => !exists(norm(p)));
  if (gone.length >= 10) add("LOW", "~/.claude.json", `claudejson-gone:${Math.floor(gone.length / 10) * 10}`, `${gone.length} of ${keys.length} project entries in ~/.claude.json point at folders that no longer exist`, "Every running session rewrites this file; prune it only when no session is open.");
  const seen = new Map(), dup = [];
  for (const k of keys) { const n = norm(k).toLowerCase(); if (seen.has(n)) dup.push(`${seen.get(n)} = ${k}`); else seen.set(n, k); }
  if (dup.length) add("INFO", "~/.claude.json", `claudejson-dupkeys:${dup.length}`, `${dup.length} project(s) appear twice in ~/.claude.json under different slash styles, each with its own settings`, dup.slice(0, 3).map((d) => q(d, 100)).join(" · "));
  const baks = listDir(HOME).filter((f) => /^\.claude\.json\./.test(f));
  const bakBytes = baks.reduce((a, f) => a + (statOf(`${HOME}/${f}`)?.size || 0), 0);
  if (baks.length >= 5) add("INFO", "~/.claude.json", `claudejson-baks:${Math.floor(baks.length / 5) * 5}`, `${baks.length} copies of ~/.claude.json sit in the home folder (${size(bakBytes)})`, baks.join(", "));
  notes.push(`~/.claude.json: ${size(claudeJson.bytes)}, ${keys.length} project entries (${gone.length} for deleted folders).`);
  SNAP.claudeJson = { bytes: claudeJson.bytes, projects: keys.length, gone: gone.length, userMcp: Object.keys(claudeJson.data?.mcpServers || {}) };
});

// ------------------------------------------------------------------------ 11. retention and sprawl
section("Retention", () => {
  const cleanup = U.cleanupPeriodDays;
  const desktopCap = U.desktopSessionCleanupPeriodDays;
  const transcripts = walk(`${CLAUDE}/projects`, { maxDepth: 4, skipDir: (p, n) => n === "memory" }).filter((f) => f.name.endsWith(".jsonl"));
  const tBytes = transcripts.reduce((a, f) => a + f.size, 0);
  const oldest = transcripts.reduce((a, f) => Math.min(a, f.mtimeMs), Date.now());
  const week = transcripts.filter((f) => Date.now() - f.mtimeMs < 7 * 86400000).reduce((a, f) => a + f.size, 0);
  notes.push(`Transcripts: ${transcripts.length} files, ${size(tBytes)}; oldest last written ${cairo(oldest)} (${days(oldest)} days ago); written in the last 7 days ${size(week)}. cleanupPeriodDays=${cleanup ?? "unset (30)"}, desktopSessionCleanupPeriodDays=${desktopCap ?? "unset"}.`);
  if (!desktopCap && tBytes > 8e9) add("LOW", "Retention", `transcripts-size:${Math.floor(tBytes / 2e9) * 2}`, `Session transcripts total ${size(tBytes)} with no desktop retention limit set`, "desktopSessionCleanupPeriodDays in ~/.claude/settings.json caps them.");
  for (const [d, limit] of [["file-history", 500e6], ["shell-snapshots", 200e6], ["relay", 100e6], ["telemetry", 100e6], ["backups", 100e6]]) {
    const b = walk(`${CLAUDE}/${d}`, { maxDepth: 6 }).reduce((a, f) => a + f.size, 0);
    if (b > limit) add("LOW", "Retention", `sprawl:${d}:${Math.floor(b / limit)}`, `~/.claude/${d} has grown to ${size(b)}`);
    SNAP.sizes = SNAP.sizes || {};
    SNAP.sizes[d] = b;
  }
  SNAP.sizes.transcripts = tBytes;
  const settingsBaks = listDir(CLAUDE).filter((f) => /^(settings\.json|CLAUDE\.md)\..*bak|\.bak/.test(f) && /^(settings|CLAUDE)/.test(f));
  if (settingsBaks.length >= 8) add("INFO", "Retention", `settings-baks:${Math.floor(settingsBaks.length / 8) * 8}`, `${settingsBaks.length} backup copies of settings.json / CLAUDE.md sit loose in ~/.claude`, "~/.claude/backups/ exists for them.");
  const scriptBaks = listDir(`${CLAUDE}/scripts`).filter((f) => /\.bak/i.test(f));
  if (scriptBaks.length >= 8) add("INFO", "Retention", `script-baks:${Math.floor(scriptBaks.length / 8) * 8}`, `${scriptBaks.length} backup copies sit loose in ~/.claude/scripts`);
});

// ----------------------------------------------------------------------------------- 12. secrets
const SECRET_PATTERNS = [
  ["Anthropic key", /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ["OpenAI key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g],
  ["Supabase access token", /\bsbp_[a-f0-9]{40}\b/g],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/g],
  ["JWT", /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/g],
  ["Resend key", /\bre_[A-Za-z0-9]{8}_[A-Za-z0-9]{16,}/g],
  ["Postgres URL with password", /postgres(?:ql)?:\/\/[^:\s"'@/]+:[^@\s"'$[<{]{6,}@(?!127\.0\.0\.1|localhost|\[?::1)/g], // the local Supabase stack's default login is not a secret
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/g],
  ["AWS key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["Inline credential", /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|ACCESS_KEY)["']?\s*[=:]\s*["']?([A-Za-z0-9_\-./+=]{20,})/g],
];
section("Secrets", () => {
  const targets = new Set();
  for (const f of listDir(CLAUDE)) if (/^(settings|CLAUDE)/.test(f)) targets.add(`${CLAUDE}/${f}`);
  for (const f of listDir(HOME)) if (/^\.claude\.json/.test(f)) targets.add(`${HOME}/${f}`);
  for (const root of roots.values()) {
    for (const f of listDir(`${root}/.claude`)) if (/^settings/.test(f)) targets.add(`${root}/.claude/${f}`);
    if (exists(`${root}/.mcp.json`)) targets.add(`${root}/.mcp.json`);
  }
  for (const wt of listDir(`${PHOENIX}/.claude/worktrees`)) targets.add(`${PHOENIX}/.claude/worktrees/${wt}/.claude/settings.local.json`);
  for (const base of [PHOENIX, "F:/Phoenix Workforce"]) for (const wt of listDir(base).filter((n) => n.startsWith("_wt-"))) targets.add(`${base}/${wt}/.claude/settings.local.json`);
  // logs included since 17 Sept: the xlsx tripwire log had recorded the production database URL with its password
  for (const dir of [`${CLAUDE}/scripts`, `${CLAUDE}/hooks`]) for (const f of listDir(dir)) if (/\.(mjs|cjs|js|ps1|psm1|cmd|bat|vbs|json|sh|py|reg|ini|log)$|\.bak/i.test(f)) targets.add(`${dir}/${f}`);
  for (const t of listDir(`${CLAUDE}/scheduled-tasks`)) targets.add(`${CLAUDE}/scheduled-tasks/${t}/SKILL.md`);
  targets.add(`${APPDATA}/Claude/claude_desktop_config.json`);
  targets.add(`${APPDATA}/Claude/config.json`);
  const hits = [];
  const distinct = new Set();
  for (const file of targets) {
    const s = statOf(file);
    if (!s || !s.isFile() || s.size > (/\.log$/i.test(file) ? 64e6 : 3e6)) continue;
    const text = readText(file);
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const [kind, re] of SECRET_PATTERNS) {
        re.lastIndex = 0;
        for (const m of line.matchAll(re)) {
          const val = m[1] || m[0];
          if (kind === "Inline credential" && (!/\d/.test(val) || !/[A-Za-z]/.test(val) || /process\.env|os\.environ|getenv|\$env/i.test(line))) continue;
          if (/REDACTED|\*{4,}|x{8,}|<[a-z_ -]+>|your[-_]?password/i.test(val)) continue; // an already-masked value or a placeholder
          const keyName = (line.slice(0, m.index).match(/["']?([A-Za-z0-9_.-]+)["']?\s*[:=]\s*["']?[^"']*$/) || [])[1] || "";
          hits.push({ file, line: i + 1, kind, key: keyName, len: val.length });
          distinct.add(sha1(val));
        }
      }
    });
  }
  if (hits.length) {
    const byFile = new Map();
    for (const h of hits) { if (!byFile.has(h.file)) byFile.set(h.file, []); byFile.get(h.file).push(h); }
    for (const [file, hs] of byFile) add("HIGH", "Secrets", `secret:${file}:${hs.map((h) => `${h.kind}@${h.line}`).join(",")}`, `${hs.length} credential(s) in plain text in ${file}`, hs.slice(0, 5).map((h) => `line ${h.line}: ${h.kind}${h.key ? ` (${h.key})` : ""}, ${h.len} chars`).join(" · "));
    notes.push(`Secret scan: ${hits.length} hit(s), ${distinct.size} distinct value(s), across ${byFile.size} file(s) of ${targets.size} scanned.`);
  } else ok("Secrets", `No credential patterns in ${targets.size} settings, backup, script, hook and task files`);
  const secretEnv = [...USER_ENV].filter((n) => /TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY/.test(n));
  if (secretEnv.length) notes.push(`Windows environment variables holding credentials (inherited by every process, every session): ${secretEnv.join(", ")}.`);
});

// ------------------------------------------------------------------------- 13. scheduled jobs
section("Scheduled jobs", () => {
  const ps = "$ErrorActionPreference='SilentlyContinue'; $ProgressPreference='SilentlyContinue'; Get-ScheduledTask | Where-Object { ($_.Actions | ForEach-Object { \"$($_.Execute) $($_.Arguments)\" }) -match '(claude|\\.mjs|phoenix|watchdog|ram-guard|xlsx)' } | ForEach-Object { $i = $_ | Get-ScheduledTaskInfo; [pscustomobject]@{ name=$_.TaskName; state=\"$($_.State)\"; last=$(if ($i.LastRunTime) { $i.LastRunTime.ToString('o') } else { '' }); result=$i.LastTaskResult } } | ConvertTo-Json -Compress";
  let tasks = [];
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 90000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    tasks = out ? [].concat(JSON.parse(out)) : [];
  } catch (e) { add("INFO", "Scheduled jobs", "tasks-unreadable", "Could not read Windows scheduled tasks", String(e.message).slice(0, 120)); return; }
  const CODES = { 0: "ok", 267009: "running", 267011: "never ran", 2147946720: "skipped — an instance was already running", 3221225786: "killed (Ctrl+C / closed)", 1: "failed (exit 1)", 2147942402: "file not found" };
  const bad = [];
  for (const t of tasks) {
    if (/attendance/i.test(t.name)) continue; // owner decision: the attendance agent dies at logon and loses nothing
    const r = Number(t.result);
    if (t.state === "Disabled") continue;
    if (r !== 0 && r !== 267009 && !(r === 2147946720 && t.state === "Running")) bad.push(`${t.name}: ${CODES[r] || `code ${r}`}${t.last ? `, last run ${cairo(t.last)}` : ""}`);
  }
  // One finding PER task, so accepted.json can settle a single job. A composite id changed every time
  // the bad set changed, which made an accepted key expire silently (measured 2026-09-21).
  if (bad.length) for (const b of [...bad].sort()) { const name = b.split(":")[0]; add("LOW", "Scheduled jobs", `tasks-bad:${name}`, `Scheduled job "${name}" ended badly on its last run`, b.slice(b.indexOf(":") + 1).trim()); }
  else ok("Scheduled jobs", `${tasks.length} Claude/Phoenix Windows scheduled jobs last ended cleanly (attendance jobs excluded by owner decision)`);
  SNAP.tasks = tasks.map((t) => t.name).sort();
});

// ------------------------------------------------------------ 14. the primary checkout's control files
section("Phoenix checkout", () => {
  if (!exists(`${PHOENIX}/.git`)) return;
  const git = (...a) => execFileSync("git", ["-C", PHOENIX, ...a], { encoding: "utf8", windowsHide: true, timeout: 30000 }).trim();
  let branch = "?";
  try { branch = git("branch", "--show-current") || "(detached)"; } catch {}
  try {
    execFileSync("git", ["-C", PHOENIX, "diff", "--quiet", "origin/main", "--", ".claude/settings.json", ".claude/hooks", ".claude/agents", ".claude/skills", ".mcp.json", "AGENTS.md", "CLAUDE.md"], { windowsHide: true, timeout: 30000 });
    ok("Phoenix checkout", `Control files in the primary checkout (branch ${branch}) match origin/main as last fetched`);
  } catch (e) {
    if (e.status === 1) {
      let files = "";
      try { files = git("diff", "--name-only", "origin/main", "--", ".claude/settings.json", ".claude/hooks", ".claude/agents", ".claude/skills", ".mcp.json", "AGENTS.md", "CLAUDE.md").split("\n").join(", "); } catch {}
      add("LOW", "Phoenix checkout", `primary-drift:${sha1(files)}`, `Sessions opened in the Phoenix primary folder (branch ${branch}) load control files that differ from main`, files);
    }
  }
});

// ---------------------------------------------------------- 15. the desktop app's own scheduled tasks
// Registered per app profile in %APPDATA%\Claude\claude-code-sessions\<account>\<org>\scheduled-tasks.json;
// the prompt lives in ~/.claude/scheduled-tasks/<id>/SKILL.md. A task registered in two profiles runs twice.
section("App scheduled tasks", () => {
  // The desktop app is an MSIX package: its %APPDATA%\Claude writes land in the package cache, which a
  // Task Scheduler process does not see through %APPDATA% — on 08 Oct this section read 0 tasks while
  // 9 were registered. Read the package cache too; a profile found in both is read once.
  const PKGS = `${HOME}/AppData/Local/Packages`;
  const bases = [`${APPDATA}/Claude/claude-code-sessions`, ...listDir(PKGS).filter((p) => p.startsWith("Claude_")).map((p) => `${PKGS}/${p}/LocalCache/Roaming/Claude/claude-code-sessions`)];
  const regs = new Map();
  const seenProfiles = new Set();
  for (const base of bases) for (const acct of listDir(base)) for (const org of listDir(`${base}/${acct}`)) {
    if (seenProfiles.has(`${acct}/${org}`)) continue;
    const j = loadJson(`${base}/${acct}/${org}/scheduled-tasks.json`);
    if (!j.missing) seenProfiles.add(`${acct}/${org}`);
    if (j.missing) continue;
    const profile = `${acct.slice(0, 8)}/${org.slice(0, 8)}`;
    if (j.error) { add("MEDIUM", "App scheduled tasks", `app-tasks-broken:${profile}`, `A desktop scheduled-task registry (profile ${profile}) is not valid JSON, so the app may drop its tasks`, j.error); continue; }
    for (const t of j.data?.scheduledTasks || []) {
      if (!regs.has(t.id)) regs.set(t.id, []);
      regs.get(t.id).push({ profile, cron: t.cronExpression || null, enabled: t.enabled !== false, file: t.filePath ? fwd(t.filePath) : null, fireAt: t.fireAt ?? null });
    }
  }
  for (const [id, rs] of regs) {
    const on = rs.filter((r) => r.enabled && r.cron);
    // The app runs a task only in the account that is open. A prompt carrying the once-a-day guard
    // (added 2026-09-17) reports once whichever copy fires first, so two copies are deliberate there.
    const guarded = on.length > 1 && on.every((r) => r.file && /STEP 0 — ONCE (A|PER) DAY/.test(readText(r.file) || ""));
    if (guarded) ok("App scheduled tasks", `${q(id)} is on in ${on.length} accounts and its prompt reports once a day`);
    else if (on.length > 1) add("MEDIUM","App scheduled tasks", `app-task-twice:${id}:${on.map((r) => r.profile).sort().join(",")}`, `Desktop scheduled task ${q(id)} is ON in ${on.length} app profiles, so it runs ${on.length} times a day and reports ${on.length} times`, on.map((r) => `profile ${r.profile} at cron ${r.cron}`).join(" · "));
  }
  const noPrompt = [...regs].filter(([, rs]) => rs.some((r) => r.enabled && r.file && !exists(r.file))).map(([id]) => id).sort();
  if (noPrompt.length) add("LOW", "App scheduled tasks", `app-task-no-prompt:${noPrompt.join(",")}`, `${noPrompt.length} enabled desktop scheduled task(s) point at a prompt file that no longer exists: ${noPrompt.join(", ")}`);
  const unregistered = listDir(`${CLAUDE}/scheduled-tasks`).filter((f) => exists(`${CLAUDE}/scheduled-tasks/${f}/SKILL.md`) && !regs.has(f));
  if (unregistered.length >= 10) add("INFO", "App scheduled tasks", `app-task-unregistered:${Math.floor(unregistered.length / 10) * 10}`, `${unregistered.length} task prompt folders in ~/.claude/scheduled-tasks are registered in no app profile (finished one-off checks) and never run`);
  const enabled = [...regs].filter(([, rs]) => rs.some((r) => r.enabled)).map(([id]) => id);
  ok("App scheduled tasks", `${regs.size} registered desktop task(s), ${enabled.length} enabled: ${enabled.join(", ") || "none"}`);
  SNAP.appTasks = [...regs].flatMap(([id, rs]) => rs.map((r) => `${id} · ${r.profile} · ${r.cron || `once ${r.fireAt}`} · ${r.enabled ? "on" : "off"}`)).sort();
});

// ------------------------------------------------------------------------------------- 16. disk space
section("Disk space", () => {
  for (const drive of ["C:/", "F:/"]) {
    let free;
    try { const s = fs.statfsSync(drive); free = s.bavail * s.bsize; } catch { continue; }
    const gb = free / 2 ** 30; // the GB Windows Explorer shows
    // the desktop app refuses a new worktree session below about 5.4 GB free on the repository's drive
    if (gb < 6) add("MEDIUM", "Disk space", `disk-low:${drive[0]}`, `${drive[0]}: has ${gb.toFixed(1)} GB free — under 6 GB, where the desktop app starts refusing worktree sessions and builds fail`);
    else if (gb < 10) add("LOW", "Disk space", `disk-tight:${drive[0]}`, `${drive[0]}: has ${gb.toFixed(1)} GB free (under 10 GB)`);
    else ok("Disk space", `${drive[0]}: ${gb.toFixed(1)} GB free`);
  }
});

// ------------------------------------------------------------- 17. memory texts that read wrong today
section("Memory texts", () => {
  const claudeMd = readText(`${CLAUDE}/CLAUDE.md`) || "";
  const autoPR = /Commit, push and open the PR automatically/i.test(claudeMd); // owner rule 2026-09-16
  const cut = [], staleAsk = [];
  for (const slug of listDir(`${CLAUDE}/projects`)) {
    const mem = `${CLAUDE}/projects/${slug}/memory`;
    const tag = (f) => (slug === "F--Phoenix-Workforce-phoenix-workforce" ? f : `${slug}/${f}`);
    for (const f of listDir(mem).filter((n) => n.endsWith(".md") && !/^MEMORY/.test(n))) {
      const text = readText(`${mem}/${f}`) || "";
      const d = frontmatter(text)?.description || "";
      // an unquoted " #" starts a YAML comment, which is how five descriptions came to end at "(PR"
      if (/\((?:PRs?|#)?\s*$/.test(d)) cut.push(tag(f));
      if (autoPR && /\bask (?:for )?(?:approval )?before (?:every )?(?:commit|git action)|always ask (?:for )?approval before:? ?\**\s*commit/i.test(text) && !/SUPERSEDED/i.test(text)) staleAsk.push(tag(f));
    }
  }
  if (cut.length) add("LOW", "Memory texts", `memory-desc-cut:${cut.sort().join(",")}`, `${cut.length} memory description(s) stop mid-sentence, and recall reads only the description`, cut.slice(0, 6).join(" · "));
  if (staleAsk.length) add("LOW", "Memory texts", `memory-stale-ask:${staleAsk.sort().join(",")}`, `${staleAsk.length} memory file(s) still tell sessions to ask before committing or opening a PR, which CLAUDE.md (owner rule, 16 Sept) made automatic`, staleAsk.slice(0, 6).join(" · "));
});

// ------------------------------------------------------ 18. one repository, several memory folders
// Memory is keyed by the folder's repository, so two separate clones of one remote keep two memories.
section("Memory split", () => {
  const byOrigin = new Map();
  for (const key of new Set(projectKeys.map(norm))) {
    if (isWorktreePath(key) || !exists(key)) continue;
    const slug = key.replace(/[^A-Za-z0-9]/g, "-");
    const n = listDir(`${CLAUDE}/projects/${slug}/memory`).filter((f) => f.endsWith(".md") && f !== "MEMORY.md").length;
    if (!n) continue;
    let origin = "";
    try { origin = execFileSync("git", ["-C", key, "remote", "get-url", "origin"], { encoding: "utf8", windowsHide: true, timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { continue; }
    origin = origin.replace(/^(https?:\/\/)[^/@]*@/i, "$1").replace(/\.git$/i, "").toLowerCase(); // never keep a token from the URL
    if (!origin) continue;
    if (!byOrigin.has(origin)) byOrigin.set(origin, new Map());
    byOrigin.get(origin).set(slug, n);
  }
  for (const [origin, slugs] of byOrigin) {
    if (slugs.size < 2) continue;
    add("LOW", "Memory split", `memory-split:${sha1(origin)}:${[...slugs.keys()].sort().join(",")}`, `One repository (${q(origin, 80)}) has ${slugs.size} separate memory folders, so a rule saved in one folder never reaches sessions opened in the other`, [...slugs].map(([s, n]) => `${s}: ${n} memory files`).join(" · "));
  }
});

// ------------------------------------------------ 19. machine scripts that must keep the fixes they received
section("Machine scripts", () => {
  const rg = readText(`${CLAUDE}/scripts/ram-guard.ps1`);
  if (rg) {
    if (/Get-ChildItem -Path \$env:TEMP[^\n]*-Recurse/.test(rg) && !/\$claudeTemp/.test(rg)) add("MEDIUM", "Machine scripts", "ram-guard-temp-scratchpads", "ram-guard.ps1 deletes old files anywhere under %TEMP% — Claude Code session scratchpads and documents included, against the owner's rule of 14 Sept");
    if (/DoctorArgs @\('--(fix|strip-idle)'\)/.test(rg)) add("LOW", "Machine scripts", "ram-guard-doctor-auth", "ram-guard.ps1 runs repo-doctor without --no-auth, so every run pages the PRODUCTION auth admin API for a report that job never uses");
  }
  const boost = readText(`${CLAUDE}/scripts/claude-boost.ps1`);
  // owner decision 2026-09-17: the app in front of him is never lowered or pushed to disk
  if (boost && /EmptyWorkingSet/.test(boost) && !/GetForegroundWindow/.test(boost)) add("MEDIUM", "Machine scripts", "claude-boost-front-app", "claude-boost.ps1 lowers and pages out the app in front of the owner again (Excel, Word, the browser) — his decision of 17 Sept was to spare it");
  for (const f of walk(`${CLAUDE}/scripts`, { maxDepth: 0 }).filter((x) => /\.log$/i.test(x.name) && x.size > 5e6)) add("LOW", "Machine scripts", `big-log:${f.name}`, `${f.name} in ~/.claude/scripts has grown to ${size(f.size)}`, "A log that is never trimmed costs disk and gets copied into every backup.");
});

// ------------------------------------------------------------------------------ snapshot + drift
function snapshotBase() {
  const perms = {}, hooks = {}, env = {}, misc = {};
  for (const l of layers) {
    const key = `${l.name} (${l.file})`;
    if (l.data?.permissions) perms[key] = { allow: [...(l.data.permissions.allow || [])].sort(), deny: [...(l.data.permissions.deny || [])].sort(), ask: [...(l.data.permissions.ask || [])].sort(), defaultMode: l.data.permissions.defaultMode ?? null };
    if (l.data?.hooks) hooks[key] = Object.entries(l.data.hooks).flatMap(([ev, gs]) => (Array.isArray(gs) ? gs : []).flatMap((g) => (g.hooks || []).map((h) => `${ev} [${g.matcher || "*"}] ${(h.command || "").slice(0, 160)}${h.args ? " " + h.args.join(" ") : ""}`))).sort();
    if (l.data?.env) env[key] = Object.keys(l.data.env).sort();
    misc[key] = { keys: Object.keys(l.data || {}).sort(), skillOverrides: l.data?.skillOverrides || null, enabledMcpjsonServers: l.data?.enabledMcpjsonServers || null, disabledMcpjsonServers: l.data?.disabledMcpjsonServers || null, model: l.data?.model ?? null, statusLine: l.data?.statusLine?.command ?? null };
  }
  const grants = (U.autoMode?.allow || []).map((g) => `${sha1(g)} ${g.slice(0, 110)}`);
  const files = {};
  for (const f of [`${CLAUDE}/CLAUDE.md`, `${PHOENIX}/CLAUDE.md`, `${PHOENIX}/AGENTS.md`]) { const t = readText(f); if (t !== null) files[f] = { bytes: Buffer.byteLength(t), sha1: sha1(t) }; }
  return { generatedAt: new Date().toISOString(), claudeCode: { desktop: BIN.desktop?.version || null, cli: BIN.cli?.version || null }, permissions: perms, hooks, env, settings: misc, autoModeGrants: grants, files };
}

function diffSnapshots(prev, cur) {
  const out = [];
  const setDiff = (label, a = [], b = []) => {
    const A = new Set(a), B = new Set(b);
    const added = b.filter((x) => !A.has(x)), removed = a.filter((x) => !B.has(x));
    for (const x of added.slice(0, 20)) out.push(`+ ${label}: ${q(x, 140)}`);
    if (added.length > 20) out.push(`+ ${label}: …and ${added.length - 20} more`);
    for (const x of removed.slice(0, 20)) out.push(`- ${label}: ${q(x, 140)}`);
    if (removed.length > 20) out.push(`- ${label}: …and ${removed.length - 20} more`);
  };
  for (const k of new Set([...Object.keys(prev.permissions || {}), ...Object.keys(cur.permissions || {})])) {
    const a = prev.permissions?.[k] || {}, b = cur.permissions?.[k] || {};
    const short = k.replace(/ \(.*\)$/, "");
    setDiff(`${short} allow`, a.allow, b.allow);
    setDiff(`${short} deny`, a.deny, b.deny);
    setDiff(`${short} ask`, a.ask, b.ask);
    if ((a.defaultMode ?? null) !== (b.defaultMode ?? null)) out.push(`~ ${short} defaultMode: ${a.defaultMode ?? "unset"} → ${b.defaultMode ?? "unset"}`);
  }
  for (const k of new Set([...Object.keys(prev.hooks || {}), ...Object.keys(cur.hooks || {})])) setDiff(`${k.replace(/ \(.*\)$/, "")} hook`, prev.hooks?.[k], cur.hooks?.[k]);
  for (const k of new Set([...Object.keys(prev.env || {}), ...Object.keys(cur.env || {})])) setDiff(`${k.replace(/ \(.*\)$/, "")} env var`, prev.env?.[k], cur.env?.[k]);
  for (const k of new Set([...Object.keys(prev.settings || {}), ...Object.keys(cur.settings || {})])) {
    const a = prev.settings?.[k] || {}, b = cur.settings?.[k] || {};
    const short = k.replace(/ \(.*\)$/, "");
    setDiff(`${short} setting`, a.keys, b.keys);
    for (const f of ["skillOverrides", "enabledMcpjsonServers", "disabledMcpjsonServers", "model", "statusLine"]) if (JSON.stringify(a[f] ?? null) !== JSON.stringify(b[f] ?? null)) out.push(`~ ${short} ${f}: ${q(JSON.stringify(a[f] ?? null), 80)} → ${q(JSON.stringify(b[f] ?? null), 80)}`);
  }
  setDiff("auto-mode grant", prev.autoModeGrants, cur.autoModeGrants);
  setDiff("MCP server", Object.entries(prev.mcp || {}).map(([k, v]) => `${k} → ${v}`), Object.entries(cur.mcp || {}).map(([k, v]) => `${k} → ${v}`));
  setDiff("skill", Object.entries(prev.skills || {}).map(([k, v]) => `${k}@${v}`), Object.entries(cur.skills || {}).map(([k, v]) => `${k}@${v}`));
  setDiff("subagent", Object.entries(prev.agents || {}).map(([k, v]) => `${k}@${v}`), Object.entries(cur.agents || {}).map(([k, v]) => `${k}@${v}`));
  setDiff("installed plugin", prev.plugins?.installed, cur.plugins?.installed);
  setDiff("enabled plugin", prev.plugins?.enabled, cur.plugins?.enabled);
  setDiff("scheduled job", prev.tasks, cur.tasks);
  setDiff("desktop scheduled task", prev.appTasks, cur.appTasks);
  for (const f of new Set([...Object.keys(prev.files || {}), ...Object.keys(cur.files || {})])) {
    const a = prev.files?.[f], b = cur.files?.[f];
    if (a?.sha1 !== b?.sha1) out.push(`~ ${f}: ${a ? a.bytes.toLocaleString("en-US") : "absent"} → ${b ? b.bytes.toLocaleString("en-US") : "absent"} bytes`);
  }
  for (const [slug, m] of Object.entries(cur.memory || {})) { const p = prev.memory?.[slug]; if (p && p.bytes !== m.bytes) out.push(`~ memory index ${slug}: ${p.bytes.toLocaleString("en-US")} → ${m.bytes.toLocaleString("en-US")} bytes`); }
  if (prev.claudeCode?.desktop !== cur.claudeCode?.desktop || prev.claudeCode?.cli !== cur.claudeCode?.cli) out.push(`~ Claude Code: desktop ${prev.claudeCode?.desktop} → ${cur.claudeCode?.desktop}, CLI ${prev.claudeCode?.cli} → ${cur.claudeCode?.cli}`);
  return out;
}

// ---------------------------------------------------------------------------------------- report
function main() {
  const base = snapshotBase();
  const snapshot = { ...base, ...SNAP };
  fs.mkdirSync(`${OUT}/snapshots`, { recursive: true });
  const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Africa/Cairo" }).replace(" ", "_").replace(/:/g, "").slice(0, 15);
  const prevName = listDir(`${OUT}/snapshots`).filter((f) => f.endsWith(".json")).sort().pop();
  const prev = prevName ? loadJson(`${OUT}/snapshots/${prevName}`).data : null;
  const drift = prev ? diffSnapshots(prev, snapshot) : null;
  fs.writeFileSync(`${OUT}/snapshots/${stamp}.json`, JSON.stringify(snapshot, null, 1));

  const open = findings.filter((f) => !f.accepted).sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev] || a.area.localeCompare(b.area));
  const settled = findings.filter((f) => f.accepted);
  const count = (s) => open.filter((f) => f.sev === s).length;
  const L = [];
  L.push(`# Claude Code setup review — ${cairo(Date.now())} (Cairo)`, "");
  L.push(`Claude Code ${BIN.desktop ? `${BIN.desktop.version} (desktop)` : ""}${BIN.cli ? ` · ${BIN.cli.version} (CLI)` : ""} · ${layers.length} settings files · ran in ${((Date.now() - started) / 1000).toFixed(1)} s`, "");
  L.push("| High | Medium | Low | Info | Settled |", "| --- | --- | --- | --- | --- |", `| ${count("HIGH")} | ${count("MEDIUM")} | ${count("LOW")} | ${count("INFO")} | ${settled.length} |`, "");
  const urgent = open.filter((f) => f.sev === "HIGH" || f.sev === "MEDIUM");
  L.push("## Needs attention", "");
  if (!urgent.length) L.push("Nothing high or medium.", "");
  for (const f of urgent) L.push(`- **${f.sev}** · ${f.area} — ${f.title}${f.detail ? `  \n  ${f.detail}` : ""}  \n  <sub>id: ${f.id}</sub>`);
  L.push("", `## Changed since the last review${prev ? ` (${cairo(prev.generatedAt)})` : ""}`, "");
  if (!prev) L.push("First run — this snapshot is the baseline.");
  else if (!drift.length) L.push("No change to permissions, hooks, grants, MCP servers, skills, subagents, plugins, memory index or instruction files.");
  else for (const d of drift) L.push(`- ${d}`);
  L.push("", "## Lower-priority findings", "");
  const low = open.filter((f) => f.sev === "LOW" || f.sev === "INFO");
  if (!low.length) L.push("None.");
  for (const f of low) L.push(`- ${f.sev} · ${f.area} — ${f.title}${f.detail ? `  \n  ${f.detail}` : ""}  \n  <sub>id: ${f.id}</sub>`);
  L.push("", "## Facts", "");
  for (const n of [...new Set(notes)]) L.push(`- ${n}`);
  L.push("", "## Checks that passed", "");
  for (const p of passed) L.push(`- ${p.area}: ${p.text}`);
  if (settled.length) { L.push("", "## Settled (accepted.json)", ""); for (const f of settled) L.push(`- ${f.sev} · ${f.title} — ${f.accepted}`); }
  const reportFile = `${OUT}/${stamp}-config-review.md`;
  fs.writeFileSync(reportFile, L.join("\n") + "\n");
  fs.writeFileSync(`${OUT}/latest.md`, L.join("\n") + "\n");

  // --alert: drift against the watcher's own baseline, so a weekly alert is the whole
  // week's delta even if a session ran the review ad hoc in between. Reuses diffSnapshots.
  if (ALERT) {
    const baseFile = `${OUT}/.alert-baseline.json`;
    const baseline = loadJson(baseFile).data || null;
    // The alert is for SECURITY-relevant drift (permissions, grants, hooks, MCP, skills,
    // subagents, plugins, env, settings, instruction files, Windows jobs, Claude Code version).
    // Two categories churn as a normal part of operation and are noise here — the desktop app's
    // own scheduled tasks (cron/fireAt/enabled flip per profile every run) and the memory-index
    // byte count (changes with every memory edit). The full report still carries both.
    const NOISY = /^[+\-] desktop scheduled task:|^~ memory index /;
    const alertDrift = (baseline ? diffSnapshots(baseline, snapshot) : []).filter((d) => !NOISY.test(d));
    const payload = {
      generatedAt: snapshot.generatedAt,
      baselineAt: baseline?.generatedAt || null,
      firstRun: !baseline,
      driftCount: alertDrift.length,
      drift: alertDrift,
      high: open.filter((f) => f.sev === "HIGH").map((f) => f.title),
      medium: open.filter((f) => f.sev === "MEDIUM").map((f) => f.title),
      reportFile,
    };
    fs.writeFileSync(`${OUT}/.alert-payload.json`, JSON.stringify(payload, null, 1));
    fs.writeFileSync(baseFile, JSON.stringify(snapshot, null, 1)); // advance baseline every alert run
  }

  const line = `config-review: ${count("HIGH")} high, ${count("MEDIUM")} medium, ${count("LOW")} low, ${count("INFO")} info${prev ? `, ${drift.length} change(s) since last run` : ", baseline"} — ${reportFile}`;
  if (!QUIET) console.log(line);
  else if (count("HIGH")) console.log(line);
}
main();
