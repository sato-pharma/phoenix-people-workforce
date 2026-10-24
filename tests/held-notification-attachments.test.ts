/**
 * A held email keeps its attachments, so approving it sends the file.
 *
 * Owner 2026-10-24: "fix the held-email approval so it keeps the attachments".
 *
 * The Notification Confidence Gate stored a held email's subject, body and recipients and nothing
 * else, and approveHeldNotification re-sent exactly that — so "the policy is attached" could be
 * held, approved and delivered with no policy on it, and nothing on screen would say so. Three
 * things are pinned here:
 *
 *   1. a held send's files are stored and read back byte for byte, under their own names;
 *   2. a file that could not be kept, or cannot be read back, REFUSES the approval — it never
 *      quietly sends the email without it;
 *   3. the wiring: the send path hands the gate its files, the gate keeps them only on a hold, and
 *      the approval passes them to the send.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { PreparedEmailAttachment } from "@/lib/email/email-providers";
import { HELD_ATTACHMENTS_BUCKET, keepHeldAttachments, loadHeldAttachments } from "@/lib/notifications/confidence-gate";

type Stored = { bucket: string; bytes: Buffer; contentType?: string };

function stubStorage(options: { failUploads?: boolean } = {}) {
  const objects = new Map<string, Stored>();
  const client = {
    storage: {
      from: (bucket: string) => ({
        download: async (path: string) => {
          const hit = objects.get(`${bucket}/${path}`);
          if (!hit) return { data: null, error: { message: "Object not found" } };
          return { data: new Blob([new Uint8Array(hit.bytes)]), error: null };
        },
        upload: async (path: string, bytes: Buffer, opts: { contentType?: string }) => {
          if (options.failUploads) {
            return { data: null, error: { message: "storage is down" } };
          }
          objects.set(`${bucket}/${path}`, { bucket, bytes: Buffer.from(bytes), contentType: opts.contentType });
          return { data: { path }, error: null };
        },
      }),
    },
  };
  return { client: client as never, objects };
}

async function assertRefused(promise: Promise<unknown>, fileName: string, message: string) {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof Error && error.message.includes(`"${fileName}"`) && /without the file/.test(error.message),
    message,
  );
}

export async function runHeldNotificationAttachmentTests() {
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n");
  const sheet = Buffer.from("PK\u0003\u0004 a workbook");
  const attachments: PreparedEmailAttachment[] = [
    { content: pdf.toString("base64"), contentType: "application/pdf", filename: "HR Policy 2026.pdf" },
    { content: sheet.toString("base64"), filename: "HR Policy 2026.pdf" },
  ];

  // ── 1. Kept, then read back byte for byte ──────────────────────────────────────────────────
  {
    const { client, objects } = stubStorage();
    const kept = await keepHeldAttachments(attachments, client);
    assert.equal(kept.length, 2, "every file on a held send must be recorded");
    assert.ok(kept.every((entry) => entry.storagePath), "every file must be stored when storage answers");
    assert.notEqual(kept[0].storagePath, kept[1].storagePath, "two files with the same name must not overwrite each other");
    assert.ok(
      [...objects.keys()].every((key) => key.startsWith(`${HELD_ATTACHMENTS_BUCKET}/`)),
      "a held send's files go to the private held-attachments bucket, never the composer's",
    );
    assert.ok(
      kept.every((entry) => !entry.storagePath?.includes("HR Policy")),
      "the storage path must never be built from the filename",
    );
    assert.equal(kept[0].byteSize, pdf.length);

    const loaded = await loadHeldAttachments(JSON.parse(JSON.stringify(kept)), client);
    assert.equal(loaded?.length, 2, "the approval must send every file the held email carried");
    assert.equal(loaded?.[0].filename, "HR Policy 2026.pdf", "the file keeps its own name");
    assert.equal(loaded?.[0].contentType, "application/pdf", "the file keeps its own type");
    assert.ok(Buffer.from(loaded?.[0].content ?? "", "base64").equals(pdf), "the PDF sent on approval must be the held file byte for byte");
    assert.ok(Buffer.from(loaded?.[1].content ?? "", "base64").equals(sheet), "the second file must be its own bytes, not the first's");
  }

  // ── 2. A send that never had files approves exactly as before ──────────────────────────────
  {
    const { client } = stubStorage();
    assert.equal(await loadHeldAttachments(null, client), undefined, "a held email with no files must approve with no attachments");
    assert.equal(await loadHeldAttachments([], client), undefined);
  }

  // ── 3. A file that could not be kept refuses the approval, never drops off it ─────────────
  {
    const { client } = stubStorage({ failUploads: true });
    const kept = await keepHeldAttachments([attachments[0]], client);
    assert.equal(kept.length, 1, "a file storage refused must still be recorded, or the approval cannot know it existed");
    assert.equal(kept[0].storagePath, null, "a file storage refused is recorded as not kept");
    await assertRefused(
      loadHeldAttachments(kept, client),
      "HR Policy 2026.pdf",
      "approving an email whose file could not be kept must be refused, never sent without the file",
    );
  }

  // ── 4. A file that is gone at approval time refuses the approval too ──────────────────────
  {
    const { client } = stubStorage();
    await assertRefused(
      loadHeldAttachments([{ byteSize: 10, filename: "Contract.pdf", storagePath: "missing/0" }], client),
      "Contract.pdf",
      "a held file that cannot be read back must refuse the approval",
    );
  }

  // ── 5. The wiring ──────────────────────────────────────────────────────────────────────────
  const gate = readFileSync("src/lib/notifications/confidence-gate.ts", "utf8");
  const send = readFileSync("src/lib/email/send-phoenix-email.ts", "utf8");

  const gateCall = send.slice(send.indexOf("await evaluateAndRecordNotificationSend({"));
  assert.match(
    gateCall.slice(0, gateCall.indexOf("});")),
    /attachments: prepared\.attachments,/,
    "the send path must hand the gate the files, or a held email has nothing to keep",
  );

  const evaluate = gate.slice(gate.indexOf("export async function evaluateAndRecordNotificationSend"));
  const evaluateBody = evaluate.slice(0, evaluate.indexOf("\nexport "));
  assert.match(
    evaluateBody,
    /decision === "hold" && input\.attachments && input\.attachments\.length > 0\s*\?\s*await keepHeldAttachments\(/,
    "the gate must keep the files of a HELD send — and only a held one",
  );
  assert.match(evaluateBody, /held_attachments: heldAttachments/, "the kept files must be written onto the review row");

  const approve = gate.slice(gate.indexOf("export async function approveHeldNotification"));
  const approveBody = approve.slice(0, approve.indexOf("\nexport "));
  assert.match(
    approveBody,
    /\.select\(`\$\{REVIEW_COLUMNS\},held_attachments,held_from_address,held_reply_to_address`\)/,
    "the approval must read the kept files, sender and Reply-To",
  );
  assert.match(
    approveBody,
    /const attachments = await loadHeldAttachments\([\s\S]*?\);[\s\S]*?sendPhoenixEmail\(\{\s*attachments,/,
    "the approval must load the kept files BEFORE the send and pass them to it",
  );

  // ── 6. The sender and Reply-To survive the hold too (owner, 2026-10-24) ─────────────────────
  // "fix the held-email approval so it keeps the From and Reply-To": without these the approved
  // email went out from the default address and its replies landed in the default inbox.
  const gateCallBody = gateCall.slice(0, gateCall.indexOf("});"));
  assert.match(gateCallBody, /from: prepared\.from,/, "the send path must hand the gate the resolved sender");
  assert.match(gateCallBody, /replyTo: prepared\.replyTo,/, "the send path must hand the gate the resolved Reply-To");
  assert.match(
    evaluateBody,
    /decision === "hold" && input\.from \? \{ held_from_address: input\.from \}/,
    "the gate must keep the sender of a HELD send — and only a held one",
  );
  assert.match(
    evaluateBody,
    /decision === "hold" && input\.replyTo \? \{ held_reply_to_address: input\.replyTo \}/,
    "the gate must keep the Reply-To of a HELD send — and only a held one",
  );
  const approveSend = approveBody.slice(approveBody.indexOf("sendPhoenixEmail({"));
  const approveSendBody = approveSend.slice(0, approveSend.indexOf("});"));
  assert.match(approveSendBody, /from: kept\.held_from_address \|\| undefined,/, "the approval must send from the kept sender");
  assert.match(approveSendBody, /replyTo: kept\.held_reply_to_address \|\| undefined,/, "the approval must send with the kept Reply-To");
}
