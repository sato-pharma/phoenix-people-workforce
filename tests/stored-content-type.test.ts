import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  GENERIC_BINARY,
  HELD_ATTACHMENT_TYPES,
  storedContentType,
  WHATSAPP_INBOX_MEDIA_TYPES,
} from "../src/lib/uploads/stored-content-type.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

const MIGRATION = "supabase/migrations/20261119014513_exact_type_lists_for_whatsapp_and_held_email_buckets.sql";

function read(relative: string): string {
  return readFileSync(path.join(process.cwd(), relative), "utf8");
}

function bucketList(sql: string, bucket: string): string[] {
  const match = new RegExp(`allowed_mime_types = array\\[([^\\]]*)\\]\\s*where id = '${bucket}'`).exec(sql);
  assert.ok(match, `the migration sets an allowed_mime_types array for ${bucket}`);
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort();
}

/** Every `.upload(` that follows `.from(<bucket constant>)` in a source file, as text. */
function uploadsTo(source: string, bucketConstant: string): string[] {
  const calls: string[] = [];
  const marker = `.from(${bucketConstant})`;
  for (let at = source.indexOf(marker); at >= 0; at = source.indexOf(marker, at + 1)) {
    const tail = source.slice(at, at + 600);
    const upload = tail.indexOf(".upload(");
    if (upload >= 0 && !tail.slice(0, upload).includes(";")) calls.push(tail.slice(upload, upload + 400));
  }
  return calls;
}

export function runStoredContentTypeTests() {
  // A listed type is stored as itself, parameters and all; storage compares only the type itself.
  assert.equal(storedContentType("application/pdf", WHATSAPP_INBOX_MEDIA_TYPES), "application/pdf");
  assert.equal(
    storedContentType("audio/ogg; codecs=opus", WHATSAPP_INBOX_MEDIA_TYPES),
    "audio/ogg; codecs=opus",
    "a WhatsApp voice note keeps its codec parameter — staging stored it under the exact list",
  );
  assert.equal(storedContentType("IMAGE/JPEG", HELD_ATTACHMENT_TYPES), "IMAGE/JPEG", "the list is matched without regard to case");

  // Anything else is KEPT as a plain download — never refused, so no file is lost and no held email
  // becomes unapprovable because of its attachment's type.
  for (const unlisted of ["text/html", "text/javascript", "application/zip", "image/svg+xml", "text/vcard"]) {
    assert.equal(
      storedContentType(unlisted, WHATSAPP_INBOX_MEDIA_TYPES),
      GENERIC_BINARY,
      `${unlisted} from a WhatsApp sender is stored as a download, not refused and not rendered`,
    );
    assert.equal(storedContentType(unlisted, HELD_ATTACHMENT_TYPES), GENERIC_BINARY, `${unlisted} on a held email is stored as a download`);
  }
  assert.equal(storedContentType("", HELD_ATTACHMENT_TYPES), GENERIC_BINARY, "a file with no type is stored as a download");
  assert.equal(storedContentType(null, WHATSAPP_INBOX_MEDIA_TYPES), GENERIC_BINARY, "a missing type is stored as a download");
  assert.equal(storedContentType(undefined, WHATSAPP_INBOX_MEDIA_TYPES), GENERIC_BINARY);

  // The fallback only works if the bucket accepts it.
  assert.ok(WHATSAPP_INBOX_MEDIA_TYPES.has(GENERIC_BINARY), "the WhatsApp list allows the type the fallback uses");
  assert.ok(HELD_ATTACHMENT_TYPES.has(GENERIC_BINARY), "the held-email list allows the type the fallback uses");

  // The code's lists ARE the buckets' lists: a type the code thinks is allowed but the bucket refuses
  // would fail the upload again, which is the defect this exists to remove.
  // Comments blanked first: the header's ROLLBACK quotes the previous (wildcard) lists in the same shape.
  const sql = stripSqlComments(read(MIGRATION));
  assert.deepEqual(
    bucketList(sql, "whatsapp-inbox-media"),
    [...WHATSAPP_INBOX_MEDIA_TYPES].sort(),
    "WHATSAPP_INBOX_MEDIA_TYPES equals whatsapp-inbox-media's allowed_mime_types in the migration",
  );
  assert.deepEqual(
    bucketList(sql, "notification-held-attachments"),
    [...HELD_ATTACHMENT_TYPES].sort(),
    "HELD_ATTACHMENT_TYPES equals notification-held-attachments' allowed_mime_types in the migration",
  );
  for (const list of [WHATSAPP_INBOX_MEDIA_TYPES, HELD_ATTACHMENT_TYPES]) {
    for (const type of list) assert.ok(!type.includes("*"), `${type}: the lists are exact, never a family wildcard`);
  }

  // Every upload to the two buckets goes through the fallback.
  const store = stripComments(read("src/lib/whatsapp-inbox/store.ts"));
  const inboxUploads = uploadsTo(store, "WHATSAPP_INBOX_MEDIA_BUCKET");
  assert.equal(inboxUploads.length, 3, "three writers put files in whatsapp-inbox-media: the Meta copy, the video copy and the sent-file copy");
  for (const call of inboxUploads) {
    assert.match(call, /contentType: storedContentType\([^)]*WHATSAPP_INBOX_MEDIA_TYPES\)/, `a WhatsApp inbox upload stores through the fallback: ${call.slice(0, 120)}`);
  }
  const gate = stripComments(read("src/lib/notifications/confidence-gate.ts"));
  const heldUploads = uploadsTo(gate, "HELD_ATTACHMENTS_BUCKET");
  assert.equal(heldUploads.length, 1, "one writer keeps held-email attachments");
  assert.match(heldUploads[0]!, /contentType: storedContentType\(att\.contentType, HELD_ATTACHMENT_TYPES\)/, "a held attachment stores through the fallback");
  assert.match(
    gate,
    /contentType: raw\.contentType,/,
    "the held email is sent under the type it recorded, not the type the file was stored under",
  );
}
