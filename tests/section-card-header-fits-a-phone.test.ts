import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./support/comment-strip.ts";

/**
 * On a 375px phone, two of the six "Performance breakdown" tabs on /sales/vs-target were
 * UNREACHABLE — not cut, not scrollable-to, simply absent. Found 2026-09-05 by the 375px admin
 * sweep, which measured 28 admin routes; 27 fitted 375px exactly and this was the only breach.
 *
 * The measurement, from the sweep's own record:
 *
 *   main = 526/375   doc = 375/375        <- main overflows 151px, the DOCUMENT does not scroll
 *   past=151 own=0  "Products"           <- pushed wholly past the clip edge
 *   past= 78 own=0  "District Managers"
 *   where: header.flex.items-center.justify-between > div.shrink-0 > div.flex.flex-wrap.gap-1.5 > button
 *
 * `own = 0` says the buttons were not internally truncated: the whole control sat past the edge.
 * And because the document did not scroll while `main` clipped, there was no way to reach them —
 * a Super Admin on a phone could not switch the breakdown to District Managers or Products at all.
 * That is worse than a horizontal scroll, and the fits-the-screen golden rule (AGENTS.md §4)
 * forbids both.
 *
 * The cause was one token. `shrink-0` on SectionCard's actions wrapper guarantees the block keeps
 * its max-content width, and `flex-wrap` only wraps when its container is narrower than its
 * content — so the tab row was never handed a narrow box and could never wrap, at any viewport.
 * The header itself could not wrap either. Fixed by wrapping, never by shrinking type, which is
 * the answer the golden rule names.
 *
 * The third assertion covers the same class of bug in the vs-target hero: `whitespace-nowrap`
 * inside an `overflow-hidden` band, which CUT 61px and lost the words "Direct Orders".
 *
 * Pinned by SHAPE, on comment-stripped source, so the prose above cannot satisfy the assertions —
 * a pinning test that matched its own explanation would pin the anti-pattern (AGENTS.md §2.1).
 */

const SECTION_CARD = "src/components/sales/target-visuals.tsx";
const VS_TARGET = "src/components/sales/vs-target/vs-target-dashboard.tsx";

function tokens(className: string): string[] {
  return className.split(/\s+/).filter(Boolean);
}

export function runSectionCardHeaderFitsAPhoneTests() {
  const sectionCard = stripComments(readFileSync(SECTION_CARD, "utf8"));

  // ── 1. the header must be able to wrap ─────────────────────────────────────────────────────
  const header = sectionCard.match(/<header className="([^"]*)">/);
  assert.ok(
    header,
    `${SECTION_CARD}: SectionCard no longer renders a <header> with a literal className. ` +
      `Re-point this test at whatever lays out the card header — do not drop it.`,
  );
  assert.ok(
    tokens(header[1]).includes("flex-wrap"),
    `${SECTION_CARD}: the SectionCard header is "${header[1]}" — "flex-wrap" is gone. Without it ` +
      `the title and the actions are locked onto one line, and a card whose actions do not fit ` +
      `375px pushes them past the shell's clip edge where the page does not scroll.`,
  );

  // ── 2. the actions block must be allowed to narrow, or its flex-wrap row can never wrap ────
  const actionsWrapper = sectionCard.match(/\{actions \? <div className="([^"]*)">\{actions\}<\/div> : null\}/);
  assert.ok(
    actionsWrapper,
    `${SECTION_CARD}: SectionCard no longer renders {actions} in a <div> with a literal ` +
      `className. Re-point this test at whatever wraps the header actions — do not drop it.`,
  );
  assert.ok(
    !tokens(actionsWrapper[1]).includes("shrink-0"),
    `${SECTION_CARD}: the actions wrapper is "${actionsWrapper[1]}" — "shrink-0" is back. It ` +
      `pins the block to its max-content width, so a "flex flex-wrap" row inside it is never ` +
      `given a narrow box and never wraps. That is exactly what put the "Products" tab 151px ` +
      `past the clip edge on /sales/vs-target, unreachable on a phone.`,
  );

  // ── 3. a long title must wrap, not clip: the box around it is min-w-0 ─────────────────────
  const title = sectionCard.match(/<h2 className="([^"]*)">\{title\}<\/h2>/);
  assert.ok(
    title,
    `${SECTION_CARD}: SectionCard no longer renders {title} in an <h2> with a literal className.`,
  );
  assert.ok(
    !tokens(title[1]).includes("whitespace-nowrap"),
    `${SECTION_CARD}: the card title is "${title[1]}" — "whitespace-nowrap" is back. It sits in ` +
      `a min-w-0 box, so nowrap cannot spill harmlessly: it clips the title instead of wrapping it.`,
  );

  // ── 4. the vs-target hero subtitle: nowrap inside an overflow-hidden band CUTS ─────────────
  const vsTarget = stripComments(readFileSync(VS_TARGET, "utf8"));
  const heroSubtitle = vsTarget.match(
    /<p className="([^"]*)">\s*\{formatPeriod\(data\.period\)\}[^<]*Source of Sales \+ Direct Orders\s*<\/p>/,
  );
  assert.ok(
    heroSubtitle,
    `${VS_TARGET}: the hero no longer renders the period/scope/source line in a <p> with a ` +
      `literal className. Re-point this test at whatever prints it — do not drop it.`,
  );
  assert.ok(
    !tokens(heroSubtitle[1]).includes("whitespace-nowrap"),
    `${VS_TARGET}: the hero subtitle is "${heroSubtitle[1]}" — "whitespace-nowrap" is back. The ` +
      `command band is overflow-hidden, so this does not spill, it CUTS: at 375px it lost 61px, ` +
      `ending the line mid-phrase with "Direct Orders" gone and no marker that anything was cut.`,
  );
}
