/**
 * The outstation trip review, exactly as the review screen shows it, on paper.
 *
 * Owner, 2026-09-28: "I want to be able to extract this page as it is as a PDF" — and, when the
 * first attempt came back wearing the Sato letterhead, 2026-09-29: "no, do not brand Sato, extract
 * the exact view."
 *
 * So this is NOT a house document. It carries no Sato mark, no SATO-DIS-2026-01 recital and none of
 * the deep-blue identity; the INK RULE does not apply, because the thing being reproduced is a
 * screen and the screen has a dark header bar, tinted chips and an amber warning box. It wears
 * Phoenix: the slate header, the orange eyebrow, the token palette from `tokens.css`, in the same
 * order and the same words as `outstation-requests-admin.tsx` renders them.
 *
 * It is a second RENDERING of the review, never a second reading of the rules: every figure comes
 * from the same request row, the same formatter (`description-format`), the same eligibility reader
 * and the same capture check the panel uses, and the route hands it the same live CRM read. When a
 * rule changes, the paper and the page change together because neither owns the rule.
 *
 * 🔴 The palette is PINNED to the light-mode token values on purpose. `tokens.css` redefines every
 * one of them under dark mode, and a document that inherited those rendered near-black on
 * near-black — caught by screenshotting the real PDF on 2026-09-29, not by reading the CSS. Paper
 * is white; it must never be at the mercy of the renderer's colour scheme.
 *
 * Pure: the caller supplies the map image and the photos as data URIs, so this builds the same
 * string with no network, no clock and no Chromium — which is what makes it testable.
 */

import {
  formatPharmacyFigure,
  pharmacyFigureText,
  pharmacyRecordingOf,
  pharmacyTileFigure,
  type VisitCountSplit,
} from "@/lib/crm/visit-count-buckets";
import { bidi } from "@/lib/field-activity/document";
import { cairoDate, cairoDateTime } from "@/lib/format/cairo-datetime";
import { resolveCaptureTimeliness } from "@/lib/outstation/capture-timeliness";
import {
  outstationEvidenceLines,
  parseOutstationDescription,
} from "@/lib/outstation/description-format";
import { viewEligibilityReason } from "@/lib/outstation/eligibility-reason";
import { PHOTO_FRAME_INDEX_ATTRIBUTE } from "@/lib/outstation/photo-frame";
import type { OutstationExpenseRequest } from "@/lib/outstation/types";
import { outstationWorkloadSourceLabel } from "@/lib/outstation/workload-source-label";

/** The light-mode Phoenix tokens, pinned. See the header: dark mode must never reach paper. */
const P = {
  accent: "#f97316",
  accentLine: "#fbcfa8",
  accentPress: "#c2410c",
  accentSoft: "#fff2e8",
  header: "#0f172a",
  headerMuted: "#94a3b8",
  ink: "#0d1015",
  inkFaint: "#9aa0a8",
  inkSoft: "#6b7078",
  line: "#e0dcd4",
  paper: "#f7f6f3",
  surface: "#ffffff",
} as const;

export type ReviewDocumentWorkloadDay = {
  am: number;
  campaign: number;
  date: string;
  pharmacies: number;
  /** Of the day's visits, how many are Phoenix CRM's own — it logs no pharmacy visit. */
  phoenix?: number;
  pm: number;
  regular: number;
};

/**
 * The live figures as the golden-rule split (src/lib/crm/visit-count-buckets.ts): a trip or day logged
 * in Phoenix CRM, which records no pharmacy visit, reads "not recorded in Phoenix" — never 0. The
 * declared figure keeps its own wording ("not counted separately").
 */
function liveSplit(figures: { am: number; pm: number; pharmacies: number; phoenix?: number }): VisitCountSplit {
  return { am: figures.am, pm: figures.pm, pharmacies: figures.pharmacies, ...(figures.phoenix ? { phoenix: figures.phoenix } : {}) };
}

/** One day's pharmacy cell: "2", "Not recorded" or "2 (iReports360 only)". */
function livePharmacyCell(day: ReviewDocumentWorkloadDay): string {
  const split = liveSplit(day);
  return pharmacyRecordingOf(split) === "not-recorded" ? pharmacyTileFigure(split).value : pharmacyFigureText(split);
}

/**
 * The live CRM read, or a plain statement that it was not available. Never a zero standing in for
 * "we could not read it" — an unavailable source must say so, not print a misleading nothing.
 */
export type ReviewDocumentWorkload =
  | { available: false }
  | {
      available: true;
      days: ReviewDocumentWorkloadDay[];
      freshnessHeadline: string | null;
      live: { am: number; campaign: number; pharmacies: number; phoenix?: number; pm: number; regular: number };
      matchStatus: string;
    };

export type ReviewDocumentPhoto = {
  capturedAtLabel: string | null;
  /**
   * "This photo carries no image…", when the frame was measured and found black. Filled on a SECOND
   * pass, after Chromium has decoded the picture — nothing on the server can read a JPEG's pixels,
   * so the first render leaves this null and the document is rebuilt once with the readings in.
   */
  frameNote: string | null;
  /** A data URI, never a signed URL — a signed URL is a key to the image and must not be printed. */
  image: string | null;
  label: string;
  locationLabel: string | null;
  /** Why there is no picture, how it was taken, or what its review said. */
  note: string | null;
};

export type OutstationReviewDocumentInput = {
  /** When the document was produced, already in Cairo time, e.g. "29 Sept 2026 · 00:12". */
  generatedOn: string;
  map: { caption: string; image: string | null };
  photos: ReviewDocumentPhoto[];
  request: OutstationExpenseRequest;
  workload: ReviewDocumentWorkload;
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The status words the panel shows: `accepted_by_admin` -> "accepted by admin". */
function words(value: string | null | undefined): string {
  const text = String(value ?? "").trim();
  return text ? text.replace(/_/g, " ") : "—";
}

/** Money exactly as the panel prints it: "EGP 1,291", no decimals. */
export function reviewMoney(value: number | null | undefined): string {
  const amount = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return `EGP ${Math.round(amount).toLocaleString("en-US")}`;
}

/** A measured distance, or the panel's own words for a missing one — never "0" and never "N/A". */
export function reviewKm(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Route lookup failed";
  return `${value.toFixed(2)} KM`;
}

/** `requestStatusTone` on screen, as inline style. */
function statusChipStyle(status: string): string {
  const normalized = String(status).toLowerCase();
  if (normalized.includes("accept") || normalized === "approved") {
    return "background:#ECFDF5;color:#047857;box-shadow:inset 0 0 0 1px #A7F3D0;";
  }
  if (normalized.includes("reject") || normalized === "rejected") {
    return "background:#FEF2F2;color:#B91C1C;box-shadow:inset 0 0 0 1px #FECACA;";
  }
  return `background:${P.accentSoft};color:${P.accentPress};box-shadow:inset 0 0 0 1px #FED7AA;`;
}

/** The workload chip, same four tones the evidence panel uses. */
function workloadChipStyle(matchStatus: string): string {
  if (matchStatus === "matched") return "background:#ECFDF5;color:#047857;box-shadow:inset 0 0 0 1px #A7F3D0;";
  if (matchStatus === "no_activity") return "background:#FEF2F2;color:#B91C1C;box-shadow:inset 0 0 0 1px #FECACA;";
  return `background:${P.accentSoft};color:${P.accentPress};box-shadow:inset 0 0 0 1px #FED7AA;`;
}

function fact(label: string, valueHtml: string): string {
  return `<div class="fact"><p class="fact__k">${escapeHtml(label)}</p><p class="fact__v">${valueHtml || "&mdash;"}</p></div>`;
}

function section(title: string, body: string): string {
  return `<section class="sec"><h2 class="h2">${escapeHtml(title)}</h2>${body}</section>`;
}

function factsBlock(request: OutstationExpenseRequest): string {
  const location = request.capturedLocation;
  const trip = request.sameDayTrip ? "Same-day" : `${request.overnightDays} night(s)`;
  const accuracy =
    request.capturedAccuracyMeters === null || request.capturedAccuracyMeters === undefined
      ? "Not reported"
      : `${request.capturedAccuracyMeters.toFixed(0)} m`;
  const pharmacies =
    request.pharmacyWorkload === null || request.pharmacyWorkload === undefined
      ? "Not counted separately"
      : String(request.pharmacyWorkload);

  return `<div class="facts">
    ${fact("Expense type", escapeHtml(words(request.expenseType)))}
    ${fact("Trip", escapeHtml(trip))}
    ${fact("Start", escapeHtml(cairoDate(request.tripStartDate)))}
    ${fact("End", escapeHtml(cairoDate(request.tripEndDate)))}
    ${fact("Transport", escapeHtml(words(request.transportationType)))}
    ${fact("Distance", escapeHtml(reviewKm(request.distanceFromResidenceKm)))}
    ${fact("Submitted", escapeHtml(cairoDateTime(request.submittedAt ?? request.createdAt)))}
    ${fact("Captured time", escapeHtml(cairoDateTime(request.capturedAt)))}
    ${fact("GPS accuracy", escapeHtml(accuracy))}
    ${fact("Offline capture", request.offlineCaptured ? "Yes" : "No")}
    ${fact("Captured location", location?.label ? bidi(location.label) : "Not resolved")}
    ${fact("Captured brick", location?.brickLabel ? bidi(location.brickLabel) : "Not resolved")}
    ${fact("Captured area / region", location ? `${bidi(location.areaLabel)} &middot; ${bidi(location.regionLabel)}` : "Not resolved")}
    ${fact("Location match", escapeHtml(location?.confidence ?? "Not matched"))}
    ${fact("AM visits", escapeHtml(String(request.amWorkload ?? 0)))}
    ${fact("PM visits", escapeHtml(String(request.pmWorkload ?? 0)))}
    ${fact("Pharmacy visits", escapeHtml(pharmacies))}
    ${fact("Workload source", escapeHtml(outstationWorkloadSourceLabel(request.workloadSource)))}
    ${fact("Workload match (at submission)", escapeHtml(words(request.workloadMatchStatus)))}
  </div>`;
}

function routeBlock(request: OutstationExpenseRequest, map: OutstationReviewDocumentInput["map"]): string {
  const from = [request.residenceAddress, request.residenceArea, request.residenceCity].filter(Boolean).join(", ");
  const to = request.toLabel ?? request.toCity ?? request.toArea ?? "";
  const minutes =
    typeof request.durationMinutes === "number" && Number.isFinite(request.durationMinutes)
      ? `${Math.round(request.durationMinutes)} min`
      : "&mdash;";
  const figure = map.image
    ? `<figure class="map"><img src="${map.image}" alt="Route from home to the captured destination"><figcaption>${escapeHtml(map.caption)}</figcaption></figure>`
    : `<p class="thin">${escapeHtml(map.caption)}</p>`;

  return `<dl class="route">
      <dt>From</dt><dd>${from ? bidi(from) : "Residence"}</dd>
      <dt>To</dt><dd>${to ? bidi(to) : "&mdash;"}</dd>
    </dl>
    <div class="facts facts--3">
      ${fact("Distance", escapeHtml(reviewKm(request.distanceFromResidenceKm)))}
      ${fact("Driving time", minutes)}
      ${fact("Minimum required", escapeHtml(typeof request.minimumRequiredDistanceKm === "number" ? `${request.minimumRequiredDistanceKm.toFixed(0)} KM` : "—"))}
    </div>
    ${figure}`;
}

/** The mono equation the approver reads on screen: Travel … Meeting … Allowance … = Total. */
function costBlock(request: OutstationExpenseRequest): string {
  const travel = request.reportTravelCost ?? request.fuelAmount + request.ticketAmount;
  const total = request.claimedTotalAmount || request.expectedTotalAmount;
  const other = request.otherAmount ?? 0;
  const parts = [
    `<span class="cost__k">Travel</span> <span class="cost__v">${reviewMoney(travel)}</span>`,
    `<span class="cost__k">Meeting</span> <span class="cost__v">${reviewMoney(request.meetingAmount ?? 0)}</span>`,
    `<span class="cost__k">Allowance</span> <span class="cost__v">${reviewMoney(request.allowanceAmount)}</span>`,
  ];
  if (other > 0) parts.push(`<span class="cost__k">Other</span> <span class="cost__v">${reviewMoney(other)}</span>`);
  return `<p class="cost">${parts.join("&nbsp;&nbsp; ")}&nbsp;&nbsp; = &nbsp;<span class="cost__k">Total</span> <span class="cost__t">${reviewMoney(total)}</span></p>`;
}

function workloadBlock(request: OutstationExpenseRequest, workload: ReviewDocumentWorkload): string {
  const declaredPharmacies =
    request.pharmacyWorkload === null || request.pharmacyWorkload === undefined
      ? "Pharmacies not counted separately"
      : `Pharmacies ${request.pharmacyWorkload}`;
  const declared = `AM ${request.amWorkload ?? 0} &middot; PM ${request.pmWorkload ?? 0} &middot; ${declaredPharmacies}`;

  if (!workload.available) {
    return `<div class="boxes">
        <div class="box"><p class="box__k">Declared (sheet)</p><p class="box__v">${declared}</p></div>
        <div class="box"><p class="box__k">Actual (evidence)</p><p class="box__v">Not available</p></div>
      </div>
      <p class="warn"><strong>The live CRM read was not available</strong> when this document was produced, so no
      visit count is shown for it. This is not a zero &mdash; it is an unanswered question.</p>`;
  }

  const live = workload.live;
  const declaredTotal = (request.amWorkload ?? 0) + (request.pmWorkload ?? 0) + (request.pharmacyWorkload ?? 0);
  const actualTotal = live.am + live.pm + live.pharmacies;
  const differs = actualTotal !== declaredTotal;
  const days = workload.days.length
    ? `<table class="tbl">
        <colgroup><col style="width:34%"><col style="width:11%"><col style="width:11%"><col style="width:14%"><col style="width:15%"><col style="width:15%"></colgroup>
        <thead><tr><th>Day</th><th class="num">AM</th><th class="num">PM</th><th class="num">Pharmacies</th><th class="num">Planned</th><th class="num">Unplanned</th></tr></thead>
        <tbody>${workload.days
          .map(
            (day) =>
              `<tr><td>${escapeHtml(cairoDate(day.date))}</td><td class="num">${day.am}</td><td class="num">${day.pm}</td><td class="num">${escapeHtml(livePharmacyCell(day))}</td><td class="num">${day.regular}</td><td class="num">${day.campaign}</td></tr>`,
          )
          .join("")}</tbody>
      </table>`
    : "";

  return `<p class="chipline"><span class="chip" style="${workloadChipStyle(workload.matchStatus)}">${escapeHtml(words(workload.matchStatus))}</span>
      <span class="thin">Phoenix CRM visits &mdash; every field visit, own or with a rep (the iReports360 archive before the team&rsquo;s start).</span></p>
    ${workload.freshnessHeadline ? `<div class="amber"><p class="amber__k">Stored verdict is out of date</p><p class="amber__v">${escapeHtml(workload.freshnessHeadline)}</p></div>` : ""}
    <div class="boxes boxes--3">
      <div class="box"><p class="box__k">Declared (sheet)</p><p class="box__v">${declared}</p></div>
      <div class="box${differs ? " box--flag" : ""}"><p class="box__k">Actual (evidence)</p><p class="box__v">AM ${live.am} &middot; PM ${live.pm} &middot; ${escapeHtml(formatPharmacyFigure(liveSplit(live)))}</p>
        ${differs ? `<p class="box__flag">&ne; declared (${actualTotal} actual vs ${declaredTotal} declared)</p>` : ""}</div>
      <div class="box"><p class="box__k">Visit type</p><p class="box__v">Planned ${live.regular} &middot; Unplanned ${live.campaign}</p></div>
    </div>
    ${days}`;
}

function validationBlock(request: OutstationExpenseRequest): string {
  const eligibility = viewEligibilityReason({
    distanceKm: request.distanceFromResidenceKm,
    minimumKm: request.minimumRequiredDistanceKm,
    reason: request.eligibilityReason,
  });
  const row = (label: string, status: string, reason: string | null, extra = "") =>
    `<tr><td><strong>${escapeHtml(label)}</strong></td><td>${escapeHtml(words(status))}</td><td>${reason ? escapeHtml(reason) : "&mdash;"}${extra}</td></tr>`;

  return `<table class="tbl">
    <colgroup><col style="width:22%"><col style="width:20%"><col style="width:58%"></colgroup>
    <thead><tr><th>Check</th><th>Result</th><th>Reason</th></tr></thead>
    <tbody>
      ${row("Territory", request.territoryValidationStatus, request.territoryValidationReason ?? null)}
      ${row(
        "Eligibility",
        request.eligibilityStatus,
        eligibility.recorded,
        eligibility.since ? `<span class="since">${escapeHtml(eligibility.since)}</span>` : "",
      )}
      ${row("Recommendation", request.approvalRecommendation, request.approvalReason ?? null)}
    </tbody>
  </table>`;
}

function notesBlock(request: OutstationExpenseRequest): string {
  const parts = parseOutstationDescription(request.notes);
  const noteLines = (parts.note ?? "").split("\n").filter((line) => line.trim().length > 0);
  const pieces: string[] = [];

  if (noteLines.length > 0) {
    pieces.push(`<div class="note">${noteLines.map((line) => `<p>${bidi(line)}</p>`).join("")}</div>`);
  }
  for (const notice of parts.allowanceNotices) {
    pieces.push(`<div class="amber"><p class="amber__v">${escapeHtml(notice)}</p></div>`);
  }
  for (const stamp of parts.evidence) {
    const [heading, ...rest] = outstationEvidenceLines(stamp);
    pieces.push(
      `<div class="stamp"><p class="stamp__k">${escapeHtml(heading)}</p>${rest.map((line) => `<p class="stamp__v">${bidi(line)}</p>`).join("")}</div>`,
    );
  }
  return pieces.length > 0 ? pieces.join("") : `<p class="thin">No notes.</p>`;
}

function photosBlock(photos: ReviewDocumentPhoto[]): string {
  if (photos.length === 0) return `<p class="thin">No photos are on file for this request.</p>`;
  return `<div class="photos">${photos
    .map(
      (photo, index) => `<figure class="photo">
        ${photo.image ? `<img src="${photo.image}" alt="${escapeHtml(photo.label)}" ${PHOTO_FRAME_INDEX_ATTRIBUTE}="${index}">` : `<div class="photo__none">No picture</div>`}
        <figcaption><span class="photo__k">${escapeHtml(photo.label)}</span>${photo.capturedAtLabel ? ` &middot; ${escapeHtml(photo.capturedAtLabel)}` : ""}
        ${photo.locationLabel ? `<br>${bidi(photo.locationLabel)}` : ""}
        ${photo.frameNote ? `<br><span class="photo__blank">${escapeHtml(photo.frameNote)}</span>` : ""}
        ${photo.note ? `<br><span class="thin">${escapeHtml(photo.note)}</span>` : ""}</figcaption>
      </figure>`,
    )
    .join("")}</div>`;
}

/**
 * The footer Chromium prints on every page. A flowing document has no fixed page count, so the
 * numbers come from Chromium's own `pageNumber`/`totalPages`. Its styles MUST be inline: the footer
 * template is rendered outside the document and never sees its stylesheet.
 */
export function outstationReviewFooter(input: { generatedOn: string; requestId: number }): string {
  const cell = `margin:0;font-size:6.8pt;color:${P.inkFaint};font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif;`;
  return `<div style="width:100%;padding:0 12mm;box-sizing:border-box;">
    <div style="height:.8pt;background:${P.line};margin-bottom:1.6mm;"></div>
    <div style="display:flex;justify-content:space-between;gap:4mm;">
      <p style="${cell}">Phoenix Workforce &middot; Outstation expense review</p>
      <p style="${cell}text-align:center;">OUTSTATION-${input.requestId} &middot; read from the live system on ${escapeHtml(input.generatedOn)}, Cairo time</p>
      <p style="${cell}text-align:right;white-space:nowrap;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></p>
    </div>
  </div>`;
}

export function buildOutstationReviewDocument(input: OutstationReviewDocumentInput): string {
  const { request } = input;
  const name = request.employeeName?.trim() || "Unassigned";
  const capture = resolveCaptureTimeliness({ capturedAt: request.capturedAt, tripEndDate: request.tripEndDate });

  // The screen's own dark header: orange eyebrow, name, then the mono identity line and the status
  // chip. The Close button is the one thing dropped — there is nothing to close on paper.
  const header = `<header class="bar">
      <div class="bar__id">
        <p class="bar__eyebrow">Trip under review</p>
        <h1 class="bar__name">${escapeHtml(name)}</h1>
        <p class="bar__meta">${escapeHtml(request.employeeHrId || "HR ID not mapped")} &middot; OUTSTATION-${request.id} &middot; ${escapeHtml(request.employeeRole)}</p>
      </div>
      <span class="chip" style="${statusChipStyle(request.status)}">${escapeHtml(words(request.status))}</span>
    </header>`;

  const lateCapture =
    capture.verdict === "late" && capture.headline
      ? `<div class="amber"><p class="amber__k">Location captured after the trip ended</p><p class="amber__v">${escapeHtml(capture.headline)}</p></div>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Outstation Trip Review · OUTSTATION-${request.id}</title>
<style>${documentCss()}</style>
</head>
<body>
  ${header}
  <p class="lede">The review of outstation request OUTSTATION-${request.id} as it stands in Phoenix, read from the
  live system on ${escapeHtml(input.generatedOn)}, Cairo time. Every figure below is the one the review screen shows.</p>
  ${lateCapture}
  ${section("The trip", factsBlock(request))}
  ${section("Route", routeBlock(request, input.map))}
  ${section("Cost breakdown", costBlock(request))}
  ${section("Verified workload", workloadBlock(request, input.workload))}
  ${section("Checks and recommendation", validationBlock(request))}
  ${section("Notes", notesBlock(request))}
  ${section("Evidence", photosBlock(input.photos))}
</body>
</html>`;
}

function documentCss(): string {
  return `
@page { size: A4 portrait; margin: 12mm 12mm 18mm 12mm; }
* { box-sizing: border-box; border-radius: 0 !important; }
/* AN EXPLICIT WHITE GROUND, AND LIGHT ONLY.
   tokens.css redefines every colour under dark mode. This document set ink colours but inherited
   its background, so on a machine in dark mode the whole page rendered near-black with near-black
   text - caught by screenshotting the real PDF on 2026-09-29, not by reading the CSS. Paper is
   white. (No backticks in this comment: it lives inside a template literal.) */
html { color-scheme: only light; }
html, body { margin: 0; padding: 0; background: ${P.surface}; }
body { font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; color: ${P.ink}; font-size: 8.4pt; line-height: 1.38; }

/* The review modal's dark header bar. */
.bar { display: flex; align-items: flex-start; justify-content: space-between; gap: 8mm;
       background: ${P.header}; padding: 4mm 5mm; }
.bar__id { min-width: 0; }
.bar__eyebrow { margin: 0; font-size: 6.6pt; font-weight: 800; text-transform: uppercase; letter-spacing: .22em; color: #fb923c; }
.bar__name { margin: 1.4mm 0 0; font-size: 14pt; font-weight: 800; letter-spacing: -.01em; color: #ffffff; }
.bar__meta { margin: 1mm 0 0; font-family: "Consolas", "Courier New", monospace; font-size: 7.6pt; color: ${P.headerMuted}; }
.chip { display: inline-block; padding: 1mm 3mm; font-size: 7.4pt; font-weight: 700; white-space: nowrap; }

.lede { margin: 4mm 0 3mm; font-size: 8.6pt; color: ${P.inkSoft}; }
.sec { margin: 0 0 4mm; }
.h2 { margin: 0 0 1.8mm; font-size: 7.6pt; font-weight: 800; text-transform: uppercase; letter-spacing: .16em;
      color: ${P.inkSoft}; border-bottom: 1pt solid ${P.accent}; padding-bottom: 1mm; break-after: avoid; }
.thin { color: ${P.inkSoft}; font-weight: 400; }

.facts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-top: .6pt solid ${P.line}; border-left: .6pt solid ${P.line}; break-inside: avoid; }
.facts--3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.fact { border-right: .6pt solid ${P.line}; border-bottom: .6pt solid ${P.line}; padding: 1.3mm 2mm; min-width: 0; }
.fact__k { margin: 0 0 .8mm; font-size: 6.4pt; font-weight: 800; text-transform: uppercase; letter-spacing: .12em; color: ${P.inkFaint}; }
.fact__v { margin: 0; font-size: 8.4pt; font-weight: 600; overflow-wrap: anywhere; }

.route { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 1mm 3mm; margin: 0 0 2.4mm; }
.route dt { font-size: 6.4pt; font-weight: 800; text-transform: uppercase; letter-spacing: .12em; color: ${P.inkFaint}; padding-top: .5mm; }
.route dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.map { margin: 2.4mm 0 0; break-inside: avoid; }
.map img { width: 100%; height: auto; display: block; border: .8pt solid ${P.line}; }
.map figcaption { margin-top: 1.2mm; font-size: 6.9pt; color: ${P.inkSoft}; }

/* The mono equation the approver reads on screen. */
.cost { margin: 0; padding: 2.4mm 3mm; background: ${P.paper}; border: .6pt solid ${P.line};
        font-family: "Consolas", "Courier New", monospace; font-size: 8.6pt; overflow-wrap: anywhere; }
.cost__k { color: ${P.inkSoft}; }
.cost__v { font-weight: 700; }
.cost__t { font-weight: 800; color: ${P.accentPress}; }

.chipline { margin: 0 0 2mm; }
.chipline .thin { font-size: 7.2pt; }
.boxes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2.5mm; margin: 0 0 2.5mm; }
.boxes--3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.box { border: .6pt solid ${P.line}; padding: 1.6mm 2mm; min-width: 0; break-inside: avoid; }
.box--flag { border-color: #FECACA; background: #FEF2F2; }
.box__k { margin: 0 0 .8mm; font-size: 6.4pt; font-weight: 800; text-transform: uppercase; letter-spacing: .12em; color: ${P.inkFaint}; }
.box__v { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.box__flag { margin: .8mm 0 0; font-size: 6.9pt; font-weight: 700; color: #B91C1C; }

/* The screen's amber warning, for a stale verdict, a late capture and an allowance notice. */
.amber { border: .6pt solid #FCD34D; background: #FFFBEB; padding: 1.8mm 2.4mm; margin: 0 0 2.5mm; break-inside: avoid; }
.amber__k { margin: 0 0 .8mm; font-size: 6.4pt; font-weight: 800; text-transform: uppercase; letter-spacing: .12em; color: #B45309; }
.amber__v { margin: 0; color: #78350F; overflow-wrap: anywhere; }

.tbl { width: 100%; table-layout: fixed; border-collapse: collapse; }
.tbl th { text-align: left; font-size: 6.4pt; font-weight: 800; text-transform: uppercase; letter-spacing: .12em;
          color: ${P.inkFaint}; border-bottom: .8pt solid ${P.line}; padding: 1.5mm; }
.tbl td { padding: 1.1mm 1.5mm; vertical-align: top; border-bottom: .5pt solid ${P.line}; overflow-wrap: anywhere; }
.tbl tbody tr:nth-child(odd) td { background: ${P.paper}; }
.tbl tr { break-inside: avoid; }
.tbl .num, .tbl th.num { text-align: right; }
.since { display: block; margin-top: 1mm; padding-left: 2.5mm; border-left: 1.4pt solid ${P.accent}; color: ${P.accentPress}; }

.note { border-left: 2pt solid ${P.accentLine}; padding-left: 3.5mm; margin: 0 0 2.5mm; }
.note p { margin: 0 0 1mm; }
.stamp { border: .6pt solid ${P.line}; padding: 1.8mm 2.4mm; margin: 0 0 2.5mm; break-inside: avoid; }
.stamp__k { margin: 0 0 .8mm; font-size: 6.9pt; font-weight: 800; text-transform: uppercase; letter-spacing: .1em; color: ${P.accentPress}; }
.stamp__v { margin: 0; color: ${P.inkSoft}; overflow-wrap: anywhere; }

.photos { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4mm; }
.photo { margin: 0; break-inside: avoid; }
.photo img { width: 100%; height: 62mm; object-fit: cover; display: block; border: .6pt solid ${P.line}; }
.photo__none { height: 62mm; border: .6pt dashed ${P.line}; display: flex; align-items: center; justify-content: center; color: ${P.inkFaint}; }
.photo figcaption { margin-top: 1.2mm; font-size: 7.2pt; overflow-wrap: anywhere; }
.photo__k { font-weight: 800; }
/* The blank-frame note, carrying the amber the review card gives it. A left rule rather than a
   filled box: the screen's own weighting, without a printed block of ink. */
.photo__blank { display: block; margin-top: 1mm; padding-left: 1.6mm; border-left: 1.2pt solid #d97706; color: #92400e; font-weight: 700; }
`;
}
