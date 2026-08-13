import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(relPath: string): string {
  return readFileSync(relPath, "utf8");
}

export function runTelegramOnboardingCampaignCapTests() {
  const onboarding = source("src/lib/notifications/telegram-onboarding.ts");

  // DEFAULT_CAMPAIGN_LIMIT must be a real ceiling on runTelegramOnboardingCampaign's batch size,
  // not just the value used when the caller omits `limit` -- a caller-supplied limit larger than
  // the documented cap must be clamped down to it, never trusted as-is. This is a regression test
  // for a real bug: the resolved `limit` used to be `input.limit` verbatim whenever it was a
  // positive finite number, so `POST /api/admin/notifications/telegram` with
  // `{"action":"send_invitations","limit":100000}` could email the entire eligible population in
  // one run, silently past the 250 the admin UI and this file's own docs promise.
  assert.match(
    onboarding,
    /const limit = Math\.min\(requested, DEFAULT_CAMPAIGN_LIMIT\);/,
    "the resolved limit must be clamped to DEFAULT_CAMPAIGN_LIMIT via Math.min, not trusted as the caller's raw value",
  );

  // The clamp must apply to whatever the caller asked for (`requested`), including the fallback
  // to DEFAULT_CAMPAIGN_LIMIT when no limit was supplied at all -- not bypass it for either case.
  assert.match(
    onboarding,
    /const requested = Number\.isFinite\(input\.limit\) && Number\(input\.limit\) > 0 \? Number\(input\.limit\) : DEFAULT_CAMPAIGN_LIMIT;/,
    "requested must resolve from the caller's limit (or the default when absent) BEFORE the cap is applied to it",
  );

  // The exact vulnerable line this replaces -- `limit` assigned directly to `requested`'s
  // expression with no Math.min wrapping it -- must not be back. `Math.min\(` immediately after
  // `const limit = ` is the fixed form; the old form assigned the ternary straight to `limit`.
  assert.doesNotMatch(
    onboarding,
    /const limit = Number\.isFinite\(input\.limit\) && Number\(input\.limit\) > 0 \? Number\(input\.limit\) : DEFAULT_CAMPAIGN_LIMIT;/,
    "the un-clamped assignment (limit = the caller's raw value) must not reappear -- that was the bug",
  );

  // `truncated`/`batch` must still be derived from the (now-clamped) `limit`, so a request for
  // more than the cap still reports truncation honestly instead of silently under-reporting it.
  assert.match(
    onboarding,
    /const truncated = available > limit;/,
    "truncated must compare against the clamped limit, so an over-cap request still reports what it dropped",
  );
  assert.match(
    onboarding,
    /const batch = targets\.slice\(0, limit\);/,
    "the actual send batch must be sliced by the clamped limit, not the caller's raw requested value",
  );

  // A caller-supplied limit SMALLER than the cap must still be honored (Math.min takes either
  // side) -- this is not a test the fix over-corrected into a hardcoded 250-always constant.
  assert.doesNotMatch(
    onboarding,
    /const limit = DEFAULT_CAMPAIGN_LIMIT;/,
    "the cap must stay a ceiling via Math.min, not collapse into always-250 regardless of a smaller caller request",
  );
}
