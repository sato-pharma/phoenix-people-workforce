import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { closeJobCardOnWebsite, publishJobCardToWebsite, readOpenCareersCards, WebsiteCareersError } from "../src/lib/recruitment/job-posts/website.ts";
import { CAREERS_ROUTES, cardDescriptionEn, careersGuard, careersRouteForTitle, cardTitle, publishCardViolations } from "../src/lib/recruitment/job-posts/website-cards.ts";

const CARD = { descAr: "وصف", descEn: "A description.", location: "Heliopolis, Cairo", titleAr: "مندوب", titleEn: "Medical Representative — Heliopolis" };
const PICTURE = new Uint8Array([1, 2, 3]);

async function withFetch(answer: (url: string, init: RequestInit) => Response | Promise<Response>, run: (calls: { init: RequestInit; url: string }[]) => Promise<void>) {
  const realFetch = globalThis.fetch;
  const realToken = process.env.SATO_WEBSITE_INTEGRATION_TOKEN;
  const calls: { init: RequestInit; url: string }[] = [];
  process.env.SATO_WEBSITE_INTEGRATION_TOKEN = "test-token";
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ init, url: String(url) });
    return answer(String(url), init);
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = realFetch;
    if (realToken === undefined) delete process.env.SATO_WEBSITE_INTEGRATION_TOKEN;
    else process.env.SATO_WEBSITE_INTEGRATION_TOKEN = realToken;
  }
}

function refusal(status: number, code: string): Response {
  return Response.json({ data: null, error: { code, message: code }, meta: null }, { status });
}

async function refusedWith(run: () => Promise<unknown>): Promise<WebsiteCareersError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof WebsiteCareersError, "a refusal reads as a sentence for the person, never a raw error");
    return error;
  }
  throw new Error("expected a refusal");
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

export async function runRecruitmentJobPostWebsiteTests() {
  // The route list: first match wins, and the title that started this has no form.
  assert.equal(CAREERS_ROUTES.length, 10);
  assert.equal(careersRouteForTitle("Medical Representative — Heliopolis")?.roleKey, "medical_representative");
  assert.equal(careersRouteForTitle("District Manager — Alexandria & Behira")?.roleKey, "district_manager");
  assert.equal(careersRouteForTitle("Personnel Specialist / Senior Personnel Specialist")?.roleKey, "personnel");
  assert.equal(careersRouteForTitle("National Sales Manager")?.roleKey, "national_sales_manager");
  assert.equal(careersRouteForTitle("District Sales Manager"), null, "the live title with no apply form");

  // The live cards' shape.
  assert.equal(cardTitle("Medical Representative", "Heliopolis"), "Medical Representative — Heliopolis");
  assert.equal(cardTitle("Product Manager", null), "Product Manager");
  assert.equal(
    cardDescriptionEn({ duties: [{ lead: "Visit doctors", rest: "weekly." }], headline: "Join us\nnow", needs: [{ lead: "Two years", rest: "" }] }),
    "Join us now. Visit doctors weekly. Two years.",
  );

  // What a press refuses before anything is sent.
  assert.deepEqual(publishCardViolations(CARD), []);
  assert.match(publishCardViolations({ ...CARD, titleEn: "District Sales Manager" })[0]!, /reaches no apply form/);
  assert.deepEqual(publishCardViolations({ ...CARD, titleAr: " " }), ["Type the job title in Arabic."]);
  assert.deepEqual(publishCardViolations({ ...CARD, descAr: "" }), ["Type the description in Arabic."]);
  assert.match(publishCardViolations({ ...CARD, descEn: "x".repeat(5001) })[0]!, /at most 5000/);

  // The guard: warnings are what someone would feel, notes are true and allowed.
  const card = (title: string) => ({ id: title, location: null, slug: title, title });
  const report = careersGuard({
    cards: [card("Medical Representative — Heliopolis"), card("Personnel Specialist"), card("Sales Star")],
    requisitionTitles: ["Medical Representative", "Medical Representative", "Product Manager", "Regional Wizard"],
    titles: ["Medical Representative", "District Sales Manager"],
  });
  assert.equal(report.requisitions, 4);
  assert.equal(report.openCards, 3);
  assert.deepEqual(report.warnings, [
    "The open card “Sales Star” reaches no apply form, so applicants are offered email only.",
    "The job title “District Sales Manager” reaches no apply form, so Publish will refuse it.",
    "1 active requisition for “Product Manager” with no open card for that role.",
    "1 active requisition for “Regional Wizard”: the careers page has no role for this title.",
  ]);
  assert.ok(report.notes.includes("The open card “Personnel Specialist” has no active requisition behind it."));
  assert.ok(report.notes.includes("Office Coordinator has no open card on the careers page."));
  assert.ok(!report.notes.some((note) => note.startsWith("Product Manager has no open card")), "a warned role is not repeated as a note");
  assert.ok(!report.notes.some((note) => note.startsWith("Medical Representative has no")), "a role with a card has no such note");

  // The publish call: the token in Authorization, the five fields and the picture, nothing else.
  await withFetch(
    () => Response.json({ data: { id: "c1", slug: "medical-rep", status: "OPEN" }, error: null, meta: null }, { status: 201 }),
    async (calls) => {
      assert.deepEqual(await publishJobCardToWebsite(CARD, PICTURE, "post.png"), { id: "c1", slug: "medical-rep" });
      assert.equal(calls.length, 1, "one press sends one call, never a retry");
      assert.equal(calls[0]!.url, "https://api.satopharma.com/api/v1/integrations/jobs");
      assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, "Bearer test-token");
      const form = calls[0]!.init.body as FormData;
      assert.deepEqual([...form.keys()].sort(), ["descAr", "descEn", "image", "location", "titleAr", "titleEn"], "the website's strict schema refuses anything else");
      assert.equal((form.get("image") as File).name, "post.png");
    },
  );

  // A refusal reads in words, and the status tells the screen what happened.
  for (const [status, code, expected, words] of [
    [401, "INTEGRATION_TOKEN_REFUSED", 502, /key on the two systems/],
    [409, "ALREADY_OPEN", 409, /already has this exact title/],
    [422, "NO_APPLY_ROUTE", 422, /no apply form/],
    [429, "RATE_LIMITED", 503, /too many failed attempts/],
    [500, "INTERNAL", 502, /may or may not exist/],
  ] as const) {
    await withFetch(
      () => refusal(status, code),
      async () => {
        const error = await refusedWith(() => publishJobCardToWebsite(CARD, PICTURE, "post.png"));
        assert.equal(error.status, expected);
        assert.match(error.message, words);
      },
    );
  }

  // No answer is never read as a card that exists, or one that does not.
  await withFetch(
    () => Promise.reject(new Error("timeout")),
    async () => {
      const error = await refusedWith(() => publishJobCardToWebsite(CARD, PICTURE, "post.png"));
      assert.match(error.message, /may or may not exist/);
    },
  );

  // Without a token nothing leaves this system at all.
  await withFetch(
    () => Response.json({}),
    async (calls) => {
      delete process.env.SATO_WEBSITE_INTEGRATION_TOKEN;
      const error = await refusedWith(() => publishJobCardToWebsite(CARD, PICTURE, "post.png"));
      assert.match(error.message, /no key for the website/);
      assert.equal(calls.length, 0);
    },
  );

  // Closing is the only change sent.
  await withFetch(
    () => Response.json({ data: { id: "c1", slug: "s", status: "CLOSED" }, error: null, meta: null }),
    async (calls) => {
      await closeJobCardOnWebsite("c1");
      assert.equal(calls[0]!.url, "https://api.satopharma.com/api/v1/integrations/jobs/c1");
      assert.equal(calls[0]!.init.method, "PATCH");
      assert.equal(calls[0]!.init.body, JSON.stringify({ status: "CLOSED" }));
    },
  );

  // The guard's read: pages, open cards only, and a failure throws rather than reading as an empty page.
  await withFetch(
    (url) => {
      const page = new URL(url).searchParams.get("page");
      const row = (id: string, status: string) => ({ id, location: "Cairo", slug: id, status, titleEn: id });
      return Response.json({ data: page === "1" ? [row("a", "OPEN"), row("b", "CLOSED")] : [row("c", "OPEN")], error: null, meta: { totalPages: 2 } });
    },
    async () => {
      assert.deepEqual((await readOpenCareersCards()).map((row) => row.id), ["a", "c"]);
    },
  );
  await withFetch(
    () => new Response("no", { status: 503 }),
    async () => {
      await assert.rejects(readOpenCareersCards(), /503/);
    },
  );

  // 🔴 ONLY A PERSON'S PRESS PUBLISHES: the one route is the only caller, with no cron, autopilot or retry.
  const callers = ["app", "src", "scripts"]
    .flatMap((dir) => sourceFiles(dir))
    .filter((file) => !file.endsWith(path.join("job-posts", "website.ts")) && readFileSync(file, "utf8").includes("publishJobCardToWebsite"))
    .map((file) => file.split(path.sep).join("/"));
  assert.deepEqual(callers, ["app/api/recruitment/job-posts/publish/route.ts"]);

  // Both routes narrow to the Super Admin, and the Talent Acquisition seat keeps building and downloading.
  for (const file of ["app/api/recruitment/job-posts/publish/route.ts", "app/api/recruitment/job-posts/close/route.ts"]) {
    const route = readFileSync(file, "utf8");
    assert.match(route, /if \(!canPublishJobPosts\(access\)\)/, `${file} must check the Super Admin gate`);
    assert.match(route, /assertRealSessionForDecision\(access, /, `${file} must refuse a local preview session`);
    assert.ok(
      route.indexOf("assertRealSessionForDecision(access") < route.indexOf("readJsonObject(request)"),
      `${file} must refuse a preview session before it reads the request`,
    );
    assert.match(route, /writeAuditLog\(/, `${file} must leave an audit row`);
  }
  assert.match(readFileSync("src/lib/recruitment/access.ts", "utf8"), /function canPublishJobPosts[^]*?return access\.role === "Super Admin";/);

  // 🔴 A title save carries no Arabic, so it can never wipe what a person typed.
  const store = readFileSync("src/lib/recruitment/job-posts/service.ts", "utf8");
  const toRow = /function toRow[^]*?\n}\n/.exec(store)?.[0] ?? "";
  assert.ok(toRow.length > 0);
  assert.doesNotMatch(toRow, /title_ar|description_ar/);
}
