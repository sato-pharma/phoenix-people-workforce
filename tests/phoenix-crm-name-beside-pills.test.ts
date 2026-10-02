import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the rep's name-beside-pills row keeps a WIDTH FLOOR on the name.
 *
 * THE DEFECT THIS PINS, measured in a real browser against staging's own emitted stylesheet on
 * 2026-10-02 at a 375px viewport:
 *
 *   | row                       | name column | lines | word broken mid-word |
 *   | visit-customer-picker     | 59.3px      | 6     | yes ("Mohamed", 67px) |
 *   | unplanned-visit-card      | 57.3px      | 7     | yes                   |
 *   | out-of-list-entry         | 144.4px     | 3     | no                    |
 *
 * WHY IT HAPPENS. The pill group is `flex max-w-full flex-wrap gap-1` — `flex: 0 1 auto` with
 * `min-width: auto` — so it never yields below its content. The name was `min-w-0 flex-1`, i.e.
 * `flex: 1 1 0%` with `min-width: 0`, and it carries `break-words`: its min-content is therefore ONE
 * broken character. The flex line can never overflow, so the parent's own `flex-wrap` has nothing to
 * trigger it, the pills keep their full 225px, and the name takes whatever is left.
 *
 * 🔴 WHY NO EXISTING CHECK CAUGHT IT. Nothing scrolls. `document.scrollWidth === clientWidth`, the
 * row's own `scrollWidth === clientWidth`, and `.employee-portal-shell` carries `overflow-x: clip`,
 * so even a real overflow would be clipped rather than scrolled. The fits-the-screen sweep looks for
 * the four sideways-scroll spellings and a raw `<table>`; a name squeezed to a sliver is none of
 * those. It is the same family as "`shrink-0` makes an inner `flex-wrap` inert" (AGENTS.md §4) with
 * the cause inverted: here an INFINITELY SHRINKABLE sibling makes the wrap inert.
 *
 * THE FIX is a floor (`min-w-[9rem]`) so the line does overflow and the pills drop to their own row:
 * at 375px the name column goes 59.3px -> 293px and 6 lines -> 2, with no word broken. At 768px and
 * above nothing moves at all (name column 434-521px, one line, pills still inline), so the look the
 * owner approved on a desktop is untouched.
 *
 * 🔴 `shrink-0` ON THE PILL GROUP IS NOT THE FIX and must never be introduced here — that is the
 * exact pattern the fits-the-screen rule names, and it would freeze the pills instead of letting
 * them wrap.
 *
 * 🔴 THIS FILE IS WRITTEN WITH THE WRITE TOOL, NEVER A HEREDOC. The first version was heredoc'd and
 * the shell ate the backslash out of a `\b` word boundary below, leaving a literal 0x08 BACKSPACE
 * byte in the source: the regex then matched a control character instead of a word boundary, so the
 * truncation assertion was DEAD and passed locally while testing nothing. `validate` caught it on
 * the first push (`tests/heredoc-backslash-damage.test.ts`), which is what that sweep is for. The
 * class tokens are matched with explicit delimiters here rather than `\b`, so there is no escape
 * left to lose.
 */

const read = (p: string) => stripComments(readFileSync(p, "utf8").replace(/\r\n/g, "\n"));

const ROWS = [
  { file: "src/components/phoenix-crm/visit-customer-picker.tsx", name: "the planned/out-of-plan customer picker" },
  { file: "src/components/phoenix-crm/out-of-list-entry.tsx", name: "the out-of-list entry picker" },
  { file: "src/components/phoenix-crm/unplanned-visit-card.tsx", name: "the unplanned visit card" },
];

/**
 * The Tailwind truncation classes, each as a whole class token.
 *
 * A class sits between quotes, spaces, backticks or braces in JSX, so the delimiters are spelled out
 * as a character class instead of a `\b` word boundary — `truncate` inside `overflow-ellipsis` or a
 * prose word must not count, and a lost backslash must not be able to turn this into a regex that
 * silently matches nothing.
 */
const TRUNCATION_CLASSES = ["truncate", "text-ellipsis", "overflow-ellipsis", "line-clamp-1", "line-clamp-2", "line-clamp-3"];
const DELIM = "[\"'`\\s{}]";

function truncationClassIn(source: string): string | null {
  for (const token of TRUNCATION_CLASSES) {
    if (new RegExp(`${DELIM}${token}${DELIM}`).test(source)) return token;
  }
  return null;
}

export function runPhoenixCrmNameBesidePillsTests() {
  // The delimiter-based class matcher is itself checked, so a broken regex cannot read as "clean".
  assert.equal(truncationClassIn('<p className="truncate text-sm">'), "truncate", "the class matcher must find a real truncate class");
  assert.equal(truncationClassIn('<p className="text-sm line-clamp-2">'), "line-clamp-2", "...and a line-clamp");
  assert.equal(truncationClassIn('<p className="break-words text-sm">'), null, "...and must not fire on an unrelated class");
  assert.equal(truncationClassIn("{busy ? \"Approving…\" : \"Approve\"}"), null, "an ellipsis in a progress label is not truncated text");

  for (const row of ROWS) {
    const src = read(row.file);

    // 1. The name column carries the floor, on the element that also carries flex-1.
    assert.match(
      src,
      /className="min-w-\[9rem\] flex-1/,
      `${row.name} (${row.file}): the name column must carry min-w-[9rem] beside flex-1 — with min-w-0 the parent's flex-wrap is inert and the name is squeezed to ~59px at 375px`,
    );

    // 2. ...and the old spelling is gone from the name column specifically.
    assert.equal(
      /className="min-w-0 flex-1">\s*\n\s*<span className="block break-words text-sm font-black/.test(src),
      false,
      `${row.name}: the name column must not go back to min-w-0 flex-1`,
    );
    assert.equal(
      /className="min-w-0 flex-1 break-words font-black/.test(src),
      false,
      `${row.name}: the name paragraph must not go back to min-w-0 flex-1`,
    );

    // 3. The pill group still WRAPS and is never frozen with shrink-0 (the rule's own anti-pattern).
    assert.match(
      src,
      /className="flex max-w-full flex-wrap gap-1"/,
      `${row.name}: the pill group must stay \`flex max-w-full flex-wrap gap-1\` so it can drop to its own row`,
    );
    assert.equal(
      /flex max-w-full shrink-0 flex-wrap|flex shrink-0 max-w-full flex-wrap/.test(src),
      false,
      `${row.name}: shrink-0 on the pill group makes its flex-wrap inert — the exact pattern the fits-the-screen rule names`,
    );

    // 4. The row itself still wraps — the floor only works because the PARENT can break the line.
    assert.match(
      src,
      /className="flex min-w-0 flex-wrap items-start justify-between gap-2"/,
      `${row.name}: the row must keep \`flex min-w-0 flex-wrap items-start justify-between gap-2\` — the floor relies on this wrap engaging`,
    );

    // 5. The name still breaks long words rather than being cut short (the no-ellipsis rule).
    assert.match(src, /break-words/, `${row.name}: the name must still wrap with break-words`);
    const truncated = truncationClassIn(src);
    assert.equal(
      truncated,
      null,
      `${row.name}: never shorten a customer's name — found the truncation class "${truncated}"`,
    );
  }
}
