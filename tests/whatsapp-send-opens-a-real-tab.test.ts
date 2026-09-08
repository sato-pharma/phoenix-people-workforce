import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The WhatsApp send button must open a tab it can actually navigate.
 *
 * ── THE BUG THAT MADE THIS ──────────────────────────────────────────────────────────────────────
 *
 * Shipped 2026-09-08, reported by the owner within the hour: "when i press send i was redirected to
 * about:blank".
 *
 * The handler opens a tab synchronously on the click and navigates it after the server renders the
 * message — correct, and necessary, because a `window.open` issued after an `await` is no longer
 * attributable to the user gesture and every popup blocker swallows it silently.
 *
 * What was wrong was the feature list: `window.open("", "_blank", "noopener,noreferrer")`. Per the
 * HTML specification, **`window.open` returns null whenever the feature list contains `noopener`** —
 * and it still opens the tab. So the tab existed, the handle to navigate it did not, the code took
 * its "the popup was blocked" branch, and the new tab sat on about:blank forever.
 *
 * ── WHY A SOURCE ASSERTION ──────────────────────────────────────────────────────────────────────
 *
 * There is no DOM in this suite, so the behaviour cannot be driven here. But the defect is entirely
 * visible in the source — one token in a feature string — and it is the kind that reads as MORE
 * correct than the fix: `noopener` is the security-conscious habit, so a later reader tidying this
 * file up is exactly who would reintroduce it. That is what this pins.
 *
 * It also pins that the tab is opened BEFORE the await, because the two failures look identical from
 * the user's side ("the button does nothing" / "it opened nothing useful") and a fix for one can
 * quietly undo the other.
 */
export function runWhatsAppSendOpensARealTabTests() {
  const source = readFileSync("src/components/recruitment/whatsapp-send-dialog.tsx", "utf8");

  // A POSITIVE CONTROL first. Every assertion below is "this string is absent" or "this string is
  // present"; if the file were ever moved or renamed, `readFileSync` would throw — but if the send
  // handler were merely rewritten out of recognition, the absence assertions would all pass
  // vacuously and this guard would silently stop guarding.
  assert.match(
    source,
    /const onSend = useCallback\(async \(\) => \{/,
    "the send handler must still be here — if it was renamed, re-point this test rather than deleting it",
  );

  const openCalls = [...source.matchAll(/window\.open\(([^)]*)\)/g)].map((match) => match[1]);
  assert.equal(
    openCalls.length,
    1,
    `expected exactly one window.open in the send dialog, found ${openCalls.length}: ${JSON.stringify(openCalls)}`,
  );

  // THE HEADLINE ASSERTION. `noopener` makes window.open return null while still opening the tab,
  // which strands the user on about:blank — the exact bug reported on 2026-09-08.
  assert.ok(
    !/noopener/.test(openCalls[0]),
    "window.open must NOT be given noopener: the spec makes it return null, so the tab opens and " +
      "nothing can ever navigate it, leaving the user on about:blank. The opener reference is the " +
      `price of being able to navigate the tab at all. Found: window.open(${openCalls[0]})`,
  );
  assert.ok(
    !/noreferrer/.test(openCalls[0]),
    "noreferrer belongs on an <a rel>, not in a window.open feature list — and pairing it with " +
      "noopener is how noopener gets reintroduced here",
  );

  // The open must still happen BEFORE the network call, or the popup blocker eats it.
  const handler = source.slice(source.indexOf("const onSend = useCallback"));
  const openAt = handler.indexOf("window.open(");
  const awaitAt = handler.indexOf("await postJson(");
  assert.ok(openAt >= 0 && awaitAt >= 0, "the handler must both open a tab and post to the server");
  assert.ok(
    openAt < awaitAt,
    "the tab must be opened BEFORE the await: a window.open after an await is no longer attributable " +
      "to the click, and every popup blocker swallows it silently — which reads as a dead button",
  );

  // The genuine-block fallback must survive, so a real blocker still leaves the user a way through.
  assert.match(
    source,
    /setBlockedUrl\(url\)/,
    "keep the fallback that offers the URL as a link when a blocker genuinely returns null",
  );
}
