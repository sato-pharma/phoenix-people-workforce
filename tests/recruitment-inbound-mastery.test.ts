import assert from "node:assert/strict";

import { findPossibleDuplicate, normalizeNameForMatch, phoneTailForMatch } from "../src/lib/recruitment/candidate-matching.ts";
import { extractAllowlistedCvUrl, isAllowlistedCvHost } from "../src/lib/recruitment/inbound/cv-link.ts";
import { shouldAlertIntakeSpike, summarizeInboundIntake } from "../src/lib/recruitment/inbound/intake-analytics.ts";

export function runRecruitmentInboundMasteryTests() {
  // --- summarizeInboundIntake ------------------------------------------------------------------
  const rows = [
    { channel: "email", created_at: "2026-07-27T00:00:00Z", outcome: "candidate_created" },
    { channel: "email", created_at: "2026-07-27T00:00:00Z", outcome: "candidate_matched" },
    { channel: "email", created_at: "2026-07-27T00:00:00Z", outcome: "ignored_no_attachment" },
    { channel: "whatsapp", created_at: "2026-07-27T00:00:00Z", outcome: "candidate_created" },
    { channel: "whatsapp", created_at: "2026-07-27T00:00:00Z", outcome: "error" },
    { channel: "whatsapp", created_at: "2026-07-27T00:00:00Z", outcome: "ignored_unsupported_attachment" },
  ];
  const a = summarizeInboundIntake(rows, 2, 30);
  assert.equal(a.total, 6);
  assert.equal(a.candidatesCreated, 2);
  assert.equal(a.candidatesMatched, 1);
  assert.equal(a.ignoredNoAttachment, 1);
  assert.equal(a.ignoredUnsupported, 1);
  assert.equal(a.errors, 1);
  assert.equal(a.deadLettered, 2, "dead-letter count is passed through from the queue");
  // Success = candidates / CV-bearing (created+matched+error+unsupported = 5); ignored_no_attachment
  // is excluded because it never carried a CV.
  assert.equal(a.successRatePct, 60, "3 candidates of 5 CV-bearing messages -> 60%");
  const email = a.byChannel.find((c) => c.channel === "email");
  assert.equal(email?.total, 3);
  assert.equal(email?.candidates, 2);
  assert.equal(email?.ignoredNoAttachment, 1);
  assert.equal(a.byOutcome[0].count >= a.byOutcome[a.byOutcome.length - 1].count, true, "outcomes are sorted by count desc");
  assert.equal(summarizeInboundIntake([], 0, 30).successRatePct, null, "no CV-bearing messages -> null rate, not a divide-by-zero");

  // --- shouldAlertIntakeSpike ------------------------------------------------------------------
  assert.equal(shouldAlertIntakeSpike({ deadLettered: 0, errors: 7, threshold: 8 }), false);
  assert.equal(shouldAlertIntakeSpike({ deadLettered: 1, errors: 7, threshold: 8 }), true, "errors + dead-letters cross the threshold together");
  assert.equal(shouldAlertIntakeSpike({ deadLettered: 8, errors: 0, threshold: 8 }), true);
  assert.equal(shouldAlertIntakeSpike({ deadLettered: 0, errors: 0, threshold: 8 }), false, "a quiet window never alerts");
  assert.equal(shouldAlertIntakeSpike({ deadLettered: 0, errors: 1, threshold: 0 }), true, "threshold clamps to >=1, so one error alerts when misconfigured to 0");

  // --- fuzzy dedup (advisory only) -------------------------------------------------------------
  assert.equal(normalizeNameForMatch("Ahmed  ALI!!"), "ahmed ali");
  assert.equal(normalizeNameForMatch("José"), "jose", "Latin diacritics are folded");
  assert.equal(normalizeNameForMatch("محمد علي"), "محمد علي", "Arabic is preserved");
  assert.equal(normalizeNameForMatch("Al"), null, "too short to be a meaningful signal");

  // Local vs international phone form still ties out on the last 9 digits.
  assert.equal(phoneTailForMatch("201001234567"), phoneTailForMatch("01001234567"));

  const existing = [
    { fullName: "Ahmed Ali", id: "c1", phoneNorm: "201001234567" },
    { fullName: "Sara Mohamed", id: "c2", phoneNorm: null },
  ];
  assert.deepEqual(
    findPossibleDuplicate(existing, { phone: "01001234567" }),
    { id: "c1", reason: "phone_tail" },
    "phone-tail is the stronger signal and wins",
  );
  assert.deepEqual(
    findPossibleDuplicate(existing, { fullName: "sara  mohamed" }),
    { id: "c2", reason: "name" },
    "falls back to a normalized-name match",
  );
  assert.equal(findPossibleDuplicate(existing, { fullName: "Nobody Here", phone: "01999999999" }), null, "no soft match -> null (never a forced merge)");

  // --- CV-as-link allowlist --------------------------------------------------------------------
  assert.equal(isAllowlistedCvHost("drive.google.com"), true);
  assert.equal(isAllowlistedCvHost("www.dropbox.com"), true, "subdomains of an allowlisted host are allowed");
  assert.equal(isAllowlistedCvHost("evil.com"), false);
  assert.equal(isAllowlistedCvHost("drive.google.com.evil.com"), false, "a lookalike suffix is NOT allowlisted");

  assert.equal(
    extractAllowlistedCvUrl("My CV: https://drive.google.com/file/d/abc/view — thanks", null),
    "https://drive.google.com/file/d/abc/view",
    "the allowlisted link is extracted from the body",
  );
  assert.equal(
    extractAllowlistedCvUrl("here https://evil.com/x then https://www.dropbox.com/s/xyz/cv.pdf", null),
    "https://www.dropbox.com/s/xyz/cv.pdf",
    "a non-allowlisted link is skipped; the allowlisted one wins",
  );
  assert.equal(extractAllowlistedCvUrl("no links at all", null), null);
  assert.equal(extractAllowlistedCvUrl("only untrusted https://pastebin.com/raw/abc", false), null, "an arbitrary host is never followed (SSRF guard)");
}
