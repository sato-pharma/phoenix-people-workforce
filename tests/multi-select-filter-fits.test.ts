import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  DROPDOWN_PANEL_EDGE_SAFETY,
  DROPDOWN_PANEL_VIEWPORT_GUTTER,
  DROPDOWN_PANEL_WIDTH,
  measureDropdownPanel,
  measureDropdownRoom,
  placeDropdownPanel,
  type HorizontalEdges,
  type MeasuredBox,
} from "../src/lib/ui/dropdown-panel-placement.ts";

// THE SQUARE-EDGE, NO-ELLIPSIS AND FITS-THE-SCREEN GOLDEN RULES (AGENTS.md §4), pinned for the two
// shared filter dropdowns: MultiSelectFilter (12 importers, every sales filter bar among them) and
// RoiMultiSelect (the Marketing ROI and Coverage Report filters).
//
// WHY THIS FILE EXISTS. On 2026-09-17 the owner found all three rules broken in the same control. The
// summary line and every option label were `truncate`, so a long distributor or product name ended in
// an ellipsis. The trigger, the panel and five controls inside it had rounded corners. And the 320px
// panel always hung from its trigger's LEFT edge: from a right-hand grid cell it ran past the screen.
// With every dropdown open on the managers' Weekly Sales page in a 1,440px window, `main` grew 58px
// wider than its box, and on the live portal at 1280px the Distributor panel spanned 1,030 → 1,286px of
// a 1,265px page.
//
// WHAT IT PINS.
//   1. No class string in either dropdown draws a round corner or an ellipsis, or opens a sideways
//      scroll box or a width floor.
//   2. The label, the summary and every option label wrap, and the trigger may grow to hold them.
//   3. The panel's CSS width can never outgrow its trigger, and the measured placement is wired in.
//   4. The placement: right-half triggers hang from their right edge, the display zoom is divided
//      out, and the room is the viewport less a gutter, cut down to `main` and every clipping box.
//
// WHEN IT FIRES. Wrap the text, square the corner, keep the panel measured. Never shrink the type, and
// never put the ellipsis back (AGENTS.md §4).

const FILTER = "src/components/ui/multi-select-filter.tsx";
const ROI = "src/components/marketing-requests/roi-multi-select.tsx";
const HOOK = "src/hooks/use-dropdown-panel-placement.ts";

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}

// ── 1. class strings ────────────────────────────────────────────────────────────────────────────────

const FORBIDDEN: { rule: string; matches: (utility: string) => boolean }[] = [
  { rule: "a round corner (the square-edge golden rule)", matches: (utility) => /^rounded(-|$)/.test(utility) },
  {
    rule: "an ellipsis (text wraps instead)",
    matches: (utility) => /^(truncate$|text-ellipsis$|line-clamp-)/.test(utility),
  },
  {
    rule: "a sideways scroll box (the fits-the-screen golden rule)",
    matches: (utility) => /^overflow-(x-)?(auto|scroll)$/.test(utility),
  },
  {
    rule: "a width floor that outgrows the screen",
    matches: (utility) => /^min-w-(\[|\(|max$|fit$|screen$)/.test(utility),
  },
];

/** Every string a class can be spelled in: string literals, template text, JSX attribute strings. */
function classStringProblems(rel: string): string[] {
  const source = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const problems: string[] = [];
  let tokens = 0;
  const visit = (node: ts.Node): void => {
    const text =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
        ? node.text
        : null;
    if (text !== null) {
      for (const token of text.split(/\s+/)) {
        if (!token) continue;
        tokens += 1;
        // `md:rounded-lg`, `!rounded`, `rounded!`: the utility is what follows the last variant.
        const utility = (token.split(":").pop() ?? "").replace(/^!|!$/g, "");
        const hit = FORBIDDEN.find((rule) => rule.matches(utility));
        if (hit) {
          const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          problems.push(`${rel}:${line} "${token}" is ${hit.rule}.`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  // Positive control: a file this scan failed to read as TSX would otherwise pass with nothing found.
  if (tokens < 100) problems.push(`${rel}: only ${tokens} class tokens were read; the scan is not seeing the file.`);
  return problems;
}

// ── 2 and 3. wrapping, and the panel's wiring ───────────────────────────────────────────────────────

/** The classes of the element whose only child is `{expression}`, e.g. `<span className="…">{label}</span>`. */
function classesAround(source: string, expression: string, rel: string): string[] {
  const escaped = expression.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = source.match(new RegExp(`<span className="([^"]*)">\\{${escaped}\\}</span>`));
  assert.ok(found, `${rel}: {${expression}} is no longer rendered by a <span> with a plain className; re-check that it wraps`);
  return found[1].split(/\s+/);
}

function wrappingProblems(rel: string, expressions: string[]): string[] {
  const source = read(rel);
  const problems: string[] = [];
  for (const expression of expressions) {
    const classes = classesAround(source, expression, rel);
    // `break-words` breaks a word longer than the line, and `min-w-0` lets the flex item shrink to a
    // line at all: without it the item keeps its longest word's width and pushes past its box.
    for (const needed of ["min-w-0", "break-words"]) {
      if (!classes.includes(needed)) problems.push(`${rel}: {${expression}} must carry \`${needed}\`; it has "${classes.join(" ")}".`);
    }
  }
  // A fixed height clips the second line of a wrapped summary; the trigger keeps 58px as its floor.
  if (!/<summary\s[^>]*className="[^"]*\bmin-h-\[58px\]/.test(source)) {
    problems.push(`${rel}: the trigger must be \`min-h-[58px]\`, so a wrapped summary can grow it.`);
  }
  if (/(?<![\w-])h-\[58px\]/.test(source)) problems.push(`${rel}: \`h-[58px]\` is back; it clips a summary that wraps.`);
  return problems;
}

function panelProblems(rel: string): string[] {
  const source = read(rel);
  const problems: string[] = [];
  const panel = source.match(/<div\s+className="(absolute left-0 top-full [^"]*)"\s+style=\{panelStyle\}/);
  if (!panel) {
    problems.push(`${rel}: the panel must be \`absolute left-0\` and wear \`style={panelStyle}\`, the measured placement.`);
  } else {
    const classes = panel[1].split(/\s+/);
    // The fallback until the first measurement: never wider than the trigger, which is on the screen.
    if (!classes.includes("max-w-full")) problems.push(`${rel}: the panel's CSS fallback must be \`max-w-full\`; it has "${panel[1]}".`);
    if (!classes.includes(`w-[${DROPDOWN_PANEL_WIDTH}px]`)) {
      problems.push(`${rel}: the panel's CSS width must be \`w-[${DROPDOWN_PANEL_WIDTH}px]\`, the width the placement prefers; it has "${panel[1]}".`);
    }
  }
  // Inside the zoomed `main`, 100vw is not compensated, and a width taken from the viewport says nothing
  // about where the trigger stands.
  if (/100vw/.test(source)) problems.push(`${rel}: a width taken from \`100vw\` is back; the panel is measured instead.`);
  // The hook's result is destructured. Kept as `panel`, every `panel.x` read fails react-hooks/refs
  // (the account is in the hook's comment), and lint is a required check.
  const wiring = [
    [/const \{[^}]*\} = useDropdownPanelPlacement\(\);/, "destructures useDropdownPanelPlacement()"],
    [/<details\s[^>]*ref=\{detailsRef\}/, "gives the <details> `ref={detailsRef}`"],
    [/<details\s[^>]*onToggle=\{onToggle\}/, "gives the <details> `onToggle={onToggle}`"],
    [/<summary\s[^>]*onClick=\{onSummaryClick\}/, "gives the <summary> `onClick={onSummaryClick}`"],
  ] as const;
  for (const [pattern, what] of wiring) {
    if (!pattern.test(source)) problems.push(`${rel}: the dropdown no longer ${what}.`);
  }
  return problems;
}

// ── 4. the placement ────────────────────────────────────────────────────────────────────────────────

type Placed = { left: number; right: number; width: number; offsetLeft: number };

/** Place a panel and read its edges back in screen pixels, the way the page will paint them. */
function place(trigger: HorizontalEdges, room: HorizontalEdges, zoom: number): Placed {
  const placement = placeDropdownPanel({ room, trigger, zoom });
  const left = trigger.left + placement.offsetLeft * zoom;
  return { left, offsetLeft: placement.offsetLeft, right: left + placement.width * zoom, width: placement.width };
}

type FakeBox = MeasuredBox & { overflowX: string };

/** One box of a fake page: `rect` in screen pixels, `offsetWidth` in its own pixels (so a zoom shows). */
function box(
  tagName: string,
  parent: FakeBox | null,
  rect: HorizontalEdges,
  { border = 0, overflowX = "visible", zoom = 1 }: { border?: number; overflowX?: string; zoom?: number } = {},
): FakeBox {
  const offsetWidth = (rect.right - rect.left) / zoom;
  return {
    clientLeft: border,
    clientWidth: offsetWidth - border * 2,
    getBoundingClientRect: () => ({ left: rect.left, right: rect.right, width: rect.right - rect.left }),
    offsetWidth,
    overflowX,
    parentElement: parent,
    tagName,
  };
}

const overflowOf = (measured: MeasuredBox) => (measured as FakeBox).overflowX;

const near = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${what}: expected ${expected}, got ${actual}`);

export function runMultiSelectFilterFitsTests() {
  // ── 1. No round corner, no ellipsis, no sideways scroll box, no width floor ─────────────────────────
  const classProblems = [...classStringProblems(FILTER), ...classStringProblems(ROI)];
  assert.deepEqual(
    classProblems,
    [],
    `The shared filter dropdowns broke a golden rule:\n  ${classProblems.join("\n  ")}\n` +
      `Square corners only, and text wraps instead of ending in an ellipsis (AGENTS.md §4).`,
  );

  // ── 2. Everything a person reads wraps ────────────────────────────────────────────────────────────
  const wrapProblems = [
    ...wrappingProblems(FILTER, ["label", "summary", "option.label"]),
    ...wrappingProblems(ROI, ["label", "summary", "option.label"]),
  ];
  assert.deepEqual(wrapProblems, [], `A dropdown's text no longer wraps:\n  ${wrapProblems.join("\n  ")}`);

  // ── 3. The panel is measured, and its fallback cannot outgrow the trigger ───────────────────────────
  const wiringProblems = [...panelProblems(FILTER), ...panelProblems(ROI)];
  assert.deepEqual(wiringProblems, [], `A dropdown's panel is no longer kept on the screen:\n  ${wiringProblems.join("\n  ")}`);

  // The hook: measured in the summary's click handler BEFORE the details opens (a `toggle` listener
  // alone paints one frame in the wrong place first), again on toggle, and again on a viewport change.
  const hook = read(HOOK);
  assert.match(
    hook,
    /const onSummaryClick = useCallback\(\(\) => \{\s*if \(detailsRef\.current && !detailsRef\.current\.open\) reposition\(\);/,
    "the summary's click must measure the panel while the details is still shut, before the click opens it",
  );
  assert.match(hook, /if \(isOpen\) reposition\(\);/, "opening the details by any route must measure the panel again");
  assert.match(
    hook,
    /useRepositionOnViewportChange\(open, reposition\);/,
    "a viewport change while the panel is open must measure it again, or a rotated phone keeps the old placement",
  );
  assert.match(
    hook,
    /\{ marginLeft: placement\.offsetLeft, maxWidth: "none", width: placement\.width \}/,
    "the panel must wear the measured offset and width, with the fallback's max-width lifted",
  );

  // ── 4a. The display zoom is divided out ─────────────────────────────────────────────────────────────
  {
    // A room of exactly 256 screen pixels holds a whole 320px panel at 0.8. Read in screen pixels, it
    // would be narrowed to 256 of its own pixels (205 on screen) and pulled back only 80% of the way.
    const zoom = 0.8;
    const room = { left: 500, right: 756 };
    const placed = place({ left: 600, right: 740 }, room, zoom);
    assert.equal(placed.width, DROPDOWN_PANEL_WIDTH, `a room of 256 screen px holds all ${DROPDOWN_PANEL_WIDTH} CSS px at zoom 0.8; got ${placed.width}`);
    near(placed.left, room.left, "the panel fills the room exactly: its left edge");
    near(placed.right, room.right, "the panel fills the room exactly: its right edge");
  }

  // ── 4b. The live-portal failure at 1280px, as a fixture ───────────────────────────────────────────
  {
    // Measured on the live portal at 1280×800 (effective zoom 0.8): a 1,265px page, a 877px-wide `main`
    // ending 16px short of the page's right edge, and the Distributor panel opening at 1,030px — its
    // trigger's left edge. The trigger's right edge is where a fourth grid cell ends inside that `main`
    // (a 16px card padding at 0.8 is 12.8px). Before the fix the panel spanned 1,030 → 1,286px.
    const zoom = 0.8;
    const page = box("HTML", null, { left: 0, right: 1265 });
    const main = box("MAIN", page, { left: 372, right: 1249 }, { zoom });
    const trigger = box("DETAILS", main, { left: 1030, right: 1236 }, { zoom });
    const room = measureDropdownRoom(trigger, 1265, overflowOf);
    near(room.left, 372 + DROPDOWN_PANEL_EDGE_SAFETY, "the room starts inside main's left edge");
    near(room.right, 1249 - DROPDOWN_PANEL_EDGE_SAFETY, "the room ends inside main's right edge, not the page's");

    const placed = place({ left: 1030, right: 1236 }, room, zoom);
    assert.ok(placed.right <= 1249, `the panel must end inside main (1,249px); it ends at ${placed.right}px`);
    assert.ok(placed.left >= 372, `the panel must start inside main (372px); it starts at ${placed.left}px`);
    near(placed.right, 1236, "a trigger in the right half hangs its panel from its RIGHT edge (1,236px)");
    assert.equal(
      placed.width,
      DROPDOWN_PANEL_WIDTH,
      `the room holds the whole panel, so it keeps its full ${DROPDOWN_PANEL_WIDTH}px of its own pixels (256 on screen at 0.8)`,
    );
    near(placed.right - placed.left, DROPDOWN_PANEL_WIDTH * zoom, "the panel is 256px wide on the screen");

    // The whole path from the DOM gives the same answer: the zoom comes from the trigger's rect over its
    // offsetWidth, never from a remembered 0.8.
    const measured = measureDropdownPanel(trigger, 1265, overflowOf);
    assert.deepEqual(
      measured,
      placeDropdownPanel({ room, trigger: { left: 1030, right: 1236 }, zoom }),
      "measureDropdownPanel must read the zoom off the trigger itself (rect width over offsetWidth)",
    );
  }

  // ── 4c. Left-half triggers hang from their left edge ────────────────────────────────────────────────
  {
    const placed = place({ left: 380, right: 600 }, { left: 373, right: 1248 }, 0.8);
    assert.equal(placed.offsetLeft, 0, `a trigger in the left half keeps its panel flush with its left edge; offset was ${placed.offsetLeft}`);
    assert.equal(placed.width, DROPDOWN_PANEL_WIDTH);
  }

  // ── 4d. A room narrower than the panel narrows the panel, and nothing crosses it ────────────────────
  {
    // A phone: no zoom below 1024px, and a 240px room.
    const room = { left: 20, right: 260 };
    const placed = place({ left: 140, right: 250 }, room, 1);
    assert.equal(placed.width, 240, `the panel narrows to the 240px room and its labels wrap; width was ${placed.width}`);
    assert.ok(placed.left >= room.left && placed.right <= room.right, `the panel must stay inside the room; it spans ${placed.left} → ${placed.right}`);
  }

  // ── 4e. Every trigger, every zoom step, every room: the panel stays inside ──────────────────────────
  {
    let cases = 0;
    for (const zoom of [1, 0.9, 0.85, 0.8, 0.75]) {
      for (const room of [
        { left: 8, right: 367 },
        { left: 12, right: 753 },
        { left: 373, right: 1248 },
        { left: 250, right: 1417 },
      ]) {
        for (let triggerWidth = 100; triggerWidth <= 400; triggerWidth += 60) {
          for (let left = room.left; left + triggerWidth <= room.right; left += 37) {
            const trigger = { left, right: left + triggerWidth };
            const placed = place(trigger, room, zoom);
            const what = `zoom ${zoom}, room ${room.left}→${room.right}, trigger ${trigger.left}→${trigger.right}`;
            // Exact, not rounded: the room is already a pixel inside every real edge, and that pixel is for
            // the browser's snapping, not for arithmetic.
            assert.ok(placed.left >= room.left - 1e-6, `${what}: the panel starts at ${placed.left}, left of the room`);
            assert.ok(placed.right <= room.right + 1e-6, `${what}: the panel ends at ${placed.right}, right of the room`);
            near(placed.width, Math.min(DROPDOWN_PANEL_WIDTH, (room.right - room.left) / zoom), `${what}: width`);
            const rightHalf = trigger.left + trigger.right > room.left + room.right;
            const flushFits = rightHalf
              ? trigger.right - placed.width * zoom >= room.left
              : trigger.left + placed.width * zoom <= room.right;
            if (flushFits && rightHalf) {
              near(placed.right, trigger.right, `${what}: a right-half trigger's panel ends at its right edge`);
            } else if (flushFits) {
              near(placed.offsetLeft, 0, `${what}: a left-half trigger's panel stays on its left edge`);
            }
            cases += 1;
          }
        }
      }
    }
    assert.ok(cases > 500, `the sweep ran only ${cases} cases`);
  }

  // ── 4f. A room narrower than the trigger keeps the panel under the trigger ──────────────────────────
  {
    const placed = place({ left: 100, right: 300 }, { left: 150, right: 250 }, 0.8);
    assert.equal(placed.offsetLeft, 0, "a trigger wider than its room keeps its panel under itself");
    near(placed.width, 250, "…and no wider than the trigger (200 screen px at 0.8)");
    for (const zoom of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const odd = placeDropdownPanel({ room: { left: 8, right: 1257 }, trigger: { left: 100, right: 300 }, zoom });
      assert.deepEqual(odd, { offsetLeft: 0, width: DROPDOWN_PANEL_WIDTH }, `a zoom of ${zoom} is read as no zoom`);
    }
  }

  // ── 4g. The room: the viewport's gutter, `main`, and every clipping box, never a visible one ────────
  {
    const zoom = 0.8;
    const page = box("HTML", null, { left: 0, right: 1425 });
    const shell = box("DIV", page, { left: 0, right: 1425 }, { overflowX: "hidden" });
    const main = box("MAIN", shell, { left: 300, right: 1409 }, { zoom });
    // A card that clips, 1 CSS px of border at 0.8, inside a wrapper that does not.
    const card = box("SECTION", main, { left: 400, right: 1200 }, { border: 1, overflowX: "hidden", zoom });
    const wrapper = box("DIV", card, { left: 420, right: 1180 }, { zoom });
    // An inline wrapper has no width to give, whatever its overflow says.
    const inline = { ...box("SPAN", wrapper, { left: 0, right: 0 }), clientWidth: 0, offsetWidth: 0, overflowX: "hidden" };
    const anchor = box("DETAILS", inline, { left: 1000, right: 1150 }, { zoom });

    const room = measureDropdownRoom(anchor, 1425, overflowOf);
    near(room.left, 400 + 1 * zoom + DROPDOWN_PANEL_EDGE_SAFETY, "the clipping card's inner left edge, zoomed border and all");
    near(room.right, 400 + 1 * zoom + (1000 - 2) * zoom - DROPDOWN_PANEL_EDGE_SAFETY, "the clipping card's inner right edge");

    const openCard = box("SECTION", main, { left: 400, right: 1200 }, { border: 1, zoom });
    const inOpenCard = box("DETAILS", openCard, { left: 1000, right: 1150 }, { zoom });
    const unclipped = measureDropdownRoom(inOpenCard, 1425, overflowOf);
    near(unclipped.left, 300 + DROPDOWN_PANEL_EDGE_SAFETY, "a card that does not clip gives no edge; main does");
    near(unclipped.right, 1409 - DROPDOWN_PANEL_EDGE_SAFETY, "main counts although its overflow is visible: its scrollWidth is what grows");

    const bare = box("DETAILS", page, { left: 10, right: 200 });
    const viewportOnly = measureDropdownRoom(bare, 1425, overflowOf);
    assert.deepEqual(
      viewportOnly,
      { left: DROPDOWN_PANEL_VIEWPORT_GUTTER, right: 1425 - DROPDOWN_PANEL_VIEWPORT_GUTTER },
      "outside main, the room is the viewport less its gutter on both sides",
    );

    const hidden = { ...box("DETAILS", main, { left: 0, right: 0 }), offsetWidth: 0 };
    assert.equal(measureDropdownPanel(hidden, 1425, overflowOf), null, "a trigger that is not laid out leaves the panel on its CSS fallback");
  }
}
