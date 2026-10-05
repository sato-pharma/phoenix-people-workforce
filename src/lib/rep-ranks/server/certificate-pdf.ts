// Phoenix Ranks — the certificate's data and its PDF. The document itself is pure (../certificate.ts);
// this file reads the standing it prints and hands the HTML to Chromium.
//
// Read with the PORTAL audience whoever asks: the certificate is scores only, exactly what the rep's
// own page shows, so it never selects the `metrics` column (read.ts).

import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { polishPortraitDataUri, portraitInitials } from "@/lib/milestones/portrait";
import { loadMilestonePhotoBytes } from "@/lib/milestones/service";
import { withChromiumPage } from "@/lib/pdf/chromium";
import { rankCertificateHtml, type RankCertificateInput } from "@/lib/rep-ranks/certificate";
import { loadRankBoard, loadTitles } from "@/lib/rep-ranks/server/read";
import type { RankWindowKind } from "@/lib/rep-ranks/windows";

/** A request that cannot be answered with a certificate, with the words the rep reads and the HTTP status. */
export class RankCertificateError extends Error {
  readonly status: 403 | 404;

  constructor(message: string, status: 403 | 404) {
    super(message);
    this.name = "RankCertificateError";
    this.status = status;
  }
}

const PORTRAIT_WIDTH = 480;
const idKey = (value: string | null | undefined): string => String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * The rep's photograph, polished, as a data URI — the performance card's own source (uploaded, then
 * the bundled portal photo), so the certificate shows the face the portal shows. Null for the
 * initials plate. Never throws: a certificate without a picture beats no certificate.
 */
async function certificatePortrait(hrIdKey: string): Promise<string | null> {
  try {
    const person = (await getEmployeeDirectoryRows()).find((row) => idKey(row.hrId) === idKey(hrIdKey));
    if (!person?.hrId) return null;
    const bytes = await loadMilestonePhotoBytes(person.hrId);
    return bytes ? await polishPortraitDataUri(bytes, { width: PORTRAIT_WIDTH }) : null;
  } catch {
    return null;
  }
}

function cairoDateLabel(at: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", day: "numeric", month: "long", year: "numeric" }).format(at);
}

/** Everything the certificate prints for one rep in one window. Throws RankCertificateError when there is nothing to certify. */
export async function loadRankCertificate(input: { hrIdKey: string; kind: RankWindowKind; windowKey: string | null }): Promise<RankCertificateInput> {
  const [board, titles] = await Promise.all([loadRankBoard({ kind: input.kind, windowKey: input.windowKey, audience: "portal" }), loadTitles()]);
  if (!board.window) throw new RankCertificateError("No ranking has been computed for this period yet.", 404);
  const row = board.rows.find((candidate) => candidate.hrIdKey === input.hrIdKey);
  if (!row) throw new RankCertificateError("This rep is not on the board for this period.", 404);
  if (!row.ranked || row.total === null || row.companyPosition === null) {
    throw new RankCertificateError("The certificate is issued once the rep is ranked in the period. Pick a period with enough days in the field.", 403);
  }
  const leader = board.rows.find((candidate) => candidate.ranked && candidate.companyPosition === 1) ?? null;
  const runnerUp = board.rows.find((candidate) => candidate.ranked && candidate.companyPosition === 2) ?? null;
  const photoDataUri = await certificatePortrait(row.hrIdKey);
  return {
    repName: row.repName,
    lineName: row.lineName,
    areaName: row.areaName,
    kind: board.kind,
    windowLabel: board.window.label,
    closed: board.window.closed,
    total: row.total,
    companyPosition: row.companyPosition,
    companyCount: row.companyCount,
    linePosition: row.linePosition,
    lineCount: row.lineCount,
    pillars: row.pillars,
    rank: row.rank,
    rollingScore: row.rollingScore,
    stars: row.stars,
    titles: titles.get(row.hrIdKey) ?? [],
    leaderTotal: leader?.total ?? null,
    runnerUpTotal: runnerUp?.total ?? null,
    issuedLabel: cairoDateLabel(new Date()),
    photoDataUri,
    initials: portraitInitials(row.repName),
  };
}

/** The certificate, as a PDF. Throws `ChromiumUnavailableError` when the runtime cannot render one. */
export async function renderRankCertificatePdf(input: RankCertificateInput): Promise<Uint8Array> {
  const html = rankCertificateHtml(input);
  return withChromiumPage(async (page) => {
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.emulateMediaType("print");
    return page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
  });
}
