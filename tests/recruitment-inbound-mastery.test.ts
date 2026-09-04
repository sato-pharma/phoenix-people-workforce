import assert from "node:assert/strict";

import { findPossibleDuplicate, normalizeNameForMatch, phoneTailForMatch } from "../src/lib/recruitment/candidate-matching.ts";
import {
  extractAllowlistedCvUrl,
  fetchCvFromUrl,
  isAllowlistedCvHost,
  isAllowlistedCvRedirectHost,
  normalizeCvDownloadUrl,
} from "../src/lib/recruitment/inbound/cv-link.ts";
import { shouldAlertIntakeSpike, summarizeInboundIntake } from "../src/lib/recruitment/inbound/intake-analytics.ts";

export async function runRecruitmentInboundMasteryTests() {
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
    // --- redirect targets: the bytes come from a DIFFERENT host than the share link ---------------
    // Regression for the failed recovery of 2026-09-03. The post-redirect re-check used the LINK
    // allowlist, so Drive's own download host was refused and all four queued CVs died a second time
    // with "redirected to a host we do not download from".
    assert.equal(isAllowlistedCvRedirectHost("drive.usercontent.google.com"), true, "Drive serves the file from usercontent.google.com");
    assert.equal(isAllowlistedCvRedirectHost("doc-0k-8c-docs.googleusercontent.com"), true, "a Docs export lands on googleusercontent.com");
    assert.equal(isAllowlistedCvRedirectHost("uc123.dl.dropboxusercontent.com"), true, "Dropbox dl=1 lands on dropboxusercontent.com");
    assert.equal(isAllowlistedCvRedirectHost("drive.google.com"), true, "the link allowlist is a subset of the redirect allowlist");
    assert.equal(isAllowlistedCvRedirectHost("evil.com"), false, "wider is not open — it is still an allowlist");
    assert.equal(isAllowlistedCvRedirectHost("usercontent.google.com.evil.com"), false, "a lookalike suffix is refused");
    assert.equal(isAllowlistedCvRedirectHost("xusercontentxgooglexcom"), false, "the dots are literal, not any-char wildcards");
    // Widening the REDIRECT surface must never widen the LINK surface an untrusted sender aims at.
    assert.equal(isAllowlistedCvHost("drive.usercontent.google.com"), false, "a download host is never a link we follow out of an email");
    assert.equal(isAllowlistedCvHost("doc-0k-8c-docs.googleusercontent.com"), false);

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

  // --- CV-as-link: viewer URL -> download URL ----------------------------------------------------
  // Regression for the 0-of-4 capture rate measured in production on 2026-09-03. These three URLs
  // are the ACTUAL links three real applicants sent to careers@ and lost; each must now be fetched
  // from its download endpoint, not its viewer page.
  assert.equal(
    normalizeCvDownloadUrl("https://drive.google.com/file/d/1chPRmPs4sm2odyq-14AO9ODrN1u1i-iC/view?usp=drivesdk"),
    "https://drive.google.com/uc?export=download&id=1chPRmPs4sm2odyq-14AO9ODrN1u1i-iC",
    "a Drive /view link becomes the direct download endpoint",
  );
  assert.equal(
    normalizeCvDownloadUrl("https://drive.google.com/file/d/1MC2qqg1wm2sx8v3JD_IiodV5cE5C9D7I/view?usp=drivesdk"),
    "https://drive.google.com/uc?export=download&id=1MC2qqg1wm2sx8v3JD_IiodV5cE5C9D7I",
  );
  assert.equal(
    normalizeCvDownloadUrl(
      "https://docs.google.com/document/d/1MXlJXMNVNkLvMFGvxc-YlrECL-LmR-8V/edit?usp=drivesdk&ouid=116865225604337524551&rtpof=true&sd=true",
    ),
    "https://docs.google.com/document/d/1MXlJXMNVNkLvMFGvxc-YlrECL-LmR-8V/export?format=pdf",
    "a Docs editor link exports the document itself",
  );
  assert.equal(
    normalizeCvDownloadUrl("https://drive.google.com/open?id=ABC123_-xyz"),
    "https://drive.google.com/uc?export=download&id=ABC123_-xyz",
    "the older /open?id= share shape is handled too",
  );
  assert.equal(
    normalizeCvDownloadUrl("https://docs.google.com/presentation/d/PID9/edit"),
    "https://docs.google.com/presentation/d/PID9/export/pdf",
    "presentations take a different export path shape",
  );
  assert.equal(
    normalizeCvDownloadUrl("https://www.dropbox.com/s/xyz/cv.pdf?dl=0"),
    "https://www.dropbox.com/s/xyz/cv.pdf?dl=1",
    "Dropbox serves the preview page unless dl=1",
  );
  assert.equal(
    normalizeCvDownloadUrl("https://wetransfer.com/downloads/abc"),
    "https://wetransfer.com/downloads/abc",
    "an unrecognised host is returned unchanged, never guessed at",
  );
  assert.equal(normalizeCvDownloadUrl("not a url"), "not a url", "an unparseable value is passed through");
  for (const shape of [
    "https://drive.google.com/file/d/ID1/view",
    "https://docs.google.com/document/d/ID2/edit",
    "https://www.dropbox.com/s/x/cv.pdf?dl=0",
  ]) {
    assert.equal(
      new URL(normalizeCvDownloadUrl(shape)).hostname,
      new URL(shape).hostname,
      "normalization NEVER changes the host — the allowlist must still hold",
    );
  }

  // --- CV-as-link: a failed fetch reports WHY, and never passes an HTML page off as a CV ---------
  const realFetch = globalThis.fetch;
  const requested: string[] = [];
  const stubFetch = (body: string | Buffer, contentType: string, status = 200) => {
    globalThis.fetch = (async (input: unknown) => {
      requested.push(String(input));
      return new Response(typeof body === "string" ? body : new Uint8Array(body), {
        headers: { "content-type": contentType },
        status,
      });
    }) as typeof globalThis.fetch;
  };
  try {
    // The exact production failure: Drive answers the viewer page with a sign-in interstitial.
    stubFetch("<!DOCTYPE html><html><body>Sign in to continue</body></html>", "text/html; charset=utf-8");
    requested.length = 0;
    const privateLink = await fetchCvFromUrl("https://drive.google.com/file/d/ID1/view?usp=drivesdk", 15_000_000);
    assert.equal(privateLink.ok, false, "an HTML page is never accepted as a CV");
    assert.match(
      privateLink.ok ? "" : privateLink.reason,
      /not public/i,
      "the reason names the real cause so Talent Acquisition can act on it",
    );
    assert.equal(
      requested[0],
      "https://drive.google.com/uc?export=download&id=ID1",
      "THE FIX: the fetch is issued against the download endpoint, not the viewer URL",
    );

    // Drive labels its interstitial octet-stream, which the generic-type tolerance would wave past.
    stubFetch("<html><head><title>Google Drive - Quota exceeded</title></head></html>", "application/octet-stream");
    const disguised = await fetchCvFromUrl("https://drive.google.com/file/d/ID2/view", 15_000_000);
    assert.equal(disguised.ok, false, "an HTML body is caught even when the header claims octet-stream");

    // The success path still works, and still yields usable bytes.
    stubFetch(Buffer.from("%PDF-1.4\nreal cv bytes"), "application/pdf");
    const good = await fetchCvFromUrl("https://drive.google.com/file/d/ID3/view", 15_000_000);
    assert.equal(good.ok, true, "a genuine PDF behind a share link is captured");
    assert.equal(good.ok && good.bytes.subarray(0, 5).toString(), "%PDF-", "the real file bytes come back");

    // A host outside the allowlist is refused before any request is made (SSRF guard intact).
    requested.length = 0;
    const untrusted = await fetchCvFromUrl("https://evil.com/cv.pdf", 15_000_000);
    assert.equal(untrusted.ok, false);
    assert.equal(requested.length, 0, "a non-allowlisted host is never even requested");

    // A dead link reports the status rather than vanishing.
    stubFetch("nope", "text/plain", 404);
    const missing = await fetchCvFromUrl("https://drive.google.com/file/d/ID4/view", 15_000_000);
    assert.equal(missing.ok, false);
    assert.match(missing.ok ? "" : missing.reason, /404/, "the reason carries the status the host returned");
    // End to end, the real Drive shape: we request drive.google.com and Google redirects to its
    // download host. This exact hop is what lost the four CVs; it must now yield bytes.
    const stubRedirect = (landsOn: string, body: string) => {
      globalThis.fetch = (async (input: unknown) => {
        requested.push(String(input));
        const res = new Response(new Uint8Array(Buffer.from(body)), {
          headers: { "content-type": "application/pdf" },
          status: 200,
        });
        Object.defineProperty(res, "url", { value: landsOn });
        return res;
      }) as typeof globalThis.fetch;
    };

    requested.length = 0;
    stubRedirect("https://drive.usercontent.google.com/download?id=ID5&export=download", "%PDF-1.4 recovered cv");
    const redirected = await fetchCvFromUrl("https://drive.google.com/file/d/ID5/view?usp=drivesdk", 15_000_000);
    assert.equal(redirected.ok, true, "THE FIX: Drive's own download host is followed instead of refused");
    assert.equal(redirected.ok && redirected.bytes.subarray(0, 5).toString(), "%PDF-", "the applicant's real file comes back");
    assert.equal(requested[0], "https://drive.google.com/uc?export=download&id=ID5", "still requested via the download endpoint");

    stubRedirect("https://evil.com/payload.pdf", "%PDF-1.4 not ours");
    const offList = await fetchCvFromUrl("https://drive.google.com/file/d/ID6/view", 15_000_000);
    assert.equal(offList.ok, false, "an off-allowlist redirect is still refused — the SSRF guard is intact");
    assert.equal(offList.ok ? "" : offList.reason.includes("evil.com"), true, "the reason names the host it refused, so the next provider change is diagnosable");
  } finally {
    globalThis.fetch = realFetch;
  }
}
