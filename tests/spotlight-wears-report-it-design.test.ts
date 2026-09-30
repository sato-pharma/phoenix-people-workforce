import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Spotlight wears Report It's design — pinned, not merely intended.
//
// Owner, 2026-09-30: "mimic the style of the report it tab … the same /employee-portals/report-it as
// design." A look copied by hand drifts the moment either side is touched, and nothing reports it —
// the page keeps rendering, it just stops being the same page. So the shared primitives are compared
// BYTE FOR BYTE against the Report It form, and the structural devices are asserted present.
//
// 🔴 IF THIS GOES RED, THE FIX IS TO COPY REPORT IT'S VALUE ACROSS, NOT TO RELAX THE ASSERTION.
// Report It is the source of the look; the spotlight follows it. The one legitimate reason to edit
// the expectations here is the owner asking for a different look for BOTH.

const root = process.cwd();
const reportIt = readFileSync(join(root, "src/components/report-it/report-it-form.tsx"), "utf8");
const spotlight = readFileSync(join(root, "src/components/spotlight/rep-spotlight-workspace.tsx"), "utf8");

/** The right-hand side of `const <name> = "…";` or a template built from one, as written. */
function constValue(source: string, name: string): string | null {
  // Handles both `const x =\n  "…";` and `const x = `${y} …`;`
  const match = new RegExp(`const ${name} =\\s*([\\s\\S]*?);\\n`).exec(source);
  return match ? match[1]!.trim() : null;
}

export function runSpotlightWearsReportItDesignTests(): void {
  // ── 1. The field, select and button primitives are the SAME STRINGS ────────────────────────────
  // These carry the whole look: square corners, slate borders, the orange focus ring, the bold
  // uppercase labels. A single divergent utility here is how two pages stop matching.
  for (const name of ["fieldClass", "selectClass", "btnGhost", "btnDark", "btnOrange"]) {
    const theirs = constValue(reportIt, name);
    const ours = constValue(spotlight, name);
    assert.ok(theirs, `report-it-form.tsx no longer declares ${name} — find where the look moved.`);
    assert.ok(ours, `rep-spotlight-workspace.tsx no longer declares ${name}.`);
    assert.equal(
      ours,
      theirs,
      `${name} has drifted from the Report It form. Copy Report It's value across — it is the source of this look.`,
    );
  }

  // ── 2. The field LABEL is the same treatment ──────────────────────────────────────────────────
  const labelClass = "mb-1.5 block text-phx-xs font-black uppercase tracking-wide text-slate-500";
  assert.ok(reportIt.includes(labelClass), "Report It's FieldLabel treatment moved; re-pin both sides.");
  assert.ok(spotlight.includes(labelClass), "The spotlight's FieldLabel no longer matches Report It's.");

  // ── 3. The structural devices Report It is recognised by ──────────────────────────────────────
  // Each is quoted from the Report It form, so a change there fails the first assertion of the pair
  // and a change here fails the second — neither side can move alone.
  const devices: [string, string][] = [
    ["dark hero", "relative overflow-hidden bg-slate-900 px-5 py-6 sm:px-8 sm:py-7"],
    ["orange bloom", "pointer-events-none absolute -right-10 -top-10 h-44 w-44 rounded-full bg-orange-500/10 blur-2xl"],
    ["hero eyebrow", "text-phx-xs font-black uppercase tracking-[0.25em] text-orange-400"],
    ["hero title", "mt-1 text-2xl font-black leading-none text-white"],
    ["progress track", "mt-1.5 h-1.5 w-full bg-white/10"],
    ["progress fill", "h-full bg-orange-500 transition-all duration-300"],
    ["rail + content grid", "grid grid-cols-1 lg:grid-cols-[244px_minmax(0,1fr)]"],
    ["stepper rail", "hidden border-r border-slate-200 bg-slate-50/60 lg:flex lg:flex-col"],
    ["step heading rule", "mb-5 flex items-center justify-between border-b border-slate-200 pb-4"],
    ["step eyebrow", "text-phx-2xs font-black uppercase tracking-[0.25em] text-orange-600"],
    ["ghost numeral", "select-none text-4xl font-black tabular-nums text-slate-200"],
    ["footer nav rule", "mt-6 flex items-center justify-between border-t border-slate-200 pt-5"],
    ["error panel", "border border-rose-300 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-800"],
    ["block header", "flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-2.5"],
  ];
  for (const [device, className] of devices) {
    assert.ok(
      reportIt.includes(className),
      `Report It no longer carries its ${device} — it is the source of this look, so re-pin both sides.`,
    );
    assert.ok(
      spotlight.includes(className),
      `The spotlight is missing Report It's ${device}. The owner asked for the same design (2026-09-30).`,
    );
  }

  // ── 4. The owner's standing UI rules, on this page ────────────────────────────────────────────
  // Square corners: the only rounded thing allowed is the hero's blurred bloom, which is a soft
  // light and not an edge. Any other `rounded-` would be a corner.
  const rounded = [...spotlight.matchAll(/rounded-[a-z0-9-]*/g)].map((m) => m[0]);
  assert.deepEqual(
    [...new Set(rounded)],
    ["rounded-full"],
    "Square corners are an owner golden rule — the only rounded token here may be the hero bloom.",
  );
  assert.ok(
    /rounded-full bg-orange-500\/10 blur-2xl/.test(spotlight),
    "The one rounded token must be the hero's blurred bloom, not a real corner.",
  );

  // No sideways scroll and no truncation: both are owner golden rules.
  assert.ok(!/overflow-x-auto/.test(spotlight), "No horizontal scroll — fit by wrapping, never by scrolling.");
  assert.ok(!/\btruncate\b|text-ellipsis/.test(spotlight), "Nothing on this page may be truncated (owner rule).");

  // The sheet image must scale rather than overflow a phone.
  assert.ok(
    /className="block w-full border border-slate-200 bg-white"/.test(spotlight),
    "The rendered sheet must be w-full so an A4 portrait fits a phone without scrolling sideways.",
  );
}
