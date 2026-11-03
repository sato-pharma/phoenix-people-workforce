import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { addDaysIso } from "../src/lib/crm/dates.ts";
import {
  commentFollowUpsOlderNote,
  commentPriceRows,
  commentReadingsFromAnswer,
  commentReadingText,
  commentStockRows,
  COMMENT_PRODUCT_NOT_NAMED,
  COMMENT_READING_BATCH_SIZE,
  openCommentFollowUps,
  readCommentBatches,
  storedMentions,
  type CommentReadingAsk,
  type CommentReadingVisit,
  type StoredCommentReading,
} from "../src/lib/phoenix-crm/comment-reading.ts";
import { UNDATED_COMMITMENT_WINDOW_DAYS } from "../src/lib/phoenix-crm/commitments.ts";

/**
 * Reading visit comments. WHAT EACH SECTION CATCHES, in the words of the change that would break it:
 *
 *  1. A sentence on a screen the rep never wrote, or a product the visit never named.
 *  2. A comment filed as "said nothing" because the model skipped it, so it is never read again.
 *  3. One bad comment holding up the 24 beside it, or an outage burning a whole fire of calls.
 *  4. A reading of a visit the board does not count, or a price sentence reaching the wrong product manager.
 *  5. A follow-up that outlives going back to the customer, or that disappears with nothing said.
 *  6. A reading imported by a KPI, rank, payroll or coaching file, or merged into a counted figure.
 *  7. The table opened to a logged-in user, or test and imported visits sent to the model.
 *  8. The rep's screen naming how the sentence was read, or carrying a count or a verdict.
 */

const COMMENT = "ص وليد لسه مش متوفر فيها  لكن متوفر في ص المسله";

function visit(index: number, comment = `تعليق ${index}`): CommentReadingVisit {
  return { visitId: `visit-${index}`, seatId: "seat-1", visitDate: "2026-11-01", comment, products: ["Royafloxacin"] };
}

function everyItemSaidNothing(batch: ReadonlyArray<{ key: number }>): unknown {
  return { items: batch.map((item) => ({ key: item.key, stock: [], price: [], follow_up: null })) };
}

function reading(visitId: string, overrides: Partial<StoredCommentReading> = {}): StoredCommentReading {
  return { visitId, seatId: "seat-1", visitDate: "2026-11-01", stock: [], price: [], followUp: null, ...overrides };
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

export async function runPhoenixCrmCommentReadingTests() {
  // ── 1. A quote is the rep's own words ──────────────────────────────────────────────────────────
  const batch = [{ key: 0, comment: COMMENT, products: ["Royafloxacin", "Saginko"] }];
  const [kept] = commentReadingsFromAnswer(
    {
      items: [
        {
          key: 0,
          stock: [
            { product: "royafloxacin", quote: "ص وليد لسه مش متوفر فيها لكن" },
            { product: "Royafloxacin", quote: "a sentence the rep never wrote" },
            { product: "Conviban", quote: "لسه مش متوفر فيها" },
          ],
          price: [{ product: null, quote: "غالي جدا" }],
          follow_up: "هتابع معاه",
        },
      ],
    },
    batch,
  );
  assert.deepEqual(
    kept.stock,
    [
      { product: "Royafloxacin", quote: "ص وليد لسه مش متوفر فيها لكن" },
      { product: null, quote: "لسه مش متوفر فيها" },
    ],
    "a quote outside the comment is dropped, spacing is forgiven, and a product the visit never named reads as not named",
  );
  assert.deepEqual(kept.price, [], "a price quote that is not in the comment is dropped");
  assert.equal(kept.followUp, null, "a follow-up that is not in the comment is dropped");

  assert.equal(commentReadingText(" door ", " later "), "door\nlater", "both of the rep's texts are read");
  assert.equal(commentReadingText(null, "  "), "", "no words, nothing to read");
  assert.deepEqual(storedMentions([{ product: "", quote: " x " }, { quote: "" }, "bad"]), [{ product: null, quote: "x" }]);

  // ── 2. A skipped comment stays unread ──────────────────────────────────────────────────────────
  const two = [batch[0], { key: 1, comment: "second", products: [] }];
  const skipped = commentReadingsFromAnswer({ items: [{ key: 1, stock: [], price: [], follow_up: null }, { key: 99, stock: [], price: [], follow_up: null }] }, two);
  assert.deepEqual(skipped.map((result) => result.key), [1], "an item the answer left out comes back as nothing, and an unknown key is ignored");
  assert.deepEqual(commentReadingsFromAnswer(null, two), [], "no answer, no readings");

  // ── 3. Batches, splitting and the outage stop ──────────────────────────────────────────────────
  const fifty = Array.from({ length: 50 }, (_, index) => visit(index));
  const sizes: number[] = [];
  const fine = await readCommentBatches(fifty, async (asked) => {
    sizes.push(asked.length);
    return { answer: everyItemSaidNothing(asked), model: "model-a" };
  });
  assert.deepEqual(sizes, [COMMENT_READING_BATCH_SIZE, COMMENT_READING_BATCH_SIZE]);
  assert.equal(fine.readings.length, 50, "a comment that says nothing still gets a row, so it is not read again");
  assert.equal(fine.readings[0].model, "model-a");

  const poison = "the comment the model cannot answer";
  const split = await readCommentBatches(
    Array.from({ length: 4 }, (_, index) => visit(index, index === 0 ? poison : `تعليق ${index}`)),
    async (asked) => {
      if (asked.some((item) => item.comment === poison) && asked.length > 2) throw new Error("max_tokens");
      return { answer: everyItemSaidNothing(asked.filter((item) => item.comment !== poison)), model: "m" };
    },
  );
  assert.equal(split.readings.length, 3, "a failed batch is split, so the comments beside a bad one are read");
  assert.ok(!split.readings.some((entry) => entry.visitId === "visit-0"), "the bad comment stays unread rather than filed as saying nothing");

  let outageCalls = 0;
  const outage = await readCommentBatches(fifty, async () => {
    outageCalls += 1;
    throw new Error("down");
  });
  assert.ok(outage.failedCalls >= 3 && outageCalls <= 5, `an outage ends the fire early, it took ${outageCalls} calls`);
  assert.equal(outage.readings.length, 0);

  const emptyAnswer = await readCommentBatches([visit(1)], async () => ({ answer: { items: [] }, model: "m" }));
  assert.equal(emptyAnswer.failedCalls, 1, "an answer with no reading in it is a failed call");

  // ── 4. The two boards ──────────────────────────────────────────────────────────────────────────
  const stockVisits = new Map([
    ["a", { customerName: "Dr Hany", territoryName: "Tanta", listType: "PM" as const }],
    ["b", { customerName: "Dr Sara", territoryName: "Tanta", listType: "AM" as const }],
  ]);
  const stock = commentStockRows(
    [
      reading("a", { visitDate: "2026-10-30", stock: [{ product: "Saginko", quote: "مش متوفر" }] }),
      reading("b", { visitDate: "2026-11-02", stock: [{ product: null, quote: "بالنواقص" }] }),
      reading("not-counted", { stock: [{ product: "Saginko", quote: "مش متوفر" }] }),
    ],
    stockVisits,
  );
  assert.deepEqual(stock.map((row) => row.customerName), ["Dr Sara", "Dr Hany"], "newest first, and a visit the board does not count stays off");
  assert.ok(!Object.keys(stock[0]).some((key) => /rep|hr/i.test(key)), "a row carries no rep");

  const priceVisits = new Map([
    ["p", { listType: "PM" as const, speciality: "Internal", area: "Tanta" }],
    ["q", { listType: "AM" as const, speciality: null, area: "Tanta" }],
  ]);
  const priceReadings = [
    reading("p", { price: [{ product: "Saginko", quote: "سعره غالي" }] }),
    reading("q", { price: [{ product: "Saginko", quote: "غالي" }, { product: null, quote: "السعر عالي" }] }),
    reading("not-counted", { price: [{ product: "Saginko", quote: "غالي" }] }),
  ];
  const team = commentPriceRows(priceReadings, priceVisits, { products: null, withArea: true });
  const saginko = team.find((row) => row.product === "Saginko");
  assert.equal(saginko?.am, 1);
  assert.equal(saginko?.pm, 1, "AM and PM stay apart, and an uncounted visit is left out");
  assert.equal(saginko?.quotes[0].area, "Tanta");
  assert.ok(team.some((row) => row.product === COMMENT_PRODUCT_NOT_NAMED));

  const own = commentPriceRows(priceReadings, priceVisits, { products: new Set(["Saginko"]), withArea: false });
  assert.deepEqual(own.map((row) => row.product), ["Saginko"], "a product manager reads only what was said about their own product");
  assert.ok(own[0].quotes.every((quote) => quote.area === null), "and never an area");
  assert.deepEqual(commentPriceRows(priceReadings, priceVisits, { products: new Set(["Other"]), withArea: false }), []);

  // ── 5. A follow-up closes on going back ────────────────────────────────────────────────────────
  const today = "2026-11-03";
  const seen = (visitId: string, customerId: string, visitDate: string, customerName = "Dr Hany") => ({ visitId, customerId, customerName, visitDate, capturedAt: `${visitDate}T10:00:00Z` });
  const open = openCommentFollowUps({
    today,
    followUps: new Map([
      ["old-visit", "هتابع معاه"],
      ["open-visit", "هشوف الزيارة الجاية"],
      ["stale-visit", "هبعتله الداتا"],
      ["nameless-visit", "هتابع"],
    ]),
    visits: [
      seen("old-visit", "went-back", "2026-10-20"),
      seen("later-visit", "went-back", "2026-10-28"),
      seen("open-visit", "waiting", "2026-11-01"),
      seen("stale-visit", "long-ago", addDaysIso(today, -(UNDATED_COMMITMENT_WINDOW_DAYS + 1))),
      seen("nameless-visit", "no-name", "2026-11-01", ""),
    ],
  });
  assert.deepEqual(open.followUps.map((entry) => entry.visitId), ["open-visit"], "a later visit closes it, and a customer with no name is never turned into an id");
  assert.equal(open.older, 1, "one past the window is counted, not silently gone");
  assert.equal(commentFollowUpsOlderNote(0), null);
  assert.match(commentFollowUpsOlderNote(1) ?? "", /^1 more from your comments was written/);

  // ── 6. No counted figure reads it ──────────────────────────────────────────────────────────────
  const allowed = new Set(
    [
      "src/lib/phoenix-crm/comment-reading.ts",
      "src/lib/phoenix-crm/server/comment-reading.ts",
      "src/lib/phoenix-crm/server/insight-reports.ts",
      "src/lib/phoenix-crm/server/commitments.ts",
      "src/lib/phoenix-crm/server/reports-workbook.ts",
      "src/components/phoenix-crm/insight-reports.tsx",
      "src/components/phoenix-crm/commitments-panel.tsx",
      "app/api/cron/phoenix-crm-visit-rollup/route.ts",
    ].map((path) => join(...path.split("/"))),
  );
  const readers = [...sourceFiles("src"), ...sourceFiles("app")].filter((path) => {
    const text = readFileSync(path, "utf8");
    return /phoenix-crm\/(server\/)?comment-reading["']/.test(text) || /phoenix_crm_visit_comment_readings/.test(text);
  });
  assert.deepEqual(readers.filter((path) => !allowed.has(path)), [], "only the two boards, the rep's own notes and the hourly fire read a reading");

  for (const path of ["src/lib/phoenix-crm/field-heard.ts", "src/lib/phoenix-crm/missing-stock.ts", "src/lib/phoenix-crm/objections-by-customer.ts"]) {
    assert.ok(!readFileSync(path, "utf8").includes("comment-reading"), `${path} keeps counting only what was recorded`);
  }

  const server = readFileSync("src/lib/phoenix-crm/server/comment-reading.ts", "utf8");
  assert.ok(server.includes("createOpenAiResponseText"), "every AI call goes through the one door");
  assert.ok(server.includes('component: "phoenix_crm_comment_reading"'), "its cost and failures are answered on their own line");
  assert.ok(!/\.from\("phoenix_crm_visits"\)/.test(server), "it never touches the visit");

  const route = readFileSync("app/api/cron/phoenix-crm-visit-rollup/route.ts", "utf8");
  assert.ok(route.includes('afterResponse("phoenix_crm_comment_reading"'), "it rides the hourly fire after the reply, so it can never fail the roll-up");

  const workbook = readFileSync("src/lib/phoenix-crm/server/reports-workbook.ts", "utf8");
  assert.ok(workbook.includes("`${SECTION_TITLES.stock}, read from comments`") && workbook.includes("Price complaints, read from comments"), "the workbook carries what the screen carries");

  // ── 7. The table and the queue ─────────────────────────────────────────────────────────────────
  const migration = readFileSync("supabase/migrations/20261103091500_phoenix_crm_visit_comment_readings.sql", "utf8");
  assert.match(migration, /alter table public\.phoenix_crm_visit_comment_readings enable row level security/);
  assert.match(migration, /revoke all on table public\.phoenix_crm_visit_comment_readings from public, anon, authenticated/);
  assert.deepEqual([...migration.matchAll(/for all to (\w+)/g)].map((match) => match[1]), ["service_role"], "no logged-in user reads a reading directly");
  assert.equal((migration.match(/create policy/gi) ?? []).length, 1, "the service role's policy is the only one");
  assert.match(migration, /revoke execute on function public\.phoenix_crm_comment_reading_queue\(integer\) from public, anon, authenticated/);
  assert.match(migration, /v\.is_test = false/);
  assert.match(migration, /v\.imported_from_ireports360_at is null/);
  assert.match(migration, /after update of comment, detail_comment on public\.phoenix_crm_visits/);
  assert.match(migration, /old\.comment is distinct from new\.comment or old\.detail_comment is distinct from new\.detail_comment/);

  // ── 8. The rep's screen ────────────────────────────────────────────────────────────────────────
  const panel = readFileSync("src/components/phoenix-crm/commitments-panel.tsx", "utf8");
  const section = panel.slice(panel.indexOf("function CommentFollowUps"), panel.indexOf("export function useCommitments"));
  assert.ok(section.length > 0);
  assert.ok(!/\b(AI|automatic|automatically|read from|model|detected)\b/i.test(section), "the rep's screen never names how the sentence was read");
  assert.ok(!/\.length|overdue|missed|kept|score/i.test(section), "and carries no count and no verdict");
  const commitmentsServer = readFileSync("src/lib/phoenix-crm/server/commitments.ts", "utf8");
  assert.ok(commitmentsServer.includes("territoryForRepWrite(viewer, raw.seatId"), "a follow-up is behind the rep's own seat gate");
}
