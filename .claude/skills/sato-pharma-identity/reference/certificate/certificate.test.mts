/**
 * The certificate, pinned.
 *
 * It is the only document in this programme that is signed, which makes it the
 * only one where a wrong figure is an assertion Sato Pharma made about somebody
 * rather than a record it kept. So three properties are held here: it is one
 * landscape page carrying the name and the signature, its figures are the same
 * figures the journey's own last page prints, and the rank appears **only** for
 * the top three of a line.
 *
 * Eligibility is not tested here because it is not in this file: the route
 * refuses a certificate before the programme has closed and for an intern who
 * is no longer active, and those are `requireActiveIntern()` and `span.closed`
 * in src/app/(intern)/journey/certificate/route.ts.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { buildJourney, type JourneyInput } from "../src/lib/journey.ts";
import type { PointLedgerEntry } from "../src/lib/point-ledger.ts";
import {
  NAME_AIR,
  NAME_MIN,
  NAME_SIZE,
  SCRIPT_MIN,
  SCRIPT_SIZE,
  certificateFilename,
  nameFont,
  renderCertificatePdf,
} from "../src/lib/certificate-pdf.ts";
import { measure } from "../src/lib/pdf.ts";
import { satoMarkInk } from "../src/lib/sato-mark.ts";

const START = "2026-08-16";
/* The day after the four weeks end, so every journey built here is closed —
   which is the state a certificate exists in and the only one it renders for. */
const AFTER = "2026-09-20";

function ledgerEntry(occurred_on: string, points: number): PointLedgerEntry {
  return {
    intern_id: "i1",
    kind: "visit",
    source_id: `visit:${occurred_on}:${points}`,
    occurred_at: `${occurred_on}T09:00:00Z`,
    week_no: 1,
    title: "Visit",
    detail: "",
    formula: "",
    potential_points: points,
    points,
    status: "counted",
    sort_rank: 1,
  } as PointLedgerEntry;
}

const visit = (date: string, name: string) => ({
  id: `${date}-${name}`,
  visit_date: date,
  visit_type: "pharmacy" as const,
  mode: "solo",
  contact_name: name,
  products: 0,
});

function input(over: Partial<JourneyInput> = {}): JourneyInput {
  return {
    today: AFTER,
    programmeStart: START,
    weekCount: 4,
    programmeName: "Future Talents 2026",
    profile: {
      fullName: "Aya Elsawy",
      submissionId: "FTP-20260012",
      verificationId: "3f6c2a9e-8b1d-4e57-a0c4-9d2e7b6f1a38",
      line: "OTC",
      area: "Cairo",
      mentor: null,
    },
    weeks: [],
    visits: [
      visit("2026-08-18", "El Ezaby"),
      visit("2026-08-19", "Seif"),
      visit("2026-08-19", "Roshdy"),
    ],
    ledger: [ledgerEntry("2026-08-18", 12), ledgerEntry("2026-08-19", 8)],
    sessions: [],
    quizzes: [],
    orders: [],
    awardDates: [],
    social: null,
    totals: { points: 20, target: 338, finalPoints: 20 },
    standing: null,
    ...over,
  };
}

const read = (over: Partial<JourneyInput> = {}) => {
  const journey = buildJourney(input(over));
  const file = Array.from(renderCertificatePdf(journey), (b) =>
    String.fromCharCode(b),
  ).join("");
  return { journey, file };
};

/**
 * The citation as printed: every 13pt run with its fill, face and position,
 * grouped into lines by baseline and read left to right. The citation is the
 * only 13pt type on the page, set in two faces since its key phrases are bold.
 */
type Run = { rgb: number[]; bold: boolean; x: number; y: number; text: string };
function citationLines(file: string): Run[][] {
  const runs: Run[] = [
    ...file.matchAll(
      /BT ([\d.]+) ([\d.]+) ([\d.]+) rg \/F(\d) 13 Tf 1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm \((.*?)\) Tj ET/g,
    ),
  ].map((m) => ({
    rgb: [m[1], m[2], m[3]].map(Number),
    bold: m[4] === "2",
    x: Number(m[5]),
    y: Number(m[6]),
    text: m[7],
  }));
  const baselines = [...new Set(runs.map((run) => run.y))].sort((a, b) => b - a);
  return baselines.map((y) => runs.filter((run) => run.y === y).sort((a, b) => a.x - b.x));
}

test("the certificate is one landscape page, signed and identified", () => {
  const { journey, file } = read();

  assert.equal(journey.span.closed, true, "the fixture is a finished programme");
  assert.equal(file.match(/\/Count (\d+)/)?.[1], "1", "one page, never two");
  /* A4 landscape: 842 wide by 595. A certificate that comes out portrait reads
     as a letter, which is the one thing this page must not look like. */
  assert.ok(
    /\/MediaBox \[0 0 842 595\]/.test(file),
    "landscape A4, and that is deliberate",
  );

  assert.ok(file.includes("(Aya Elsawy) Tj"), "the name is the content");
  assert.ok(
    file.includes("(CERTIFICATE OF COMPLETION) Tj"),
    "it says what it is",
  );
  assert.ok(
    file.includes("(Omar Anwar Gawish) Tj"),
    "it is signed, which is the whole difference from the journey",
  );
  assert.ok(
    // WinAnsi middot, written as the byte itself rather than as an escape.
    file.includes("(HR Section Head · Sato Pharma) Tj"),
    "and the signatory's role is on it",
  );
  /* The record column is the date of issue only (owner, 13 Sep 2026): the FTP
     number is where the journey's password is cut from, and a certificate is
     handed to strangers. */
  assert.ok(
    !file.includes("FTP-20260012"),
    "the certificate prints no FTP number",
  );
  assert.ok(
    file.includes("(12 September 2026) Tj") && file.includes("(Date of issue) Tj"),
    "issued on the programme's last day, not on the day it was downloaded",
  );
  // The company's mark is drawn from the artwork, exactly as the journey's is.
  assert.ok(/cm \/Im\d+ Do Q/.test(file), "the mark is the real artwork");

  assert.equal(
    certificateFilename(journey),
    "ftp2026-certificate-aya-elsawy.pdf",
  );
});

test("the company is on the page in type, not only as a mark", () => {
  const { file } = read();

  /* The mark is a raster and `satoMark()` is allowed to return null — the page
     still builds, exactly as the journey's does. A certificate that loses its
     artwork must not also lose whose certificate it is, so the issuer is named
     in type in three independent places: the citation, the signatory's line
     and the foot. */
  assert.ok(
    file.includes("(completed Sato Pharma's"),
    "the one sentence names the company that issued it",
  );
  assert.ok(
    file.includes("(HR Section Head · Sato Pharma) Tj"),
    "and so does the signature block",
  );
  assert.ok(
    file.includes("(SATO PHARMA · FUTURE TALENTS PROGRAM 2026) Tj"),
    "and the foot of the page",
  );
});

test("the certificate's cards are the calls by kind and the sessions attended", () => {
  /* Owner, 13 Sep 2026: AM visits, PM visits, Pharmacy Campaign and the share
     of the sessions attended. Hospital is the AM account and polyclinic the PM
     polyclinic, which is how the account form already names them. */
  const plain = read();
  assert.equal(plain.journey.totals.byType.pharmacy, 3);
  for (const label of ["AM VISITS", "PM VISITS", "PHARMACY CAMPAIGN", "SESSION ATTENDANCE"]) {
    assert.ok(plain.file.includes(`(${label}) Tj`), `the ${label.toLowerCase()} card is on the page`);
  }
  assert.ok(plain.file.includes("(3) Tj"), "the pharmacy calls");
  assert.ok(plain.file.includes("(0) Tj"), "no AM or PM calls prints a zero, not a gap");
  assert.ok(!plain.file.includes("(FINAL SCORE) Tj"), "the score is no longer a card");
  /* Nothing to measure attendance against is not 0%, which would say every
     session was missed. */
  assert.equal(plain.journey.totals.attendancePct, null);
  assert.ok(!/\(\d+%\) Tj/.test(plain.file), "no sessions to measure prints no percentage");

  const measured = read({
    visits: [
      visit("2026-08-18", "El Ezaby"),
      { ...visit("2026-08-31", "Dar El Fouad"), visit_type: "hospital" as const },
      { ...visit("2026-09-07", "Nasr City polyclinic"), visit_type: "polyclinic" as const },
    ],
    /* Minutes are clamped to the session's own length, and a session the
       intern was not expected at counts neither for nor against. */
    sessions: [
      { id: "a1", sessionId: "p1", session_date: "2026-08-17", title: "Core selling skills", minutes: 150, points: 1 },
      { id: "a2", sessionId: "p9", session_date: "2026-08-19", title: "Another line", minutes: 60, points: 0 },
    ],
    programmeSessions: [
      { id: "p1", duration: 100 },
      { id: "p2", duration: 100 },
    ],
  });
  assert.equal(measured.journey.totals.attendancePct, 50, "100 of 200 expected minutes");
  assert.ok(measured.file.includes("(50%) Tj"), "and the card prints it as a percentage");
  assert.ok(
    (measured.file.match(/\(1\) Tj/g) ?? []).length >= 3,
    "one AM call, one PM call and one pharmacy call, each on its own card",
  );
});

test("approved orders are a card only for somebody who has one", () => {
  /* Owner, 13 Sep 2026: show approved orders if there are any, and never a
     card reading 0. A rejected order is not a sale and counts for nothing. */
  const order = (id: string, status: string) => ({
    id,
    order_date: "2026-08-25",
    place_name: "El Ezaby",
    status,
  });
  const none = read({ orders: [order("o1", "rejected")] });
  assert.equal(none.journey.totals.approvedOrders, 0);
  assert.ok(!/\(APPROVED ORDERS?\) Tj/.test(none.file), "a rejected order alone prints no card");

  const one = read({ orders: [order("o1", "approved"), order("o2", "rejected")] });
  assert.equal(one.journey.totals.approvedOrders, 1, "only the approved one counts");
  assert.ok(one.file.includes("(APPROVED ORDER) Tj"), "one order is an order, not orders");
  /* The journey says what was rejected; a signed page never does. */
  assert.ok(!/rejected|submitted:/i.test(one.file), "no rejected orders on the certificate");

  const two = read({ orders: [order("o1", "approved"), order("o2", "approved")] });
  assert.ok(two.file.includes("(APPROVED ORDERS) Tj"));
  assert.ok(two.file.includes("(2) Tj"));
});

test("a rank reaches the certificate only for the top three of a line", () => {
  const second = read({
    standing: { place: 7, of: 65, linePlace: 2, lineSize: 18, scored: true },
  });
  /* The honour is set in a chip, so it is uppercase on the page. */
  assert.ok(
    second.file.includes("(FINISHED SECOND OF 18 ON THE OTC LINE) Tj"),
    "second on the line is an honour a certificate can carry",
  );

  /* And the programme rank beside it (owner, 13 Sep 2026: rank in line and rank
     in total), in the one chip: on the line's baseline, after it with air for
     the hairline between them, both inside the chip, and the chip centred. */
  const run = (text: string) => {
    const m = second.file.match(new RegExp(`1 0 0 1 (-?[\\d.]+) (-?[\\d.]+) Tm \\(${text}\\) Tj`));
    assert.ok(m, `"${text}" is on the page`);
    return { x: Number(m[1]), y: Number(m[2]), end: Number(m[1]) + measure(text, 7.6, "bold", 1.8) };
  };
  const onLine = run("FINISHED SECOND OF 18 ON THE OTC LINE");
  const overall = run("7TH OF 65 ACROSS THE PROGRAMME");
  assert.equal(overall.y, onLine.y, "both ranks sit on one baseline");
  assert.ok(overall.x - onLine.end >= 24, `the programme rank follows with ${(overall.x - onLine.end).toFixed(1)} of air`);
  const tokens = second.file.split(/\s+/);
  let fill = "";
  let chip: number[] | null = null;
  let chipBox = "";
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "rg") fill = tokens.slice(i - 3, i).join(" ");
    else if (tokens[i] === "re" && tokens[i + 1] === "f" && fill === "0.953 0.976 0.988") {
      chip = tokens.slice(i - 4, i).map(Number);
      chipBox = tokens.slice(i - 4, i).join(" ");
    }
  }
  assert.ok(chip, "the chip is on the page");
  const [chipX, , chipW] = chip!;
  assert.ok(
    onLine.x - chipX >= 12 && chipX + chipW - overall.end >= 12,
    `both ranks are inside the chip: ${(onLine.x - chipX).toFixed(1)} on the left, ${(chipX + chipW - overall.end).toFixed(1)} on the right`,
  );
  assert.ok(Math.abs(chipX + chipW / 2 - 421) < 0.5, `the chip is centred, on ${(chipX + chipW / 2).toFixed(1)}`);

  /* Holding both ranks the chip reaches the tail of the Arabic wordmark, and a
     flat tint across a watermark cuts it with a straight edge. So the wordmark
     is drawn again inside the chip: clipped to the chip exactly, in exactly the
     place the page's own copy sits, after the tint and before the ranks, and
     flattened against the chip's tint — against the paper it is a white box
     inside a blue one. */
  const escaped = chipBox.replace(/[.\-]/g, "\\$&");
  const redraw = new RegExp(`q ${escaped} re W n\\s+q ([\\d. -]+) cm /(Im\\d+) Do Q\\s+Q`).exec(second.file);
  assert.ok(redraw, "the wordmark runs on under the chip, drawn again inside a clip that is the chip");
  const pageCopy = [...second.file.matchAll(/q ([\d. -]+) cm \/(Im\d+) Do Q/g)].find(
    (m) => Number(m[1].split(" ")[0]) > 300,
  );
  assert.ok(pageCopy, "the page's own wordmark is drawn");
  assert.equal(redraw![1], pageCopy![1], "the copy under the chip sits exactly where the page's does");
  assert.notEqual(redraw![2], pageCopy![2], "and is a second raster, not the paper's copy");
  const at = second.file.indexOf(redraw![0]);
  assert.ok(at > second.file.indexOf(`${chipBox} re f`), "it is drawn over the chip's tint, not under it");
  assert.ok(at < second.file.indexOf("(FINISHED SECOND OF 18 ON THE OTC LINE) Tj"), "and under the ranks");
  const underChip = imageObjects(second.file).find((r) => r.name === redraw![2])!;
  const counts = new Map<string, number>();
  for (let p = 0; p < underChip.samples.length; p += 3) {
    const px = `${underChip.samples[p]},${underChip.samples[p + 1]},${underChip.samples[p + 2]}`;
    counts.set(px, (counts.get(px) ?? 0) + 1);
  }
  const ground = [...counts].reduce((a, b) => (a[1] > b[1] ? a : b))[0];
  assert.equal(ground, "243,249,252", "its ground is the chip's tint");
  let darkest = 255;
  for (const s of underChip.samples) if (s < darkest) darkest = s;
  assert.ok(darkest > 190 && darkest < 245, `and its ink is the watermark's, darkest sample ${darkest}`);

  /* Fourth is where it stops, and the cut is the point of the test: a signed
     page reading "18th of 22" is a document nobody would hand to anybody, and
     the journey is where a full standing belongs. */
  const fourth = read({
    standing: { place: 30, of: 65, linePlace: 4, lineSize: 18, scored: true },
  });
  assert.doesNotMatch(fourth.file, /FINISHED (FIRST|SECOND|THIRD|FOURTH)/);
  assert.doesNotMatch(fourth.file, /OF 18 ON THE OTC LINE/);
  assert.doesNotMatch(fourth.file, /ACROSS THE PROGRAMME/, "nor the programme rank without it");

  // And nothing is quoted while nobody has scored, as everywhere else.
  const unscored = read({
    standing: { place: 1, of: 65, linePlace: 1, lineSize: 18, scored: false },
  });
  assert.doesNotMatch(unscored.file, /FINISHED FIRST/);
});

test("a long name steps down rather than running off the page", () => {
  /* The name is the content of this page and is set larger than anything else
     in either document — wider, at that size, than the column will hold for a
     four-part Egyptian name. Truncating somebody's name
     on their own certificate is not an option, so the size steps down until it
     fits — and the test is the size actually written into the content stream,
     because a name that overflows does not throw, it just prints past the
     keyline. */
  /* Which face is in play is decided by whether a font file exists on disk, so
     the test cannot assume either — it asks the renderer the same question the
     renderer asks. `/F4` because F1 to F3 are the three Helveticas and this
     document embeds exactly one face; `/F2` is Helvetica Bold, the fallback. */
  const script = nameFont();
  const resource = script ? "F4" : "F2";
  const display = script ? SCRIPT_SIZE : NAME_SIZE;
  const floor = script ? SCRIPT_MIN : NAME_MIN;

  const short = read();
  /* Read against the exported constant, not a literal: a test hardcoding 48
     would pass for the wrong reason the day the display size moves again. */
  assert.ok(
    short.file.includes(`/${resource} ${display} Tf`),
    "a normal name keeps the display size",
  );

  const longName = "Abdelrahman Mohamed Hassanein Aboulmagd Elsharkawy";
  const long = read({
    profile: {
      fullName: longName,
      submissionId: "FTP-20260099",
      verificationId: "c81e0d47-2a5b-4f9c-b3e6-51a8d7c2f094",
      line: "OTC",
      area: "Cairo",
      mentor: null,
    },
  });

  assert.ok(
    long.file.includes(`(${longName}) Tj`),
    "the whole name is on the page, not an abbreviation of it",
  );
  /* The resource is captured rather than matched, so a name that came out in
     the wrong typeface fails here by name instead of failing as a size that
     could not be found. */
  const set = long.file
    .slice(0, long.file.indexOf(`(${longName}) Tj`))
    .match(/\/(F\d+) ([\d.]+) Tf(?![\s\S]*\/F\d+ [\d.]+ Tf)/);
  assert.equal(set?.[1], resource, "the name is set in the face it was sized in");
  const size = Number(set?.[2]);
  assert.ok(size >= floor && size < display, `it stepped down, to ${size}pt`);
  /* And it stepped down to a size it CHOSE rather than to the floor, which is
     the assertion that caught the floor being a cap: the loop stops at the floor
     whether the name fits or not, so a floor above the size a long name needs
     prints past the column and nothing here would have said so. A name longer
     than anyone on the roster has must still land with room under the floor. */
  assert.ok(size > floor, `the floor has room under it; it settled at ${size}pt`);
  /* And it fits: A4 landscape less two 54pt margins, less the name's own air.
     The tracking comes out of the stream beside the size, for the reason the
     size does — the display face sets negative and the script face sets none,
     and a fixed -0.6 here would quietly measure a different string from the one
     on the page the day that changes. */
  const tracking = Number(
    long.file
      .slice(0, long.file.indexOf(`(${longName}) Tj`))
      .match(/([-\d.]+) Tc(?![\s\S]*[-\d.]+ Tc)/)?.[1] ?? 0,
  );
  assert.ok(
    measure(longName, size, script ?? "bold", tracking) <= 842 - 108 - NAME_AIR,
    "the stepped-down name is inside the column",
  );
});

test("the citation is broken the way somebody would break it by hand", () => {
  /* Cairo East rather than Cairo, because it is the area that tempts an even
     wrap into "in Cairo / East". At Cairo alone every wrap happens to land on
     the clauses, and this test passed with the clause packing taken out. */
  const { file } = read({
    profile: {
      fullName: "Aya Elsawy",
      submissionId: "FTP-20260012",
      verificationId: "3f6c2a9e-8b1d-4e57-a0c4-9d2e7b6f1a38",
      line: "OTC",
      area: "Cairo East",
      mentor: null,
    },
  });

  /* Each printed line is its runs on one baseline, read back in order — which
     is reading what was printed rather than what the builder meant. */
  const printed = citationLines(file);
  const lines = printed.map((runs) => runs.map((run) => run.text).join(" "));
  assert.equal(lines.length, 3, "the 2026 citation sets on three lines, one clause each");

  /* The first defect this pinned was 474pt over 262pt, with "in" stranded at
     the end of the first line away from the Cairo it belongs to. Since the
     sentence carries the training and the role it has three clauses, and the
     second defect was the balancer splitting them for an even block: "in Cairo
     / East", "medical sales / promotion". Every line but the last ends on its
     comma, none ends on a function word, and none is wider than the measure. */
  for (const line of lines.slice(0, -1)) {
    assert.ok(line.endsWith(","), `a line ends on a clause, not inside one: "${line}"`);
    const words = line.split(" ");
    assert.ok(
      !["a", "an", "the", "in", "on", "of", "to", "from", "and"].includes(
        words[words.length - 1].toLowerCase(),
      ),
      `no line ends on a function word; one ends on "${words[words.length - 1]}"`,
    );
  }
  printed.forEach((runs, index) => {
    const first = runs[0];
    const last = runs[runs.length - 1];
    const end = last.x + measure(last.text, 13, last.bold ? "bold" : "regular");
    assert.ok(end - first.x <= 842 - 108 - 160, `"${lines[index]}" is inside the measure`);
    /* Centred as printed, bold runs and all: a line drawn a run at a time is
       only centred if every run lands where the measure said it would. */
    const left = first.x - 54;
    const right = 842 - 54 - end;
    assert.ok(
      Math.abs(left - right) < 0.5,
      `"${lines[index]}" is centred, with ${left.toFixed(1)} of column on the left and ${right.toFixed(1)} on the right`,
    );
  });
  assert.ok(
    lines.join(" ").includes("in Cairo East,"),
    "and the phrase it broke is whole again",
  );

  /* An area of more than one word is a name and breaks nowhere, and it prints
     the way the card prints it: the roster's "October -Zayed" came out as
     "October - / Zayed," across two lines of a signed page. */
  const zayed = citationLines(
    read({
      profile: {
        fullName: "Aya Elsawy",
        submissionId: "FTP-20260012",
        verificationId: "3f6c2a9e-8b1d-4e57-a0c4-9d2e7b6f1a38",
        line: "Pediatrics",
        area: "October -Zayed",
        mentor: null,
      },
    }).file,
  ).map((runs) => runs.map((run) => run.text).join(" "));
  assert.ok(
    zayed.some((line) => line.includes("October · Zayed,")),
    `the area is whole, on one line and tidied: ${JSON.stringify(zayed)}`,
  );
  /* It is also the citation long enough to push a bold phrase across a break,
     and a bold phrase in two halves reads as two emphases. */
  for (const phrase of ["Future Talents 2026", "medical sales promotion,", "Medical Representative."]) {
    assert.ok(
      zayed.some((line) => line.includes(phrase)),
      `"${phrase}" is whole on one line: ${JSON.stringify(zayed)}`,
    );
  }
});

test("the foot's two rules are one hierarchy, not one of them missing", () => {
  const { file } = read();

  /* Every filled rectangle on the page with the colour it was filled in. The
     writer emits "r g b rg" and then "x y w h re f", so the fill in force is
     whatever the last rg set — which is how the page is actually painted, and
     therefore the only honest way to read a colour back. */
  const rects: { x: number; y: number; w: number; h: number; fill: number[] }[] =
    [];
  const tokens = file.split(/\s+/);
  let fill = [0, 0, 0];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "rg") fill = tokens.slice(i - 3, i).map(Number);
    else if (tokens[i] === "re") {
      const [x, y, w, h] = tokens.slice(i - 4, i).map(Number);
      rects.push({ x, y, w, h, fill });
    }
  }

  /* The foot rules are the only hairlines on their baseline. y is from the
     bottom in the stream and the foot sits at 492 from the top of a 595pt
     sheet, so they are the 1pt rects at 102. */
  const foot = rects
    .filter((r) => r.h === 1 && Math.abs(r.y - 102) < 0.5)
    .sort((a, b) => a.x - b.x);
  assert.equal(foot.length, 2, "the signature rule and the provenance rule");
  const [sig, prov] = foot;

  /* The frame's own keyline, read off the page rather than written down here:
     the full-width hairline the double frame is drawn with. */
  const keyline = rects.find((r) => r.h === 1 && r.w > 700 && r.y > 400);
  assert.ok(keyline, "the outer keyline is on the page to compare against");

  /* Three renders settled this and the two it rejected are what these assert.
     Drawn in the keyline's own grey the provenance rule does not read as the
     quieter of two rules — beside full ink, at the same height, under a mirror
     of the same label, it reads as a rule that failed to print. Drawn in ink it
     makes a record id look like a second signature. It is FAINT: the colour its
     own label and rows are set in, plainly a step down from the signature and
     plainly a line somebody drew. */
  assert.ok(
    sig.fill[0] < 0.2,
    `the signature rule is ink, at ${sig.fill.join(" ")}`,
  );
  assert.ok(
    prov.fill[0] - sig.fill[0] > 0.15,
    `the provenance rule steps down from the signature's, not level with it at ${prov.fill.join(" ")}`,
  );
  assert.ok(
    keyline!.fill[0] - prov.fill[0] > 0.15,
    `and it is darker than the frame's keyline, not lost in it at ${prov.fill.join(" ")}`,
  );
});

test("the citation itself says what the training was and what it makes somebody eligible for", () => {
  /* Owner, 13 Sep 2026: the training focused on medical sales promotion and
     completing it makes the holder eligible to be a medical representative —
     in fresh words, not the 2025 certificate's, and in the body of the text
     rather than in the foot. It goes on every certificate, not only the top
     three's. */
  const citation = (file: string) =>
    citationLines(file)
      .flat()
      .map((run) => run.text)
      .join(" ");

  /* Second on the line, so the chip is on the page: that is the certificate
     the third line has to find room on. */
  const { file } = read({
    standing: { place: 7, of: 65, linePlace: 2, lineSize: 18, scored: true },
  });
  assert.ok(file.includes("(FINISHED SECOND OF 18 ON THE OTC LINE) Tj"), "the chip is on the page");
  const text = citation(file);
  assert.ok(
    text.endsWith(
      "with a training focus on medical sales promotion, and is thereby eligible for the role of Medical Representative.",
    ),
    `the sentence closes on the training and the role: "${text}"`,
  );
  assert.ok(text.startsWith("completed Sato Pharma's"), "in the same sentence as the completion");
  assert.ok(!/sales representative/i.test(file), "not last year's wording");
  assert.ok(!file.includes("ELIGIBLE FOR THE ROLE OF"), "and not a second statement in the foot");

  /* Where the eye lands (owner, 13 Sep 2026: highlight what is important and
     colour what the reader's eye should fall on). Three phrases bold and one of
     them coloured: the programme and the training focus in ink, the role in the
     brand blue, and every other word in the body grey. Stated as relationships
     rather than as hex, so retuning the palette does not retune the test. */
  const runs = citationLines(file).flat();
  const bold = runs.filter((run) => run.bold);
  assert.deepEqual(
    bold.map((run) => run.text),
    ["Future Talents 2026", "medical sales promotion,", "Medical Representative."],
    "three phrases are set bold and nothing else is",
  );
  const [programme, focus, role] = bold;
  assert.ok(role.rgb[2] - role.rgb[0] > 0.4, `the role is in the brand blue, at ${role.rgb.join(" ")}`);
  for (const run of [programme, focus]) {
    assert.ok(Math.max(...run.rgb) < 0.15, `"${run.text}" is ink, at ${run.rgb.join(" ")}`);
  }
  assert.equal(
    runs.filter((run) => run.rgb[2] - run.rgb[0] > 0.15).length,
    1,
    "the role is the only coloured thing in the sentence",
  );
  for (const run of runs.filter((r) => !r.bold)) {
    assert.ok(
      run.rgb[0] > 0.2 && run.rgb[0] < 0.4,
      `"${run.text}" stays in the body grey, at ${run.rgb.join(" ")}`,
    );
  }

  /* The third line costs a line of room, and on a top-three certificate the
     chip already takes the rest: the figures strip must still clear the foot.
     The strip is the one wide tinted rect under the chip; SIGNED is the foot's
     label. Both read back as y from the bottom of the sheet. */
  const rects = [...file.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re f/g)]
    .map((m) => m.slice(1).map(Number))
    .filter(([, , w, h]) => w > 600 && h > 30 && h < 60);
  assert.equal(rects.length, 1, "the figures strip is on the page");
  const stripBottom = rects[0][1];
  const signed = Number(file.match(/1 0 0 1 [\d.]+ ([\d.]+) Tm \(SIGNED\) Tj/)![1]);
  const air = stripBottom - (signed + 6.6 * 0.718);
  assert.ok(air >= 12, `the strip keeps ${air.toFixed(1)} of air over the foot's label`);

  /* And for somebody outside the top three, who carries no chip. */
  const plain = citation(read({ standing: null }).file);
  assert.ok(plain.includes("eligible for the role of Medical Representative."), "every certificate says it");
});

test("the seal's type sits where type sits, not where the middle is", () => {
  const { file } = read();

  /* The seal's inset keyline is 6pt off all four edges of the tile, so the box
     the type stands in is exactly square and the eye holds it to that. Its two
     horizontal hairlines are the only rects on the page in the half-mix of the
     on-dark grey against ink, which is what finds them without a coordinate. */
  const tokens = file.split(/\s+/);
  let fill = "";
  const bars: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "rg") fill = tokens.slice(i - 3, i).join(" ");
    else if (tokens[i] === "re" && fill.startsWith("0.31 ")) {
      const [, y, w, h] = tokens.slice(i - 4, i).map(Number);
      if (w > h) bars.push(y);
    }
  }
  assert.equal(bars.length, 2, "the inset keyline's top and foot");
  const [insetFoot, insetHead] = bars.sort((a, b) => a - b);

  /* y runs from the bottom in the stream, so the box's inner edges are the head
     hairline's own y and the foot hairline's y plus its weight. */
  const baseline = (text: string) => {
    const m = file.match(
      /* No second Tm may fall between the matrix and the string, or a short run
         reaches past its own block into the next one — which it did, and read
         the year's position off the label above it. */
      new RegExp(
        `1 0 0 1 [-\\d.]+ ([-\\d.]+) Tm(?:(?!Tm)[\\s\\S])*?\\(${text}\\) Tj`,
      ),
    );
    assert.ok(m, `the seal's ${text} is on the page`);
    return Number(m![1]);
  };
  /* Neither line has a descender, so the block the eye sees is the cap top of
     the label down to the year's baseline. Helvetica's capital is 717/1000. */
  const head = baseline("FTP") + 7 * 0.717;
  const foot = baseline("2026");
  const above = insetHead - head;
  const below = foot - (insetFoot + 1);

  /* At 26 and 47 below the tile this ran about 14pt above the block and 10pt
     below it: a symmetrical box with the type visibly low in it and the year
     crowding the keyline it sits over. A block of caps and figures wants to sit
     a shade ABOVE the middle, never under it — so the air below is the larger
     of the two, and only just. Both halves fire: level or low trips the first,
     lifted too far trips the second. */
  assert.ok(
    below >= above,
    `the seal's block leans up, not down — ${above.toFixed(1)}pt above it and ${below.toFixed(1)}pt below`,
  );
  assert.ok(
    below - above < 6,
    `and it leans by a shade rather than floating — ${above.toFixed(1)} against ${below.toFixed(1)}`,
  );
});

/* The name is painted twice before its gloss: once in paper, fat, as the
   knock-out that stands it in front of the Arabic, and then for real. Every
   assertion about the NAME means the second one, so it is found as the first
   run of the name not filled in paper — found by what it is, not by being
   first, which is what the knock-out quietly stopped it being. */
function plainName(file: string, name = "Aya Elsawy"): number {
  const needle = `(${name}) Tj`;
  for (let at = file.indexOf(needle); at >= 0; at = file.indexOf(needle, at + 1)) {
    const fill = [...file.slice(0, at).matchAll(/([\d.]+) ([\d.]+) ([\d.]+) rg/g)].pop();
    if (fill && fill.slice(1, 4).join(" ") !== "1 1 1") return at;
  }
  return -1;
}

test("the name stands in front of the Arabic, on a knock-out of paper", () => {
  const { file } = read();

  /* Owner, 13 Sep 2026: "make the name layered at the front". Paint order
     already put it there; what the page lacked was the look of it, because the
     wordmark's sweeps ran right up to every letter. So the same name is drawn
     first in paper with a fat stroke, cutting a margin round each letter. */
  const at = plainName(file);
  assert.ok(at > 0, "the name itself is on the page");
  const first = file.indexOf("(Aya Elsawy) Tj");
  assert.ok(first < at, "a knock-out of the name is painted before the name");

  const halo = file.slice(file.lastIndexOf("BT", first), file.indexOf("ET", first));
  assert.ok(/(^|\s)1 1 1 rg/.test(halo), `the knock-out is filled in paper: ${halo.slice(0, 80)}`);
  const stroke = halo.match(/([\d.]+) ([\d.]+) ([\d.]+) RG ([\d.]+) w/);
  assert.ok(stroke, "and stroked, which is what makes it wider than the letters");
  assert.deepEqual(stroke.slice(1, 4), ["1", "1", "1"], "stroked in paper too");
  const w = Number(stroke[4]);
  /* A margin and not a blob: under 3 it is a hairline nobody sees at reading
     distance, past 12 it fills the counters of the script and reads as a
     sticker the name was printed on. */
  assert.ok(w >= 3 && w <= 12, `the knock-out is a margin round the letters, at ${w}pt`);
  assert.ok(halo.includes("2 Tr") && halo.lastIndexOf("0 Tr") > halo.indexOf("2 Tr"),
    "fill-then-stroke is switched on for it and off again");

  /* Same place, same size, or it is a white smear beside the name. */
  const tm = (s: string) => [...s.matchAll(/([\d.]+) ([\d.]+) Tm/g)].pop()?.slice(1, 3).join(" ");
  const tf = (s: string) => [...s.matchAll(/\/F\d+ ([\d.]+) Tf/g)].pop()?.[1];
  const real = file.slice(file.lastIndexOf("BT", at), at);
  assert.equal(tm(halo), tm(real), "the knock-out sits exactly under the name");
  assert.equal(tf(halo), tf(real), "and is set at the name's own size");

  /* Behind the name and in front of the ground: after the watermark, which is
     the first raster on the page, and with nothing painted between it and the
     name. */
  assert.ok(file.indexOf(" Do") < first, "the knock-out is painted over the Arabic, not under it");
  const between = file.slice(file.indexOf("ET", first), file.lastIndexOf("BT", at));
  assert.ok(!/ (re|Do|Tj)\b/.test(between), `nothing lands between the knock-out and the name: ${between}`);
});

test("the name is set in the band's own ink, and carries it", () => {
  const { file } = read();

  /* The name is navy and it READS navy, which are two claims and only the
     second one was ever in doubt. It was set in INK — the head band's own value
     to the byte — and the owner asked three times for it to be "the dark navy
     of the upper strip", sending a swatch that measures 158x76 pixels, every
     one of them rgb(17,24,32): INK exactly. Matching the number was never the
     problem. A 104pt block of #111820 reads navy; the same value in a
     calligraphic hairline the renderer antialiases toward the paper reads
     black. So the assertion is not "it equals the band" — that assertion passed
     throughout and told nobody anything — it is that the name is set in a blue
     somebody would call blue, and it is stated as a relationship between the
     channels so it survives the exact navy being retuned. */
  const band = file.match(/([\d.]+) ([\d.]+) ([\d.]+) rg\s+0 491 842 104 re/);
  assert.ok(band, "the head band is painted on the page");
  const at = plainName(file);
  assert.ok(at > 0, "the name is on the page");
  const fill = [...file.slice(0, at).matchAll(/([\d.]+) ([\d.]+) ([\d.]+) rg/g)].pop();
  assert.ok(fill, "the name is set in a colour somebody chose");
  const [r, g, b] = fill.slice(1, 4).map(Number);
  assert.ok(
    b - r > 0.15,
    `the name is a navy and not a near-black: ${fill.slice(1, 4).join(" ")}`,
  );
  assert.ok(
    b > g && g > r,
    `and it is blue rather than merely light, at ${fill.slice(1, 4).join(" ")}`,
  );
  /* And still the darkest thing on the page after the band, which is the rule
     this certificate is built on: the person is its largest and strongest
     object. A navy chosen for legibility that goes past the citation's own grey
     has stopped being ink. */
  assert.ok(
    (r + g + b) / 3 < 0.35,
    `and it is still ink, not a tint: mean ${((r + g + b) / 3).toFixed(3)}`,
  );

  /* The rule under the name follows the name and not the frame, because it is
     measured to the name: a rule the width of the word is an underline. Left in
     INK it is a black stub under a navy name. It is the 1.2pt hairline, and the
     higher of the two on the page in PDF space, where y runs from the bottom. */
  const rules = [...file.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) rg\s+[\d.]+ ([\d.]+) [\d.]+ 1\.2 re/g)];
  const underline = rules.sort((p, q) => Number(q[4]) - Number(p[4]))[0];
  assert.ok(underline, "the rule under the name is on the page");
  assert.deepEqual(
    underline.slice(1, 4),
    fill.slice(1, 4),
    "the rule under the name is the name's own colour, not the frame's ink",
  );

  /* And it CARRIES that value, which is a different claim and the one the page
     actually failed. A 104pt block of #111820 and a calligraphic hairline of
     #111820 do not weigh the same — the renderer antialiases the hairline
     toward the paper, so one ink comes out looking like two colours. The name
     is therefore filled AND stroked, in one ink. Read as: mode 2 is set before
     the name, the stroke colour was set from the same three numbers rather than
     inherited from whatever stroked last, and the mode is put back before the
     block ends. */
  const block = file.slice(file.lastIndexOf("BT", at), file.indexOf("ET", at));
  const stroke = block.match(/([\d.]+) ([\d.]+) ([\d.]+) RG ([\d.]+) w/);
  assert.ok(stroke, "the name is stroked as well as filled");
  assert.deepEqual(
    stroke.slice(1, 4),
    fill.slice(1, 4),
    "and stroked in the same ink it is filled in, not in whatever stroked last",
  );
  assert.ok(
    Number(stroke[4]) > 0 && Number(stroke[4]) <= 0.45,
    `a hair of stroke and not a faux bold, at ${stroke[4]}pt`,
  );
  assert.ok(block.includes("2 Tr"), "fill-then-stroke is actually switched on");
  assert.ok(
    block.lastIndexOf("0 Tr") > block.indexOf("2 Tr"),
    "and switched off again, so nothing after the name is stroked",
  );
  /* Stated as a property and not as a count: the sheen below is the same name
     drawn once per band, so counting "2 Tr" counts the bands and would have to
     be retuned every time the sheen is. What must stay true is that the only
     string on this page set fill-then-stroke is the name. */
  for (const m of [...file.matchAll(/2 Tr/g)]) {
    const around = file.slice(file.lastIndexOf("BT", m.index), file.indexOf("ET", m.index));
    assert.ok(
      around.includes("(Aya Elsawy) Tj"),
      `only the name is inked fill-then-stroke, and this is not it: ${around.slice(-60)}`,
    );
  }
});

test("the name is polished, and the polish never makes it paler", () => {
  const { file } = read();

  /* The gloss is the name drawn again once per horizontal strip, each strip in
     its own value, through a RECTANGLE clip — there is no gradient in this
     writer and no transparency, and neither was added for a line of type.

     The first thing asserted is the safety of the construction rather than its
     looks: every q is closed. A clip left open runs to the end of the page and
     puts every later mark inside the last strip of somebody's name, in a file
     that opens, validates and passes every other assertion here. */
  const at = plainName(file);
  const stream = [...file.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)]
    .map((m) => m[1])
    .find((s) => s.includes("(Aya Elsawy) Tj"));
  assert.ok(stream, "the page's own content stream is readable");
  const ops = stream.split(/\s+/);
  const opens = ops.filter((t) => t === "q").length;
  const closes = ops.filter((t) => t === "Q").length;
  assert.equal(
    opens,
    closes,
    `every clip the page opens is closed again: ${opens} q against ${closes} Q`,
  );

  /* The bands, read off the page: each is a clip rectangle followed by the name
     in that band's colour. Found by the clip, so a band drawn WITHOUT one — the
     defect that paints a stripe across the whole column — is not counted as a
     band, it is missing from this list and the count below fails. */
  const bands = [
    ...file.matchAll(
      /q [\d.]+ ([\d.]+) [\d.]+ [\d.]+ re W n\s*\nBT ([\d.]+) ([\d.]+) ([\d.]+) rg[^\n]*\(Aya Elsawy\) Tj/g,
    ),
  ].map((m) => ({ y: Number(m[1]), v: [Number(m[2]), Number(m[3]), Number(m[4])] }));
  assert.ok(bands.length > 12, `the name is glossed in bands, and there are ${bands.length}`);

  /* The plain filled name comes FIRST and the sheen is laid over it. That is
     what keeps every other assertion on this page — and a reader's own copy of
     the text — reading one ordinary line rather than 26 clipped fragments. */
  assert.ok(
    at < file.indexOf("re W n"),
    "the plain name is drawn before the first band, not replaced by them",
  );

  const mean = (c) => (c[0] + c[1] + c[2]) / 3;
  const navy = bands.map((b) => mean(b.v));
  const base = [...file.slice(0, at).matchAll(/([\d.]+) ([\d.]+) ([\d.]+) rg/g)]
    .pop()
    .slice(1, 4)
    .map(Number);

  /* The lesson of the eleven renders, and the only one worth a test. A gloss is
     light, and light on type reads as PALER type — which is the opposite of
     what this page spent four rounds being asked for — unless the light is a
     SLIVER and the rest of the letter is deepened under it. It is a share of
     the letter and not a mean: the version on the page lights 3 bands of 26 and
     deepens 20, while the two that were rendered and read as a faded name lit
     14 of 44, and the broad ramp lit 24 of 32 and deepened none of them. A
     fifth is the line between them, and it is nowhere near either. */
  const lighter = navy.filter((v) => v > mean(base) + 0.01).length;
  const deeper = navy.filter((v) => v < mean(base) - 0.005).length;
  assert.ok(
    lighter <= bands.length / 5,
    `the light is a sliver of the letter: ${lighter} of ${bands.length} bands are lighter than the name`,
  );
  assert.ok(
    deeper > bands.length / 2,
    `and the rest of it is deepened rather than left alone: ${deeper} of ${bands.length}`,
  );

  /* And there IS a highlight — a band materially lighter than the name — or
     this is a deepening with no gloss in it at all. */
  assert.ok(
    Math.max(...navy) - mean(base) > 0.12,
    `there is a highlight and not merely a shadow: brightest ${Math.max(...navy).toFixed(3)}`,
  );
  assert.ok(
    Math.min(...navy) < mean(base),
    `and the letter is deepened away from it: darkest ${Math.min(...navy).toFixed(3)}`,
  );

  /* Where the light sits. It is placed in EMS above the baseline so it holds
     its place as the name steps down, and it belongs on the letters: above the
     x-height, below the cap line. Read in PDF space, where y runs from the foot
     of the page and the name's baseline is its Tm. */
  const head = file.slice(0, at);
  const baseline = Number([...head.matchAll(/1 0 0 1 [\d.]+ ([\d.]+) Tm/g)].pop()[1]);
  const size = Number([...head.matchAll(/\/F4 ([\d.]+) Tf/g)].pop()[1]);
  const brightest = bands.reduce((a, b) => (mean(b.v) > mean(a.v) ? b : a));
  const above = brightest.y - baseline;
  assert.ok(
    above > size * 0.4 && above < size * 0.72,
    `the light sits between the x-height and the cap line, at ${(above / size).toFixed(2)} em`,
  );
});

test("the Arabic wordmark is a watermark: behind the text, and pale", () => {
  const { file } = read();

  /* Two rasters and no more: the wordmark behind the page and the company's
     mark on the band. The verification code carries no mark (owner, 13 Sep
     2026; tests/verification.test.mts). Each is one XObject however many
     times it is drawn. */
  const rasters = imageObjects(file);
  assert.equal(rasters.length, 2, "the watermark and the band's mark, once each");

  const draws = [
    ...file.matchAll(
      /q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm \/(Im\d+) Do Q/g,
    ),
  ];
  assert.equal(draws.length, 2, "each is drawn once");

  /* The watermark is found by WHAT IT IS — the wide raster, against the mark's
     355 x 134 — and never by being the first one drawn, because that is the
     property under test three lines below. `draws[0]` passes vacuously the
     moment the call moves: the mark is also painted before the name and is
     also centred, so the assertion that fires is the paleness one, naming the
     wrong defect entirely. That mistake was made here, and was found by moving
     the call and reading which assertion failed. A test that locates its
     subject by the thing it is checking is checking nothing. */
  const widest = rasters.reduce((a, b) => (a.width > b.width ? a : b));
  const watermark = draws.find((drawn) => drawn[5] === widest.name);
  assert.ok(watermark, `the wide raster ${widest.name} is drawn on the page`);

  /* BEHIND is the whole of its correctness, and a content stream has no
     z-order beyond the order things are painted in. Drawn after the name this
     is a grey block over somebody's name — and the file still opens, still
     validates, and still passes every other assertion in this file. */
  assert.ok(
    file.indexOf(watermark[0]) < file.indexOf("(Aya Elsawy) Tj"),
    "the watermark is painted before the name, not over it",
  );
  assert.ok(
    file.indexOf(watermark[0]) <
      file.indexOf("(CERTIFICATE OF COMPLETION) Tj"),
    "and before the title",
  );

  /* It is laid TO the right edge and never past it, it lives on the right half
     of the sheet, and it is drawn in the artwork's own proportions. The middle
     one was got wrong first time — a centred horizontal strip across the whole
     sheet, which is a background image rather than a mark struck into the paper
     — and the first was got wrong the other way. The last used to read `h > w`,
     which was true of a stand-in typeset as two stacked lines and is false of
     the company's real wordmark, a single calligraphic line; what it was
     actually defending is that the ornament is not stretched to fill a box
     somebody chose, so it is now asserted against the raster's own pixels. */
  const [, w, h, x, up] = watermark.map(Number);
  /* `cm` puts y in PDF space, measured from the BOTTOM of the sheet, while
     every coordinate in certificate-pdf.ts is measured from the top — the
     class flips it once, at the last moment. Flipping it back here is what
     makes the number below comparable to the strip's own floor; read raw, it
     is 484 and looks like a failure. */
  const top = 595 - up - h;
  /* Arabic is written right to left, so the right edge of this block is where
     both words BEGIN, and a bleed there is not a crop — it is the first letter
     of each word off the sheet. At the 34pt this ran off at first, `ساتو فارما`
     printed as `ـاتو` over `ـارما`, which is a watermark of something that is
     not the company's name, in a file that opens and passes everything else.
     So the assertion is about the INK and not about the file: the file's own
     frame may hang over the edge and its letters may not. That is a difference
     of nought on the artwork in the tree, which is cropped to its ink, and was
     2.8pt on the stand-in before it — which is the point, since the next
     artwork may well arrive padded again. Both directions fire — bled, the
     first; pulled inside the margin, the second. */
  const ink = satoMarkInk("arabic");
  assert.ok(ink, "the artwork's ink box can be measured off the file");
  const inkRight = x + w * ink!.right;
  assert.ok(
    inkRight <= 842.5,
    `no letter of it is off the sheet — the ink ends at ${inkRight.toFixed(1)} of 842`,
  );
  assert.ok(
    inkRight >= 840.5,
    `and it is laid to the trim rather than stopping inside the margin, at ${inkRight.toFixed(1)}`,
  );
  assert.ok(x > 842 / 2, `and it lives on the right half, starting at ${x}`);
  const drawn = w / h;
  const artwork = widest.width / widest.height;
  assert.ok(
    Math.abs(drawn - artwork) < 0.005,
    `it is drawn in the artwork's own proportions, ${drawn.toFixed(3)} against ${artwork.toFixed(3)}`,
  );

  /* Its foot clears the figures strip, whose own tint is painted after it. A
     tinted rectangle across the bottom of the ornament cuts it with a straight
     horizontal edge — the one thing that gives away a raster on paper. */
  assert.ok(
    top + h <= 400,
    `it stops above the figures strip, at ${top + h}`,
  );
  assert.ok(top < 130, `and hangs from under the navy band, at ${top}`);

  /* And it is PALE. This is the one property of a watermark that matters and
     the one that cannot be read off the call: the strength is applied inside
     sato-mark.ts over a raster whose own pixels are solid black, so nothing in
     certificate-pdf.ts can be inspected to find out what came of it. The
     samples are inflated and looked at instead, which is the same check the
     reverse mark's ground gets for the same reason. */
  let darkest = 255;
  let lightest = 0;
  for (const sample of widest.samples) {
    if (sample < darkest) darkest = sample;
    if (sample > lightest) lightest = sample;
  }
  assert.equal(lightest, 255, "the paper around the letters is still paper");
  assert.ok(
    darkest > 200,
    `the ink is a watermark, not type: darkest sample ${darkest}`,
  );
  assert.ok(
    darkest < 250,
    `and it is actually there: darkest sample ${darkest}`,
  );
});

/**
 * Every image XObject in the file, by resource name, with its samples.
 *
 * The name matters because a caller has to be able to say WHICH raster it
 * means without relying on the order they were drawn in. It comes out of the
 * page's own `/XObject` dictionary, which is the only thing that ties `/Im2`
 * in a content stream to an object number.
 *
 * The stream is taken by `/Length` from the byte after `stream`, never by
 * searching for `endstream`: the payload is deflate output and those nine
 * bytes occur inside it often enough to matter.
 */
function imageObjects(
  file: string,
): { name: string; width: number; height: number; samples: Buffer }[] {
  const dict = /\/XObject << ([^>]*) >>/.exec(file);
  assert.ok(dict, "the page declares its rasters");
  const out = [];
  for (const [, name, id] of dict[1].matchAll(/\/(Im\d+) (\d+) 0 R/g)) {
    /* Found by offset and then read with a plain literal regex, rather than by
       building one out of `id` with `new RegExp`. A string-built pattern needs
       every backslash doubled, and a `\d` that loses its backslash becomes the
       letter d — a pattern that matches nothing, silently, in a helper whose
       whole job is to find things. */
    const at = file.indexOf(`\n${id} 0 obj\n`);
    assert.notEqual(at, -1, `object ${id} exists`);
    const head =
      /^<< \/Type \/XObject \/Subtype \/Image \/Width (\d+) \/Height (\d+)[^>]*?\/Length (\d+) >>\nstream\n/.exec(
        file.slice(at + `\n${id} 0 obj\n`.length),
      );
    assert.ok(head, `object ${id} is the image ${name} points at`);
    const start = at + `\n${id} 0 obj\n`.length + head[0].length;
    const width = Number(head[1]);
    const height = Number(head[2]);
    const samples = inflateSync(
      Buffer.from(file.slice(start, start + Number(head[3])), "latin1"),
    );
    assert.equal(
      samples.length,
      width * height * 3,
      `${name} inflates to exactly its declared pixels`,
    );
    out.push({ name, width, height, samples });
  }
  return out;
}
