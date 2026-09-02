import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { mapInAppNotificationRows } from "../src/lib/communication/metrics.ts";

/**
 * The notifications bell — what it shows, and that it stays on the screen.
 *
 * All three things pinned here were found by MEASURING production on 2026-09-02 (revision
 * 99c9909f2) rather than by reading the component, and each was invisible to the check that should
 * have caught it.
 */
/**
 * Source with comments stripped.
 *
 * Every "this className is gone" pin below has to read CODE. Documenting a removed pattern quotes
 * it verbatim — that is the point of the comment — and an un-stripped scan then fails on the very
 * note explaining the fix. Caught by this suite on itself.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

export function runNotificationBellPolishTests() {
  const VIEWER = "b-10";

  // ── Send plumbing must never reach the reader ────────────────────────────────────────────────
  // `idempotencyKey` was rendered as a detail row on 5 of 5 notifications that carried one, with
  // values like the one below. Two owner rules at once: raw codes instead of human-readable names,
  // and the ONLY label being ellipsised anywhere in the panel (one hid 2556px of text in a 161px
  // box). It slipped past the existing guard because `isUuidLike` only catches a BARE uuid, and
  // this is a composite.
  {
    const rows = mapInAppNotificationRows(
      [
        {
          category: "general",
          employeeHrId: VIEWER,
          id: "p1",
          metadata: {
            title: "t",
            message: "m",
            idempotencyKey: "ireports360-sync:ireports360-visits-sync:1b28cfea-489b-4017-9d3a-7c1f2b6e5a40",
            dedupeKey: "recruitment_triage_backlog:2026-09-02:B-10",
            correlationId: "telegram-daily-hr-digest:B-10:2026-09-02",
            // A real, useful value of the SAME shape — proves the filter is keyed on the KEY and
            // has not simply stopped rendering the generic metadata loop altogether.
            areaName: "October -Zayed",
          },
          recipients: [VIEWER],
          status: "sent",
          subject: "t",
        },
      ],
      VIEWER,
    );

    const details = rows[0]?.details ?? [];
    const blob = JSON.stringify(details).toLowerCase();

    assert.equal(blob.includes("idempotency"), false, "the idempotency key must not be rendered");
    assert.equal(blob.includes("1b28cfea"), false, "nor its value");
    assert.equal(blob.includes("dedupe"), false, "nor a dedupe key");
    assert.equal(blob.includes("correlation"), false, "nor a correlation id");
    assert.ok(
      details.some((detail) => detail.value === "October -Zayed"),
      "a genuinely useful metadata value must still render — the generic loop is not disabled, only filtered",
    );
  }

  // ── No ellipsis anywhere in the bell ─────────────────────────────────────────────────────────
  const bell = codeOnly(readFileSync("src/components/layout/in-app-notifications-bell.tsx", "utf8"));
  assert.ok(
    !/\btruncate\b/.test(bell),
    "the bell must not truncate: the owner's standing rule is that text wraps, never ellipsises",
  );

  // ── It must stay inside the viewport, via the shared placement ───────────────────────────────
  // Source-pinned because the component is JSX and the runner's type stripping cannot import it.
  assert.ok(
    bell.includes("placeAnchoredPanel("),
    "the panel must be placed through the shared clamp, not with a fixed right-0 className",
  );
  assert.ok(
    /style=\{\{ marginLeft: placement\.offsetLeft, width: placement\.width \}\}/.test(bell),
    "the measured placement must reach the panel element, or it is computed and discarded",
  );
  assert.ok(
    !/\bw-\[min\(380px/.test(bell),
    "the hard-coded width must be gone — it capped the width while the panel still hung off the LEFT edge, which is exactly the trap",
  );
  assert.ok(
    !/useEffect\(\s*\(\)\s*=>\s*\{\s*setPlacement/.test(bell),
    "placement stays in the event handler — setState inside useEffect is a lint error in this repo",
  );

  // ── The unread marker is a COUNT, matching the sibling menu ──────────────────────────────────
  assert.ok(
    /nav-badge-alarm absolute right-1 top-1/.test(bell),
    "the badge keeps the shared alarm class so it pulses with the sidebar badges",
  );
  assert.ok(
    /unreadCount > 99 \? "99\+" : unreadCount/.test(bell),
    "it shows how many are unread, capped — InternalMessagesMenu beside it always did",
  );
  assert.ok(
    !/ring-2 ring-white/.test(bell),
    "the hard-coded white ring is gone — it was drawn against a near-black admin topbar",
  );

  // ── The alarm motion is ON, by the owner's 2026-09-02 decision ───────────────────────────────
  // Reversed twice now (stopped 2026-08-28, restored 2026-09-02 when he was asked directly and
  // chose the continuous pulse). Pinned so a later session cannot quietly revert it to the earlier
  // decision on the strength of a stale comment.
  const css = readFileSync("app/globals.css", "utf8");
  const alarmRule = /\.nav-badge-alarm \{\s*animation:\s*([^;]+);/.exec(css);
  assert.ok(alarmRule, ".nav-badge-alarm must declare an animation");
  assert.ok(
    !/^\s*none\s*$/.test(alarmRule![1]),
    "the alarm pulse must remain enabled — the owner asked for it back on 2026-09-02",
  );
  assert.match(alarmRule![1], /nav-badge-alarm-pump/, "and it is the pump keyframe, as originally shipped");

  // The accessibility guard is NOT the owner's preference and must survive the restore.
  assert.match(
    css,
    /prefers-reduced-motion[\s\S]*\.nav-badge-alarm,/,
    "prefers-reduced-motion must still disable the alarm — that guard is not his styling decision to reverse",
  );

  // ── The topbar must outrank the nav rows, or every panel it owns is painted over ─────────────
  // MEASURED at 375px on 2026-09-02: with the panel open, the "Organogram" nav link rendered at
  // [42,93,110,111] — inside the panel's [12,64,363,620] — legible on top of the notifications.
  // `backdrop-blur-xl` makes the header a stacking context, so the panel's own `z-30` ranks it
  // against nothing outside; the header then lost to the LATER nav-row sibling at equal footing.
  // No z-index on the panel can fix that, which is exactly why this pin lives on the header.
  const topbar = codeOnly(readFileSync("src/components/layout/topbar.tsx", "utf8"));
  const headerTag = /<header className=\{`([^`]+)`/.exec(topbar);
  assert.ok(headerTag, "the topbar header must carry a className to pin");
  assert.match(
    headerTag![1],
    /\brelative\b/,
    "the header must be positioned, or its z-index is inert and the nav rows paint over its panels",
  );
  assert.match(
    headerTag![1],
    /\bz-40\b/,
    "and ranked above the nav rows (z-auto) it shares a sticky container with",
  );
  assert.match(headerTag![1], /backdrop-blur-xl/, "the blur that causes the trap is still there — this pin is why");

  // ── The sibling menu is clamped the same way ─────────────────────────────────────────────────
  // Found while verifying the bell: the messages panel opened at left -36 in a 375px viewport, the
  // identical `right-0` + width-cap failure. Pinned together so the two triggers in one toolbar
  // cannot drift apart again.
  const messages = codeOnly(readFileSync("src/components/layout/internal-messages-menu.tsx", "utf8"));
  assert.ok(
    messages.includes("placeAnchoredPanel("),
    "the messages panel must use the same shared clamp as the bell beside it",
  );
  assert.ok(
    !/absolute right-0 top-full/.test(messages),
    "right-0 is what put it off the left edge — placement is measured, not anchored by className",
  );
  assert.ok(
    !/w-\[min\(760px/.test(messages),
    "the width cap went with it: it capped the width while the panel still hung off-screen",
  );
}
