import assert from "node:assert/strict";

import { getMappedAgentHrIds } from "../src/lib/crm/reads.ts";
import { canonicalHrIdKey } from "../src/lib/hr-id.ts";

// `getMappedAgentHrIds` answers "which of these people has ANY visit" — the DSM no-record connector
// asks it before charging a manager, the probation dashboard before badging a rep "CRM-unmapped".
// It used to page through every visit those people ever made, `order=id` with an `id > cursor`
// keyset, to learn which had one: for the connector's 74 reps on 28 Oct 2026 that was 81,119 rows,
// 82 pages, about 72,000 buffer reads a page — about 27 seconds of database time for 67 names. It
// now asks the vendor half for ONE row per person and the Phoenix half once for everybody still
// unanswered (production, same day: 67 = 67 names, md5-identical, about 1,400 buffer reads).
//
// This suite drives the real function against an in-memory `crm_visits_unified` behind a stubbed
// `fetch`, and pins both halves of that: the ANSWER (one spelling per person found, nobody else,
// the date bound honoured) and the SHAPE of every question asked (a one-row probe per person on the
// vendor half, a shrinking question on the rest, never an ordered or keyset walk). The client is
// pointed at a fake address for the duration, so no request can reach a real database even if the
// stub were bypassed; the real environment is put back afterwards, and getSupabaseAdmin() rebuilds
// its memoized client for the restored address on its next call.

const FAKE_URL = "https://mapped-agents.supabase.test";
const VENDOR = "ireports360";

type Visit = { agent_hr_id: string; source: string; visit_date: string };

type Question = {
  url: URL;
  source: { op: string; value: string } | null;
  spellings: string[];
  limit: number | null;
  notAfter: string | null;
};

function readQuestion(url: URL): Question {
  const source = url.searchParams.get("source");
  const hrIds = url.searchParams.get("agent_hr_id") ?? "";
  const limit = url.searchParams.get("limit");
  const date = url.searchParams.get("visit_date");
  assert.ok(hrIds.startsWith("in.(") && hrIds.endsWith(")"), `every question names its people with an in-list: ${url.search}`);
  return {
    url,
    source: source ? { op: source.slice(0, source.indexOf(".")), value: source.slice(source.indexOf(".") + 1) } : null,
    spellings: hrIds
      .slice(4, -1)
      .split(",")
      .map((value) => value.replace(/^"(.*)"$/, "$1")),
    limit: limit === null ? null : Number(limit),
    notAfter: date?.startsWith("lte.") ? date.slice(4) : null,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Rows of the fake view, in storage order, exactly as PostgREST would filter and cap them. */
function answerFrom(visits: readonly Visit[], question: Question): Response {
  const rows = visits.filter((visit) => {
    if (!question.spellings.includes(visit.agent_hr_id)) return false;
    if (question.source?.op === "eq" && visit.source !== question.source.value) return false;
    if (question.source?.op === "neq" && visit.source === question.source.value) return false;
    if (question.notAfter && visit.visit_date > question.notAfter) return false;
    return true;
  });
  return json(rows.slice(0, question.limit ?? rows.length).map((visit) => ({ agent_hr_id: visit.agent_hr_id })));
}

async function withFakeView<T>(
  visits: readonly Visit[],
  run: (questions: Question[]) => Promise<T>,
  answer: (question: Question) => Response = (question) => answerFrom(visits, question),
): Promise<T> {
  const saved = {
    fetch: globalThis.fetch,
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  process.env.NEXT_PUBLIC_SUPABASE_URL = FAKE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role-key";
  const questions: Question[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.origin, FAKE_URL, "the reader must only ever reach the fake database");
    assert.equal(url.pathname, "/rest/v1/crm_visits_unified", "the reader asks the visits door, nothing else");
    const question = readQuestion(url);
    questions.push(question);
    // A question that never shrinks would loop for ever; fail here, in the words of the defect.
    assert.ok(questions.length <= 100, `the reader asked ${questions.length} questions — it is not converging`);
    return answer(question);
  }) as typeof fetch;
  try {
    return await run(questions);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url;
    if (saved.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
  }
}

function people(values: readonly string[]): string[] {
  return values.map((value) => canonicalHrIdKey(value) ?? "").sort();
}

function visits(agent: string, source: string, date: string, count: number): Visit[] {
  return Array.from({ length: count }, () => ({ agent_hr_id: agent, source, visit_date: date }));
}

// Storage order matters: the 2,500 Phoenix rows of PD-0021 sit before CN-0009's two, so the first
// Phoenix page comes back FULL of one person and the reader has to ask again for the rest.
const VIEW: Visit[] = [
  ...visits("AI-0005", VENDOR, "2026-09-14", 40),
  ...visits("ai-0005", VENDOR, "2026-10-02", 3),
  ...visits("AI-0022", VENDOR, "2026-11-05", 12),
  ...visits("pd-0021", "phoenix", "2026-10-20", 2_500),
  ...visits("CN-0009", "phoenix", "2026-10-21", 2),
  // Somebody nobody asked about, on both halves: must never be answered.
  ...visits("B-40", VENDOR, "2026-10-01", 30),
  ...visits("B-40", "phoenix", "2026-10-01", 30),
];

// Two spellings of one person, and a person with no visit at all.
const ASKED = ["AI-0005", "ai-0005", "AI-0022", "PD-0021", "cn-0009", "B-7"];

function assertNoWalk(questions: readonly Question[]) {
  for (const question of questions) {
    assert.equal(question.url.searchParams.get("order"), null, `no question may sort — an ordered read cannot stop early: ${question.url.search}`);
    assert.equal(question.url.searchParams.get("id"), null, `no question may keyset on id — that is the every-visit walk: ${question.url.search}`);
  }
}

function personOf(question: Question): Set<string> {
  return new Set(question.spellings.map((spelling) => canonicalHrIdKey(spelling) ?? ""));
}

export async function runCrmMappedAgentHrIdsTests() {
  // ── Unbounded (the probation badge): everyone with any visit, once each ──────────────────────
  await withFakeView(VIEW, async (questions) => {
    const found = await getMappedAgentHrIds(ASKED);
    assert.deepEqual(people(found), ["ai-0005", "ai-0022", "cn-0009", "pd-0021"], "everybody with a visit, nobody without, nobody unasked");
    assert.equal(new Set(people(found)).size, found.length, "ONE spelling per person found, never one per stored spelling");

    const vendor = questions.filter((question) => question.source?.op === "eq");
    const rest = questions.filter((question) => question.source?.op === "neq");
    assert.equal(vendor.length + rest.length, questions.length, "every question names its half of the view by source");
    assert.equal(vendor.length, 5, "one vendor probe per PERSON — two spellings of AI-0005 are one probe");
    for (const probe of vendor) {
      assert.equal(probe.source?.value, VENDOR);
      assert.equal(probe.limit, 1, `a vendor probe asks for ONE row: ${probe.url.search}`);
      assert.equal(personOf(probe).size, 1, `a vendor probe names one person's spellings: ${probe.spellings.join(",")}`);
    }
    assert.deepEqual([...new Set(vendor.flatMap((probe) => [...personOf(probe)]))].sort(), ["ai-0005", "ai-0022", "b-7", "cn-0009", "pd-0021"]);

    assert.equal(rest.length, 2, "the Phoenix half: one full page of PD-0021, then one short page for the rest");
    for (const question of rest) assert.equal(question.source?.value, VENDOR);
    assert.deepEqual([...personOf(rest[0])].sort(), ["b-7", "cn-0009", "pd-0021"], "the Phoenix half is asked only about people the vendor half did not answer");
    assert.deepEqual([...personOf(rest[1])].sort(), ["b-7", "cn-0009"], "the next question drops whoever the full page answered");
    assertNoWalk(questions);
  });

  // ── Bounded (the DSM connector, a closed month): a visit after the bound does not count ───────
  await withFakeView(VIEW, async (questions) => {
    const found = await getMappedAgentHrIds(ASKED, { notAfterDate: "2026-10-31" });
    assert.deepEqual(
      people(found),
      ["ai-0005", "cn-0009", "pd-0021"],
      "AI-0022's only visits fall after the month — onboarding later must never rewrite a closed month",
    );
    for (const question of questions) assert.equal(question.notAfter, "2026-10-31", `every question carries the bound: ${question.url.search}`);
    assertNoWalk(questions);
  });

  // ── Nothing to ask: no question at all ───────────────────────────────────────────────────────
  await withFakeView(VIEW, async (questions) => {
    assert.deepEqual(await getMappedAgentHrIds([]), []);
    assert.deepEqual(await getMappedAgentHrIds(["", "   "]), []);
    assert.equal(questions.length, 0, "blank ids are nobody, and nobody costs no request");
  });

  // ── A missing view is "not provisioned" ([]), any other failure is loud ──────────────────────
  await withFakeView(VIEW, async () => {
    assert.deepEqual(await getMappedAgentHrIds(ASKED), [], "a missing view reads as nobody mapped, as before");
  }, () => json({ code: "PGRST205", message: "Could not find the table 'public.crm_visits_unified' in the schema cache" }, 404));

  await withFakeView(VIEW, async () => {
    await assert.rejects(getMappedAgentHrIds(ASKED), /statement timeout/, "a real failure must never read as 'nobody has a visit'");
  }, () => json({ code: "57014", message: "canceling statement due to statement timeout" }, 500));

  // ── A full page that answers nobody fails instead of asking the same question for ever ───────
  await withFakeView(VIEW, async () => {
    await assert.rejects(getMappedAgentHrIds(["PD-0021"]), /a full page answered nobody/);
  }, (question) =>
    question.source?.op === "eq" ? json([]) : json(Array.from({ length: question.limit ?? 1 }, () => ({ agent_hr_id: "B-40" }))),
  );
}
