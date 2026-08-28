import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

// A REJECTED plan submit used to render in the SAME sky-blue banner as the success message
// "Plan submitted for direct manager review." A real user pressed Submit, was told in a calm
// blue box that she already had an approved plan for that week, read it as a confirmation,
// and reported the page as "bouncing with no error". Nothing on the page said failure.
//
// These are source pins: the banner is a client component with no test-time renderer here.
// The style assertions are made against a SLICE of the messageBanner block, not the whole
// file — the same red class is used by other banners in this component, so a whole-file
// includes() passes even with the fix removed. (It did, on the first draft of this test.)
export function runWeeklyPlanErrorBannerToneTests() {
  const src = readFileSync("src/components/employee-portal/plans-workspace.tsx", "utf8");

  // ── The single failure path must report through the error tone ─────────────
  assert.ok(
    src.includes('showError(friendlyError(error instanceof Error ? error.message : "Action failed."));'),
    "runAction's catch must report through showError so a failed action renders as a failure",
  );

  // ── The two helpers must mean what they are named ──────────────────────────
  assert.ok(
    src.includes('const showError = (text: string) => setMessage({ text, tone: "error" });'),
    "showError must set tone 'error'",
  );
  assert.ok(
    src.includes('const showInfo = (text: string) => setMessage({ text, tone: "info" });'),
    "showInfo must set tone 'info'",
  );

  // ── Slice the banner, then assert the difference is actually RENDERED ───────
  // Without this the state carries a tone that nothing paints, which is the original bug one
  // indirection further down.
  const bannerStart = src.indexOf("const messageBanner = message ? (");
  assert.ok(bannerStart >= 0, "the messageBanner block must exist — this test slices it by marker");
  const bannerEnd = src.indexOf(") : null;", bannerStart);
  assert.ok(bannerEnd > bannerStart, "the messageBanner block must terminate — this test slices it by marker");
  const banner = src.slice(bannerStart, bannerEnd);

  assert.ok(banner.includes('message.tone === "error"'), "the message banner must branch on the message tone");
  assert.ok(
    banner.includes("border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-800"),
    "an error message must render in the repo's red error style, not the sky-blue info style",
  );
  assert.ok(
    banner.includes("border border-sky-200 bg-sky-50 p-3 text-sm font-semibold text-sky-800"),
    "a non-error message must keep the sky-blue info style",
  );
  assert.ok(
    banner.includes('role={message.tone === "error" ? "alert" : "status"}'),
    "an error banner must be announced as an alert, not left as a silent colour change",
  );

  // ── Only the catch may use the error tone ──────────────────────────────────
  const errorCalls = src.split("showError(").length - 1;
  assert.equal(errorCalls, 1, "showError must be called exactly once — only from runAction's catch");

  // ── No route back to a bare string ─────────────────────────────────────────
  // setMessage(null) stays legitimate; setMessage("some text") is how tone and text drift
  // apart again.
  assert.ok(
    !src.includes('setMessage("'),
    "message text must go through showInfo/showError, never setMessage with a bare string",
  );
}
