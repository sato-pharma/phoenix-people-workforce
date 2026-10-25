import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { PerformanceCardData } from "../src/lib/employee-portal/performance-card.ts";
import { PERFORMANCE_CARD_LAYOUT_SCRIPT, performanceCardHtml } from "../src/lib/employee-portal/performance-card-render.ts";
import { foldRepEstablishment } from "../src/lib/employee-portal/rep-establishment.ts";
import { repRankStanding } from "../src/lib/employee-portal/rep-rank.ts";
import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";
import { performanceShareCaption, shareComposerUrl } from "../src/lib/share/social-share.ts";
import { issueShareCardToken, readShareCardToken } from "../src/lib/share/share-card-token.ts";
import { signatureNameFor } from "../src/lib/employee-portal/signature-name.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE MEDICAL REP'S EXPORTABLE, SHAREABLE PERFORMANCE CARD.
 *
 * Owner, 2026-10-03: *"make the rep able to export a snapshot as pic or PDF, very premium polished,
 * and make him able to share on LinkedIn or Facebook or WhatsApp — the snapshot showing his identity
 * banner, his rank, a chart of his achievements, looks like a mini dashboard"*, and then:
 * *"do not show the current medical reps, only show total structure of medical reps count vacants."*
 *
 * Five things here cost real work to get right, and each is pinned below.
 *
 *  1. THE DENOMINATOR IS THE STRUCTURE, NOT THE HEAD COUNT. 111 rep seats (35 vacant) against the
 *     70 who could be scored in Jul–Aug. The scored count MOVES every month, so the same performance
 *     would read as a better rank in a thin month.
 *  2. THE CARD IS HIS IDENTITY BANNER, HIS PROOF AND HIS FOOTER (owner, 2026-10-03: "the export
 *     picture must show the photo, the name, the title, the identity banner and the rank — full
 *     redesign, premium, polished"). His photograph in the banner's bezel, the banner's signature
 *     name and title, NO HR id, and both ranks in the footer he approved on the strip — checked on
 *     the EMITTED document, because the source can hold the right strings in the wrong place.
 *  3. NO MONEY ON THE CARD. It is built to be posted publicly; a rep's territory revenue is the
 *     company's confidential figure, not his to publish.
 *  4. SELF ONLY, behind its OWN narrow permission — never `employee_profile:export`, a broad
 *     record-export right a rep does not hold.
 *  5. THE PUBLIC LINK CARRIES ONLY A SIGNED SUBJECT. No hr id is ever read off the wire.
 *
 * Comments are stripped before every source read: this file's prose spells the strings it pins.
 */

const CARD = "src/lib/employee-portal/performance-card.ts";
const RENDER = "src/lib/employee-portal/performance-card-render.ts";
const ROUTE = "app/api/employee-portals/performance-card/route.ts";
const REGISTRY = "src/lib/security/access-registry.ts";
const PERMS = "src/lib/auth/permissions.ts";
const STRIP = "src/components/employee-portal/rep-honour-strip.tsx";
const IMAGE = "app/share/card/[token]/image/route.ts";
const IDENTITY = "src/components/employee-portal/identity-card.tsx";

/** Hager's real card as it stood on 2026-10-03 — 8th of 111, 6th of 35 in CNS, 108% over Jul–Aug. */
const FIXTURE: PerformanceCardData = {
  hrId: "B-135",
  displayName: "Hager Abdelmaged",
  fullName: "Hager Nabil Abdelmaged",
  signatureName: signatureNameFor("Hager Nabil Abdelmaged"),
  photoDataUri: "data:image/jpeg;base64,/9j/PORTRAIT",
  initials: "HA",
  jobTitle: "Medical Representative",
  lineName: "CNS",
  areaName: "Alex East",
  fromPeriod: "2026-07",
  toPeriod: "2026-08",
  windowLabel: "Jul – Aug 2026",
  achievementPercent: 108.4,
  standing: {
    fromPeriod: "2026-07",
    toPeriod: "2026-08",
    windowLabel: "Jul – Aug 2026",
    company: { rank: 8, outOf: 111, ranked: 70, vacant: 35, achievementPercent: 108.4 },
    line: { rank: 6, outOf: 35, ranked: 22, vacant: 9, achievementPercent: 108.4, lineName: "CNS" },
  },
  months: [
    { period: "2026-07", label: "Jul", achievementPercent: 77 },
    { period: "2026-08", label: "Aug", achievementPercent: 140 },
  ],
};

const flat = (path: string) => stripComments(readFileSync(path, "utf8")).replace(/\s+/g, " ");

function row(partial: { repHrId: string; lineCode?: string | null; actualValue: number; targetValue: number | null }): AchievementRow {
  const targetValue = partial.targetValue;
  return {
    period: "2026-08",
    lineCode: partial.lineCode === undefined ? "cns" : partial.lineCode,
    regionCode: "RG1",
    areaCode: "AR1",
    areaState: "active",
    isOther: false,
    repSeatId: `seat-${partial.repHrId}`,
    repHrId: partial.repHrId,
    dmSeatId: "dm",
    dmHrId: "B-900",
    productCode: "GU001",
    actualUnits: 1,
    actualValue: partial.actualValue,
    targetUnits: targetValue == null ? null : 1,
    targetValue,
    achievementValue: targetValue ? partial.actualValue / targetValue : null,
    achievementUnits: null,
    hasTarget: targetValue != null && targetValue > 0,
    hasActual: partial.actualValue > 0,
  };
}

const PUBLISHED = new Set(["cns|2026-08", "pedia|2026-08"]);

export function runRepPerformanceCardTests() {
  // ── 1. The establishment: seats, not people ──────────────────────────────────────────────────
  const seats = foldRepEstablishment([
    { seat_tier: "REP", line_code: "cns", is_vacant: false },
    { seat_tier: "REP", line_code: "cns", is_vacant: true },
    { seat_tier: "REP", line_code: "pedia", is_vacant: false },
    // A district manager's chair, and an acting DM's — neither belongs in a rep's denominator.
    { seat_tier: "DM", line_code: "cns", is_vacant: false },
    { seat_tier: "ACTING_DM", line_code: "cns", is_vacant: false },
    { seat_tier: "NSM", line_code: "cns", is_vacant: false },
  ]);
  assert.equal(seats.company.seats, 3, "every REP seat counts, vacant ones included");
  assert.equal(seats.company.vacant, 1, "and the vacancies are counted, not hidden");
  assert.equal(seats.byLine.get("cns")?.seats, 2, "per line too");
  assert.equal(seats.byLine.get("cns")?.vacant, 1);
  assert.equal(seats.byLine.get("pedia")?.seats, 1);
  assert.equal(seats.byLine.get("dm"), undefined, "a tier is never mistaken for a line");

  // ── 2. The badge's "out of N" is the structure ───────────────────────────────────────────────
  // Two reps scored; the structure holds five rep seats, three of them empty.
  const board = [
    row({ repHrId: "B-1", actualValue: 200, targetValue: 100 }),
    row({ repHrId: "B-2", actualValue: 150, targetValue: 100 }),
  ];
  const establishment = foldRepEstablishment([
    { seat_tier: "REP", line_code: "cns", is_vacant: false },
    { seat_tier: "REP", line_code: "cns", is_vacant: false },
    { seat_tier: "REP", line_code: "cns", is_vacant: true },
    { seat_tier: "REP", line_code: "cns", is_vacant: true },
    { seat_tier: "REP", line_code: "cns", is_vacant: true },
  ]);
  const withStructure = repRankStanding(board, PUBLISHED, { hrId: "B-1", establishment });
  assert.equal(withStructure?.company?.outOf, 5, "the badge counts the whole structure, not the scorers");
  assert.equal(withStructure?.company?.ranked, 2, "the scored count is kept — for the card, never the badge");
  assert.equal(withStructure?.company?.vacant, 3, "and so is the vacancy count");
  assert.equal(withStructure?.company?.rank, 1, "the RANK is still among the reps who could be scored");
  assert.equal(withStructure?.line?.outOf, 5, "the line board reads its own line's seats");

  // FAIL SOFT: with no seat model there is still a denominator — the scored count — never 0.
  const noStructure = repRankStanding(board, PUBLISHED, { hrId: "B-1", establishment: null });
  assert.equal(noStructure?.company?.outOf, 2, "an unreadable seat model falls back to the scored count");
  assert.equal(noStructure?.company?.vacant, 0, "and claims no vacancies it cannot see");
  assert.equal(
    repRankStanding(board, PUBLISHED, { hrId: "B-1", establishment: foldRepEstablishment([]) })?.company?.outOf,
    2,
    "an EMPTY seat model is the same failure — never 'of 0 medical reps' on a rep's keepsake",
  );

  // ── 3. The card, drawn: his identity banner, the proof, and HIS footer carrying the rank ──────
  const render = flat(RENDER);
  const html = performanceCardHtml(FIXTURE);
  const band = (open: string, close: string) => {
    const start = html.indexOf(open);
    return start < 0 ? "" : html.slice(start, html.indexOf(close, start));
  };
  const banner = band('<header class="banner">', "</header>");
  const mid = band('<main class="mid">', "</main>");
  const foot = band('<footer class="foot">', "</footer>");
  assert.ok(banner && mid && foot, `${RENDER}: three bands — the identity banner, the proof, his footer`);

  // His PHOTOGRAPH, in the identity banner's own bezel — and the monogram plate when there is none.
  assert.ok(
    banner.includes(`<div class="portrait"><div class="portrait-in"><img src="${FIXTURE.photoDataUri}"`),
    `${RENDER}: his photograph is on the card, inside the identity banner's portrait frame`,
  );
  const noPhoto = performanceCardHtml({ ...FIXTURE, photoDataUri: null });
  assert.ok(
    noPhoto.includes('<div class="portrait-in"><span class="portrait-mono">HA</span>') &&
      !noPhoto.includes('<div class="portrait-in"><img'),
    `${RENDER}: no photograph draws the monogram plate — never an empty frame, never a failed card`,
  );
  // The name his portal banner signs with, in the banner's script, with his title under it.
  assert.ok(
    banner.includes('<p class="sig-name"><span>Hager N. Abdelmaged</span></p>') &&
      banner.includes('<p class="sig-title">Medical Representative</p>'),
    `${RENDER}: the banner signs with his signature name and carries his title`,
  );
  assert.ok(
    /@font-face \{ font-family: "Pinyon Script";[^}]*src: url\("data:font\/woff2;base64,/.test(html),
    `${RENDER}: the script face is INLINED — setContent has no origin, so a /fonts/ url would load nothing`,
  );
  assert.ok(
    /<svg class="wave"[\s\S]*fill="#0b1f3a"[\s\S]*stroke="#f47b20"/.test(banner) &&
      banner.includes('<img class="banner-wm" src="data:image/png;base64,'),
    `${RENDER}: the banner keeps its watermark, its navy wave and the wave's orange stroke`,
  );
  // 🔴 THE BANNER'S DIVIDER FADES BETWEEN SOLID COLOURS. Faded out through alpha — the component's way
  // — it printed as a dark line in the PDF (darkest pixel 87 against 203 in the picture, the one place a
  // pixel diff of the two found them disagreeing, 2026-10-03).
  assert.ok(
    /\.divider \{[^}]*background: linear-gradient\(180deg, #fdf8f3, #e0d0bc 20%, #e0d0bc 80%, #fdf8f3\); \}/.test(html),
    `${RENDER}: the banner divider fades cream → beige → cream, with no alpha for a PDF to print dark`,
  );
  // 🔴 NAMES, NEVER CODES. The portal banner prints the HR id; a card built to be posted never does.
  assert.ok(!html.includes(FIXTURE.hrId), `${RENDER}: the HR id appears NOWHERE on a card built to be posted publicly`);

  // THE RANK, IN HIS FOOTER — the two inks, "of N", the period under them, both marks in his order.
  assert.ok(
    foot.includes('<span class="rank-fig" style="color:#f47b20">8th</span><span class="rank-of">of 111</span>') &&
      foot.includes(
        '<p class="micro">CNS line</p><p class="rank-row"><span class="rank-fig" style="color:#0879b8">6th</span><span class="rank-of">of 35</span>',
      ),
    `${RENDER}: the footer carries both ranks — the company in Phoenix orange, his line in Sato blue, each "of N"`,
  );
  assert.ok(
    foot.indexOf("rank-fig") < foot.indexOf('<p class="foot-period">Jul – Aug 2026</p>'),
    `${RENDER}: the period sits UNDER the ranking, as it does on the strip`,
  );
  assert.ok(
    foot.indexOf('alt="Sato Pharma"') < foot.indexOf('class="foot-panel"') &&
      foot.indexOf('class="foot-panel"') < foot.indexOf('class="foot-bird"') &&
      foot.includes('<span class="foot-word-a">PHOENIX</span><span class="foot-word-b">WORKFORCE</span>'),
    `${RENDER}: Sato on the left, the ranking in the centre, the Phoenix lockup on the right — his footer's order`,
  );
  assert.ok(
    /\.foot-rule \{[^}]*height: 3px; background: #0879b8;/.test(html) && (foot.match(/class="foot-rule /g) ?? []).length === 2,
    `${RENDER}: a 3px Sato-blue rule along the footer's top AND its bottom`,
  );
  assert.ok(
    html.includes(
      "background-image: linear-gradient(to right, #ebeef1 1px, transparent 1px), linear-gradient(to bottom, #ebeef1 1px, transparent 1px);",
    ) && html.includes("background-size: 18px 18px; background-position: calc(50% + 9px) calc(50% + 9px);"),
    `${RENDER}: the faint square grid, offset half a square so a line runs through the centre`,
  );
  assert.ok(
    /\.foot-panel \{[^}]*width: 360px; height: 144px;[^}]*background: #ffffff;/.test(html),
    `${RENDER}: the ranking sits on a BLANK panel of 20 × 8 whole squares — an even count both ways`,
  );
  assert.ok(
    PERFORMANCE_CARD_LAYOUT_SCRIPT.includes("while (width < need) width += 2 * 18;"),
    `${RENDER}: a long line name widens the panel TWO squares at a time, so its edges stay on the lines`,
  );
  assert.ok(
    performanceCardHtml({ ...FIXTURE, standing: null }).includes('<p class="foot-period foot-period-only">Jul – Aug 2026</p>'),
    `${RENDER}: with no rank the footer still closes the card — the period under the tick, as his photo frame has the date`,
  );

  // The proof: the figure toned by the one scale, the bar DRAWN TO SCALE, the chart, the structure.
  assert.ok(
    mid.includes('<p class="ach-fig" style="color:#0f9d58">108<small>%</small></p>') && mid.includes('class="ach-mark" style="left:92.59%"'),
    `${RENDER}: 108% of target, and the bar to scale — the 100% tick at 100/108 of its length`,
  );
  assert.ok(
    /class="bar" style="height:[\d.]+%;background:#e2621b"><span class="val">77%/.test(mid) &&
      /class="bar" style="height:[\d.]+%;background:#0f9d58"><span class="val">140%/.test(mid),
    `${RENDER}: the month chart — every month a toned, labelled column`,
  );
  assert.ok(
    mid.includes('<dt>Structure</dt><dd>111 rep seats<span class="fact-sub"> · 35 vacant</span></dd>'),
    `${RENDER}: the structure and its vacancies, stated on the card`,
  );
  assert.ok(
    !/scored/i.test(mid),
    `${RENDER}: NOT the reps who were scored — "do not show the current medical reps, only show total structure of medical reps count vacants" (owner, 2026-10-03)`,
  );

  // A NAME IS FITTED, NEVER CUT — once the script face has loaded — and a card the pass did not run
  // on is refused rather than printed.
  assert.ok(
    PERFORMANCE_CARD_LAYOUT_SCRIPT.includes("await document.fonts.ready;") && PERFORMANCE_CARD_LAYOUT_SCRIPT.includes("name.style.fontSize"),
    `${RENDER}: the one-line name is shrunk to its room after Pinyon Script loads — never cut, never an ellipsis`,
  );
  assert.ok(
    /throw new Error\("The performance card's layout pass did not run/.test(render),
    `${RENDER}: a card the layout pass did not run on is refused, not printed`,
  );
  // 🔴 If a gradient numeral ever comes back, it needs BOTH halves of the fix that made the first
  // card's rank visible: -webkit-text-fill-color (color:transparent alone drops the glyphs in
  // Chromium) and an inline background-IMAGE (the shorthand resets background-clip).
  if (/background-clip: ?text/.test(render)) {
    assert.ok(
      /-webkit-text-fill-color: transparent/.test(render) && !/style="background:linear-gradient/.test(render),
      `${RENDER}: a gradient numeral needs -webkit-text-fill-color AND an inline background-image, never the shorthand`,
    );
  }

  // THE SIGNATURE NAME IS THE PORTAL BANNER'S — pinned on both sides, so neither drifts alone.
  assert.equal(signatureNameFor("Hager Nabil Abdelmaged"), "Hager N. Abdelmaged");
  assert.equal(signatureNameFor("Esraa Fathy Mohamed Al-Shandalati"), "Esraa F. Al-Shandalati");
  assert.equal(signatureNameFor("  Hager   Nabil  Abdelmaged "), "Hager N. Abdelmaged");
  assert.equal(signatureNameFor("Amr Gbr"), "Amr Gbr", "two parts or fewer are printed whole");
  assert.ok(
    flat(IDENTITY).includes(
      "if (parts.length < 3) return name; return `${parts[0]} ${parts[1].charAt(0).toUpperCase()}. ${parts[parts.length - 1]}`;",
    ),
    `${IDENTITY}: the banner still signs with the rule the card restates — change both or neither`,
  );

  // ── 4. No money, and no rounded corner, on a card built to be posted ─────────────────────────
  const card = flat(CARD);
  assert.ok(
    !/salesValue|targetValue:|actualValue|egp|EGP/.test(render),
    `${RENDER}: no money on the card — percentages, the rank and the counts only`,
  );
  assert.ok(
    !/netSalary|payslip/i.test(render + card),
    `${RENDER}: the no-payslip rule reaches every surface, a shareable one most of all`,
  );
  assert.ok(
    /border-radius: 0 !important/.test(render),
    `${RENDER}: the square-edge golden rule, written out — tokens.css would otherwise default to 4px`,
  );
  assert.ok(
    /loadMilestonePhotoBytes\(hrId\)/.test(card) && /polishPortraitDataUri\(bytes/.test(card),
    `${CARD}: the photograph is the portal's (the ONE resolution: uploaded, bundled, none), polished like the milestone keepsake`,
  );
  assert.ok(
    /if \(!person\) throw new Error\(/.test(card),
    `${CARD}: no directory row, no card — the HR id is never drawn as his name`,
  );
  assert.ok(
    /signatureName: signatureNameFor\(fullName\)/.test(card),
    `${CARD}: the card signs with the portal banner's signature rule`,
  );
  assert.ok(
    /summarizeAchievement/.test(card),
    `${CARD}: the window is summed then divided once — the repo's one implementation of that rule`,
  );
  assert.ok(
    !/summary.achievementValue * 100/.test(card) && !/point.achievementValue != null ? point.achievementValue * 100/.test(card),
    `${CARD}: the card's percentages are ALL sales ÷ target, as the closing and the rank badge on it divide — never the covered ratio`,
  );
  assert.ok(
    /publishedPointsOnly/.test(card) && /targetValue > 0/.test(card),
    `${CARD}: published months with a target only — an unscorable month is not a bar on a keepsake`,
  );

  // ── 5. Self only, behind its own narrow right ────────────────────────────────────────────────
  const route = flat(ROUTE);
  assert.ok(
    /assertPermission\(access, "performance_card_self", "export"\)/.test(route),
    `${ROUTE}: its own narrow permission, never employee_profile:export`,
  );
  assert.ok(
    /loadPerformanceCard\(access\.hrId\)/.test(route),
    `${ROUTE}: the subject is the session's own hr id — there is no identity field on the wire`,
  );
  assert.ok(
    !/searchParams\.get\("hrId"\)|body\?\.hrId|payload\?\.hrId/.test(route),
    `${ROUTE}: an hr id must never be read off the wire`,
  );
  assert.ok(
    /assertExportRateLimit/.test(route),
    `${ROUTE}: a Chromium render is the most expensive thing a rep can ask for — it is rate limited`,
  );
  assert.ok(
    /ChromiumUnavailableError/.test(route),
    `${ROUTE}: no renderer answers 503 with his own sentence, never a stack trace`,
  );
  assert.ok(
    flat(PERMS).includes('performance_card_self: ["export"]'),
    `${PERMS}: the Medical Rep holds export on his own card and nothing more`,
  );
  assert.ok(
    /pattern: "\/api\/employee-portals\/performance-card", permission: \{ resource: "performance_card_self", action: "export" \}/.test(
      flat(REGISTRY),
    ),
    `${REGISTRY}: the route is declared with the permission it actually asserts`,
  );

  // ── 6. The share link carries a signed subject and nothing else ──────────────────────────────
  process.env.PHOENIX_AUTH_SECRET ||= "test-secret-for-share-card-tokens";
  const token = issueShareCardToken({ kind: "performance", hrId: "b-135" });
  const payload = readShareCardToken(token);
  assert.equal(payload?.k, "performance", "the token names the card kind");
  assert.ok(payload && "hr" in payload && payload.hr.length > 0, "and carries the canonical subject");
  assert.equal(
    readShareCardToken(`${token}x`),
    null,
    "a tampered token is indistinguishable from a missing one — both resolve to nothing",
  );
  assert.equal(
    readShareCardToken(token, Math.floor(Date.now() / 1000) + 40 * 24 * 60 * 60),
    null,
    "and a link expires, whatever a platform cached at scrape time",
  );
  const image = flat(IMAGE);
  assert.ok(
    /payload\.k === "performance"/.test(image) && /loadPerformanceCard\(payload\.hr\)/.test(image),
    `${IMAGE}: the public picture renders the SIGNED subject's card and no other`,
  );

  // ── 7. The caption, and the composers it opens ───────────────────────────────────────────────
  const caption = performanceShareCaption("Jul – Aug 2026", "Ranked 8th of 111 medical reps");
  assert.ok(caption.includes("Jul – Aug 2026"), "a shared rank must name its period — nobody can ask later");
  assert.ok(caption.includes("Ranked 8th of 111 medical reps"), "and state the rank it is about");
  assert.ok(
    performanceShareCaption("Jul – Aug 2026", null).includes("Jul – Aug 2026"),
    "with no badge the caption still names the window",
  );
  for (const target of ["whatsapp", "linkedin", "facebook"] as const) {
    const url = shareComposerUrl(target, caption, "https://phoenix-hr.satopharma.com/share/card/abc");
    assert.ok(url && url.startsWith("https://"), `${target} must open a real composer`);
  }
  assert.equal(
    shareComposerUrl("whatsapp-status", caption, "https://example.test/x"),
    null,
    "WhatsApp Status has no web composer — it is the OS share sheet or nothing",
  );

  // ── 8. The strip on the page ─────────────────────────────────────────────────────────────────
  const strip = flat(STRIP);
  assert.ok(strip.startsWith('"use client"'), `${STRIP}: it fetches and shares, so it is a client component`);
  assert.ok(
    !/\brounded(-|\b)/.test(strip),
    `${STRIP}: the square-edge golden rule — no round or semi-round corners`,
  );
  assert.ok(
    /#f47b20/.test(strip) && /#0879b8/.test(strip),
    `${STRIP}: both marks — Phoenix orange and Sato's one brand blue (owner, 2026-10-03)`,
  );
  assert.ok(
    /SHARE_TARGETS/.test(strip) && /shareComposerUrl/.test(strip) && /shareFallbackHint/.test(strip),
    `${STRIP}: it reuses the portal's share CONTRACT — the targets, the composers and the hint`,
  );
  assert.ok(
    /navigator as Navigator & \{ share/.test(strip),
    `${STRIP}: the OS share sheet with the file is the real mechanism on the reps' tablets`,
  );
  assert.ok(
    /body\?\.error \?\?|body\.error \?\?/.test(strip),
    `${STRIP}: the route's own sentence is what the rep reads, never a status code`,
  );
}
