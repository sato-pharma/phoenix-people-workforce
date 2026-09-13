import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The searchable dropdown stayed open after its field scrolled out of sight.
 *
 * Seen in the owner's video of the Weekly / Monthly Plan page, 2026-09-13: he opened an Activity
 * picker and scrolled the page. The field went up under the portal's sticky header, and the option
 * list — position:fixed, portalled to <body> — kept tracking it and drew itself over the header,
 * hanging from nothing.
 *
 * The scroll listener used to be `updateMenuPosition` itself, which only ever MOVES the panel. It
 * now hit-tests the field's centre and closes the panel when the field is no longer the thing on
 * screen there. `SearchableSelect` is shared by every dropdown in the application, so this reads the
 * component's source (as tests/searchable-select-no-ellipsis.test.ts does): the defect is which
 * function the scroll listener runs, and a node test cannot scroll a browser.
 */
export function runSearchableSelectHiddenTriggerTests() {
  const source = readFileSync("src/components/ui/searchable-select.tsx", "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  // Headline: a page scroll must not be handled by the reposition function alone.
  assert.ok(
    !/addEventListener\("scroll", updateMenuPosition/.test(code),
    "the scroll listener is `updateMenuPosition` again — that only moves the panel, so it follows a field hidden under the header instead of closing",
  );

  const scrollHandler = code.match(/const onScroll = \(event: Event\) => \{([\s\S]*?)\n    \};/);
  assert.ok(scrollHandler, "the dropdown's scroll handler moved or was renamed; re-check that it closes a hidden field's panel");
  const body = scrollHandler[1];
  assert.ok(
    /if \(!triggerIsOnScreen\(\)\) \{\s*setOpen\(false\);/.test(body),
    "a scroll that leaves the field off screen must close the panel",
  );
  assert.ok(
    /dropdownRef\.current\?\.contains\(event\.target\)\) return;/.test(body),
    "scrolling the option list itself must not close the panel",
  );
  assert.ok(
    /addEventListener\("scroll", onScroll, true\)/.test(code) && /removeEventListener\("scroll", onScroll, true\)/.test(code),
    "the scroll handler must be attached in the capture phase (the page scrolls inside containers) and removed the same way",
  );

  // "On screen" is a hit-test, not a viewport-bounds check: a sticky header covers a field that is
  // still inside the viewport, which is exactly the video.
  const visibility = code.match(/const triggerIsOnScreen = React\.useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[\]\);/);
  assert.ok(visibility, "triggerIsOnScreen moved; re-check how the dropdown decides its field is hidden");
  assert.ok(
    /document\.elementFromPoint\(/.test(visibility[1]) && /wrapper\.contains\(hit\)/.test(visibility[1]),
    "the field counts as on screen only when a hit-test at its centre lands inside it — a header over it must count as hidden",
  );
}
