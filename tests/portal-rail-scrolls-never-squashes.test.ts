import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * The employee portal's dark icon rail SCROLLS when the window is short — it never squashes its links.
 *
 * Measured 2026-09-16 in headless Chromium (classic scrollbars, dpr 1, dev-auth request headers) on
 * /employee-portals/targets as a National Sales Manager, whose rail holds eight sections; 1024 and
 * 1280px wide read identically. The rail's nav is a column flexbox that scrolls (`flex flex-1 flex-col
 * overflow-y-auto`), and each section link was `h-10` with CSS's initial `flex-shrink: 1`. A flex item
 * shrinks BEFORE its container overflows, down to its automatic minimum — for these links, the 16px
 * icon — so the links gave up their height before the nav scrolled at all:
 *
 *   window height       420px   540px   600px   900px
 *   links, expanded    19.8px  34.8px    40px    40px
 *   links, collapsed     16px  28.8px  36.3px    40px
 *
 * Expanded, the nav read scrollHeight = clientHeight at every height (226 = 226 at 420px). Collapsed at
 * 420px it overflowed by 18px, but only once all eight links had hit their 16px floor. There the active
 * section's 28px marker, taller than its squashed link, ran 6px past it at each end (4.1px expanded),
 * across the links above and below.
 *
 * `shrink-0` keeps every link at its own height; the nav overflows and scrolls instead. Its bar stays
 * HIDDEN — the owner's decision, 2026-09-16: the rail scrolls with the wheel, a trackpad, touch or Tab,
 * and a visible classic bar would cost 15px the 58px rail cannot pay beside a 52px link
 * (tests/shell-chrome-overflows.test.ts holds that width budget).
 *
 * Read off the classes at every breakpoint the rail renders at (the aside is `hidden … lg:block`), the
 * way the width budget is — not a byte window.
 */

const LAYOUT = "src/components/employee-portal/employee-portal-layout.tsx";

/** Tailwind v4's `--spacing`. */
const SPACING_PX = 4;

/** Tailwind's min-width breakpoints, narrowest first: the order their utilities cascade in. */
const BREAKPOINTS = ["", "sm", "md", "lg", "xl", "2xl"] as const;
type Breakpoint = (typeof BREAKPOINTS)[number];

/** The aside is `hidden … lg:block`, so the rail only exists from lg. */
const RAIL_BREAKPOINTS: ReadonlyArray<readonly [Breakpoint, number]> = [
  ["lg", 1024],
  ["xl", 1280],
  ["2xl", 1536],
];

function tokens(className: string): string[] {
  return className.split(/\s+/).filter(Boolean);
}

/** `lg:shrink-0` is ["lg", "shrink-0"]. A colon inside brackets, as in `[scrollbar-width:none]`, belongs to the utility. */
function splitVariant(token: string): [string, string] {
  let depth = 0;
  let split = -1;
  for (let index = 0; index < token.length; index += 1) {
    const char = token[index];
    if (char === "[") depth += 1;
    else if (char === "]") depth -= 1;
    else if (char === ":" && depth === 0) split = index;
  }
  return split === -1 ? ["", token] : [token.slice(0, split), token.slice(split + 1)];
}

/**
 * What one utility family resolves to at a breakpoint. Tailwind emits responsive variants in breakpoint
 * order, so the widest breakpoint at or below this one that sets the family wins, whatever order the
 * classes are written in. Any other variant (`hover:`, `max-lg:`, `[&…]:`) is not charged.
 */
function resolveAt<T>(list: string[], breakpoint: Breakpoint, read: (utility: string) => T | null): T | null {
  let value: T | null = null;
  for (const scope of BREAKPOINTS.slice(0, BREAKPOINTS.indexOf(breakpoint) + 1)) {
    for (const token of list) {
      const [variant, utility] = splitVariant(token);
      if (variant !== scope) continue;
      const resolved = read(utility);
      if (resolved !== null) value = resolved;
    }
  }
  return value;
}

/** A spacing value in px: `10` is 40, `px` is 1, `[40px]` is 40, `[2.5rem]` is 40. */
function spacingPx(value: string): number | null {
  if (value === "px") return 1;
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * SPACING_PX;
  const arbitrary = value.match(/^\[(\d+(?:\.\d+)?)(px|rem)\]$/);
  if (arbitrary) return Number(arbitrary[1]) * (arbitrary[2] === "rem" ? 16 : 1);
  return null;
}

function heightOf(utility: string): number | null {
  const match = utility.match(/^(?:h|size)-(.+)$/);
  return match ? spacingPx(match[1]) : null;
}

function minHeightOf(utility: string): number | null {
  const match = utility.match(/^min-h-(.+)$/);
  return match ? spacingPx(match[1]) : null;
}

/** `flex-shrink` from one utility; unset, CSS's initial value is 1. */
function shrinkOf(utility: string): number | null {
  if (utility === "shrink-0" || utility === "flex-shrink-0" || utility === "flex-none") return 0;
  if (["shrink", "flex-shrink", "flex-1", "flex-auto", "flex-initial"].includes(utility)) return 1;
  const numeric = utility.match(/^(?:flex-)?shrink-(?:\[(\d+(?:\.\d+)?)\]|(\d+))$/);
  return numeric ? Number(numeric[1] ?? numeric[2]) : null;
}

function displayOf(utility: string): string | null {
  return ["flex", "inline-flex", "grid", "inline-grid", "block", "inline-block", "hidden", "contents"].includes(utility)
    ? utility
    : null;
}

function directionOf(utility: string): string | null {
  const match = utility.match(/^flex-(row|col)(?:-reverse)?$/);
  return match ? match[1] : null;
}

function overflowYOf(utility: string): string | null {
  const match = utility.match(/^overflow-y-(auto|scroll|hidden|clip|visible)$/);
  return match ? match[1] : null;
}

function overflowOf(utility: string): string | null {
  const match = utility.match(/^overflow-(auto|scroll|hidden|clip|visible)$/);
  return match ? match[1] : null;
}

export function runPortalRailScrollsNeverSquashesTests() {
  const layout = stripComments(readFileSync(LAYOUT, "utf8"));
  const sidebarStart = layout.indexOf("export function EmployeePortalSidebar");
  assert.notEqual(sidebarStart, -1, `${LAYOUT}: EmployeePortalSidebar is gone — re-point this test.`);
  const sidebar = layout.slice(sidebarStart);

  const railMatch = sidebar.match(/<div className=\{`\$\{collapsed \? "w-full" : "w-\[\d+px\]"\} shrink-0[^`]*`\}>/);
  assert.ok(
    railMatch && railMatch.index !== undefined,
    `${LAYOUT}: the icon rail is no longer \`\${collapsed ? "w-full" : "w-[…px]"} shrink-0 …\`.`,
  );
  const rail = sidebar.slice(railMatch.index);

  const navMatch = rail.match(/<nav className="([^"]*)">/);
  assert.ok(
    navMatch && navMatch.index !== undefined,
    `${LAYOUT}: the icon rail no longer holds a <nav> with a literal className.`,
  );
  const nav = tokens(navMatch[1]);
  const navBody = rail.slice(navMatch.index, rail.indexOf("</nav>", navMatch.index));

  const linkOpen = navBody.indexOf("<Link");
  assert.notEqual(linkOpen, -1, `${LAYOUT}: the icon rail's nav no longer renders its sections as <Link>s.`);
  const linkBody = navBody.slice(linkOpen);
  const linkMatch = linkBody.match(/className=\{`([^`$]*)\$\{/);
  assert.ok(linkMatch, `${LAYOUT}: the rail link no longer opens with a static className before its active-state switch.`);
  const linkClassName = linkMatch[1].trim();
  const link = tokens(linkClassName);

  const markerMatch = linkBody.match(/<span className="([^"]*\babsolute\b[^"]*)" \/>/);
  assert.ok(markerMatch, `${LAYOUT}: the rail link no longer draws its active marker as an absolute <span>.`);
  const marker = tokens(markerMatch[1]);

  const iconMatch = linkBody.match(/<Icon className="([^"]*)" \/>/);
  assert.ok(iconMatch, `${LAYOUT}: the rail link no longer draws its section <Icon> with a literal className.`);
  const icon = tokens(iconMatch[1]);

  // The owner's decision, 2026-09-16: a rail that scrolls keeps its bar hidden.
  const visibleBar: string[] = [];
  if (!nav.includes("[scrollbar-width:none]")) visibleBar.push("`[scrollbar-width:none]` is gone");
  if (!nav.includes("[&::-webkit-scrollbar]:hidden")) visibleBar.push("`[&::-webkit-scrollbar]:hidden` is gone");
  if (nav.includes("phoenix-employee-sidebar-scroll")) {
    visibleBar.push("`.phoenix-employee-sidebar-scroll` is back — unlayered, it draws a thin orange bar over any utility");
  }
  assert.deepEqual(
    visibleBar,
    [],
    `${LAYOUT}: the icon rail's nav shows a scrollbar again (${visibleBar.join("; ")}). The owner decided on ` +
      `2026-09-16 that the rail scrolls with its bar HIDDEN: the wheel, a trackpad, touch and Tab all still reach ` +
      `every section, and a classic bar costs 15px the 58px rail cannot pay beside a 52px link. Nav: "${navMatch[1]}".`,
  );

  for (const [breakpoint, width] of RAIL_BREAKPOINTS) {
    const at = `at ${breakpoint} (${width}px and up)`;

    const overflowY: string = resolveAt(nav, breakpoint, overflowYOf) ?? resolveAt(nav, breakpoint, overflowOf) ?? "visible";
    assert.ok(
      overflowY === "auto" || overflowY === "scroll",
      `${LAYOUT}: ${at} the icon rail's nav is overflow-y: ${overflowY}, so it cannot scroll. On a short window ` +
        `its lower sections then hang past the card, which is overflow-hidden, and no one can reach them. ` +
        `Nav: "${navMatch[1]}".`,
    );

    const linkHeight: number | null = resolveAt(link, breakpoint, heightOf);
    assert.ok(linkHeight !== null, `${LAYOUT}: ${at} the rail link "${linkClassName}" has no fixed height.`);
    const iconHeight: number = resolveAt(icon, breakpoint, heightOf) ?? 0;
    const display: string | null = resolveAt(nav, breakpoint, displayOf);
    const direction: string = resolveAt(nav, breakpoint, directionOf) ?? "row";
    const columnFlex: boolean = (display === "flex" || display === "inline-flex") && direction === "col";
    const shrink: number = resolveAt(link, breakpoint, shrinkOf) ?? 1;
    const minHeight: number | null = resolveAt(link, breakpoint, minHeightOf);
    // A shrinkable flex item stops at its min-height; left at `auto`, that is the smaller of its own
    // height and its content — the icon.
    const floor: number =
      columnFlex && shrink > 0 ? Math.min(linkHeight, minHeight ?? Math.min(linkHeight, iconHeight)) : linkHeight;
    assert.ok(
      floor >= linkHeight,
      `${LAYOUT}: ${at} a rail link can shrink from ${linkHeight}px to ${floor}px (flex-shrink ${shrink}, ` +
        `min-height ${minHeight === null ? `auto, the ${iconHeight}px icon` : `${minHeight}px`}). Its nav is a column ` +
        `flexbox, and a flex item shrinks before its container overflows — so on a short window the links squash ` +
        `instead of the nav scrolling. That is what was measured on 2026-09-16: at a 420px-tall window the links drew ` +
        `19.8px (16px collapsed) instead of 40px, under a 28px active marker. Keep \`shrink-0\` on the link. ` +
        `Link: "${linkClassName}".`,
    );

    const markerHeight: number | null = resolveAt(marker, breakpoint, heightOf);
    assert.ok(markerHeight !== null, `${LAYOUT}: ${at} the active marker "${markerMatch[1]}" has no fixed height.`);
    assert.ok(
      markerHeight <= floor,
      `${LAYOUT}: ${at} the active section's ${markerHeight}px marker is taller than the ${floor}px its link can ` +
        `be held to, so it lies across the links above and below it. Marker: "${markerMatch[1]}".`,
    );
  }
}
