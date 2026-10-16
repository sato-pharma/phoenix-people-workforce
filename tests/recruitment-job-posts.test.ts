import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  JOB_POST_MAX_AREAS,
  JOB_POST_TEMPLATES,
  jobPostFileStem,
  jobPostForArea,
  renderJobPostHtml,
  type JobPostAssets,
  type JobPostContent,
} from "../src/lib/recruitment/job-posts/templates.ts";
import {
  JOB_POST_MAX_LINES,
  coerceAreas,
  coerceTitleDraft,
  contentFromDraft,
  postRequestViolations,
  titleDraftViolations,
} from "../src/lib/recruitment/job-posts/titles.ts";

/**
 * JOB POSTS — the five templates and the rules a post obeys (owner, 2026-10-15).
 *
 * The pictures are drawn from one pure function, so what is pinned here is the HTML every template
 * emits: that every word the person typed reaches the page, that nothing they typed can become
 * markup, that an area picture names its own area and no other, and that the line is printed only
 * when it was chosen.
 */

const ASSETS: JobPostAssets = { fontRegular: "data:font/ttf;base64,AA==", fontBold: "data:font/ttf;base64,AA==", logo: "data:image/png;base64,LIGHT", logoOnDark: "data:image/svg+xml;base64,DARK", logoOnBlue: "data:image/svg+xml;base64,BLUE", arabic: "data:image/png;base64,ARABIC" };

const AREAS = ["Heliopolis", "Nasr City", "Cairo East 1"];

function post(over: Partial<JobPostContent> = {}): JobPostContent {
  return {
    title: "Medical Representative",
    department: "Sales",
    headline: null,
    reportsTo: "District Manager",
    employment: "Full-time",
    location: "Sheraton, Cairo",
    duties: [
      { lead: "Visit", rest: "your doctors every week" },
      { lead: "Report", rest: "calls the same day" },
    ],
    needs: [
      { lead: "Pharmacy", rest: "or science degree" },
      { lead: "Driving", rest: "licence" },
    ],
    areas: [],
    line: null,
    menuName: "Medical Representative",
    whatsapp: "01159888247",
    careers: "satopharma.com/careers",
    ...over,
  };
}

function applyBands(html: string): number {
  return html.split("Send your CV on WhatsApp").length - 1;
}

export function runRecruitmentJobPostsTests() {
  // ── Every template carries every word ──────────────────────────────────────────────────────────
  assert.equal(JOB_POST_TEMPLATES.length, 5, "the owner approved five templates");

  for (const { key } of JOB_POST_TEMPLATES) {
    const html = renderJobPostHtml(post({ areas: AREAS }), key, ASSETS);
    assert.ok(html.includes("Medical"), `${key}: the job title is on the page`);
    for (const word of ["Visit", "your doctors every week", "Report", "calls the same day"]) {
      assert.ok(html.includes(word), `${key}: duty text "${word}" is on the page`);
    }
    for (const word of ["Pharmacy", "or science degree", "Driving", "licence"]) {
      assert.ok(html.includes(word), `${key}: need text "${word}" is on the page`);
    }
    for (const area of AREAS) assert.ok(html.includes(area), `${key}: area "${area}" is on the page`);
    assert.equal(applyBands(html), 1, `${key}: the apply band appears exactly once`);
    assert.ok(html.includes("011 5988 8247"), `${key}: the WhatsApp number prints in its spaced form`);
    assert.ok(html.includes("and your area"), `${key}: a multi-area post asks for the area`);
  }

  // ── A per-area picture names its own area and no other ─────────────────────────────────────────
  const all = post({ areas: AREAS });
  for (const { key } of JOB_POST_TEMPLATES) {
    for (const area of AREAS) {
      const html = renderJobPostHtml(jobPostForArea(all, area), key, ASSETS);
      assert.ok(html.includes(area), `${key}: the ${area} picture names ${area}`);
      for (const other of AREAS.filter((name) => name !== area)) {
        assert.ok(!html.includes(other), `${key}: the ${area} picture must not name ${other}`);
      }
      assert.ok(!html.includes("and your area"), `${key}: a one-area picture does not ask for the area`);
      assert.ok(!html.includes("Open in"), `${key}: a one-area picture has no area list`);
    }
  }
  assert.deepEqual(all.areas, AREAS, "narrowing to one area leaves the source post untouched");

  // No areas at all: the plain location fact, and no area block.
  const noAreas = renderJobPostHtml(post(), "executive", ASSETS);
  assert.ok(noAreas.includes("Sheraton, Cairo"), "no area chosen -> the location fact is printed");
  assert.ok(!noAreas.includes("Open in"), "no area chosen -> no area block");

  // ── The line prints only when it was chosen ────────────────────────────────────────────────────
  for (const { key } of JOB_POST_TEMPLATES) {
    const without = renderJobPostHtml(post(), key, ASSETS);
    for (const name of ["CNS", "Anti Infective", "Pedia"]) {
      assert.ok(!without.includes(name), `${key}: no line chosen -> "${name}" is nowhere on the page`);
    }
    const withLine = renderJobPostHtml(post({ line: "Anti Infective" }), key, ASSETS);
    assert.ok(withLine.includes("Anti Infective"), `${key}: a chosen line is printed`);
  }

  // ── Nothing typed becomes markup ───────────────────────────────────────────────────────────────
  const hostile = post({
    title: "Rep <img src=x onerror=alert(1)>",
    duties: [{ lead: "<script>alert(1)</script>", rest: "<b>bold</b> & more" }],
    needs: [{ lead: 'Quote"', rest: "<i>x</i>" }],
    areas: ["<u>Nasr City</u>", "Heliopolis"],
    menuName: "<s>Rep</s>",
  });
  for (const { key } of JOB_POST_TEMPLATES) {
    const html = renderJobPostHtml(hostile, key, ASSETS);
    assert.ok(!html.includes("<script>alert(1)"), `${key}: a <script> typed in a duty is not emitted as a tag`);
    assert.ok(!html.includes("<img src=x"), `${key}: markup typed in the title is not emitted as a tag`);
    assert.ok(!html.includes("<u>Nasr City"), `${key}: markup typed in an area is not emitted as a tag`);
    assert.ok(!html.includes("<s>Rep</s>"), `${key}: markup typed in the WhatsApp choice is not emitted as a tag`);
    assert.ok(!html.includes("<i>x</i>"), `${key}: markup typed in a need is not emitted as a tag`);
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), `${key}: the duty text shows, escaped`);
  }

  // ── File names ─────────────────────────────────────────────────────────────────────────────────
  assert.equal(jobPostFileStem({ title: "Medical Representative" }), "medical-representative");
  assert.equal(jobPostFileStem({ title: "Medical Representative" }, "Cairo East 1"), "medical-representative-cairo-east-1");
  assert.equal(jobPostFileStem({ title: "///" }), "job-post", "a title with nothing usable still gets a name");

  // ── The rules a title and a post obey ──────────────────────────────────────────────────────────
  const good = coerceTitleDraft({
    title: "  Medical Representative ",
    duties: [{ lead: "Visit", rest: "doctors" }, { lead: "", rest: "" }],
    needs: [{ lead: "Degree", rest: "" }],
  });
  assert.equal(good.title, "Medical Representative", "the title is trimmed");
  assert.equal(good.duties.length, 1, "an empty editor row is not a duty");
  assert.equal(good.employment, "Full-time", "employment defaults");
  assert.equal(good.location, "Sheraton, Cairo", "location defaults");
  assert.deepEqual(titleDraftViolations(good), [], "a complete title saves");

  assert.ok(titleDraftViolations({ ...good, title: "" }).some((m) => /name/i.test(m)), "a title needs a name");
  assert.ok(titleDraftViolations({ ...good, needs: [] }).some((m) => /need/i.test(m)), "a title needs at least one requirement");
  const tooMany = Array.from({ length: JOB_POST_MAX_LINES + 1 }, (_, i) => ({ lead: `L${i}`, rest: "x" }));
  assert.ok(titleDraftViolations({ ...good, duties: tooMany }).length > 0, `more than ${JOB_POST_MAX_LINES} duties is refused`);
  assert.ok(titleDraftViolations({ ...good, needs: [{ lead: "", rest: "text" }] }).length > 0, "a line with no bold opening is refused");

  assert.deepEqual(coerceAreas([" Heliopolis ", "heliopolis", "", "Nasr City", 7]), ["Heliopolis", "Nasr City", "7"], "areas are trimmed and de-duplicated");
  assert.deepEqual(coerceAreas("Heliopolis"), [], "a non-array reads as no areas, never a crash");

  assert.deepEqual(postRequestViolations({ draft: good, areas: AREAS, line: null, template: "executive" }), []);
  assert.ok(postRequestViolations({ draft: good, areas: AREAS, line: null, template: "comic-sans" }).length > 0, "an unknown template is refused");
  const crowd = Array.from({ length: JOB_POST_MAX_AREAS + 1 }, (_, i) => `Area ${i}`);
  assert.ok(postRequestViolations({ draft: good, areas: crowd, line: null, template: "split" }).length > 0, "too many areas is refused");

  // The apply details are the server's, never the request's.
  const content = contentFromDraft(
    coerceTitleDraft({ title: "Rep", needs: [{ lead: "A", rest: "" }], whatsapp: "01000000000", careers: "evil.example" }),
    { areas: [], line: null },
    { whatsapp: "01159888247", careers: "satopharma.com/careers" },
  );
  assert.equal(content.whatsapp, "01159888247", "a request cannot print another WhatsApp number");
  assert.equal(content.careers, "satopharma.com/careers", "a request cannot print another careers address");
  assert.equal(content.menuName, "Rep", "the WhatsApp choice defaults to the job title");

  // ── The field-force titles are seeded with their wording READY (owner, 2026-10-16) ─────────────
  // Choosing a title fills both lists from its row, so a title that is not in the database has no
  // wording to load. Each seeded block is parsed back out of the migration and must save as written.
  const seed = readFileSync(new URL("../supabase/migrations/20261016005009_ats_job_post_titles_field_force_seed.sql", import.meta.url), "utf8");
  const blocks = seed.split("insert into public.ats_job_post_titles").slice(1);
  assert.equal(blocks.length, 3, "the migration seeds exactly the three field-force titles");
  const seeded = new Map<string, { duties: number; needs: number; menu: string }>();
  for (const block of blocks) {
    const title = /values \(\s*'([^']+)'/.exec(block)?.[1] ?? "";
    const [duties, needs] = [...block.matchAll(/'(\[[\s\S]*?\])'::jsonb/g)].map((m) => JSON.parse(m[1]!.replace(/''/g, "'")) as unknown);
    const menu = /,\s*'([^']+)'\s*\)\s*on conflict/.exec(block)?.[1] ?? "";
    const parsed = coerceTitleDraft({ title, department: "Sales", duties, needs, menuName: menu });
    assert.deepEqual(titleDraftViolations(parsed), [], `${title}: the seeded wording saves as written`);
    assert.equal(parsed.duties.length, (duties as unknown[]).length, `${title}: no seeded duty is dropped on the way in`);
    assert.equal(parsed.needs.length, (needs as unknown[]).length, `${title}: no seeded requirement is dropped on the way in`);
    seeded.set(title, { duties: parsed.duties.length, needs: parsed.needs.length, menu });
  }
  assert.deepEqual([...seeded.keys()].sort(), ["District Sales Manager", "Medical Representative", "Product Manager"], "the three titles the owner asked for");
  assert.equal(seeded.get("District Sales Manager")?.menu, "District Manager", "the WhatsApp choice is the menu's own label, not the longer post title");
  for (const owners of [
    "Plan and complete weekly visits to doctors and pharmacies in your assigned area.",
    "Achieve monthly sales targets for each assigned product.",
    "Bachelor''s degree in Pharmacy, Vet, or Science.",
    "6 months to 2 years of experience in pharmaceutical sales.",
    "Ability to use CRM systems, mobile applications, and sales reports.",
    "Responsible, self-motivated, and committed to achieving targets.",
  ]) {
    assert.ok(seed.includes(owners), `Medical Representative keeps the owner's own wording (pasted 2026-10-16): ${owners}`);
  }
  for (const owners of [
    "Lead, motivate, and manage medical representatives across your region.",
    "Track individual results, identify gaps, and take corrective actions.",
    "Must be a resident of the district you will manage.",
    "Must own a car.",
    "Strong leadership, decision-making, and commitment to achieving targets.",
  ]) {
    assert.ok(seed.includes(owners), `District Sales Manager keeps the owner's own wording (pasted 2026-10-16): ${owners}`);
  }
  assert.equal(seeded.get("District Sales Manager")?.duties, 6, "all six District Sales Manager duties are kept");

  // The Product Manager's requirements are the owner's own too (pasted 2026-10-16): a later migration swaps
  // the seed's draft list for his seven lines, guarded so an edit made on the page is never overwritten.
  const pmNeeds = readFileSync(new URL("../supabase/migrations/20261016142455_job_post_product_manager_needs.sql", import.meta.url), "utf8");
  const [pmNew] = [...pmNeeds.matchAll(/'(\[[\s\S]*?\])'::jsonb/g)].map((m) => JSON.parse(m[1]!.replace(/''/g, "'")) as unknown);
  const pmParsed = coerceTitleDraft({ title: "Product Manager", department: "Marketing", duties: [{ lead: "x", rest: "" }], needs: pmNew });
  assert.deepEqual(titleDraftViolations(pmParsed), [], "the Product Manager's seven requirements save as written");
  assert.equal(pmParsed.needs.length, 7, "all seven of the owner's Product Manager requirements are kept");
  assert.ok(/needs = '\[[\s\S]*?Pharmacy, medicine, veterinary or science degree/.test(pmNeeds), "the update only fires while the requirements still hold the seed's draft");
  assert.ok(pmNeeds.includes("Greater Cairo resident") && pmNeeds.includes("Chest, ENT or Urology"), "residence and the specialities preference are in the list");

  // The owner then asked (2026-10-16) for the post tailored to marketers: a headline, six duties in a
  // marketer's own words, his seven requirements tightened. Guarded on the text the two earlier migrations wrote.
  const pmCopy = readFileSync(new URL("../supabase/migrations/20261016143954_job_post_product_manager_marketer_copy.sql", import.meta.url), "utf8");
  const [copyDuties, copyNeeds] = [...pmCopy.matchAll(/'(\[[\s\S]*?\])'::jsonb/g)].map((m) => JSON.parse(m[1]!.replace(/''/g, "'")) as unknown);
  assert.ok(pmCopy.includes("headline = 'Own the brand.' || chr(10) || 'Lead the launch.'"), "the headline is two lines, split on a newline");
  const copyParsed = coerceTitleDraft({ title: "Product Manager", department: "Marketing", headline: "Own the brand.\nLead the launch.", duties: copyDuties, needs: copyNeeds });
  assert.deepEqual(titleDraftViolations(copyParsed), [], "the marketer copy saves as written — headline, six duties, seven requirements");
  assert.deepEqual([copyParsed.duties.length, copyParsed.needs.length], [6, 7], "six duties and all seven of the owner's requirements");
  assert.ok(copyParsed.needs.some((line) => line.lead === "Greater Cairo resident"), "the residence line stays \"Greater Cairo\", never plain Cairo (owner, 2026-10-16)");
  assert.ok(/headline is null[\s\S]*?Own your line''s marketing plan[\s\S]*?Preferably experience in Chest, ENT or Urology/.test(pmCopy), "the update only fires while the headline is empty and both lists still hold the earlier text");

  // ── The builder: choosing a title loads its words, and the page wears the shared premium look ──
  const page = readFileSync(new URL("../src/components/recruitment/job-post-builder.tsx", import.meta.url), "utf8");
  assert.ok(/const pick = [\s\S]*?load\(found\)/.test(page), "picking a saved title loads its duties and requirements at once");
  assert.ok(/const typeTitleName = [\s\S]*?isBlank\(draft\.duties\)[\s\S]*?load\(match\)/.test(page), "typing a saved title's name into an EMPTY new title loads it, and never replaces typed words");
  assert.ok(page.includes("adminPanelHeaderClassName"), "every panel opens with the shared dark header band");
  assert.ok(!/rounded-(full|lg|xl|2xl|3xl)/.test(page), "no rounded corners (square-edge rule)");
  assert.ok(page.includes('"Choose the department."'), "a post cannot silently inherit a department");

  // ── The preview frame must not be clamped by the admin shell ──────────────────────────────────
  // app/globals.css gives every iframe in .admin-shell max-width: 100%. The preview draws the post at
  // its true 1080px and scales it with a transform, so that clamp squeezes the page into the column
  // first and the scale shrinks it again — the right half of the post was cut off on 2026-10-15.
  const builder = readFileSync(new URL("../src/components/recruitment/job-post-builder.tsx", import.meta.url), "utf8");
  const frame = /<iframe[\s\S]*?\/>/.exec(builder)?.[0] ?? "";
  assert.ok(frame.includes('maxWidth: "none"'), "the preview iframe opts out of the admin shell's max-width: 100% clamp");
  assert.ok(frame.includes('maxHeight: "none"'), "the preview iframe opts out of any max-height clamp too");

  // ── A post that could not be fitted is refused, never drawn clipped (owner-approved 2026-10-16) ──
  // The layout pass reports whether it ran out of room; the server refuses such a post (422), and the
  // preview shows the same verdict, so the person sees it before pressing download.
  const drawn = renderJobPostHtml(post(), "executive", ASSETS);
  const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;
  // Executive with a two-line headline: the title drops to a statement line under it. A fixed 326px hero
  // hid that line under the facts card overlapping the hero's foot (Product Manager, 2026-10-16).
  const headlined = renderJobPostHtml(post({ headline: "Own the brand.\nLead the launch." }), "executive", ASSETS);
  assert.ok(headlined.includes('<div class="statement"><i></i>Medical Representative</div>'), "a headlined Executive post still prints the title, as its statement line");
  assert.ok(headlined.includes(".hero { position: relative; min-height: 326px; padding-bottom: 66px;"), "the Executive hero grows with a two-line headline instead of hiding the title under the facts card");
  assert.ok(drawn.includes("const report = { titles: 0, k: 1, limited: false }"), "the layout report starts as not limited");
  assert.ok(drawn.includes("report.limited = true") && drawn.includes("if (k <= 0.6 || overflowing()) report.limited = true"), "running out of room (a title or the text at its floor, or anything still overflowing) marks the report limited");
  assert.ok(drawn.includes("window.parent.postMessage({ jobPostFit: report }"), "the sandboxed preview posts its fit to the page, the only way out of the frame");

  const render = readFileSync(new URL("../src/lib/recruitment/job-posts/render.ts", import.meta.url), "utf8");
  assert.ok(render.includes("if (report.limited !== false) throw new JobPostTooLongError"), "a limited layout is refused, not printed — and a report without the flag counts as limited");
  assert.equal(occurrences(render, "await load(page,"), 1, "a picture's page is loaded ONCE; the PNG and the PDF both come from that one fitted page");
  const shot = render.indexOf('emulateMediaType("screen")');
  assert.ok(shot > 0 && shot < render.indexOf("page.screenshot") && render.indexOf("page.screenshot") < render.indexOf('emulateMediaType("print")') && render.indexOf('emulateMediaType("print")') < render.indexOf("page.pdf("), "screen picture first, then print media for the PDF, on the same page");

  const route = readFileSync(new URL("../app/api/recruitment/job-posts/render/route.ts", import.meta.url), "utf8");
  assert.ok(route.includes("instanceof JobPostTooLongError) return recruitmentProblem(error.message, 422)"), "the route answers a post that cannot fit with a 422 and the plain message");
  assert.ok(route.includes('entityType: "job_post_download"'), "every download leaves an audit row");
  assert.equal(occurrences(route, "await record("), 2, "the picture/PDF and the full set each record once the file exists");
  assert.ok(route.indexOf("renderJobPostBundle(content, template)") < route.indexOf("await record(null)") && route.indexOf("const drawn =") < route.indexOf("await record(area"), "a row is written only AFTER the file was drawn, so a refused post is never logged as downloaded");
  const audit = readFileSync(new URL("../src/lib/admin/audit.ts", import.meta.url), "utf8");
  assert.ok(audit.includes('"job_post_download"'), "the audit union names the download entity type");

  assert.ok(page.includes("<FitBadge") && page.includes('"Fits at full size"') && page.includes("Text ${Math.round(fit.k * 100)}%"), "each design and the preview show how much the text shrank");
  assert.ok(page.includes("event.source !== frame.current.contentWindow"), "only a message from the preview's own frame is believed");
  assert.equal(occurrences(page, "mainFit?.limited === true"), 2, "the picture and PDF buttons switch off for a post that is too long");

  // ── The mark never sits on a white box, and the Arabic wordmark is a faint watermark (owner 2026-10-16) ──
  // Every design takes the logo variant its ground needs: on-light on white paper, on-dark on the two
  // dark grounds. The white "plate" behind the mark is gone, and the Arabic wordmark is one flat ink
  // through a mask — never a masthead, and only on Executive and Split.
  for (const { key } of JOB_POST_TEMPLATES) {
    const html = renderJobPostHtml(post({ areas: AREAS }), key, ASSETS);
    assert.ok(!html.includes('class="plate"') && !html.includes(".plate {"), `${key}: no white plate behind the logo`);
    assert.equal(occurrences(html, `<img src="${ASSETS.logoOnDark}"`), key === "night-blueprint" ? 1 : 0, `${key}: the on-dark mark is used on the navy ground only`);
    assert.equal(occurrences(html, `<img src="${ASSETS.logoOnBlue}"`), key === "bold-blue" ? 1 : 0, `${key}: the reverse mark is used on the brand-blue ground only`);
    assert.equal(occurrences(html, `<img src="${ASSETS.logo}"`), key === "bold-blue" || key === "night-blueprint" ? 0 : 1, `${key}: the on-light mark is used on white paper only`);
    assert.equal(occurrences(html, 'class="wm"'), key === "executive" || key === "split" ? 1 : 0, `${key}: the Arabic watermark is drawn once on Executive and Split only`);
    assert.ok(html.includes(`mask-image: url("${ASSETS.arabic}")`), `${key}: the Arabic wordmark is a mask, so it prints in one flat ink`);
  }
  assert.ok(!renderJobPostHtml(post(), "bold-blue", ASSETS).includes("<img src=\"" + ASSETS.arabic), "the Arabic wordmark is never an <img> — never a masthead");
  assert.ok(render.includes('"brand/sato-pharma-logo-on-navy-reverse.svg"') && render.includes('"brand/sato-pharma-logo-on-blue.svg"') && render.includes('"brand/sato-pharma-arabic-on-light.png"'), "the server draws with the on-dark mark and the Arabic wordmark");
  assert.ok(builder.includes("/brand/sato-pharma-logo-on-navy-reverse.svg") && builder.includes("/brand/sato-pharma-logo-on-blue.svg") && builder.includes("/brand/sato-pharma-arabic-on-light.png"), "the preview loads the same two files, so it matches the download");
}
