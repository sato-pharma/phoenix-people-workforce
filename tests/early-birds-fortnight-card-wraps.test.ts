import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The Stars of the Fortnight band must WRAP on a phone — it may never be pinned to one line.
 *
 * Measured 2026-09-02 at 375x812 on /employee-portals, signed in as a Medical Rep. Every text node
 * in this card carried the no-wrap utility, and the card's own `overflow-hidden` then CLIPPED what
 * overflowed rather than scrolling it. That combination hides itself from the usual check: the
 * document measured a clean 375/375 the whole time, because clipped content contributes nothing to
 * `scrollWidth`. What a rep actually saw:
 *
 *   • the dark header held "Stars of the Fortnight · August 1-15, 2026" and "View board" on one
 *     unbreakable row. The link's right edge measured 399px against a 363px `main` — 36px past it
 *     — and the bar read "STARS OF THE FORTNIGHT · AUGUST 1-15, 2026VIEW BOA".
 *   • a winner's own name clipped mid-word: "Hana Abdelaziz Samir Abdelaziz Ghoniem" stopped at the
 *     screen edge. Egyptian names run four and five parts long, so this is the normal case here,
 *     not a long-tail one.
 *
 * The owner's fits-the-screen golden rule (AGENTS.md §4) allows exactly one remedy: WRAPPING.
 * Explicitly NOT a smaller type scale, NOT an ellipsis or `truncate`, and NOT `overflow-x-auto`
 * over a min-width floor — that last one is named in the rule as the bug rather than the fix.
 *
 * This pins the fix by SHAPE, not by a byte window, so an edit elsewhere in the file cannot
 * false-fail it. Comments are stripped first: the prose above and the component's own header
 * comment both name the banned utilities, and a pinning test that matched its own explanation
 * would pin the anti-pattern.
 */

const CARD = "src/components/early-birds/early-bird-of-the-fortnight-card.tsx";

/** Drop block comments and whole-line `//` comments. Never touches a `//` inside a string. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

export function runEarlyBirdsFortnightCardWrapsTests() {
  const code = stripComments(readFileSync(CARD, "utf8"));

  assert.ok(
    code.includes("EarlyBirdOfTheFortnightCard"),
    `${CARD}: the card component is gone — this test is pinning a file that no longer exists.`,
  );

  // Every class actually applied, as exact tokens. Deliberately NOT a regex word boundary: an
  // escape written through a heredoc silently degrades to a backspace character, and the assertion
  // then passes on every input forever (AGENTS.md §2.1 — it happened while writing this file).
  // Token equality cannot be defeated that way, and it also catches a `sm:`-prefixed spelling.
  const classes = new Set(
    [...code.matchAll(/className="([^"]+)"/g)].flatMap((match) => match[1].split(/\s+/)),
  );
  const applied = (utility: string) =>
    [...classes].some((token) => token === utility || token.endsWith(`:${utility}`));

  assert.ok(
    applied("bg-slate-900"),
    `${CARD}: no className carries "bg-slate-900" — the header bar this test reads is gone, so every ` +
      `assertion below would pass vacuously. Re-point the test at the card's real markup.`,
  );

  // 1. The class that caused the clip, in any of the four places it used to sit.
  assert.ok(
    !applied("whitespace-nowrap"),
    `${CARD}: "whitespace-nowrap" is back. This card is a landing-page band on a 375px phone and it ` +
      `sits inside overflow-hidden, so anything that cannot wrap is CLIPPED — silently, with the ` +
      `page still measuring 375/375. If a specific line genuinely must hold together, merge it into ` +
      `fewer words; do not pin the whole line.`,
  );

  // 2. The three remedies the golden rule forbids, so nobody "fixes" a future overflow with one.
  for (const banned of ["truncate", "text-ellipsis", "overflow-x-auto"]) {
    assert.ok(
      !applied(banned),
      `${CARD}: "${banned}" is not an allowed remedy here — AGENTS.md §4 names the ellipsis ban and ` +
        `calls overflow-x-auto over a min-width floor the bug, not the fix. Wrap instead.`,
    );
  }

  // 3. The header must be allowed to break between the title and the "View board" link.
  const header = code.match(/<div className="(flex flex-wrap[^"]*bg-slate-900[^"]*)"/);
  assert.ok(
    header,
    `${CARD}: the dark header row is no longer "flex flex-wrap … bg-slate-900". Without flex-wrap the ` +
      `title and the "View board" link are locked onto one row, which is what overflowed by 36px.`,
  );

  // 4. …and on a phone the title takes the whole row, so it wraps across the full bar instead of
  //    fighting the link for width. From `sm:` up both sit on one line, as they always did.
  const heading = code.match(/<h2 className="([^"]+)"/);
  assert.ok(heading, `${CARD}: the <h2> heading is gone or no longer carries a literal className.`);
  const headingClasses = heading[1].split(/\s+/);
  for (const required of ["basis-full", "sm:basis-auto", "min-w-0"]) {
    assert.ok(
      headingClasses.includes(required),
      `${CARD}: the heading is "${heading[1]}" — missing "${required}". At 360px the title alone is ` +
        `wider than the bar, so it needs the full row to itself on a phone and must be able to ` +
        `shrink below its content.`,
    );
  }

  // 5. A winner's name is the one string here with no safe break point of its own.
  const name = code.match(/<p className="([^"]*)"[^>]*>\s*\{star\.employeeName\}/);
  assert.ok(name, `${CARD}: the winner-name <p> no longer renders {star.employeeName} directly.`);
  assert.ok(
    name[1].split(/\s+/).includes("break-words"),
    `${CARD}: the winner-name line is "${name[1]}" — missing "break-words". "Hana Abdelaziz Samir ` +
      `Abdelaziz Ghoniem" is a real winner, and on a phone it has to break rather than run off.`,
  );
}
