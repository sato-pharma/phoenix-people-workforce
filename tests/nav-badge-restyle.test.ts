import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// The sidebar's pending badge: the owner restyled it on 2026-09-04 and was explicit
// that THE MOTION STAYS. That makes this a two-sided pin, and the second side is the
// one worth having — a future "let's calm the sidebar down" pass would reach for the
// animation first, and that is the half he asked to keep.
//
//   • the pump and its faster/bigger overdue escalation must still be applied, and
//     the keyframes behind them must still exist;
//   • pending is a TINTED pill, overdue a SOLID red one, so the two states differ by
//     fill weight and not by hue alone;
//   • every surface tells the badge which rail it is on, because the ring around the
//     collapsed dot is the rail's own background and was hardcoded to the dark one.
// ─────────────────────────────────────────────────────────────────────────────

function readSource(relative: string): string {
  return readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
}

export function runNavBadgeRestyleTests() {
  const badge = readSource("src/components/layout/nav-badge.tsx");
  const globalCss = readSource("app/globals.css");

  // ── The motion. Owner constraint: restyle it, keep the pump ─────────────────
  assert.ok(
    badge.includes('overdue ? "nav-badge-alarm-overdue" : "nav-badge-alarm"'),
    "the badge must still carry a pump class in BOTH states — the owner restyled the fill and kept the motion",
  );
  for (const keyframe of ["nav-badge-alarm-pump", "nav-badge-alarm-pump-urgent", "ep-breathe-orange", "ep-breathe-red"]) {
    assert.ok(globalCss.includes(`@keyframes ${keyframe}`), `${keyframe} must still exist — the badge classes animate with it`);
  }
  assert.ok(
    globalCss.includes("animation: nav-badge-alarm-pump 1s ease-in-out infinite, ep-breathe-orange 1s ease-in-out infinite"),
    "the ordinary pump must stay at 1s",
  );
  assert.ok(
    globalCss.includes("animation: nav-badge-alarm-pump-urgent 0.7s ease-in-out infinite, ep-breathe-red 0.7s ease-in-out infinite"),
    "the overdue pump must stay faster and red — that escalation is the whole SLA signal",
  );

  // ── The restyle: escalation is fill weight, not hue alone ───────────────────
  assert.ok(
    badge.includes('"bg-red-600 text-white ring-1 ring-red-400/50"'),
    "an SLA-overdue count must stay a SOLID red pill — it is the loudest thing the rail can say",
  );
  assert.ok(
    badge.includes('"bg-orange-400/20 text-orange-200 ring-1 ring-orange-400/45"') &&
      badge.includes('"bg-orange-100 text-orange-700 ring-1 ring-orange-300/80"'),
    "an ordinary pending count must be a tinted pill on both rails, so it stops shouting at the volume of an overdue one",
  );
  assert.ok(
    badge.includes("tabular-nums"),
    "the pill scales on every pump; proportional digits change its width mid-animation and read as a stutter",
  );

  // ── Every surface says which rail it is on ──────────────────────────────────
  assert.ok(
    badge.includes('dark ? "ring-slate-900" : "ring-white"'),
    "the collapsed dot's ring is the rail's own background punched around it, so it must follow the rail rather than assume the dark one",
  );
  const callers = {
    "src/components/layout/sidebar.tsx": 2,
    "src/components/layout/horizontal-nav-rows.tsx": 1,
  };
  for (const [file, expected] of Object.entries(callers)) {
    const source = readSource(file);
    const rendered = source.match(/<ApprovalNavBadge\b/g)?.length ?? 0;
    const told = source.match(/<ApprovalNavBadge[^/>]*\bdark=/g)?.length ?? 0;
    assert.equal(rendered, expected, `${file} should render ${expected} ApprovalNavBadge(s); found ${rendered}`);
    assert.equal(
      told,
      rendered,
      `${file} renders ${rendered} badge(s) but tells only ${told} which rail they are on — an untold badge silently takes the light treatment`,
    );
  }

  // The portal rail is light and passes nothing, which is what the default is for.
  const portal = readSource("src/components/employee-portal/employee-portal-layout.tsx");
  assert.ok(
    portal.includes('import { NavBadge } from "@/components/layout/nav-badge";'),
    "the portal must import the badge from its own module, not through the sidebar — that re-export pulled dnd-kit and the layout editor into every portal page's bundle",
  );
  assert.ok(
    !portal.includes("<NavBadge dark"),
    "the portal rail is light, so it must take the default rather than restate it",
  );
}
