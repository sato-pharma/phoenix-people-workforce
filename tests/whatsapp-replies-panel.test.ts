import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createAccessContext, phoenixRoles, type PhoenixRole } from "../src/lib/auth/permissions.ts";
import { canViewWhatsAppOutboundLog } from "../src/lib/recruitment/access.ts";
import { recruitmentHiringPageItems } from "../src/config/system-navigation.ts";

// The panel that answers "show me the reply that went out" without anyone running a query.
//
// The log table shipped on 2026-08-30; the owner's next move was to run a psql command to read it,
// which could not connect — there is no local database. A record nobody can open is only half an
// answer, so this is the screen that reads it back.
//
// Four things can silently regress, and each one turns the page into a confident lie:
//
//   1. AN EMPTY LOG READS AS HEALTHY. This is the one that has already happened here, on the
//      neighbouring page: during the 2026-08-01 WhatsApp outage intake-health reported a perfect
//      score right through a total outage, because nothing had been enqueued and so nothing had
//      failed. Zero replies against zero arrivals is a quiet line; zero replies against real
//      arrivals is an alarm. The page must not render the calm wording for the second case.
//   2. A FAILED QUERY READS AS SILENCE. The writer module never throws, on purpose — an audit row
//      is not worth an applicant's reply. A READER that swallowed its error would render "nothing
//      went out" over a broken database, which is the exact confusion the panel exists to end.
//   3. THE MESSAGE IS SHORTENED. A reply you can only read half of answers nothing, and the owner's
//      standing rule forbids ellipsis truncation outright.
//   4. THE GATE WIDENS. The table holds applicants' phone numbers next to what was said to them.

const ROOT = new URL("../", import.meta.url);
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, ROOT)), "utf8");

const VIEW_SOURCE = read("src/components/recruitment/whatsapp-replies-view.tsx");
const PAGE_SOURCE = read("app/(admin)/recruitment/whatsapp-replies/page.tsx");
const READER_SOURCE = read("src/lib/recruitment/inbound/whatsapp-outbound-report.ts");
const WRITER_SOURCE = read("src/lib/recruitment/inbound/whatsapp-outbound-log.ts");
const MIGRATION_SOURCE = read("supabase/migrations/20260830124500_whatsapp_outbound_message_log.sql");

export async function runWhatsAppRepliesPanelTests(): Promise<void> {
  // ── 1. HEADLINE: an empty log cannot read as healthy when messages arrived ──
  // Break the fix — collapse the two branches into one calm sentence — and this is what fires.
  assert.match(
    VIEW_SOURCE,
    /rows\.length === 0[\s\S]{0,1400}?inboundSinceLogging === 0/,
    "the empty state must branch on how many messages arrived, not just on rows.length. No replies " +
      "AND no arrivals is a quiet line; no replies against real arrivals is an alarm, and rendering " +
      "the reassuring wording for both is the 2026-08-01 outage failure repeated on a new page.",
  );

  // ── 1b. …and the alarm must not fire on messages that predate the record ───
  // Found by opening the page rather than by reading it: the first render held four real inbound
  // messages from the preceding weeks against a log a few hours old and announced that Phoenix had
  // replied to none of them. An inbound message from before the table existed cannot have a row
  // however well the reply worked, so comparing across that boundary manufactures an alarm out of
  // the log's own youth — and an alarm that cries wolf on day one is one nobody reads on day thirty.
  assert.ok(
    !/inboundInWindow === 0 \? \(/.test(VIEW_SOURCE),
    "the alarm branch must key on inboundSinceLogging, never on the raw window count",
  );
  assert.match(
    READER_SOURCE,
    /export const OUTBOUND_LOG_LIVE_SINCE = "20\d\d-\d\d-\d\dT/,
    "the reader must name the instant the log went live",
  );
  assert.match(
    READER_SOURCE,
    /\.gte\("created_at", comparableSince\)/,
    "and the comparable inbound count must be floored at it",
  );
  assert.match(
    READER_SOURCE,
    /since > OUTBOUND_LOG_LIVE_SINCE \? since : OUTBOUND_LOG_LIVE_SINCE/,
    "and take the LATER of the two boundaries, so a short window is not widened back past the log",
  );
  assert.match(
    VIEW_SOURCE,
    /That is not a quiet line/,
    "the alarm branch must say plainly that this is NOT normal — a neutral 'no replies yet' reads " +
      "as reassurance, which is the whole defect",
  );
  assert.match(
    VIEW_SOURCE,
    /That is a quiet channel, not a fault/,
    "and the genuinely-quiet branch must say so, or a silent line reads as a broken one",
  );

  // ── 2. The reader surfaces a failure; the writer still swallows one ─────────
  // Two modules with opposite duties on the same table. Both halves asserted, because the whole
  // reason for the split is that satisfying one rule in the wrong file breaks the other.
  assert.match(
    READER_SOURCE,
    /if \(result\.error\) throw result\.error/,
    "getWhatsAppOutboundReport must throw on a query error. A reader that returned [] would render " +
      "'nothing went out' over a broken database.",
  );
  assert.ok(
    !/throw /.test(WRITER_SOURCE),
    "the WRITE module must still throw nothing at all — an audit row is never worth costing an " +
      "applicant their reply. If the reader was added to that file instead, this is what fails.",
  );
  assert.match(
    PAGE_SOURCE,
    /catch \(error\)[\s\S]{0,600}?WhatsApp replies unavailable/,
    "and the page must render that failure as an error state, not as an empty list",
  );

  // ── 3. The message is shown whole ──────────────────────────────────────────
  assert.match(
    VIEW_SOURCE,
    /whitespace-pre-wrap/,
    "the body must keep the line breaks the recipient saw",
  );
  assert.ok(
    !/\btruncate\b/.test(VIEW_SOURCE),
    "no truncate class anywhere in this view — the owner's standing rule forbids ellipsis " +
      "truncation, and a half-shown reply answers nothing",
  );
  assert.ok(
    !VIEW_SOURCE.includes("…") && !/\.slice\(0,\s*\d+\)/.test(VIEW_SOURCE),
    "and no ellipsis character or hand-rolled substring either",
  );

  // ── 3b. Bilingual bodies: direction is decided PER LINE ────────────────────
  // Found by looking at the rendered page at 375px, not by reading the source. Every reply this
  // line sends is Arabic followed by the same text in English, so the message contains both
  // directions and neither one can be a property of the block:
  //
  //   no dir at all      -> the Arabic renders against the reader (what this panel first shipped)
  //   dir="auto" on <p>  -> the first strong character is Arabic, the whole block turns RTL, and
  //                         the ENGLISH half breaks: "Thanks for contacting Sato Pharma." renders
  //                         as ".Thanks for contacting Sato Pharma"
  //
  // Both were measured in a 375px harness against the real message templates. Per line is the only
  // arrangement that is right for both halves, and it is what WhatsApp showed the recipient.
  assert.match(
    VIEW_SOURCE,
    /body\.split\("\\n"\)/,
    "the message body must be split into lines so each can carry its own direction — a single " +
      "block cannot be both RTL and LTR, and every reply this line sends is both",
  );
  // Counted against the CODE, not the prose: the comment above the component names the wrong fix
  // in order to warn against it, and a naive count reads that warning as the defect it describes.
  const VIEW_CODE = VIEW_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.equal(
    (VIEW_CODE.match(/dir="auto"/g) ?? []).length,
    1,
    'exactly one dir="auto" in the code, and it belongs on the per-line element. Putting it on the ' +
      "paragraph instead turns the whole bilingual message RTL and renders the English half " +
      "backwards — the mirror image of the bug this replaced.",
  );
  assert.match(
    VIEW_SOURCE,
    /className="block whitespace-pre-wrap break-words"\s*\n?\s*dir="auto"/,
    'the dir="auto" must sit on the same per-line span that carries whitespace-pre-wrap and ' +
      "break-words, or the line keeps its direction but loses its line breaks or its wrapping",
  );
  assert.match(
    VIEW_SOURCE,
    /line === "" \? " " : line/,
    "an empty line must still occupy a line box, or the blank the sender put between the Arabic " +
      "and the English collapses and the two halves run together",
  );

  // ── 4. Cairo time, never a raw UTC string ──────────────────────────────────
  assert.match(
    VIEW_SOURCE,
    /timeZone: "Africa\/Cairo"/,
    "every moment shown to a person is Cairo local time (AGENTS.md §4)",
  );

  // ── 5. The gate admits exactly the two seats, and is checked before the read ─
  const allowed = phoenixRoles.filter((role: PhoenixRole) =>
    canViewWhatsAppOutboundLog(createAccessContext({ hrId: "HR-PANEL-TEST", role })),
  );
  assert.deepEqual(
    [...allowed].sort(),
    ["HR Advisory", "Super Admin"],
    "this table holds applicants' phone numbers next to what was said to them. Exactly the two " +
      `seats that work the pipeline may read it. Got: ${allowed.join(", ")}`,
  );
  // Called BEFORE any data is fetched — a gate below the read has already leaked a query's worth
  // of work, and in this repo a filter below the gate is a recorded defect class.
  const gateAt = PAGE_SOURCE.indexOf("canViewWhatsAppOutboundLog(access)");
  const readAt = PAGE_SOURCE.indexOf("getWhatsAppOutboundReport(");
  assert.ok(gateAt > 0 && readAt > 0 && gateAt < readAt, "the permission check must precede the read");

  // ── 6. Every failure the DB can store has words on the screen ──────────────
  // Coupled to the migration's own CHECK rather than to a copy of the list: add a fifth reason to
  // the constraint without giving it a sentence, and the row renders a bare "Not sent" that
  // explains nothing.
  const check = /failure_reason in \(([^)]*)\)/.exec(MIGRATION_SOURCE);
  assert.ok(check, "the migration must still constrain failure_reason to a known set");
  const reasons = [...check[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(reasons.length >= 4, `expected the four known failure reasons, found ${reasons.length}`);
  for (const reason of reasons) {
    assert.ok(
      VIEW_SOURCE.includes(`"${reason}"`),
      `failure reason "${reason}" is storable but the panel has no sentence for it — it would ` +
        "render as a bare 'Not sent', which tells the reader nothing",
    );
  }

  // ── 7. The card is on the hub and it opens ─────────────────────────────────
  const card = recruitmentHiringPageItems.find((item) => item.href === "/recruitment/whatsapp-replies");
  assert.ok(card, "the panel must be offered on the Recruitment & Hiring hub, or nobody can reach it");
  assert.ok(
    existsSync(fileURLToPath(new URL("app/(admin)/recruitment/whatsapp-replies/page.tsx", ROOT))),
    "and the card must open a page that exists",
  );

  // ── 8. Read-only by construction ───────────────────────────────────────────
  // An audit trail with an edit button is a weaker one. No client bundle, no fetch, no form.
  assert.ok(
    !VIEW_SOURCE.includes("use client") && !/fetch\(/.test(VIEW_SOURCE),
    "the view stays a server component with no write path — this is a record, not a workspace",
  );
}
