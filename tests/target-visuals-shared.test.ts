import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// The two TARGET modules draw the same figure the same way.
//
// Four screens answer "how are we doing against target?" — `VsTargetDashboard` and
// `TargetsWorkspace`, each rendered in BOTH shells (the admin shell at /sales/vs-target and
// /sales/targets, the employee portal at /employee-portals/sales-vs-target and
// /employee-portals/targets).
//
// Until 2026-09-04 only one of the two had any visual encoding at all. The dashboard had a
// command band, an achievement ring, proportion bars and a tone ramp; the workspace printed
// its region and district-manager rollups as bare percentages in a `max-h-40` scroll box and
// its achievement column as a coloured number. The primitives were PRIVATE to the dashboard
// file, so there was nothing the workspace could have reused even if it had wanted to — which
// is exactly how two screens about one subject drift into looking like two products.
//
// The primitives now live in `src/components/sales/target-visuals.tsx` and both modules import
// them. This test pins that arrangement by SHAPE, not by class string:
//
//   1. Both modules import from the shared module.
//   2. Neither module re-declares a primitive the shared module owns. A local
//      `function AchievementRing(` in either file is the drift this whole exercise removed —
//      it would compile, render, and quietly diverge.
//   3. The shared module keeps the three judgement calls that are NOT free to change:
//      a null achievement is neutral rather than red, a null percentage prints an em dash
//      rather than "0%", and the ring's ARC is clamped to 1 while the printed number is not.
//
// Point 3 is the one worth stating plainly. `achievementTone(null)` returning a red class
// would accuse every area with no target loaded of missing a target it was never given, on
// four screens at once, and nothing else in the suite would notice.
// ─────────────────────────────────────────────────────────────────────────────

const SHARED = "../src/components/sales/target-visuals.tsx";
const CONSUMERS = [
  "../src/components/sales/targets-workspace.tsx",
  "../src/components/sales/vs-target/vs-target-dashboard.tsx",
];

/** Primitives the shared module owns. A consumer that declares one of these has forked it. */
const OWNED = [
  "AchievementRing",
  "AchievementCell",
  "AchievementMeter",
  "ProportionBar",
  "GrowthPill",
  "SectionCard",
  "CommandBand",
  "BandStat",
  "BandChoice",
  "achievementTone",
  "achievementHex",
  "formatPct",
  "formatEgp",
  "formatEgpFull",
  "formatPeriod",
];

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

/**
 * Comments are stripped before the fork scan, so the prose above — which names the primitives
 * it is describing — cannot fail the build it exists to explain.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

export function runTargetVisualsSharedTests() {
  const shared = read(SHARED);

  // ── The shared module actually exports what it claims to own ─────────────
  for (const name of OWNED) {
    assert.match(
      shared,
      new RegExp(`export (?:function|const) ${name}\\b`),
      `target-visuals.tsx must export ${name} — it is listed as a shared primitive, and a ` +
        "consumer importing a name that is not exported fails at build time rather than here.",
    );
  }

  // ── HEADLINE: neither target module forks a shared primitive ─────────────
  for (const path of CONSUMERS) {
    const source = stripComments(read(path));

    assert.match(
      source,
      /from "@\/components\/sales\/target-visuals"/,
      `${path} must import its visual primitives from @/components/sales/target-visuals. ` +
        "Both target modules render in both shells, and a module that stops importing the " +
        "shared language is a module that has started drawing the same figure differently.",
    );

    for (const name of OWNED) {
      const declaresLocally = new RegExp(`^\\s*(?:export\\s+)?(?:function|const)\\s+${name}\\b`, "m").test(source);
      assert.ok(
        !declaresLocally,
        `${path} declares its own ${name}. That primitive is owned by ` +
          "src/components/sales/target-visuals.tsx and shared by both target modules — a local " +
          "copy compiles and renders perfectly while the two screens quietly diverge, which is " +
          "the exact defect the shared module was created to end. Import it instead.",
    );
    }
  }

  // ── The judgement calls that must not be "tidied" ────────────────────────

  // A null achievement is NEUTRAL. Red would accuse an unmeasured area of a miss.
  const toneBody = /export function achievementTone\(value: number \| null\): string \{([\s\S]*?)\n\}/.exec(shared);
  assert.ok(toneBody, "achievementTone must remain a declared function in target-visuals.tsx.");
  const nullBranch = /if \(value == null\) return "([^"]+)";/.exec(toneBody[1]);
  assert.ok(nullBranch, "achievementTone must keep an explicit `value == null` branch.");
  assert.ok(
    !/red/.test(nullBranch[1]),
    `achievementTone(null) returns "${nullBranch?.[1]}". A null achievement means NO TARGET WAS ` +
      "LOADED, not a missed one. Colouring it red tells a District Manager their untargeted area " +
      "under-performed against a target nobody ever set, on four screens at once.",
  );

  // A null percentage is an em dash, never "0%".
  assert.match(
    shared,
    /export function formatPct\(value: number \| null\): string \{\s*return value == null \? "—"/,
    'formatPct must render a null as "—", never "0%". "0%" says the area sold nothing; "—" says ' +
      "it was not measured. Those are different facts and the distinction is the point.",
  );

  // The ring's ARC is clamped; the printed number is not.
  assert.match(
    shared,
    /const fraction = value == null \? 0 : Math\.max\(0, Math\.min\(1, value\)\);/,
    "AchievementRing must clamp its ARC fraction to [0,1]. Without the clamp a 140% achiever " +
      "wraps the circle past its own start and reads as 40%.",
  );
  assert.match(
    shared,
    /\{formatPct\(value\)\}/,
    "AchievementRing must print the UNCLAMPED value in the middle of the ring — the arc is " +
      "capped for legibility, the number stays truthful.",
  );
}
