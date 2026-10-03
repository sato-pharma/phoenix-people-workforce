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
  const glows = ["nav-badge-glow", "nav-badge-glow-urgent"];
  for (const keyframe of ["nav-badge-alarm-pump", "nav-badge-alarm-pump-urgent", "ep-breathe-orange", ...glows]) {
    assert.ok(globalCss.includes(`@keyframes ${keyframe}`), `${keyframe} must still exist — the badge classes animate with it`);
  }
  assert.ok(
    /\.nav-badge-alarm \{\s*animation: nav-badge-alarm-pump 1s ease-in-out infinite;/.test(globalCss),
    "the ordinary pump must stay at 1s",
  );
  assert.ok(
    /\.nav-badge-alarm-overdue \{\s*animation: nav-badge-alarm-pump-urgent 0\.7s ease-in-out infinite;/.test(globalCss),
    "the overdue pump must stay faster — that escalation is the whole SLA signal",
  );
  assert.ok(
    globalCss.includes("animation: nav-badge-glow 1s ease-in-out infinite;") &&
      globalCss.includes("animation: nav-badge-glow-urgent 0.7s ease-in-out infinite;") &&
      globalCss.includes("background: rgb(220 38 38);"),
    "the glow keeps the pump's own timing, and the overdue glow stays faster and red",
  );

  // ── The glow is drawn on the compositor (owner, 2026-10-03: "cheap to draw, same look") ───────
  // An animated box-shadow repaints every frame for as long as a count waits: measured 112-136% of
  // a CPU core for the portal's three pulsing badges, against 17-30% for this glow. So the
  // glow keyframes may move ONLY transform and opacity, and the badge rules must not bring the
  // box-shadow breathe back. The one see-through pill is the documented exception.
  for (const glow of glows) {
    const block = new RegExp(`@keyframes ${glow} \\{([\\s\\S]*?)\\n\\}`).exec(globalCss)?.[1] ?? "";
    assert.ok(block.includes("transform") && block.includes("opacity"), `${glow} must animate transform and opacity`);
    assert.ok(!/box-shadow|background|width|height|inset/.test(block), `${glow} must not animate a property that repaints`);
  }
  for (const rule of [/\.nav-badge-alarm \{([^}]*)\}/, /\.nav-badge-alarm-overdue \{([^}]*)\}/]) {
    const body = rule.exec(globalCss)?.[1] ?? "";
    assert.ok(body.includes("animation:") && !body.includes("ep-breathe"), "the alarm badge must not animate the box-shadow breathe again");
  }
  assert.ok(
    /\.nav-badge-alarm::before,[\s\S]*?\{[^}]*background: inherit;[^}]*z-index: -1;/.test(globalCss),
    "a copy of the badge's own fill must sit over the glow, or the glow tints the inside of the badge",
  );

  // Same look: the glow must grow the same number of pixels on every side, as the box-shadow did.
  // One shared scale cannot — a "27" badge is wider than tall, so its glow showed above and below
  // before the sides (seen frame by frame, 2026-10-03). So each axis starts from the badge's own
  // measured size, and every pulsing badge must hand that size over.
  for (const [glow, spread] of [["nav-badge-glow", 14], ["nav-badge-glow-urgent", 16]] as const) {
    const block = new RegExp(`@keyframes ${glow} \\{([\\s\\S]*?)\\n\\}`).exec(globalCss)?.[1] ?? "";
    assert.ok(
      block.includes(`scale(calc(var(--glow-w, 16) / (var(--glow-w, 16) + ${spread})), calc(var(--glow-h, 16) / (var(--glow-h, 16) + ${spread})))`),
      `${glow} must start each axis from the badge's own width and height, or a wide badge's glow is lopsided`,
    );
  }
  const sizer = readSource("src/components/layout/alarm-glow.ts");
  assert.ok(
    sizer.includes('setProperty("--glow-w", String(badge.offsetWidth))') && sizer.includes('setProperty("--glow-h", String(badge.offsetHeight))'),
    "the glow's start size is the badge's LAYOUT size, which the pump's transform does not change",
  );
  assert.ok(sizer.includes("new ResizeObserver"), "a count that changes width (9 -> 10) must re-measure, or the glow is sized for the old width");
  const pulsingBadges: Record<string, number> = {
    "src/components/layout/nav-badge.tsx": 3,
    "src/components/layout/in-app-notifications-bell.tsx": 1,
    "src/components/employee-portal/employee-portal-layout.tsx": 2,
    "src/components/employee-portal/portal-chrome-widgets.tsx": 1,
  };
  for (const [file, expected] of Object.entries(pulsingBadges)) {
    const measured = readSource(file).match(/ref=\{alarmGlowRef\}/g)?.length ?? 0;
    assert.equal(measured, expected, `${file} should hand ${expected} pulsing badge(s) to alarmGlowRef; found ${measured}`);
  }
  assert.ok(
    badge.includes('!overdue && dark && "nav-badge-alarm-glass"') &&
      /prefers-reduced-motion: no-preference[\s\S]*\.nav-badge-alarm\.nav-badge-alarm-glass \{\s*animation: nav-badge-alarm-pump 1s ease-in-out infinite, ep-breathe-orange 1s ease-in-out infinite;/.test(globalCss),
    "the see-through dark-rail pill keeps its box-shadow glow — a copy of a 20% fill would double it",
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
