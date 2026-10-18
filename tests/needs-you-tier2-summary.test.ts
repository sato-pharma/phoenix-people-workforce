import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { buildNeedsYouDailyMessage } from "../src/lib/needs-you/deliver/daily.ts";
import { NEEDS_YOU_SUMMARY_MODEL, summarizeNeedsYouBoard, summaryFactsFrom } from "../src/lib/needs-you/ai/summarize.ts";
import { SUMMARY_JSON_WORD, SUMMARY_MAX_CHARS, buildSummaryPrompt } from "../src/lib/needs-you/ai/summary.ts";
import { TELEGRAM_BUDGET } from "../src/lib/needs-you/render/telegram.ts";
import { needsYouSourceIds, type NeedsYouBoard, type NeedsYouItem } from "../src/lib/needs-you/types.ts";

import { stripComments } from "./support/comment-strip.ts";

/**
 * 🔴 THE SUMMARY MUST NEVER COST HIM THE BOARD. That is the defect switching tier 2 on actually
 * found, and it is assertion 1.
 *
 * `buildNeedsYouDailyMessage` prepends the lead OUTSIDE the budget the body is built to. Measured
 * 2026-09-28 before the fix: a 12-item board renders 739 characters, and a maximum-length
 * 220-character summary in front of it made 961 — past Telegram's 900, which slices from the END,
 * mid-word, with no marker. The summary would have pushed the BOARD off the bottom of its own
 * digest: the one feature meant to help him read the board faster would have been the thing hiding
 * it, and nothing would have reported it.
 *
 * 🔴 AND NOTHING HERE MAY REACH THE NETWORK. `tests/` runs with PRODUCTION credentials and
 * APP_ENV=production, so `hasAiApiKey()` is true in the suite — a test that exercised the
 * happy path of `summarizeNeedsYouBoard` would make a real, billed OpenAI call on every CI run.
 * Only the two arms that return BEFORE the call are exercised live; the rest is read from source.
 * Never "improve" this file by feeding it a board with items and no unreadable source.
 *
 * WHAT EACH ASSERTION CATCHES, in the words of the change that would break it:
 *
 *  1. A lead that pushes the board past Telegram's real ceiling.
 *  2. The model being shown a verdict, a failure count, or anything but the waiting items.
 *  3. A token spent on a day that can never get a summary anyway.
 *  4. The nano default, or the 25s timeout calibrated for it.
 *  5. Telemetry recorded against the shared client instead of this feature.
 *  6. A refusal swallowed, so a summary that quietly stopped appearing reads as a quiet week.
 *  7. The word "json" leaving the INPUT, which is a 400 on every call and no summary at all.
 */

const repoRoot = path.resolve(import.meta.dirname, "..");
const SUMMARIZE = "src/lib/needs-you/ai/summarize.ts";
const DAILY = "src/lib/needs-you/deliver/daily.ts";
const read = (rel: string) => stripComments(readFileSync(path.join(repoRoot, rel), "utf8"));

function item(key: string, label: string): NeedsYouItem {
  return {
    ageDays: null, count: 1, externalUrl: null, href: "/admin/needs-you", key, kind: "approval",
    label, lane: "yours", note: null, oldestAt: null, overdue: false, people: [],
    sourceId: "action-inbox",
  } as NeedsYouItem;
}

function board(over: Partial<NeedsYouBoard> = {}): NeedsYouBoard {
  return {
    allClearProvable: false,
    generatedAt: "2026-09-28T04:36:00.000Z",
    notProven: [],
    someoneElse: [],
    sources: needsYouSourceIds.map((id) => ({ id, label: id, status: "ok" as const, because: null, itemCount: 0 })),
    worthKnowing: [],
    yours: [],
    ...over,
  };
}

export async function runNeedsYouTier2SummaryTests() {
  // 1 — THE ONE THAT MATTERS: a maximum-length lead never costs the board its ceiling.
  {
    // 🔴 TWENTY, NOT TWELVE, AND THE NUMBER IS LOAD-BEARING. Measured 2026-09-28 with the reserve
    // removed: 12 items reaches 889 characters — UNDER the 900 ceiling, so a twelve-item fixture
    // passes whether the fix is present or not and proves nothing. The board saturates at 20, where
    // the same break produces 1053. A fixture that cannot reach the ceiling cannot test it.
    const full = board({
      yours: Array.from({ length: 20 }, (_, i) => item(`y-${i}`, `item ${i} waiting on a decision only you can make`)),
    });
    const lead = "X".repeat(SUMMARY_MAX_CHARS);
    const withLead = buildNeedsYouDailyMessage({ board: full, boardUrl: "/admin/needs-you", summaryLead: lead });
    const without = buildNeedsYouDailyMessage({ board: full, boardUrl: "/admin/needs-you" });

    assert.ok(
      withLead.length <= TELEGRAM_BUDGET,
      `a ${SUMMARY_MAX_CHARS}-character summary took the message to ${withLead.length}, past Telegram's ` +
        `${TELEGRAM_BUDGET}. Telegram slices from the END with no marker, so the overflow is the BOARD — ` +
        "the summary would hide the very thing it is meant to introduce.",
    );
    assert.ok(withLead.startsWith(lead), "the lead is a prefix and nothing else");
    assert.ok(
      without.length <= TELEGRAM_BUDGET,
      "the board alone must also fit, or the reserve is hiding a pre-existing overflow",
    );
    assert.doesNotMatch(withLead, /…/, "nothing printed may carry an ellipsis");
  }

  // 2 — the model sees the items and NOTHING else.
  {
    const facts = summaryFactsFrom(
      board({
        notProven: [{ id: "payroll-publish", label: "Payroll", because: "it did not answer" }],
        yours: [item("a", "one thing")],
        worthKnowing: [item("w", "context")],
      }),
    );
    assert.deepEqual(
      Object.keys(facts).sort(),
      ["items", "notProvenCount"],
      "the facts handed to tier 2 must carry the items and the refusal counter and nothing else — no " +
        "verdict and no lane it could reassure about",
    );
    assert.equal(facts.items.length, 1, "only the WAITING items reach the model");
    assert.equal(facts.notProvenCount, 1, "the refusal counter is counted, and it is never sent to the model");
  }

  // 3 — the two days that can never get a summary spend no tokens. These are the ONLY arms run
  //     live here: both return before any network call, and the suite holds real credentials.
  {
    const blind = await summarizeNeedsYouBoard(
      board({
        notProven: [{ id: "resignations", label: "Resignations", because: "it did not answer" }],
        yours: [item("a", "one thing")],
      }),
    );
    assert.equal(blind.lead, null, "a day with an unreadable source never gets a written summary");
    assert.match(String(blind.because), /could not be read/i, "and it says why");

    const quiet = await summarizeNeedsYouBoard(board({ yours: [] }));
    assert.equal(quiet.lead, null, "a day with nothing waiting has nothing to lead with");
    assert.match(String(quiet.because), /nothing is waiting/i, "and it says why");

    const src = read(SUMMARIZE);
    const guardAt = src.indexOf("notProvenCount > 0 || facts.items.length === 0");
    // The CALL, not the import — `createOpenAiResponseText` also appears in the import line at the
    // top of the file, which sits above every guard and would make this comparison always true.
    const callAt = src.indexOf("await createOpenAiResponseText(");
    assert.ok(guardAt >= 0 && callAt >= 0, `${SUMMARIZE}: the refusal guard and the call must both be present`);
    assert.ok(
      guardAt < callAt,
      `${SUMMARIZE}: the refusal must be checked BEFORE the call, or a day that can never get a ` +
        "summary still pays for one",
    );
  }

  // 4 — gpt-5.4, and a timeout that is not the nano-tier default.
  {
    assert.equal(NEEDS_YOU_SUMMARY_MODEL, "gpt-5.4", "the owner chose a strong model; cheapness comes from the cadence");
    const src = read(SUMMARIZE);
    assert.match(src, /model: NEEDS_YOU_SUMMARY_MODEL/, `${SUMMARIZE}: the call must use that model`);
    assert.match(
      src,
      /timeoutMs: OPENAI_ROUTE_BUDGET_MS/,
      `${SUMMARIZE}: the timeout must be passed explicitly. The client's default is calibrated for the ` +
        "fast nano tier and its own comment records a gpt-5.4 call exceeding it in production.",
    );
  }

  // 5 — telemetry lands on this feature, not the shared client.
  {
    assert.match(
      read(SUMMARIZE),
      /component: "needs_you_summary"/,
      `${SUMMARIZE}: without its own component the cost and the out-of-credit alarm are attributed to ` +
        "the shared OpenAI client, and a per-feature cost question becomes unanswerable",
    );
  }

  // 6 — a real failure is PRINTED; the two "nothing to say" refusals are not.
  {
    const src = read(DAILY);
    assert.match(
      src,
      /summaryDroppedNotice\(/,
      `${DAILY}: a refusal other than "nothing to say" must be printed. Silent degradation is what hid ` +
        "the masked-key defect for days — a summary that quietly stops appearing reads as a quiet week.",
    );
    assert.match(src, /silentRefusals/, `${DAILY}: the two no-op refusals must be excluded by name, not by guesswork`);
    assert.ok(
      src.includes("a source could not be read, so no summary was attempted") &&
        src.includes("nothing is waiting, so there is nothing to lead with"),
      `${DAILY}: the silent refusals must match summary.ts's own wording exactly, or a reworded refusal ` +
        "starts being printed as though it were a failure",
    );
  }

  // 7 — THE INPUT CARRIES THE WORD "json". The Responses API refuses `text.format: json_object`
  //     with a 400 unless the word appears in the INPUT messages; `instructions` does not count,
  //     however many times it says JSON. Every production run from the feature shipping on
  //     2026-09-28 to the fix returned exactly that 400 in about a second, so tier 2 produced no
  //     summary at all and three mornings printed the dropped-summary notice instead of a lead.
  {
    const { input, instructions } = buildSummaryPrompt({
      items: [{ name: "Anti Infective closing", reason: "not published" }],
      notProvenCount: 0,
    });
    assert.match(
      input,
      /json/i,
      "the prompt INPUT must contain the word \"json\". Without it OpenAI answers 400 " +
        "(\"Response input messages must contain the word 'json' in some form to use 'text.format' of " +
        "type 'json_object'\") on every single call, and the written summary never appears — the " +
        "instructions saying JSON does not satisfy it.",
    );
    assert.ok(
      input.includes(SUMMARY_JSON_WORD),
      "the carrier line must be the exported constant, so rewording it cannot quietly drop the word",
    );
    assert.match(instructions, /json/i, "the instructions still state the shape that is wanted");
    // The word is all that is added: no count, no verdict, no lane the model could reassure about.
    assert.doesNotMatch(input, /notProven|verdict|all clear|nothing/i, "assertion 2's boundary still holds");
  }
}
