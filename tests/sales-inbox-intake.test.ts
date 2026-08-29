import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createCursorTracker } from "../src/lib/sales/inbox/cursor-advance.ts";
import {
  MAX_ARRIVAL_BYTES,
  countOversizeWorkbooks,
  pickWorkbookAttachments,
  sanitizeArrivalFileName,
  type MailAttachment,
} from "../src/lib/sales/inbox/attachments.ts";
import { parseSalesEmailInboxesConfig } from "../src/lib/sales/inbox/mailboxes-config.ts";

/**
 * The sales mailbox intake reads distributor workbooks out of a company mailbox and parks them for
 * a person to import. Two properties are worth a test, and everything else here supports them.
 *
 * THE HEADLINE — a message that could not be recorded must never be stepped over. The bytes of a
 * distributor's monthly file exist in exactly one place the machine can see: that message. Advance
 * the cursor past it and the file is gone with no record anywhere that it ever arrived — during a
 * close, that is a distributor's entire month silently missing from a published closing. The
 * opposite mistake is equally real and this repo has already paid for it: stopping the whole folder
 * on one bad message left the notification outbox dead for thirteen days behind fifty exhausted
 * rows, green the entire time. So the loop continues and the cursor holds, and those are separate
 * assertions below because they are separate failures.
 *
 * THE SECOND — this job never imports anything. An arrival is a file and a guess at who sent it.
 * The monthly closing is the most consequential number this company publishes, and an auto-import
 * would put the one step nobody ever looked at directly underneath it.
 */

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

/** Source with comments removed.
 *
 *  Not a nicety. These files DOCUMENT what they refuse to do — "IT NOTIFIES NOBODY. No mail, no
 *  in-app, no Telegram, no push" is a sentence in the cron route — so a naive grep for `telegram`
 *  fails on the very prose that promises the opposite. A test that reads a docstring as if it were
 *  a call site is a test that will one day be "fixed" by deleting the explanation. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function workbook(name: string, bytes: number, extra: Partial<MailAttachment> = {}): MailAttachment {
  return { content: Buffer.alloc(bytes, 1), filename: name, ...extra };
}

export function runSalesInboxIntakeTests() {
  // ── THE HEADLINE: the cursor holds at the first failure ──────────────────────────────────────
  {
    const cursor = createCursorTracker(100);
    cursor.succeeded(101);
    cursor.succeeded(102);
    cursor.failed(103);
    cursor.succeeded(104);
    cursor.succeeded(105);

    assert.equal(
      cursor.lastProcessedUid(),
      102,
      "a message that failed must hold the cursor behind it — persisting 105 would step over 103 and lose that distributor's workbook with no record it ever arrived",
    );
    assert.equal(cursor.stalledAtUid(), 103, "the failed UID must be reported so it is visible, not merely re-read forever in silence");
  }

  // The other half of the same rule: holding the cursor must NOT mean refusing to read on. The
  // later messages are still recorded in this run; only the cursor is frozen.
  {
    const cursor = createCursorTracker(0);
    cursor.failed(7);
    cursor.succeeded(8);
    assert.equal(cursor.stalledAtUid(), 7, "the stall point stays at the first failure");
    assert.equal(cursor.lastProcessedUid(), 0, "the cursor stays behind the failure even though later messages succeeded");
    const source = codeOnly(readSource("../src/lib/sales/inbox/poller.ts"));
    assert.ok(
      /for \(const uid of plan\.uids\)/.test(source),
      "the poller must iterate every planned UID",
    );
    assert.ok(
      !/\bbreak\b/.test(source.slice(source.indexOf("for (const uid of plan.uids)"))),
      "the message loop must never break out on a failure — that is the head-of-line block that left the notification outbox dead for 13 days",
    );
  }

  // A second failure must not move the stall point, in either direction.
  {
    const cursor = createCursorTracker(0);
    cursor.failed(20);
    cursor.failed(5);
    cursor.failed(90);
    assert.equal(cursor.stalledAtUid(), 20, "only the FIRST failure pins the cursor");
    assert.equal(cursor.lastProcessedUid(), 0, "nothing after a failure may advance the cursor");
  }

  // A clean run advances to the highest UID seen, and out-of-order UIDs cannot drag it backwards.
  {
    const cursor = createCursorTracker(50);
    cursor.succeeded(52);
    cursor.succeeded(51);
    assert.equal(cursor.lastProcessedUid(), 52, "a clean run advances to the highest UID handled");
    assert.equal(cursor.stalledAtUid(), null, "a clean run reports no stall");
    const empty = createCursorTracker(50);
    assert.equal(empty.lastProcessedUid(), 50, "a folder with nothing new keeps its baseline rather than resetting to zero");
  }

  // ── THE SECOND: this job records, it never imports ───────────────────────────────────────────
  {
    for (const rel of [
      "../src/lib/sales/inbox/poller.ts",
      "../src/lib/sales/inbox/arrivals.ts",
      "../app/api/cron/sales-inbox-intake/route.ts",
    ]) {
      const source = codeOnly(readSource(rel));
      assert.ok(
        !/commitDistributorSales|monthly-import\/commit|publishClosing|confirmStep/.test(source),
        `${rel} must never reach the import or the closing — an arrival is a file and a guess at who sent it, and the person doing the close is the one who decides`,
      );
      // No mail, no in-app, no Telegram, no push. The owner's standing rule is that this system
      // sends no extra email at all, and the arrivals surface in the wizard where the work is.
      assert.ok(
        !/sendEmail|notifyRecipients|enqueueNotification|telegram|sendPush/i.test(source),
        `${rel} must notify nobody — the arrivals appear in the Monthly Sales wizard, which is where this work already happens`,
      );
    }
  }

  // ── Which attachments are candidate workbooks ────────────────────────────────────────────────
  {
    const picked = pickWorkbookAttachments([
      workbook("EGD_July.xlsx", 2048),
      workbook("signature.png", 512),
      workbook("terms.pdf", 4096),
      workbook("logo.xlsx", 256, { related: true }),
      workbook("Legacy.XLS", 1024),
      workbook("empty.xlsx", 0),
    ]);
    assert.deepEqual(
      picked.map((item) => item.fileName),
      ["EGD_July.xlsx", "Legacy.XLS"],
      "only non-inline, non-empty .xlsx/.xls attachments are candidates — and the extension match is case-insensitive",
    );
    assert.deepEqual(picked.map((item) => item.index), [0, 1], "the index is the position among WORKBOOKS, which is what the arrival's identity key uses");
  }

  // Matching is on extension, not MIME: distributor exports routinely arrive as octet-stream, and
  // a MIME filter would drop real files silently.
  {
    const picked = pickWorkbookAttachments([
      workbook("MULTI_2026-07.xlsx", 900, { contentType: "application/octet-stream" }),
    ]);
    assert.equal(picked.length, 1, "a workbook labelled application/octet-stream is still a workbook");
  }

  // Oversize is reported, never dropped in silence — a distributor whose file stops arriving has
  // to be visible somewhere.
  {
    const huge = [workbook("giant.xlsx", MAX_ARRIVAL_BYTES + 1)];
    assert.equal(pickWorkbookAttachments(huge).length, 0, "an attachment past the ceiling is not parked");
    assert.equal(countOversizeWorkbooks(huge), 1, "but it IS counted, so the run reports it");
    assert.ok(
      MAX_ARRIVAL_BYTES > 10 * 1024 * 1024,
      "the arrival ceiling must sit above the importer's own 10MB limit — a 12MB file is a real file a person needs to know arrived, and a refusal they can act on beats silence",
    );
  }

  assert.deepEqual(pickWorkbookAttachments(undefined), [], "a message with no attachments is not an error");

  // ── Storage-safe names, without losing what the person will recognise ────────────────────────
  {
    assert.equal(sanitizeArrivalFileName("EGD_July 2026.xlsx"), "EGD_July-2026.xlsx");
    {
      // Asserted as properties rather than pinned to one mangled literal: what matters is that
      // nothing traversal-shaped reaches a storage key, not the exact dashes it collapses into.
      const traversal = sanitizeArrivalFileName("../../etc/passwd.xlsx");
      assert.ok(!traversal.includes("/") && !traversal.includes("\\"), "no path separator may survive into a storage key");
      assert.ok(!traversal.startsWith("."), "a storage key must not begin with a dot");
      assert.ok(traversal.endsWith(".xlsx"), "the workbook extension is kept");
    }
    assert.equal(
      sanitizeArrivalFileName("تقرير.xlsx"),
      "arrival.xlsx",
      "a wholly non-Latin name reduces to nothing but its extension — an Egyptian distributor sending one must still get a real object name, not a bare '.xlsx'",
    );
    assert.equal(sanitizeArrivalFileName(""), "arrival.xlsx", "an unnamed attachment still gets a usable object name");
    assert.ok(sanitizeArrivalFileName("report").endsWith(".xlsx"), "a name with no extension gains one");
  }

  // ── Configuration: absent means inert, never broken ──────────────────────────────────────────
  {
    assert.deepEqual(parseSalesEmailInboxesConfig(undefined), [], "no configuration means no mailboxes, which is a clean no-op run");
    assert.deepEqual(parseSalesEmailInboxesConfig("not json at all"), [], "malformed configuration must not throw inside a cron route");
    assert.deepEqual(parseSalesEmailInboxesConfig("{}"), [], "a non-array payload is ignored rather than half-read");

    const parsed = parseSalesEmailInboxesConfig(
      JSON.stringify([
        { host: "imap.example.com", label: "sales", password: "x", user: "sales@example.com" },
        { host: "imap.example.com", label: "missing-user", password: "x" },
      ]),
    );
    assert.equal(parsed.length, 1, "an entry missing its user is dropped, not connected with a blank credential");
    assert.equal(parsed[0].port, 993, "port defaults to IMAPS");
    assert.equal(parsed[0].secure, true, "TLS is the default, never something a missing field can switch off");
  }

  // ── The wizard is where an arrival becomes visible ───────────────────────────────────────────
  // A feature can ship green, deploy cleanly and be reachable by nobody; zero usage looks identical
  // to zero adoption. The panel is the whole point of the poller, so its wiring is pinned here.
  {
    const wizard = readSource("../src/components/sales/monthly-sales-wizard.tsx");
    assert.ok(
      wizard.includes("/api/sales/inbox-arrivals?distributor="),
      "the wizard must fetch arrivals narrowed to the OPEN step — an unidentified workbook attaching itself to whichever step happens to be open is how the wrong distributor's sales get imported",
    );
    assert.ok(
      /action: "claim"/.test(wizard),
      "a committed arrival must be claimed — commit deletes the storage object it read, so an unclaimed arrival keeps being offered while pointing at a file that no longer exists",
    );
  }
}
