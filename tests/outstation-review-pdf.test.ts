import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { buildOutstationReviewDocument, outstationReviewFooter } from "@/lib/outstation/review-document";
import { viewEligibilityReason } from "@/lib/outstation/eligibility-reason";
import { buildRouteStaticMapUrl, decodePolyline, renderRouteDiagram } from "@/lib/outstation/review-map-image";
import { parseOutstationDescription } from "@/lib/outstation/description-format";
import type { OutstationExpenseRequest } from "@/lib/outstation/types";

/**
 * "Extract this page as it is as a PDF… no horizontal scrolling… look in the eligibility. Also
 * check the notes, it needs to be cleaned out." — owner, 2026-09-28.
 *
 * Three defects were on the card he was looking at, all of them printed verbatim by any export:
 *
 *   1. The map plotted one pin in Egypt and one in the Gulf of Guinea, because the request's
 *      residence coordinate was (0, 0) and the only guard was `!= null`.
 *   2. The eligibility reason was Google's raw JSON error body, stored as a sentence.
 *   3. The notes repeated one allowance sentence five times, then a machine audit line reading
 *      `source=… hr_id=… gps=… draft_id=…` with a UTC timestamp.
 *
 * All three are production strings from OUTSTATION-148 and are used verbatim below.
 */

const REAL_ELIGIBILITY_REASON =
  'Distance could not be validated against Google Maps. Google Routes API failed with 400: {\n'
  + '  "error": {\n    "code": 400,\n    "message": "Location coordinates must not be (0, 0).",\n'
  + '    "status": "INVALID_ARGUMENT"\n  }\n}\n.';

const ONE_ALLOWANCE_SENTENCE =
  "No allowance: a trip to Cairo from a regional base does not earn an outstation per-diem allowance.";

const REAL_NOTES =
  `Allowance guard: ${Array(5).fill(ONE_ALLOWANCE_SENTENCE).join(" ")}\n`
  + "Arrival photo evidence: source=live_camera hr_id=AI-0013 captured_at=2026-09-17T04:50:24.100Z "
  + "location=100 El Hegaz St, Al Matar, El Nozha, Cairo Governorate 4470324, Egypt · Brick ميدان هليوبوليس "
  + "· Area Heliopolis · Region Cairo gps=30.109659300509975,31.340977818314666 "
  + "draft_id=b1073eeb-b977-42a3-b9eb-c72d9b57d2b5 request_id=148";

/** OUTSTATION-148 as production holds it, after tonight's residence repair. */
function realRequest(overrides: Partial<OutstationExpenseRequest> = {}): OutstationExpenseRequest {
  return {
    allowanceAmount: 0,
    amWorkload: 0,
    approvalReason: "Location or timing checks require manager review before the request can move forward.",
    approvalRecommendation: "manager_review",
    capturedAccuracyMeters: 21.205325204387,
    capturedAt: "2026-09-17T04:45:47.505Z",
    capturedLatitude: 30.1098822354724,
    capturedLocation: {
      areaLabel: "Heliopolis",
      brickLabel: "ميدان هليوبوليس",
      confidence: "High · 0.3 km",
      label: "ميدان هليوبوليس · Heliopolis · Cairo",
      regionLabel: "Cairo",
    },
    capturedLongitude: 31.3411007346295,
    claimedTotalAmount: 1291,
    createdAt: "2026-09-17T04:53:40.157Z",
    distanceFromResidenceKm: 518.24,
    durationMinutes: 370.3,
    eligibilityReason: REAL_ELIGIBILITY_REASON,
    eligibilityStatus: "needs_review",
    employeeHrId: "AI-0013",
    employeeName: "Weaam Mahmoud Mohamed Mahmoud",
    employeeRole: "District Manager",
    expectedTotalAmount: 1291,
    expenseType: "meeting",
    fuelAmount: 0,
    id: 148,
    meetingAmount: 0,
    minimumRequiredDistanceKm: 60,
    notes: REAL_NOTES,
    offlineCaptured: false,
    otherAmount: 0,
    overnightDays: 4,
    pharmacyWorkload: null,
    pmWorkload: 0,
    reportTravelCost: 1291,
    residenceAddress: "ع1 - ابراج الحمام - سيتي سوهاج ثان - سوهاج",
    residenceArea: "سوهاج ثان",
    residenceCity: "سوهاج",
    residenceLatitude: 26.54775,
    residenceLongitude: 31.69926,
    routePolyline: null,
    sameDayTrip: false,
    status: "submitted",
    submittedAt: "2026-09-17T04:53:38.882Z",
    territoryValidationReason:
      "Captured destination is outside the employee's assigned area and should be reviewed manually.",
    territoryValidationStatus: "outside_expected_territory",
    ticketAmount: 1291,
    toArea: "El Nozha",
    toCity: "Cairo Governorate",
    toLabel: "102 Mohammed Waly, Al Matar, El Nozha, Cairo Governorate 4470342, Egypt",
    transportationType: "train",
    tripEndDate: "2026-09-17",
    tripStartDate: "2026-09-13",
    workloadMatchStatus: "no_activity",
    ...overrides,
  } as OutstationExpenseRequest;
}

function buildDoc(overrides: Partial<OutstationExpenseRequest> = {}): string {
  return buildOutstationReviewDocument({
    generatedOn: "29 Sept 2026 · 00:09",
    map: { caption: "A caption.", image: null },
    mark: "",
    photos: [],
    request: realRequest(overrides),
    workload: { available: false },
  });
}

export function runOutstationReviewPdfTests() {
  // ── 1. THE MAP MUST NEVER PLOT A PLACEHOLDER AS A PLACE ──────────────────────────────────────

  const nullIsland = buildRouteStaticMapUrl({
    apiKey: "test-key",
    destination: { lat: 25.9179718709569, lng: 32.7602003842803 },
    polyline: "abc",
    residence: { lat: 0, lng: 0 },
  });
  assert.ok(nullIsland.url, "a real destination is still worth drawing on its own");
  assert.ok(
    !/markers=[^&]*0%2C0/.test(nullIsland.url ?? ""),
    "🔴 (0, 0) must never become a marker — that is the pin in the Gulf of Guinea the owner saw",
  );
  assert.ok(
    !/path=/.test(nullIsland.url ?? ""),
    "and the stored route is measured FROM home, so with no resolved home it must not be drawn either",
  );
  assert.match(
    nullIsland.caption,
    /never plotted as a place/,
    "the caption has to say why home is missing, or a reader assumes the trip started at D",
  );

  const centroid = buildRouteStaticMapUrl({
    apiKey: "test-key",
    destination: { lat: 30.1, lng: 31.3 },
    polyline: null,
    residence: { lat: 26.820553, lng: 30.802498 },
  });
  assert.ok(
    !/markers=[^&]*26\.820553/.test(centroid.url ?? ""),
    "the Egypt centroid is the OTHER unresolved shape and must be refused the same way",
  );

  const good = buildRouteStaticMapUrl({
    apiKey: "test-key",
    destination: { lat: 30.1098822354724, lng: 31.3411007346295 },
    polyline: "abc",
    residence: { lat: 26.54775, lng: 31.69926 },
  });
  assert.ok(/markers=[^&]*26\.54775/.test(good.url ?? ""), "a real home MUST be drawn");
  assert.ok(/path=/.test(good.url ?? ""), "and the stored route with it");
  assert.ok(
    !/key=$/.test(good.url ?? "") && /key=test-key/.test(good.url ?? ""),
    "the key is a query parameter, so it must be present and encoded exactly once",
  );

  assert.equal(
    buildRouteStaticMapUrl({ apiKey: null, destination: { lat: 30, lng: 31 }, polyline: null, residence: { lat: 26, lng: 31 } }).url,
    null,
    "with no key there is no request to make, and the caption says so rather than printing a broken image",
  );

  // The self-drawn diagram carries the SAME guard, or the fallback reintroduces the defect.
  assert.equal(
    renderRouteDiagram({ destination: { lat: null, lng: null }, polyline: "abc", residence: { lat: 0, lng: 0 } }),
    null,
    "🔴 the diagram must refuse null island exactly as the street map does: with (0, 0) for home and "
      + "no destination there is nothing real to draw, and a diagram here would put the Gulf of Guinea "
      + "back on the page through the fallback",
  );
  const diagram = renderRouteDiagram({
    destination: { lat: 30.1098822354724, lng: 31.3411007346295 },
    polyline: null,
    residence: { lat: 0, lng: 0 },
  });
  assert.ok(diagram, "a real destination alone is still drawable");
  assert.match(
    diagram?.caption ?? "",
    /never plotted as a place/,
    "🔴 and the diagram must refuse null island exactly as the street map does",
  );

  // A malformed polyline must end the line, never throw — a broken route cannot break the PDF.
  assert.doesNotThrow(() => decodePolyline("sa`aDohn`E~~~"), "a truncated polyline is survivable");
  assert.equal(decodePolyline(null).length, 0, "and an absent one decodes to nothing");
  assert.ok(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@").length === 3, "a valid polyline decodes to its points");

  // ── 2. THE ELIGIBILITY REASON IS A SENTENCE, NEVER GOOGLE'S JSON ─────────────────────────────

  const eligibility = viewEligibilityReason({
    distanceKm: 518.24,
    minimumKm: 60,
    reason: REAL_ELIGIBILITY_REASON,
  });
  for (const fragment of ['"error"', '"code"', '"status"', "INVALID_ARGUMENT", "{", "}"]) {
    assert.ok(
      !(eligibility.recorded ?? "").includes(fragment),
      `the reason a person reads must not contain ${fragment} — it is an API response body, not a reason`,
    );
  }
  assert.match(
    eligibility.recorded ?? "",
    /No home coordinate was on file/,
    "and it must say what actually went wrong, in words the reader can act on",
  );
  assert.match(
    eligibility.since ?? "",
    /518\.24 km, which is above the 60 km minimum/,
    "a reason that says the distance could not be validated is overtaken once a distance exists — "
      + "the card must not say both without explaining which is current",
  );
  assert.match(
    eligibility.since ?? "",
    /has not been re-decided/,
    "🔴 but it must NEVER read as a new verdict: the system flags an expense and never decides one",
  );
  assert.equal(
    viewEligibilityReason({ distanceKm: null, minimumKm: 60, reason: REAL_ELIGIBILITY_REASON }).since,
    null,
    "with no distance measured there is nothing that has since been measured",
  );
  assert.equal(
    viewEligibilityReason({ distanceKm: 518, minimumKm: 60, reason: "Trip is under the minimum distance." }).since,
    null,
    "a reason that never claimed the distance was unvalidated is not overtaken by one",
  );

  // ── 3. THE NOTES ARE CLEANED ─────────────────────────────────────────────────────────────────

  const parts = parseOutstationDescription(REAL_NOTES);
  assert.equal(
    parts.allowanceNotices.length,
    1,
    "🔴 one sentence repeated five times must read ONCE — the guard writes one row per trip day",
  );
  assert.match(
    parts.allowanceNotices[0],
    /\(5 days\)\.$/,
    "and it must keep the fact it covered five days, or the repetition is merely hidden",
  );
  assert.equal(parts.evidence.length, 1, "the machine audit line becomes a structured stamp");
  assert.equal(parts.evidence[0].capturedAtLabel, "17 Sept 2026 · 07:50", "in Cairo time, not the stored UTC");
  assert.equal(
    parts.evidence[0].place,
    "100 El Hegaz St, Al Matar, El Nozha, Cairo Governorate",
    "with the plus code, postal number and trailing country dropped",
  );

  // ── 4. THE DOCUMENT ITSELF ───────────────────────────────────────────────────────────────────

  const doc = buildDoc();

  // 🔴 An explicit white ground. Without it the whole paper rendered near-black with near-black
  // text on a machine in dark mode — caught by screenshotting the real document on 2026-09-29.
  assert.match(doc, /html, body \{[^}]*background: #FFFFFF/, "the document must set its own white ground");
  assert.match(doc, /color-scheme: only light/, "and refuse the renderer's dark scheme outright");

  // THE SQUARE-EDGE GOLDEN RULE and THE FITS-THE-SCREEN GOLDEN RULE, on paper.
  assert.match(doc, /border-radius: 0 !important/, "no round corners anywhere, including on paper");
  assert.ok(
    !/overflow-x\s*:\s*auto|overflow-x\s*:\s*scroll/.test(doc),
    "nothing on a printed page may scroll sideways — there is nowhere to scroll to",
  );
  assert.match(doc, /table-layout: fixed/, "tables must fit their column widths rather than push wider");
  assert.ok(
    !/white-space\s*:\s*nowrap/.test(doc.replace(/white-space: nowrap;\s*\}/g, "}")),
    "and no unwrappable run may force the page wider than the paper",
  );

  // The house identity. The standard's number rides in the FOOTER, which Chromium prints on every
  // page from its own template — so it is asserted against that, not against the body.
  const footer = outstationReviewFooter({ generatedOn: "29 Sept 2026 · 00:09", requestId: 148 });
  assert.match(footer, /SATO-DIS-2026-01 v1\.0/, "every company document carries the standard's number");
  assert.match(footer, /class="pageNumber"[\s\S]*class="totalPages"/, "and a flowing document numbers its own pages");
  assert.ok(
    /style="/.test(footer) && !/class="foot__/.test(footer),
    "the footer template is rendered outside the document, so it cannot rely on the stylesheet — "
      + "its styles must be inline or it prints as unstyled black text",
  );
  assert.match(doc, /Outstation Trip Review/, "and the document says what it is");

  // Names, never codes.
  assert.match(doc, /Weaam Mahmoud Mohamed Mahmoud/, "the employee is named");
  assert.ok(
    !doc.includes("AI-0013"),
    "🔴 and their HR code is not printed — names, never codes (the request's own reference stays)",
  );
  assert.match(doc, /OUTSTATION-148/, "the request keeps its own reference, as an invoice has a number");

  // The three defects must not survive into the document.
  for (const fragment of ["INVALID_ARGUMENT", '"code": 400', "draft_id=", "gps=", "source=live_camera", "hr_id="]) {
    assert.ok(!doc.includes(fragment), `the printed review must not contain ${fragment}`);
  }
  assert.equal(
    doc.split("does not earn an outstation per-diem allowance").length - 1,
    1,
    "the repeated allowance sentence must appear once in the document, not five times",
  );

  // A late capture is stated on the paper too — the coordinate everything else derives from.
  assert.match(
    buildDoc({ capturedAt: "2026-10-11T07:00:00.000Z" }),
    /Location captured after the trip ended/,
    "a capture from after the trip must be flagged on paper as it is on screen",
  );
  assert.ok(
    !buildDoc().includes("Location captured after the trip ended"),
    "and a capture on the trip's last day must say nothing at all",
  );

  // An unavailable CRM read is an unanswered question, never a zero.
  assert.match(doc, /it is an unanswered question/, "a source that did not answer must say so");

  // ── 5. THE ROUTE IS SERVED BY THE SAME GATE AS THE REVIEW ────────────────────────────────────

  const route = readFileSync(
    new URL("../app/api/admin/outstation/[id]/pdf/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    route,
    /assertOutstationAdminAccess\(access, "approve"\)/,
    "whoever may open the review may print it, and nobody else — the same gate, named in the handler",
  );
  assert.ok(
    !/signedUrl|photo\.url\}/.test(route.replace(/imageDataUri\(photo\.url\)/g, "")),
    "a signed storage URL is a key to the image and must never be written into the document",
  );
  assert.match(
    route,
    /getRepTripVisitWorkload/,
    "the paper reads the same live CRM source the panel does, so the two cannot disagree",
  );
}
