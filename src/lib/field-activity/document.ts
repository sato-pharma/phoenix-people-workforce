/**
 * Field Activity — the report as a house document.
 *
 * SATO-DIS-2026-01 v1.0 in the HR PREMIUM dress (owner, 2026-10-13: ticked "change to the premium
 * look" on the review page): the company's identity on the company's paper, carried by line and type,
 * with the premium frame, watermark, masthead and running foot. The ink rule holds — no filled areas
 * except the 6% zebra on data tables — and every corner is square. It prints LANDSCAPE, which is not a stylistic choice: a day page carries a route map
 * beside a table of stops each of which needs its coordinates and its full address, and on portrait
 * A4 that either spills to a second page or forces the address down to a size nobody reads.
 *
 * ONE PAGE PER DAY, and a deliberate second page when a day earns one. A day with more than eight
 * GPS stops holds about twice the content of an ordinary one; rather than shrink the type or drop
 * the address, such a day prints its summary, map and claim on the first page and its full stop
 * list on a page headed "— every stop" and footed "(continued)". Nothing is lost and nothing is
 * cramped.
 */

import {
  PHARMACIES_IREPORTS360_ONLY,
  PHARMACIES_NOT_RECORDED_IN_PHOENIX,
  PHOENIX_LOGS_NO_PHARMACY_VISIT,
  formatVisitCountSplit,
  pharmacyFigureText,
  pharmacyRecordingOf,
  type VisitCountSplit,
} from "@/lib/crm/visit-count-buckets";
import { systemLegalEntity } from "@/config/system-settings";
import { HOUSE_COLORS } from "@/lib/hiring-pack/house-identity";
import {
  PREMIUM_COMPANY_DOCUMENT_BRAND,
  PREMIUM_IDENTITY_CSS,
  premiumMasthead,
  premiumPageChrome,
  premiumSheetCss,
} from "@/lib/hiring-pack/premium-identity";
import type {
  FieldActivityDay,
  FieldActivityReport,
  FieldActivityStop,
} from "@/lib/field-activity/model";

export type FieldActivityDayMap = { dateIso: string; svg: string; caption: string };

const DENSE_STOPS = 8;

/**
 * "AM 3 &middot; PM 9 &middot; Pharmacies 2" through the golden-rule helper, so a day logged in Phoenix CRM
 * — which records no pharmacy visit — reads "Pharmacies not recorded in Phoenix", never 0.
 */
function countsFact(counts: VisitCountSplit): string {
  return formatVisitCountSplit(counts).split(" · ").map(escapeHtml).join(" &middot; ");
}

/** "3 &middot; 9 &middot; 2" for the summary table's one AM · PM · Ph cell, with the same words. */
function countsCell(counts: VisitCountSplit): string {
  return `${counts.am} &middot; ${counts.pm} &middot; ${escapeHtml(pharmacyFigureText(counts))}`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Direction PER RUN, never per block.
 *
 * Wrapping a mixed line in `dir="rtl"` is the bug: an address like "شرف - برج الحكمة, ش Gamal Abd
 * El-Nasir, Qism Shebeen El-Kom" then reorders its Latin parts and throws the commas and full stops
 * to the wrong end. Each Arabic run gets its own isolated span and the Latin around it is untouched.
 */
/**
 * The Phoenix field set as ONE wrapped sentence under the row it belongs to.
 *
 * A printed page has no viewport either, but it has a COLUMN — this report prints two side by side — so
 * the detail is still prose rather than cells. The tier was decided on the server
 * (`phoenix-visit-detail.ts`); this prints what arrived and never re-derives one, and a PDF is a
 * document somebody keeps and forwards, so it must say exactly what its reader could see on screen.
 */
function phoenixLine(detail: FieldActivityStop["phoenix"]): string | null {
  if (!detail) return null;
  const parts = [
    detail.products.length > 0 ? detail.products.join(" · ") : null,
    detail.samples ? `samples ${detail.samples}` : null,
    detail.availability,
    detail.objection,
    detail.nextStep,
    detail.pharmacyFeedback ? `pharmacy ${detail.pharmacyFeedback}` : null,
    detail.offPlan,
    detail.location,
    detail.evidence,
    detail.capture,
  ].filter((part): part is string => typeof part === "string" && part.trim().length > 0);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function bidi(value: string | null | undefined): string {
  const text = String(value ?? "");
  if (!text) return "";
  const runs = text.split(/([؀-ۿ][؀-ۿ\s،؛؟-]*)/);
  return runs
    .filter(Boolean)
    .map((run) =>
      /^[؀-ۿ]/.test(run)
        ? `<span dir="rtl" lang="ar">${escapeHtml(run.trim())}</span>`
        : `<span dir="ltr">${escapeHtml(run)}</span>`,
    )
    .join("");
}

/** The country and the postal number repeat on every row and locate nothing the coordinates do not. */
export function tidyAddress(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/,?\s*(Egypt|مصر)\s*$/u, "")
    .replace(/\s+\d{5,8}(?=,|$)/g, "")
    .trim()
    .replace(/,$/, "");
}

export function clock12(value: string | null | undefined): string {
  if (!value) return "—";
  const text = String(value).length > 8 ? String(value).slice(-8) : String(value);
  const match = /^(\d{2}):(\d{2})/.exec(text);
  if (!match) return "—";
  const hour = Number(match[1]);
  const suffix = hour < 12 ? "AM" : "PM";
  return `${hour % 12 || 12}:${match[2]} ${suffix}`;
}

export function longDate(dateIso: string, weekday: string): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  const month = date.toLocaleString("en-GB", { month: "long", timeZone: "UTC" });
  return `${weekday} ${date.getUTCDate()} ${month} ${date.getUTCFullYear()}`;
}

function money(value: number): string {
  return value.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function duration(minutes: number | null): string {
  if (minutes == null) return "—";
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

function fact(label: string, value: string): string {
  return `<div class="fact"><p class="fact__k">${escapeHtml(label)}</p><p class="fact__v">${value}</p></div>`;
}

function dayChip(day: FieldActivityDay): string {
  switch (day.kind) {
    case "field":
      return "Field day";
    case "field-no-gps":
      return "Field record with no GPS";
    case "leave":
      return "Approved leave";
    case "own-visits":
      return "Own visits, made alone";
    case "office":
      return "Head office day";
    case "weekend":
      return "Weekend";
    default:
      return "No activity recorded";
  }
}

function dayFacts(day: FieldActivityDay): string[] {
  const facts: string[] = [];
  if (day.partners.length > 0) {
    facts.push(fact("Out with", day.partners.map((p) => escapeHtml(p.name)).join("<br>")));
  }
  if (day.leave) {
    facts.push(
      fact(
        "Where they were",
        `On approved leave<br><span class="thin">${escapeHtml(day.leave.type ?? "leave")} &middot; ${escapeHtml(day.leave.dayPart ?? "")} &middot; ${escapeHtml(day.leave.status ?? "")}</span>`,
      ),
    );
    if (day.leave.reference) {
      facts.push(
        fact(
          "Leave record",
          `${escapeHtml(day.leave.reference)}<br><span class="thin">${escapeHtml(day.leave.paymentStatus ?? "")}${day.leave.managerName ? ` &middot; approved by ${escapeHtml(day.leave.managerName)}` : ""}</span>`,
        ),
      );
    }
  }
  if (day.countedTotal > 0 || day.stops.length > 0) {
    facts.push(
      fact("Counted visits", countsFact(day.counts)),
    );
  }
  if (day.firstCheckin && day.lastCheckin) {
    facts.push(fact("GPS window", `${clock12(day.firstCheckin)} to ${clock12(day.lastCheckin)}`));
    facts.push(fact("Time on territory", `${duration(day.onTerritoryMinutes)}<br><span class="thin">first to last check-in</span>`));
  }
  if (day.firstLog) {
    const tail = day.logsLandedNextDay
      ? `<br><span class="thin">the NEXT day &mdash; average ${((day.averageLogLagMinutes ?? 0) / 60).toFixed(1)} hours after the door</span>`
      : day.averageLogLagMinutes != null
        ? `<br><span class="thin">average ${day.averageLogLagMinutes} min after the door</span>`
        : "";
    facts.push(fact("Logging window", `${clock12(day.firstLog)} to ${clock12(day.lastLog)}${tail}`));
  }
  if (day.stops.length > 1) {
    facts.push(
      fact("Movement between stops", `${(day.movementMetres / 1000).toFixed(2)} km<br><span class="thin">straight-line, stop to stop</span>`),
    );
  }
  if (day.trip?.capturedAt && day.trip.capturedLat != null && day.trip.capturedLon != null) {
    facts.push(
      fact(
        "Their own phone fix",
        `${clock12(day.trip.capturedAt)}${day.trip.capturedAccuracyMeters != null ? ` &middot; accuracy ${Math.round(day.trip.capturedAccuracyMeters)} m` : ""}` +
          `<br><span class="thin">${day.trip.capturedLat.toFixed(6)}, ${day.trip.capturedLon.toFixed(6)}</span>`,
      ),
    );
  }
  if (day.punches) {
    facts.push(
      fact(
        "Fingerprint punch",
        `${clock12(day.punches.firstTime)} to ${clock12(day.punches.lastTime)}<br><span class="thin">${day.punches.count} punch${day.punches.count === 1 ? "" : "es"}</span>`,
      ),
    );
  }
  if (day.kind === "weekend") facts.push(fact("Why the day is empty", "Friday is the weekend<br><span class=\"thin\">nothing is expected on this day</span>"));
  if (day.kind === "empty") facts.push(fact("Records on this day", "None &mdash; no visit, no GPS, no punch, no trip"));
  return facts;
}

function stopRowWide(stop: FieldActivityStop): string {
  return `<tr>
  <td class="num"><strong>${stop.index}</strong></td>
  <td>${clock12(stop.checkedAt)} <span class="thin">${escapeHtml(stop.checkedAt.slice(-2))}s</span></td>
  <td>${bidi(stop.customerName)}
      <div class="addr">${stop.lat.toFixed(6)}, ${stop.lon.toFixed(6)}${stop.address ? ` &mdash; ${bidi(tidyAddress(stop.address))}` : ""}</div></td>
  <td>${escapeHtml(stop.speciality ?? "—")} <span class="thin">&middot; ${escapeHtml(stop.grade ?? "—")}</span></td>
  <td class="num">${escapeHtml(stop.ampm ?? "—")}</td>
  <td>${clock12(stop.savedAt)} <span class="thin">${stop.logLagMinutes == null ? "" : `+${stop.logLagMinutes}m`}</span></td>
  <td class="num">${stop.legMetres == null ? "&mdash;" : `${stop.legMetres} m`}</td>
</tr>`;
}

function stopRowNarrow(stop: FieldActivityStop): string {
  return `<tr>
  <td class="num"><strong>${stop.index}</strong></td>
  <td>${clock12(stop.checkedAt)}</td>
  <td>${bidi(stop.customerName)} <span class="thin">&middot; ${escapeHtml(stop.speciality ?? "—")} ${escapeHtml(stop.grade ?? "")} &middot; ${escapeHtml(stop.ampm ?? "")}</span>
      <div class="addr">${stop.lat.toFixed(6)}, ${stop.lon.toFixed(6)}${stop.address ? ` &mdash; ${bidi(tidyAddress(stop.address))}` : ""}${stop.legMetres == null ? "" : ` &mdash; ${stop.legMetres} m from the last stop`}</div></td>
  <td class="num">${clock12(stop.savedAt)} <span class="thin">${stop.logLagMinutes == null ? "" : `+${stop.logLagMinutes}m`}</span></td>
</tr>`;
}

function stopsTable(day: FieldActivityDay, compact: boolean): string {
  const cols = compact
    ? '<colgroup><col style="width:7%"><col style="width:20%"><col style="width:44%"><col style="width:29%"></colgroup>'
    : '<colgroup><col style="width:4%"><col style="width:12%"><col style="width:39%"><col style="width:16%"><col style="width:9%"><col style="width:13%"><col style="width:7%"></colgroup>';
  const head = compact
    ? '<tr><th class="num">#</th><th>In</th><th>Customer and address</th><th class="num">Logged</th></tr>'
    : '<tr><th class="num">#</th><th>Checked in</th><th>Customer, coordinates and address</th><th>Speciality, grade</th><th class="num">AM/PM</th><th>Logged at</th><th class="num">Leg</th></tr>';
  const body = day.stops.map((stop) => (compact ? stopRowNarrow(stop) : stopRowWide(stop))).join("");
  return `<table class="tbl">${cols}<thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function tripBlock(day: FieldActivityDay): string {
  const trip = day.trip;
  if (!trip) return "";
  const workload = trip.workload;
  return `
  <h2 class="h2">Outstation claim ${escapeHtml(trip.reference)}</h2>
  <div class="facts facts--2">
    ${fact("Destination", `${escapeHtml(trip.destination ?? "—")}<br><span class="thin">${escapeHtml(trip.transport ?? "")}${trip.distanceKm != null ? ` &middot; ${trip.distanceKm.toFixed(2)} km` : ""}${trip.durationMinutes != null ? ` &middot; ${Math.round(trip.durationMinutes)} min` : ""}${trip.minimumKm != null ? ` (minimum ${trip.minimumKm} km)` : ""}</span>`)}
    ${fact("Money claimed", `<strong>${money(trip.claimedTotal)}</strong><br><span class="thin">fuel ${money(trip.fuel)} &middot; allowance ${money(trip.allowance)} &middot; tickets ${money(trip.tickets)} &middot; meeting and other ${money(trip.meeting + trip.other)}</span>`)}
    ${fact("Decision", `${trip.approvedTotal != null ? money(trip.approvedTotal) : "Not decided"}<br><span class="thin">${escapeHtml(trip.status ?? "")} &middot; ${escapeHtml(trip.eligibility ?? "")} &middot; ${escapeHtml(trip.recommendation ?? "")}</span>`)}
    ${fact("Gates", `${escapeHtml(trip.evidenceGate ?? "—")}<br><span class="thin">workload ${escapeHtml((trip.workloadGate ?? "").toLowerCase())} &mdash; AM ${workload.am ?? 0} &middot; PM ${workload.pm ?? 0} &middot; Ph ${workload.pharmacies ?? 0}</span>`)}
  </div>`;
}

/**
 * The premium masthead, one per printed page: full-size on the cover, slim on every day page. A slim
 * one drops the diamond rule and sets a smaller title, because this one repeats on every page of a
 * report that can run to 30 or more of them and each page needs its height for the stops and the map.
 *
 * The two lines the old masthead carried under the title are its subtitles, word for word.
 */
function masthead(report: FieldActivityReport, period: string, slim: boolean): string {
  const subject = report.subject;
  const subjectLine = [subject.name, subject.jobTitle, subject.lineName ? `${subject.lineName} line` : null]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  // The masthead letter-spaces its English subtitles, and letter-spacing cuts the joins of Arabic.
  const langOf = (text: string): "ar" | "en" => (/[؀-ۿ]/.test(text) ? "ar" : "en");
  return premiumMasthead({
    compact: !slim,
    legalNameAr: systemLegalEntity.legalNameAr,
    legalNameEn: systemLegalEntity.legalNameEn,
    orientation: "landscape",
    slim,
    subtitles: [
      { lang: langOf(subjectLine), text: subjectLine },
      { lang: "en", text: period },
    ],
    title: "Field Activity Report",
    titleLang: "en",
  });
}

export function buildFieldActivityDocument(input: {
  report: FieldActivityReport;
  maps: FieldActivityDayMap[];
  generatedOn: string;
}): string {
  const { report } = input;
  const mapsByDay = new Map(input.maps.map((map) => [map.dateIso, map]));
  const periodLabel = `${report.fromIso} to ${report.toIso}`;
  // Fixed in print, so Chrome repeats it on every page: it is written once, on the cover. Its running
  // foot carries the line the old in-page footer carried, which is the same on every page.
  const chrome = premiumPageChrome({
    brand: PREMIUM_COMPANY_DOCUMENT_BRAND,
    department: `Employee record ${report.subject.hrId} · read from the live system on ${input.generatedOn}, Cairo time`,
    orientation: "landscape",
  });

  const rows = report.days
    .map((day) => {
      const counted = day.countedTotal > 0 ? countsCell(day.counts) : "&mdash;";
      const gps = day.firstCheckin && day.lastCheckin ? `${clock12(day.firstCheckin)} &ndash; ${clock12(day.lastCheckin)}` : day.punches ? `${clock12(day.punches.firstTime)} &ndash; ${clock12(day.punches.lastTime)} (punch)` : "None";
      const what =
        day.kind === "field"
          ? `Field day${day.partners.length > 0 ? ` &mdash; with ${escapeHtml(day.partners[0].name)}` : ""}`
          : day.kind === "leave"
            ? `Approved ${escapeHtml((day.leave?.type ?? "leave").toLowerCase())} leave${day.countedTotal > 0 ? " &mdash; and a visit recorded anyway" : ""}`
            : day.kind === "field-no-gps"
              ? "Field record with no GPS"
              : day.kind === "own-visits"
                ? `Own visits, made alone (${day.ownVisits.length}) &mdash; counted in no figure`
              : day.kind === "office"
                ? "Head office &mdash; fingerprint attendance"
                : day.kind === "weekend"
                  ? "Weekend"
                  : "No record of any kind";
      return `<tr><td><strong>${escapeHtml(longDate(day.dateIso, day.weekday))}</strong></td><td>${what}</td><td class="num">${counted}</td><td>${gps}</td><td class="num">${day.trip ? money(day.trip.claimedTotal) : "&mdash;"}</td></tr>`;
    })
    .join("");

  const flagBlock =
    report.flags.length > 0
      ? `<h2 class="h2">What the report could not reconcile</h2><ul class="list">${report.flags
          .map((flag) => `<li><strong>${escapeHtml(longDate(flag.dateIso, "")).trim()}</strong> &middot; ${escapeHtml(flag.message)}</li>`)
          .join("")}</ul>`
      : "";

  const cover = `
<section class="page">
  ${masthead(report, periodLabel, false)}
  <h1 class="title">Field activity, day by day</h1>
  <p class="lede">Every visit, every GPS fix, every logged time and every expense recorded for
  ${escapeHtml(report.subject.name)} between ${escapeHtml(report.fromIso)} and ${escapeHtml(report.toIso)},
  read from the live system on ${escapeHtml(input.generatedOn)}. One page per day follows this summary.</p>

  <h2 class="h2">The period at a glance</h2>
  <table class="tbl">
    <colgroup><col style="width:24%"><col style="width:30%"><col style="width:13%"><col style="width:20%"><col style="width:13%"></colgroup>
    <thead><tr><th>Day</th><th>What the day was</th><th class="num">AM &middot; PM &middot; Ph</th><th>GPS window</th><th class="num">Claimed</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td colspan="2">Total</td><td class="num"><strong>${countsCell(report.totals.counts)}</strong></td><td>${report.totals.fieldDays} field day${report.totals.fieldDays === 1 ? "" : "s"}</td><td class="num"><strong>${money(report.totals.claimedTotal)}</strong></td></tr></tfoot>
  </table>

  <h2 class="h2">How to read this report</h2>
  <div class="note">
    <p><strong>A GPS check-in is where they stood. A logged time is when the call was typed in.</strong>
    Those are different clocks and both are shown on every stop, with the gap between them.</p>
    <p><strong>A manager records no visits of their own.</strong> On a double visit the medical
    representative enters the call and tags the manager on it, so the GPS fix is the
    representative's. Every stop here is a call the subject was tagged on, and the map plots those
    stops only &mdash; never the representative's own later rounds.</p>
    <p><strong>The vendor's clock can read up to an hour early in summer.</strong> The phones sending
    these times mostly sit on Egypt standard time while Cairo is on summer time, so an iReports360
    time is not defensible to the minute. Fingerprint punches are exact.</p>${
      pharmacyRecordingOf(report.totals.counts) === "recorded"
        ? ""
        : `
    <p><strong>${escapeHtml(PHOENIX_LOGS_NO_PHARMACY_VISIT)}.</strong> A pharmacy there is feedback on a
    doctor's visit, so a day logged in Phoenix CRM reads &ldquo;${escapeHtml(PHARMACIES_NOT_RECORDED_IN_PHOENIX)}&rdquo;
    for pharmacies, never 0, and beside iReports360 visits the figure counts those alone
    ${escapeHtml(PHARMACIES_IREPORTS360_ONLY)}.</p>`
    }
  </div>
  ${flagBlock}
  ${chrome}
</section>`;

  const dayPages = report.days
    .map((day, index) => {
      const map = mapsByDay.get(day.dateIso);
      const dense = day.stops.length > DENSE_STOPS;
      const mapBlock = map
        ? `<h2 class="h2">Where their phone put them</h2><figure class="map">${map.svg}<figcaption>${escapeHtml(map.caption)}</figcaption></figure>`
        : "";
      const unlocated =
        day.unlocated.length > 0
          ? `<h2 class="h2">Recorded on this day with no iReports360 check-in to match</h2><ul class="list">${day.unlocated
              .map(
                (item) =>
                  `<li><strong>${clock12(item.savedAt)}</strong>${item.savedOn ? ` <span class="thin">(${escapeHtml(item.savedOn)})</span>` : ""} &middot; ${escapeHtml(item.ampm ?? "—")} &middot; ${bidi(item.label)}${item.counts ? "" : " <span class=\"thin\">— not a customer call, counted in nothing</span>"}${phoenixLine(item.phoenix) ? `<br><span class="thin">${bidi(phoenixLine(item.phoenix) ?? "")}</span>` : ""}</li>`,
              )
              .join("")}</ul>`
          : "";
      // Owner, 2026-10-20 ("Show, keep out of reps"): a manager's own single visits, listed on the manager's own day
      // and counted in nothing — no figure on this document includes them, and none is asked for a position or a photo.
      const own =
        day.ownVisits.length > 0
          ? `<h2 class="h2">Own visits, made alone &mdash; listed, counted in no figure</h2><ul class="list">${day.ownVisits
              .map((item) => {
                const detail = [item.speciality, item.grade ? `Grade ${item.grade}` : null, item.where, item.products.join(", ") || null, item.comment]
                  .filter(Boolean)
                  .join(" · ");
                return `<li><strong>${clock12(item.loggedAt)}</strong> &middot; ${escapeHtml(item.half)} half &middot; ${item.planned ? "Planned" : "Not on the plan"}${item.inVacantTerritory ? " &middot; vacant area" : ""} &middot; ${bidi(item.customerName)}${detail ? `<br><span class="thin">${bidi(detail)}</span>` : ""}</li>`;
              })
              .join("")}</ul>`
          : "";
      const notes = day.notes.length > 0 ? `<p class="warn">${day.notes.map((note) => escapeHtml(note)).join(" ")}</p>` : "";
      const solo =
        day.partnerSoloCalls > 0
          ? `<p class="tail">The medical representative recorded a further <strong>${day.partnerSoloCalls} call${day.partnerSoloCalls === 1 ? "" : "s"}</strong> on this day that ${escapeHtml(report.subject.name.split(" ")[0])} is not tagged on. They are the representative's own work, they are not on the map above, and they are counted nowhere in this report.</p>`
          : "";

      const stopsBlock = day.stops.length > 0 ? `<h2 class="h2">Every stop, in the order their phone recorded it</h2>${stopsTable(day, dense)}` : "";
      const body = dense
        ? `<div class="cols cols--even"><div>${mapBlock}</div><div>${tripBlock(day)}${unlocated}${own}</div></div>`
        : `<div class="cols"><div>${stopsBlock}${unlocated}${own}</div><div>${mapBlock}${tripBlock(day)}</div></div>`;

      const spill = dense
        ? `
<section class="page">
  ${masthead(report, longDate(day.dateIso, day.weekday), true)}
  <div class="dayhead">
    <h1 class="title">${escapeHtml(longDate(day.dateIso, day.weekday))} &mdash; every stop <span class="thin">(continued)</span></h1>
    <p class="chip">${day.stops.length} stops</p>
  </div>
  ${stopsBlock}
</section>`
        : "";

      return `
<section class="page">
  ${masthead(report, longDate(day.dateIso, day.weekday), true)}
  <div class="dayhead">
    <h1 class="title">${escapeHtml(longDate(day.dateIso, day.weekday))}</h1>
    <p class="chip">${escapeHtml(dayChip(day))}</p>
  </div>
  <div class="facts">${dayFacts(day).join("")}</div>
  ${body}
  ${notes}
  ${solo}
</section>${spill}`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Field Activity Report — ${escapeHtml(report.subject.name)} — ${escapeHtml(periodLabel)}</title>
<style>${documentCss()}</style></head>
<body>${cover}${dayPages}</body></html>`;
}

function documentCss(): string {
  const c = HOUSE_COLORS;
  return `
${premiumSheetCss(".page", "landscape")}
${PREMIUM_IDENTITY_CSS}
* { box-sizing: border-box; border-radius: 0 !important; }
html, body { margin: 0; padding: 0; }
body { font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; color: ${c.body}; font-size: 8pt; line-height: 1.34; }
.page { page-break-after: always; }
.page:last-child { page-break-after: auto; }
.dayhead { display: flex; align-items: baseline; justify-content: space-between; gap: 6mm; margin-top: 2.2mm; }
.pm-band + .title { margin-top: 2.6mm; }
.title { margin: 0 0 1.5mm; font-size: 14.5pt; font-weight: 700; color: ${c.deep}; letter-spacing: -.01em; }
.chip { margin: 0; font-size: 7.6pt; font-weight: 700; text-transform: uppercase; letter-spacing: .08em;
        color: ${c.blue}; border: 1pt solid ${c.blue}; padding: .8mm 2.4mm; white-space: nowrap; }
.lede { margin: 0 0 5mm; font-size: 9pt; max-width: 200mm; }
.h2 { display: flex; align-items: center; gap: 3mm; margin: 2.6mm 0 1.4mm; font-size: 8pt; font-weight: 700; text-transform: uppercase; letter-spacing: .1em;
      color: ${c.deep}; }
.h2::after { content: ""; flex: 1 1 auto; border-top: .5pt solid ${c.hair}; }
.thin { color: ${c.muted}; font-weight: 400; font-size: 7.2pt; }
.addr { color: ${c.muted}; font-weight: 400; font-size: 6.3pt; line-height: 1.2; margin-top: .2mm; }
.facts { display: grid; grid-template-columns: repeat(4, 1fr); border-top: .6pt solid ${c.hair}; border-left: .6pt solid ${c.hair}; }
.facts--2 { grid-template-columns: repeat(2, 1fr); }
.fact { border-right: .6pt solid ${c.hair}; border-bottom: .6pt solid ${c.hair}; padding: 1.2mm 2mm; }
.fact__k { margin: 0 0 .8mm; font-size: 6.9pt; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: ${c.muted}; }
.fact__v { margin: 0; font-size: 8.2pt; font-weight: 600; }
.cols { display: grid; grid-template-columns: 1.3fr 1fr; gap: 6mm; align-items: start; }
.cols--even { grid-template-columns: 1.1fr 1fr; }
.map { margin: 0; }
.map svg { width: 100%; height: auto; border: .8pt solid ${c.hair}; display: block; }
.map figcaption { margin-top: 1.2mm; font-size: 6.9pt; color: ${c.muted}; }
.tbl { width: 100%; table-layout: fixed; border-collapse: collapse; }
.tbl th { text-align: left; font-size: 6.9pt; font-weight: 700; text-transform: uppercase; letter-spacing: .06em;
          color: ${c.deep}; border-top: .7pt solid ${c.deep}; border-bottom: .5pt solid ${c.hair}; padding: 1.6mm; }
.tbl td { padding: .85mm 1.4mm; vertical-align: top; border-bottom: .5pt solid ${c.hair}; word-wrap: break-word; }
.tbl tbody tr:nth-child(odd) td { background: ${c.tint}; }
.tbl .num, .tbl th.num { text-align: right; }
.tbl tfoot td { padding: 1.8mm 1.6mm; border-top: .7pt solid ${c.deep}; border-bottom: none; font-weight: 700; }
.note { border-left: 1.2pt solid ${c.blue}; padding-left: 3.5mm; }
.note p { margin: 0 0 2mm; }
.warn { margin: 2.5mm 0 0; border-left: 2pt solid ${c.deep}; padding-left: 3.5mm; }
.tail { margin: 2.5mm 0 0; }
.list { margin: 0; padding-left: 4.5mm; }
.list li { margin-bottom: 1.4mm; }
`;
}
