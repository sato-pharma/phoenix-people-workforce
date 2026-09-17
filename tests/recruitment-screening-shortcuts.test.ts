import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * EVERY KEY THIS SCREEN BINDS MUST BE NAMED SOMEWHERE A READER CAN SEE IT.
 *
 * Measured on the branch this test arrived on, 2026-09-18. The screening workstation had bound
 * eight keys since the day it shipped — J and the down arrow for the next CV, K and the up arrow
 * for the one before, S to shortlist, 1/2/3 to star, 0 to clear the star, U to undo, F for full
 * width, Escape to leave it — under a comment that reads, in the source, "the keyboard, for the
 * reader who is doing this two hundred times".
 *
 * SEVEN OF THE EIGHT WERE NAMED NOWHERE ON THE SCREEN. Only U was, in the undo band's footnote.
 * There was no legend, no tooltip and no mark on any button, so the only way to discover the
 * keyboard was to read the TypeScript. The owner screens CVs daily and did all 1,121 of production's
 * records with the mouse; his verdict on the screen was "zero functionality ... its non usable", and
 * the functionality was there the whole time, unfindable. A shortcut nobody can find is not a
 * shortcut, and this file is what stops the next one being added the same way.
 *
 * THE PATTERN IS NOT NEW. This module's own predecessor, candidate-screening-session.tsx, already
 * prints the key inside the button — `<kbd className="text-phx-2xs font-normal opacity-70">S</kbd>`
 * — and names it in the tooltip. The fix adopts that markup, per the standing rule to match the
 * sibling screens rather than invent a look.
 *
 * ONE DELIBERATE DIFFERENCE, and CI found it. The predecessor names the size; the review header must
 * write the same 10px as `text-[10px]`, because `runRecruitmentScreeningWorkstationTests` pins that
 * file against custom NAMED font sizes — `cn()` runs tailwind-merge, which drops `text-phx-2xs`
 * silently, leaving the mark at whatever it inherits and visible only through getComputedStyle in a
 * real browser. The named form went out on this branch's first push and the pin turned the `test`
 * job red, which is exactly the job that pin exists to do.
 *
 * THE `boundKeys` SET BELOW IS A TRIPWIRE, NOT A LIST. It is asserted to equal what the handlers
 * actually bind, so adding a ninth shortcut turns this test red until somebody also decides where
 * the screen SAYS so. That is the whole point: the defect was never a missing keystroke, it was a
 * keystroke with no way in.
 */

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

export async function runScreeningShortcutTests() {
  const workstation = read("../src/components/recruitment/workstation/screening-workstation.tsx");
  const pageClient = read("../src/components/recruitment/workstation/workstation-page-client.tsx");
  const header = read("../src/components/recruitment/workstation/workstation-review-header.tsx");
  const stars = read("../src/components/recruitment/workstation/candidate-stars.tsx");

  // ── 1 · WHAT IS ACTUALLY BOUND ────────────────────────────────────────────────────────────────
  //
  // Read off the two keydown handlers rather than trusted from a list, so this test cannot drift
  // away from the code it is guarding. Both files gate on `typing` first, which is why a search
  // term containing "s" does not decide the CV underneath — that behaviour is pinned separately by
  // the handlers' own guard, not here.
  const bound = new Set<string>();
  for (const source of [workstation, pageClient]) {
    for (const match of source.matchAll(/key(?:\.toLowerCase\(\))? === "([^"]+)"/g)) bound.add(match[1]);
    for (const match of source.matchAll(/event\.key === "(Arrow[A-Za-z]+|Escape)"/g)) bound.add(match[1]);
  }

  const expected = ["0", "1", "2", "3", "ArrowDown", "ArrowUp", "Escape", "f", "j", "k", "s", "u"];
  assert.deepEqual(
    [...bound].sort(),
    expected,
    "the workstation binds a key this test does not know about — decide where the SCREEN says so, then add it here",
  );

  // ── 2 · EACH ONE IS NAMED WHERE IT IS USED ────────────────────────────────────────────────────
  //
  // The headline assertions. Each names the surface a reader would actually be looking at when they
  // need that key — not a help page somewhere else, which is the design that produced the problem.

  // S — shortlist. On the button, in the predecessor's own markup.
  assert.match(header, /hotkey="S"/, "Shortlist must WEAR its key — S was bound and invisible");
  assert.match(
    header,
    /<kbd className="text-\[10px\] font-normal opacity-70">\{hotkey\}<\/kbd>/,
    "…as a kbd at the predecessor's own 10px, in the bracket form this file's font-size pin requires",
  );

  // J and K — moving through the queue. J is on the button; K has no button at all, so the only
  // place it can be taught is that same button's tooltip.
  assert.match(header, /hotkey="J"/, "Next candidate must wear J");
  assert.match(
    header,
    /press J or the down arrow\. K or the up arrow goes back one\./,
    "…and must teach K, which has NO control anywhere — it was reachable only by reading the source",
  );

  // 1 / 2 / 3 and 0 — the stars. In the tooltip, because a 28px glyph has no room for a second mark.
  assert.match(
    stars,
    /\$\{candidateRatingLabels\[value\]\} — press \$\{value\}`/,
    "each star must name the number that sets it — nothing on production's 1,121 CVs is starred",
  );
  assert.match(stars, /, or 0, to take the star off/, "…and clearing must name 0, which is not a rating of zero");

  // U — undo. The one key that was already discoverable; pinned so it stays that way.
  assert.match(workstation, /Or press U\./, "the undo offer must keep naming U");

  // F and Escape — full width. There is no control that ENTERS it, so the way out names the way in.
  assert.match(
    pageClient,
    /Back to the page — or press F again, or Escape/,
    "leaving full width must name F and Escape — no button enters it, so this tooltip is the only teacher",
  );
  assert.match(header, /Leave full-screen reading — or press Escape/, "and full-screen reading must name Escape");

  // ── 3 · REJECT STAYS UNBOUND, AND SAYS SO ─────────────────────────────────────────────────────
  //
  // The one verdict with no key, deliberately: the button opens a panel that asks for a reason, and
  // a keystroke that skipped it would turn every rejection into an unexplained one. Without the
  // tooltip that reads as an oversight beside a Shortlist that HAS a key, which is how a helpful
  // hand comes to add one. Both halves are pinned: no mark on the button, and the reason in words.
  assert.doesNotMatch(
    header,
    /hotkey="R"/,
    "Reject must NOT get a key — it asks for a reason first, and a keystroke would skip the panel",
  );
  assert.match(
    header,
    /No keyboard shortcut on purpose — it asks you for a reason first\./,
    "…and must say why, or the gap beside Shortlist reads as an oversight somebody will 'fix'",
  );

  // ── 4 · THE DECISION STILL MOVES THE WORK ON ──────────────────────────────────────────────────
  //
  // Surfacing the keys is worth nothing if a verdict leaves the reader on the CV they just decided.
  // `decide` advances on its own, which is what makes S a whole cycle rather than half of one, and
  // what the Shortlist tooltip now promises in words.
  assert.match(
    header,
    /The queue moves to the next CV on its own\./,
    "Shortlist's tooltip promises the advance, so the advance must stay promised",
  );
  const decide = workstation.slice(workstation.indexOf("const decide = useCallback("));
  assert.ok(
    decide.slice(0, decide.indexOf("[busy,")).includes("goToNext()"),
    "a decision must still advance to the next CV — without it S is half a cycle and the promise is false",
  );
}
