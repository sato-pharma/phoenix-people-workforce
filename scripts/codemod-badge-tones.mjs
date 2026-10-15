// Collapse the badge colour families onto the --phx-* semantic tokens.
//
// WHY ONLY COLOUR
// The same meaning was drawn in two hues, chosen at random per file: warn was
// `amber` 50 times and `orange` 49, danger `rose` 44 and `red` 15, info `sky` 9
// and `blue` 7. That is the drift a reader actually sees, and fixing it is a pure
// class rename — no markup moves, no layout shifts.
//
// The 30 distinct padding/weight signatures are NOT touched here. Changing a
// badge's padding reflows the row it sits in, and the standing rule is that text
// never wraps and is never ellipsised — so that needs a look at each screen, not
// a codemod.
//
// WHY IT IS SAFE TO RUN
// It rewrites ONLY inside quoted class strings that are already confirmed
// badge-shaped: rounded-full, real padding, an explicit text size, and a
// semantic colour pair. That test deliberately excludes the 198 status dots, 71
// icon wells, 164 colourless pills and 4 avatars that share the rounded-full
// shape — converting those would be a visible regression. `slate` in particular
// appears thousands of times across the app; only its badge occurrences move.
//
// Idempotent: a class already on a --phx- token no longer matches the palette
// pattern, so a second run is a no-op.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "codemod-badge-tones",
  entry: import.meta.url,
  known: ["--write"],
  hints: [
    "it is a dry run by default — pass --write to edit files",
  ],
});

const ROOTS = ["app", "src"];

/** Owner-protected files. Never rewritten, whatever they contain. */
const PROTECTED = [
  "src/lib/incentives/scheme-2026.ts",
  "src/lib/payroll/policy.ts",
  "src/components/employee-portal/identity-card.tsx",
  "src/lib/sales/office-allocation.ts",
];

/** Which palette family means what. Two hues per meaning is the bug being fixed. */
const TONE_OF = {
  emerald: "ok", green: "ok",
  amber: "warn", orange: "warn", yellow: "warn",
  rose: "danger", red: "danger",
  sky: "info", blue: "info", violet: "info", purple: "info",
  slate: "neutral", gray: "neutral", zinc: "neutral", neutral: "neutral",
};

/**
 * The token each role maps to. neutral borrows the surface/ink/line trio.
 *
 * `strong` exists for SOLID badges — `bg-slate-900`, `bg-violet-500`. Without it
 * a near-black badge mapped to `phx-ink-soft` (#6b7078), turning a solid chip
 * into a mid-grey one and putting its white text at roughly 4.0:1, under the AA
 * bar. For the semantic tones the ink token is already the dark one; only
 * neutral needed a genuinely strong value.
 */
const TOKEN = {
  ok: { bg: "phx-ok-bg", fg: "phx-ok", line: "phx-ok-line", strong: "phx-ok" },
  warn: { bg: "phx-warn-bg", fg: "phx-warn", line: "phx-warn-line", strong: "phx-warn" },
  danger: { bg: "phx-danger-bg", fg: "phx-danger", line: "phx-danger-line", strong: "phx-danger" },
  info: { bg: "phx-info-bg", fg: "phx-info", line: "phx-info-line", strong: "phx-info" },
  // paper (#f7f6f3), not surface (#ffffff): a neutral badge sits ON a white card,
  // so a pure-white fill is invisible. paper is what slate-50 was already doing.
  neutral: { bg: "phx-paper", fg: "phx-ink-soft", line: "phx-line", strong: "phx-ink" },
};

const FAMILIES = Object.keys(TONE_OF).join("|");
// bg-rose-50, text-rose-700, border-rose-200/80, ring-rose-200 — optional opacity suffix.
const COLOUR = new RegExp(`\\b(bg|text|border|ring)-(${FAMILIES})-(\\d{2,3})(/\\d{1,3})?\\b`, "g");

/** Is this class string a badge? Same test as the survey that produced the 126. */
function isBadge(cls) {
  if (!/\brounded-full\b/.test(cls)) return false;
  if (!/\bpx-[\d.]+/.test(cls)) return false;                    // dots and icon wells have no padding
  if (!/\btext-(phx-|xs|sm|\[)/.test(cls)) return false;          // must render text
  if (/\b(overflow-hidden|object-cover)\b/.test(cls)) return false; // avatars
  return new RegExp(`\\b(bg|text)-(${FAMILIES})-\\d{2,3}\\b`).test(cls);
}

function rewrite(cls) {
  return cls.replace(COLOUR, (whole, role, family, shade, opacity) => {
    const tone = TONE_OF[family];
    const t = TOKEN[tone];
    // A light shade is a fill; a heavy one is ink. 400 is the boundary in this app.
    // A fill at 700+ is a SOLID badge and needs the strong token, not the soft ink.
    const n = Number(shade);
    if (role === "bg") return `bg-${n <= 200 ? t.bg : n >= 700 ? t.strong : t.fg}${opacity ?? ""}`;
    if (role === "text") return `text-${n >= 400 ? t.fg : t.bg}${opacity ?? ""}`;
    return `${role}-${t.line}${opacity ?? ""}`; // border / ring are always the edge
  });
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const full = path.join(dir, e);
    if (statSync(full).isDirectory()) {
      if (e === "node_modules" || e.startsWith(".") || e.startsWith("_wt-")) continue;
      walk(full, out);
    } else if (/\.tsx$/.test(e)) out.push(full);
  }
  return out;
}

const apply = process.argv.includes("--write");
const files = ROOTS.flatMap((r) => walk(r));
let touchedFiles = 0;
let touchedStrings = 0;
let touchedClasses = 0;
const skipped = [];
const samples = [];

for (const file of files) {
  const rel = file.replace(/\\/g, "/");
  if (PROTECTED.some((p) => rel.endsWith(p))) { skipped.push(rel); continue; }

  const src = readFileSync(file, "utf8");
  let changedHere = 0;

  const next = src.replace(/(["'`])([^"'`\n]*\brounded-full\b[^"'`\n]*)\1/g, (whole, q, cls) => {
    if (!isBadge(cls)) return whole;
    const out = rewrite(cls);
    if (out === cls) return whole;
    changedHere++;
    touchedClasses += (cls.match(COLOUR) ?? []).length;
    if (samples.length < 8) samples.push({ rel, before: cls, after: out });
    return `${q}${out}${q}`;
  });

  if (changedHere > 0) {
    touchedFiles++;
    touchedStrings += changedHere;
    if (apply) writeFileSync(file, next);
  }
}

console.log(`${apply ? "REWROTE" : "would rewrite"}  ${touchedStrings} badge class strings`);
console.log(`            across ${touchedFiles} files`);
console.log(`            ${touchedClasses} individual colour classes`);
if (skipped.length) console.log(`\nprotected, untouched: ${skipped.join(", ")}`);

if (!apply) {
  console.log("\n── sample rewrites (read these before applying) ──");
  for (const s of samples) {
    const only = (c) => (c.match(COLOUR) ?? []).join(" ");
    console.log(`\n  ${s.rel}`);
    console.log(`    before: ${only(s.before)}`);
    // Exclude the Phase 5 SIZE tokens (text-phx-xs and friends) — they are not
    // colour and showing them here made the preview read as a spurious rewrite.
    const colourTokens = (s.after.match(/\b(?:bg|text|border|ring)-phx-[a-z0-9-]+/g) ?? [])
      .filter((c) => !/^text-phx-(?:\d?x?[a-z]?s|base|lg|xl|\dxl)$/.test(c));
    console.log(`    after : ${colourTokens.join(" ")}`);
  }
  console.log("\n(dry run — pass --write to apply)");
}
