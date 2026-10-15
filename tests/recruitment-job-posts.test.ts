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

const ASSETS: JobPostAssets = { fontRegular: "data:font/ttf;base64,AA==", fontBold: "data:font/ttf;base64,AA==", logo: "data:image/png;base64,AA==" };

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
}
