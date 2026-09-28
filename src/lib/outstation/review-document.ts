/**
 * An outstation trip review, as a house document — the review panel on paper, as it stands.
 *
 * Owner request 2026-09-28: "I want to be able to extract this page as it is as a PDF." So this is a
 * second RENDERING of the review, never a second reading of the rules: every figure comes from the
 * same request row, the same formatter (`description-format`), the same eligibility reader and the
 * same capture check the panel uses, and the route passes it the same live CRM read. When a rule
 * changes, the paper and the page change together because neither owns the rule.
 *
 * It wears the house identity (SATO-DIS-2026-01): the mark, the deep and blue inks, square edges,
 * and THE INK RULE — no filled areas except the 6% zebra row. That is why every notice here is a
 * LEFT RULE and not a tinted box, although the screen uses tints: paper is not the screen.
 *
 * Names, never codes. The employee is named; their HR code is not printed. The request carries its
 * own reference (OUTSTATION-148) because that is the document's number, as an invoice has one.
 *
 * Pure: the caller supplies the mark, the map image and the photos as data URIs, so this builds the
 * same string with no network, no clock and no Chromium — which is what makes it testable.
 */

import { bidi, tidyAddress } from "@/lib/field-activity/document";
import { cairoDate, cairoDateTime } from "@/lib/format/cairo-datetime";
import { HOUSE_COLORS } from "@/lib/hiring-pack/house-identity";
import { resolveCaptureTimeliness } from "@/lib/outstation/capture-timeliness";
import {
  outstationEvidenceLines,
  parseOutstationDescription,
} from "@/lib/outstation/description-format";
import { viewEligibilityReason } from "@/lib/outstation/eligibility-reason";
import type { OutstationExpenseRequest } from "@/lib/outstation/types";

export type ReviewDocumentWorkloadDay = {
  am: number;
  campaign: number;
  date: string;
  pharmacies: number;
  pm: number;
  regular: number;
};

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
      live: { am: number; campaign: number; pharmacies: number; pm: number; regular: number };
    };

export type ReviewDocumentPhoto = {
  capturedAtLabel: string | null;
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
  /** The house mark as a data URI, or "" to print without it. */
  mark: string;
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

/** The status words the panel shows, `accepted_by_admin` -> "accepted by admin". */
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
  return `${value.toFixed(2)} km`;
}

function fact(label: string, valueHtml: string): string {
  return `<div class="fact"><p class="fact__k">${escapeHtml(label)}</p><p class="fact__v">${valueHtml || "&mdash;"}</p></div>`;
}

function section(title: string, body: string): string {
  return `<section class="sec"><h2 class="h2">${escapeHtml(title)}</h2>${body}</section>`;
}

function factsBlock(request: OutstationExpenseRequest): string {
  const location = request.capturedLocation;
  const trip = request.sameDayTrip ? "Same-day" : `${request.overnightDays} night${request.overnightDays === 1 ? "" : "s"}`;
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
    ${fact("Workload match (at submission)", escapeHtml(words(request.workloadMatchStatus)))}
  </div>`;
}

function routeBlock(request: OutstationExpenseRequest, map: OutstationReviewDocumentInput["map"]): string {
  const from = tidyAddress(
    [request.residenceAddress, request.residenceArea, request.residenceCity].filter(Boolean).join(", "),
  );
  const to = tidyAddress(request.toLabel ?? request.toCity ?? request.toArea ?? "");
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
      ${fact("Minimum for outstation", escapeHtml(typeof request.minimumRequiredDistanceKm === "number" ? `${request.minimumRequiredDistanceKm.toFixed(0)} km` : "—"))}
    </div>
    ${figure}`;
}

function costBlock(request: OutstationExpenseRequest): string {
  const travel = request.reportTravelCost ?? request.fuelAmount + request.ticketAmount;
  const total = request.claimedTotalAmount || request.expectedTotalAmount;
  const rows: Array<[string, number]> = [
    ["Travel", travel],
    ["Meeting", request.meetingAmount ?? 0],
    ["Allowance", request.allowanceAmount],
    ["Other", request.otherAmount ?? 0],
  ];
  return `<table class="tbl">
    <colgroup><col style="width:70%"><col style="width:30%"></colgroup>
    <thead><tr><th>Component</th><th class="num">Amount</th></tr></thead>
    <tbody>${rows.map(([label, amount]) => `<tr><td>${label}</td><td class="num">${reviewMoney(amount)}</td></tr>`).join("")}</tbody>
    <tfoot><tr><td>Total claimed</td><td class="num">${reviewMoney(total)}</td></tr></tfoot>
  </table>`;
}

function workloadBlock(request: OutstationExpenseRequest, workload: ReviewDocumentWorkload): string {
  const declared = `AM ${request.amWorkload ?? 0} &middot; PM ${request.pmWorkload ?? 0} &middot; Pharmacies ${
    request.pharmacyWorkload === null || request.pharmacyWorkload === undefined ? "not counted separately" : request.pharmacyWorkload
  }`;

  if (!workload.available) {
    return `<div class="facts facts--2">
        ${fact("Declared (sheet)", declared)}
        ${fact("Actual (live CRM)", "Not available")}
      </div>
      <p class="warn">The live CRM read was not available when this document was produced, so no visit count
      is shown for it. This is not a zero &mdash; it is an unanswered question.</p>`;
  }

  const live = workload.live;
  const days = workload.days.length
    ? `<table class="tbl">
        <colgroup><col style="width:34%"><col style="width:11%"><col style="width:11%"><col style="width:14%"><col style="width:15%"><col style="width:15%"></colgroup>
        <thead><tr><th>Day</th><th class="num">AM</th><th class="num">PM</th><th class="num">Pharmacies</th><th class="num">Regular</th><th class="num">Campaign</th></tr></thead>
        <tbody>${workload.days
          .map(
            (day) =>
              `<tr><td>${escapeHtml(cairoDate(day.date))}</td><td class="num">${day.am}</td><td class="num">${day.pm}</td><td class="num">${day.pharmacies}</td><td class="num">${day.regular}</td><td class="num">${day.campaign}</td></tr>`,
          )
          .join("")}</tbody>
      </table>`
    : "";

  return `<div class="facts facts--3">
      ${fact("Declared (sheet)", declared)}
      ${fact("Actual (live CRM)", `AM ${live.am} &middot; PM ${live.pm} &middot; Pharmacies ${live.pharmacies}`)}
      ${fact("Visit type", `Regular ${live.regular} &middot; Campaign ${live.campaign}`)}
    </div>
    ${workload.freshnessHeadline ? `<p class="warn"><strong>Stored verdict is out of date.</strong> ${escapeHtml(workload.freshnessHeadline)}</p>` : ""}
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
    pieces.push(`<p class="warn">${escapeHtml(notice)}</p>`);
  }
  for (const stamp of parts.evidence) {
    const [heading, ...rest] = outstationEvidenceLines(stamp);
    pieces.push(
      `<p class="stamp"><strong>${escapeHtml(heading)}</strong>${rest.map((line) => `<br>${bidi(line)}`).join("")}</p>`,
    );
  }
  return pieces.length > 0 ? pieces.join("") : `<p class="thin">No notes.</p>`;
}

function photosBlock(photos: ReviewDocumentPhoto[]): string {
  if (photos.length === 0) return `<p class="thin">No photos are on file for this request.</p>`;
  return `<div class="photos">${photos
    .map(
      (photo) => `<figure class="photo">
        ${photo.image ? `<img src="${photo.image}" alt="${escapeHtml(photo.label)}">` : `<div class="photo__none">No picture</div>`}
        <figcaption><strong>${escapeHtml(photo.label)}</strong>${photo.capturedAtLabel ? ` &middot; ${escapeHtml(photo.capturedAtLabel)}` : ""}
        ${photo.locationLabel ? `<br>${bidi(photo.locationLabel)}` : ""}
        ${photo.note ? `<br><span class="thin">${escapeHtml(photo.note)}</span>` : ""}</figcaption>
      </figure>`,
    )
    .join("")}</div>`;
}

/**
 * The footer Chromium prints on every page. A flowing document has no fixed page count, so the
 * page numbers come from Chromium's own `pageNumber`/`totalPages` rather than from a hand count.
 * Its styles MUST be inline: the footer template does not see the document's stylesheet.
 */
export function outstationReviewFooter(input: { generatedOn: string; requestId: number }): string {
  const c = HOUSE_COLORS;
  const cell = `margin:0;font-size:6.8pt;color:${c.muted};font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif;`;
  return `<div style="width:100%;padding:0 12mm;box-sizing:border-box;">
    <div style="height:.8pt;background:${c.hair};margin-bottom:1.6mm;"></div>
    <div style="display:flex;justify-content:space-between;gap:4mm;">
      <p style="${cell}"><strong>SATO-DIS-2026-01 v1.0</strong> &middot; Sato Pharma</p>
      <p style="${cell}text-align:center;">Outstation request OUTSTATION-${input.requestId} &middot; read from the live system on ${escapeHtml(input.generatedOn)}, Cairo time</p>
      <p style="${cell}text-align:right;white-space:nowrap;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></p>
    </div>
  </div>`;
}

export function buildOutstationReviewDocument(input: OutstationReviewDocumentInput): string {
  const { request } = input;
  const name = request.employeeName?.trim() || "Unassigned";
  const capture = resolveCaptureTimeliness({ capturedAt: request.capturedAt, tripEndDate: request.tripEndDate });

  const masthead = `<header class="mast">
      ${input.mark ? `<img class="mast__mark" src="${input.mark}" alt="Sato Pharma">` : '<div class="mast__mark"></div>'}
      <div class="mast__id">
        <p class="mast__doc">Outstation Trip Review</p>
        <p class="mast__sub">${escapeHtml(name)}${request.employeeRole ? ` &middot; ${escapeHtml(request.employeeRole)}` : ""}</p>
        <p class="mast__sub mast__sub--thin">OUTSTATION-${request.id} &middot; ${escapeHtml(words(request.status))}</p>
      </div>
    </header>
    <div class="mast__rule"></div>`;

  const lede = `<h1 class="title">${escapeHtml(name)}</h1>
    <p class="lede">The review of outstation request OUTSTATION-${request.id} as it stands in Phoenix, read from the
    live system on ${escapeHtml(input.generatedOn)}, Cairo time. Every figure below is the one the review screen shows.</p>`;

  const lateCapture =
    capture.verdict === "late" && capture.headline
      ? `<p class="warn"><strong>Location captured after the trip ended.</strong> ${escapeHtml(capture.headline)}</p>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Outstation Trip Review · OUTSTATION-${request.id}</title>
<style>${documentCss()}</style>
</head>
<body>
  ${masthead}
  ${lede}
  ${lateCapture}
  ${section("The trip", factsBlock(request))}
  ${section("Route", routeBlock(request, input.map))}
  ${section("Cost breakdown", costBlock(request))}
  ${section("Verified workload", workloadBlock(request, input.workload))}
  ${section("Checks and recommendation", validationBlock(request))}
  ${section("Notes", notesBlock(request))}
  ${section("Photos", photosBlock(input.photos))}
</body>
</html>`;
}

function documentCss(): string {
  const c = HOUSE_COLORS;
  return `
@page { size: A4 portrait; margin: 12mm 12mm 18mm 12mm; }
* { box-sizing: border-box; border-radius: 0 !important; }
/* AN EXPLICIT WHITE GROUND, AND LIGHT ONLY.
   This document set ink colours but inherited its background, so on a machine in dark mode the
   whole paper rendered near-black with near-black text — caught by screenshotting it on 2026-09-29
   rather than by reading the CSS. A printed document is white by definition; it must never be at
   the mercy of the renderer's colour scheme. The color-scheme declaration also stops Chromium
   force-inverting table chrome. (No backticks in this comment: it lives inside a template
   literal, and one would end the string.) */
html { color-scheme: only light; }
html, body { margin: 0; padding: 0; background: #FFFFFF; }
body { font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; color: ${c.body}; font-size: 8.4pt; line-height: 1.38; }
.mast { display: flex; align-items: flex-start; justify-content: space-between; gap: 8mm; }
.mast__mark { width: 30mm; height: auto; }
.mast__id { text-align: right; }
.mast__doc { margin: 0; font-size: 11pt; font-weight: 700; color: ${c.deep}; letter-spacing: .02em; }
.mast__sub { margin: 1mm 0 0; font-size: 8.2pt; font-weight: 600; }
.mast__sub--thin { color: ${c.muted}; font-weight: 400; }
.mast__rule { height: 1.6pt; background: ${c.blue}; margin: 2mm 0 4mm; }
.title { margin: 0 0 1.5mm; font-size: 15pt; font-weight: 700; color: ${c.deep}; letter-spacing: -.01em; }
.lede { margin: 0 0 4mm; font-size: 8.8pt; }
.sec { margin: 0 0 4mm; }
.h2 { margin: 0 0 1.8mm; font-size: 8pt; font-weight: 700; text-transform: uppercase; letter-spacing: .1em;
      color: ${c.deep}; border-bottom: 1pt solid ${c.blue}; padding-bottom: 1mm; break-after: avoid; }
.thin { color: ${c.muted}; font-weight: 400; }
.facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-top: .6pt solid ${c.hair}; border-left: .6pt solid ${c.hair}; break-inside: avoid; }
.facts--2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.facts--3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.fact { border-right: .6pt solid ${c.hair}; border-bottom: .6pt solid ${c.hair}; padding: 1.3mm 2mm; min-width: 0; }
.fact__k { margin: 0 0 .8mm; font-size: 6.6pt; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: ${c.muted}; }
.fact__v { margin: 0; font-size: 8.4pt; font-weight: 600; overflow-wrap: anywhere; }
.route { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 1mm 3mm; margin: 0 0 2.4mm; }
.route dt { font-size: 6.6pt; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: ${c.muted}; padding-top: .5mm; }
.route dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.map { margin: 2.4mm 0 0; break-inside: avoid; }
.map img { width: 100%; height: auto; display: block; border: .8pt solid ${c.hair}; }
.map figcaption { margin-top: 1.2mm; font-size: 6.9pt; color: ${c.muted}; }
.tbl { width: 100%; table-layout: fixed; border-collapse: collapse; break-inside: auto; }
.tbl th { text-align: left; font-size: 6.8pt; font-weight: 700; text-transform: uppercase; letter-spacing: .06em;
          color: ${c.deep}; border-bottom: 1pt solid ${c.deep}; padding: 1.5mm; }
.tbl td { padding: 1.1mm 1.5mm; vertical-align: top; border-bottom: .5pt solid ${c.hair}; overflow-wrap: anywhere; }
.tbl tbody tr:nth-child(odd) td { background: ${c.tint}; }
.tbl tr { break-inside: avoid; }
.tbl .num, .tbl th.num { text-align: right; }
.tbl tfoot td { padding: 1.8mm 1.5mm; border-top: 1pt solid ${c.deep}; border-bottom: none; font-weight: 700; }
.since { display: block; margin-top: 1mm; padding-left: 2.5mm; border-left: 1.4pt solid ${c.blue}; color: ${c.deep}; }
.note { border-left: 2pt solid ${c.light}; padding-left: 3.5mm; margin: 0 0 2mm; }
.note p { margin: 0 0 1mm; }
.warn { margin: 0 0 2.4mm; border-left: 2pt solid ${c.deep}; padding-left: 3.5mm; }
.stamp { margin: 0 0 2mm; border-left: 2pt solid ${c.hair}; padding-left: 3.5mm; }
.photos { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4mm; }
.photo { margin: 0; break-inside: avoid; }
.photo img { width: 100%; height: 62mm; object-fit: cover; display: block; border: .8pt solid ${c.hair}; }
.photo__none { height: 62mm; border: .8pt dashed ${c.hair}; display: flex; align-items: center; justify-content: center; color: ${c.muted}; }
.photo figcaption { margin-top: 1.2mm; font-size: 7.2pt; overflow-wrap: anywhere; }
`;
}
