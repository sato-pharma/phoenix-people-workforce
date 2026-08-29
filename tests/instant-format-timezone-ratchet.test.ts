import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Standing owner rule: "Report every time in Africa/Cairo local time, never raw UTC."
//
// An Intl date format with no `timeZone` uses THE RUNTIME'S zone. That is the
// whole defect, and it is invisible on this laptop, because this laptop's zone
// IS Africa/Cairo — so the wrong code and the right code print the same string
// here. Railway runs with no TZ set, which means UTC. Cairo is UTC+2/+3, so an
// unzoned instant renders 2–3 hours EARLY in production, and anything logged
// after 21:00 Cairo renders on the WRONG DAY.
//
// WHAT COUNTS
// A date-format call that renders a time-of-day component (`hour`, `minute`,
// `second`, `timeStyle`) and supplies no `timeZone`. Those two facts together
// mean a real instant is being rendered in whatever zone the process happens to
// be in.
//
// WHAT IS NOT A VIOLATION
//   - A DATE-ONLY format. `src/lib/i18n/format.ts` pins UTC on purpose for these:
//     they render a date-only literal anchored at T00:00:00Z, and re-zoning one
//     to Cairo shifts it a day backwards. formatDateOnly must not be "fixed".
//   - A call that supplies the zone as an ES6 SHORTHAND — `{ hour: "2-digit",
//     timeZone }`. This is not a hypothetical: the first census run for this
//     ratchet reported 20 sites where the truth was 19, because a colon-anchored
//     `timeZone:` regex missed the shorthand in two of the most careful helpers
//     in the repo (`src/lib/attendance/timezone.ts`, whose entire docstring is
//     about getting Cairo's offset right, and `src/lib/cron-control/
//     cron-expression.ts`). Both were flagged as bugs and neither was one. The
//     detector self-checks below now pin that case so it cannot come back.
//
// TWO ARMS, NOT ONE, BECAUSE THE RISK IS NOT UNIFORM
//   - A file carrying "use client" only ever runs in a browser. Every Phoenix
//     user is in Cairo, so those 17 are accidentally correct today and latent
//     rather than broken. They RATCHET: the count may fall, never rise.
//   - A file without the directive CAN render on the server, where the clock is
//     UTC. Those are wrong the moment they run. Zero tolerance, no baseline.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Counted 2026-08-29 in the worktree that fixed the two server-side sites.
 *
 * The pre-fix tree had 19: these same 17, plus `coaching-report-detail.tsx:73`
 * (every coaching-report timestamp, rendered server-side in UTC) and
 * `private-calendar/export.ts:86` (the "Generated" stamp inside every downloaded
 * sheet and PDF). Both now pass PHOENIX_BUSINESS_TIME_ZONE.
 *
 * An earlier census put the totals at 20/18. That figure counted a shorthand
 * `timeZone` as missing — see WHAT IS NOT A VIOLATION above. Nothing changed on
 * screen between 20 and 19; only the measurement stopped being wrong.
 *
 * Lower this when sites are genuinely retired; never raise it to make a red run green.
 */
const CLIENT_BASELINE = 17;

/**
 * Not a baseline — a rule. A server-rendered instant with no zone is wrong in
 * production on the day it is written. It was 2 before this ratchet landed.
 */
const SERVER_CAPABLE_ALLOWED = 0;

const ROOTS = ["app", "src"];

/** Every way this codebase formats a date or an instant. */
const CALL_HEAD =
  /(?:Intl\.DateTimeFormat|\.toLocaleString|\.toLocaleDateString|\.toLocaleTimeString)\s*\(/g;

/** A time-of-day component: the thing that makes this an INSTANT and not a date. */
const TIME_FIELD = /\b(?:hour|minute|second|timeStyle|hour12|hourCycle)\s*:/;

/**
 * Deliberately a bare word, NOT `timeZone\s*:`. `{ hour: "2-digit", timeZone }`
 * supplies the zone exactly as surely as `timeZone: "Africa/Cairo"` does.
 */
const TIME_ZONE = /\btimeZone\b/;

/**
 * Blank comments before measuring, so a sentence describing the rule is never
 * counted as breaking it. Newlines survive, so every file:line reported below
 * still points at its real line. The `[^:]` guard keeps `https://…` from reading
 * as the start of a line comment and swallowing the rest of the line with it.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * True only when the directive is the file's FIRST real line, which is the only
 * place Next honours it. A looser test would let a file that merely mentions the
 * string escape the zero-tolerance arm into the ratcheted one.
 */
function isClientComponent(strippedSource: string): boolean {
  const first = strippedSource.split("\n").find((line) => line.trim().length > 0);
  return first !== undefined && /^\s*["']use client["']/.test(first);
}

/**
 * Read the full argument list of the call whose `(` sits at `openIndex`.
 *
 * A fixed line window cannot do this. These options objects span 6–10 lines, and
 * the call almost always ends `.format(new Date(value))` — a nested paren pair
 * that a naive scan closes on, truncating the arguments and hiding the very
 * `timeZone` key being looked for. String literals are tracked so a `)` inside
 * one (`"h:mm a (z)"`) does not end the extraction early either.
 */
function extractArgs(source: string, openIndex: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  return null;
}

type Site = { site: string; isClient: boolean };

function scan(label: string, rawSource: string): { sites: Site[]; calls: number } {
  const source = stripComments(rawSource);
  const isClient = isClientComponent(source);
  const sites: Site[] = [];
  let calls = 0;
  CALL_HEAD.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CALL_HEAD.exec(source))) {
    calls += 1;
    const args = extractArgs(source, match.index + match[0].length - 1);
    if (args === null) continue;
    if (!TIME_FIELD.test(args)) continue;
    if (TIME_ZONE.test(args)) continue;
    sites.push({ site: `${label}:${source.slice(0, match.index).split("\n").length}`, isClient });
  }
  return { sites, calls };
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".") || entry.startsWith("_wt-")) continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

export function runInstantFormatTimezoneRatchetTests() {
  // ───────────────────────────────────────────────────────────────────────────
  // Check the detector against known inputs BEFORE trusting it on ~2,900 files.
  // A ratchet whose regex is wrong does not fail loudly — it reports a number,
  // and a wrong number looks exactly as authoritative as a right one. Two of
  // these cases are here because the detector really did get them wrong while it
  // was being written, and the wrong answer was a confident accusation against
  // correct code.
  // ───────────────────────────────────────────────────────────────────────────
  const count = (snippet: string) => scan("probe.ts", snippet).sites.length;

  assert.equal(
    count('new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit" }).format(d)'),
    1,
    "an instant format with no timeZone is the violation this whole file exists for",
  );
  assert.equal(
    count('new Intl.DateTimeFormat("en-US", { hour: "2-digit", timeZone: "Africa/Cairo" }).format(d)'),
    0,
    "an explicit zone is compliant",
  );
  assert.equal(
    count('new Intl.DateTimeFormat("en-US", { hour: "2-digit", timeZone }).format(d)'),
    0,
    "a SHORTHAND zone is compliant — the census that read 20 instead of 19 missed exactly this, and accused two correct helpers",
  );
  assert.equal(
    count('new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(d)'),
    0,
    "a DATE-ONLY format is out of scope: formatDateOnly pins UTC on purpose and re-zoning it shifts the day backwards",
  );
  assert.equal(
    count('d.toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit" })'),
    1,
    "toLocaleString is the same defect wearing a different name",
  );
  assert.equal(
    count('d.toLocaleTimeString("en-GB", { hour: "2-digit", timeZone: TZ })'),
    0,
    "a zone from a constant is still a zone",
  );
  assert.equal(
    count("// no timeZone here, so it would render in UTC — prose describing the rule\nconst x = 1;"),
    0,
    "a comment naming the rule is documentation, not a violation",
  );

  // The nested-paren case: `.format(new Date(v))` closes two pairs after the
  // options object. A scanner that stops at the first `)` never sees `timeZone`.
  assert.equal(
    count(
      'new Intl.DateTimeFormat("en-US", {\n  hour: "2-digit",\n  minute: "2-digit",\n  timeZone: "Africa/Cairo",\n}).format(new Date(value))',
    ),
    0,
    "balanced-paren extraction must read past a nested .format(new Date(v)) to find the zone that is really there",
  );
  // ...and the same shape WITHOUT a zone must still be caught, or the check above
  // could be passing because the extraction failed rather than because it worked.
  assert.equal(
    count('new Intl.DateTimeFormat("en-US", {\n  hour: "2-digit",\n}).format(new Date(value))'),
    1,
    "the multi-line shape must still be caught when the zone is genuinely absent",
  );
  assert.equal(
    count('new Intl.DateTimeFormat("en-US", { hour: "2-digit", dayPeriod: "short" }).format(d) + ")"'),
    1,
    "a parenthesis inside a string literal must not end the argument extraction early",
  );

  // The client/server split decides which arm a site lands in, so it is checked too.
  assert.equal(
    scan("probe.tsx", '"use client";\nconst s = d.toLocaleString("en-GB", { hour: "2-digit" });').sites[0]?.isClient,
    true,
    "a leading use-client directive puts the site in the ratcheted arm",
  );
  assert.equal(
    scan("probe.ts", 'const s = d.toLocaleString("en-GB", { hour: "2-digit" });').sites[0]?.isClient,
    false,
    "no directive means the file can render on the server, where the clock is UTC",
  );
  assert.equal(
    scan("probe.ts", 'const help = "use client";\nconst s = d.toLocaleString("en-GB", { hour: "2-digit" });').sites[0]
      ?.isClient,
    false,
    "the directive only counts as the FIRST real line — otherwise a string mentioning it would buy an exemption from the strict arm",
  );

  // Line numbers survive stripping, or every file:line reported below is shifted
  // upward by the size of whatever comment block sat above it.
  assert.equal(
    scan("probe.ts", '/*\n * a note\n */\nd.toLocaleString("en-GB", { hour: "2-digit" });').sites[0]?.site,
    "probe.ts:4",
    "stripping must preserve line numbers, or every site this test prints is wrong",
  );

  // ───────────────────────────────────────────────────────────────────────────

  const files = ROOTS.flatMap((r) => walk(r));
  assert.ok(
    files.length > 1000,
    `only ${files.length} source files were scanned — the walk is not reaching the tree, so any count it reports is meaningless`,
  );

  let dateFormatCalls = 0;
  const clientSites: string[] = [];
  const serverCapableSites: string[] = [];
  for (const file of files) {
    const { sites, calls } = scan(file.replace(/\\/g, "/"), readFileSync(file, "utf8"));
    dateFormatCalls += calls;
    for (const found of sites) (found.isClient ? clientSites : serverCapableSites).push(found.site);
  }

  assert.ok(
    dateFormatCalls > 600,
    `only ${dateFormatCalls} date-format calls were found across ${files.length} files — the call regex has stopped matching, so a count of zero violations would mean nothing`,
  );

  // ARM 1 — zero tolerance. These render in production, in UTC.
  assert.equal(
    serverCapableSites.length,
    SERVER_CAPABLE_ALLOWED,
    `${serverCapableSites.length} instant(s) are formatted with no timeZone in a file that can render on the SERVER, ` +
      `whose clock is UTC. In production these read 2-3 hours early, and after 21:00 Cairo they read on the wrong DAY.\n` +
      `Pass timeZone: PHOENIX_BUSINESS_TIME_ZONE from @/lib/i18n/format.\n` +
      `Sites:\n  ${serverCapableSites.join("\n  ")}`,
  );

  // ARM 2 — the ratchet over the browser-only sites.
  assert.ok(
    clientSites.length <= CLIENT_BASELINE,
    `${clientSites.length - CLIENT_BASELINE} new unzoned instant format(s) were added to client components — ` +
      `the count went ${CLIENT_BASELINE} -> ${clientSites.length}.\n` +
      `These are only correct because every Phoenix user's browser is in Cairo. Pass ` +
      `timeZone: PHOENIX_BUSINESS_TIME_ZONE and the site stops depending on that.\n` +
      `Sites now present:\n  ${clientSites.join("\n  ")}`,
  );

  assert.ok(
    clientSites.length >= CLIENT_BASELINE,
    `Good news: unzoned client instant formats dropped ${CLIENT_BASELINE} -> ${clientSites.length}. Lower ` +
      `CLIENT_BASELINE in this file to ${clientSites.length} so the ground that was won cannot be given back.`,
  );
}
