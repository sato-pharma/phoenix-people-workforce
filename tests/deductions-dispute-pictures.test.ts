import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildDisputeAttachmentPath,
  checkDisputeImage,
  cleanDisputeFileName,
  DISPUTE_ATTACHMENT_BUCKET,
  DISPUTE_ATTACHMENT_MAX_BYTES,
  DISPUTE_ATTACHMENT_MAX_FILES,
  sniffDisputeImageType,
} from "../src/lib/deductions/comment-attachment-rules.ts";

/**
 * Pictures on a deduction dispute reply (owner, 2026-10-08: "make me able to upload a picture or more
 * in the dispute reply and it appears to the person I'm replying to").
 *
 * What is pinned: which bytes count as a picture (read from the file itself, never its name), where
 * they are stored, that a reply is refused BEFORE it is written when a picture is bad, that the bytes
 * are only handed to the employee they belong to or an admin reader, and that both screens show them.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
const PDF = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
const HTML = new TextEncoder().encode("<script>alert(1)</script>");
const GIF = new TextEncoder().encode("GIF89a....");

export function runDeductionsDisputePicturesTests() {
  // 1. The bytes decide, never the name or the claimed type.
  {
    assert.equal(sniffDisputeImageType(JPEG), "image/jpeg");
    assert.equal(sniffDisputeImageType(PNG), "image/png");
    assert.equal(sniffDisputeImageType(WEBP), "image/webp");
    assert.equal(sniffDisputeImageType(PDF), null, "a PDF is not a picture");
    assert.equal(sniffDisputeImageType(HTML), null, "a script renamed picture.png is not a picture");
    assert.equal(sniffDisputeImageType(GIF), null, "a GIF is not on the list");
    assert.equal(sniffDisputeImageType(new Uint8Array(0)), null);
  }

  // 2. A file is accepted or refused with a sentence the sender can act on, prefixed so the route returns 400.
  {
    const ok = checkDisputeImage({ bytes: JPEG, name: "C:\\Users\\x\\Desktop\\proof.jpg" });
    assert.equal(ok.contentType, "image/jpeg");
    assert.equal(ok.fileName, "proof.jpg", "the path is dropped from the shown name");

    assert.throws(() => checkDisputeImage({ bytes: HTML, name: "proof.png" }), /^Error: Validation: Only JPEG, PNG or WebP/);
    assert.throws(() => checkDisputeImage({ bytes: new Uint8Array(0), name: "x.jpg" }), /Validation: A picture is empty/);
    const huge = new Uint8Array(DISPUTE_ATTACHMENT_MAX_BYTES + 1);
    huge.set(JPEG);
    assert.throws(() => checkDisputeImage({ bytes: huge, name: "x.jpg" }), /Validation: A picture is larger than 5 MB/);
    assert.equal(DISPUTE_ATTACHMENT_MAX_FILES, 4);
  }

  // 3. A shown name is clean; a stored key never carries the name at all.
  {
    assert.equal(cleanDisputeFileName("../../etc/passwd\u0000.png", "image/png"), "passwd .png");
    assert.equal(cleanDisputeFileName("   ", "image/webp"), "picture.webp");
    assert.ok(cleanDisputeFileName(`${"a".repeat(300)}.jpg`, "image/jpeg").length <= 125);

    const path = buildDisputeAttachmentPath({
      attachmentId: "0f8fad5b-d9cb-469f-a165-70867728950e",
      candidateId: "../8e7e2a01-44f9-482a-847e-7cb76be1f219",
      contentType: "image/jpeg",
    });
    assert.equal(path, "8e7e2a01-44f9-482a-847e-7cb76be1f219/0f8fad5b-d9cb-469f-a165-70867728950e.jpg");
    assert.throws(() => buildDisputeAttachmentPath({ attachmentId: "", candidateId: "x", contentType: "image/png" }));
  }

  // 4. The bucket is private and the table is service-role only.
  {
    const migration = read("supabase/migrations/20261008220000_deductions_comment_attachments.sql");
    assert.match(migration, new RegExp(`'${DISPUTE_ATTACHMENT_BUCKET}',\\s*'${DISPUTE_ATTACHMENT_BUCKET}',\\s*false`), "the bucket is private");
    assert.match(migration, /array\['image\/jpeg', 'image\/png', 'image\/webp'\]/);
    assert.match(migration, /enable row level security/);
    assert.match(migration, /revoke all on table public\.deductions_comment_attachments from public, anon, authenticated/);
    assert.match(migration, /comment_id\s+uuid not null references public\.deductions_comments \(id\) on delete cascade/);
  }

  // 5. The reply route checks the sender and every picture BEFORE anything is written.
  {
    const route = read("app/api/admin/deductions/comments/route.ts");
    const post = route.slice(route.indexOf("export async function POST"));
    assert.ok(
      post.indexOf("assertDeductionsDecisionActor(access)") !== -1 &&
        post.indexOf("assertDeductionsDecisionActor(access)") < post.indexOf("request.formData()"),
      "a non-Super-Admin is turned away before any picture is read",
    );
    assert.ok(
      post.indexOf("checkDisputeImage(") !== -1 && post.indexOf("checkDisputeImage(") < post.indexOf("addDeductionsReply("),
      "every picture is checked before the reply is written",
    );
    assert.match(post, /multipart\/form-data/);

    const comments = read("src/lib/deductions/comments.ts");
    assert.match(comments, /discardDisputeComment\(row\.id\)/, "a reply whose pictures failed to store is removed, never shown half-written");
    assert.match(comments, /return attachCommentAttachments\(await attachAuthorNames\(rows\.map\(mapCommentRow\)\)\)/, "the employee's own thread carries the pictures");
    // The admin inbox read pages through the whole history, so its rows are `rows`, not a one-shot `data`.
    const inboxFrom = comments.indexOf("export async function listRecentDeductionsComments");
    assert.ok(inboxFrom >= 0, "the admin inbox read exists");
    const afterInbox = comments.slice(inboxFrom);
    // The function ends at the first closing brace that starts a line AND is followed by a line break; the
    // `}): Promise<…> {` that closes its parameter type also starts a line but is followed by text.
    const inbox = afterInbox.slice(0, afterInbox.search(/\n\}\r?\n/));
    assert.match(inbox, /attachCommentAttachments\(await attachAuthorNames\(rows\.map\(mapCommentRow\)\)\)/, "the admin inbox carries the pictures");
    assert.match(comments, /pictureCount > 0/, "the notification says pictures are attached, because an email cannot show them");
  }

  // 6. A picture is handed only to the employee it belongs to or an admin reader; never cached, never sniffed.
  {
    const server = read("src/lib/deductions/comment-attachments.ts");
    const reader = server.slice(server.indexOf("export async function readDisputeAttachmentForViewer"));
    assert.ok(
      reader.indexOf("isDeductionsReadActor") < reader.indexOf(".download("),
      "the viewer is checked before a byte is read from storage",
    );
    assert.match(reader, /ownerCompact !== viewerCompact/, "an employee sees only pictures on their own deduction");

    const serve = read("app/api/deductions/comments/attachments/[id]/route.ts");
    assert.match(serve, /"Cache-Control": "private, no-store"/);
    assert.match(serve, /"X-Content-Type-Options": "nosniff"/);

    const registry = read("src/lib/security/access-registry.ts");
    assert.match(registry, /pattern: "\/api\/deductions\/comments\/attachments\/:id"/, "the picture route is in the access registry");
  }

  // 7. Both screens show the pictures, and the picker keeps the house look.
  {
    const tab = read("src/components/admin/deductions-disputes-tab.tsx");
    assert.match(tab, /<PictureStrip attachments=\{comment\.attachments\} \/>/, "the admin thread shows them");
    assert.match(tab, /<PicturePicker/, "the reply box can add them");
    assert.match(tab, /form\.append\("images"/, "they travel as multipart");

    const portal = read("src/components/employee-portal/deductions-workspace.tsx");
    assert.match(portal, /<PictureStrip attachments=\{comment\.attachments\} \/>/, "the employee sees them in their thread");

    const pictures = read("src/components/deductions/dispute-pictures.tsx");
    assert.doesNotMatch(pictures, /rounded-/, "square edges");
    assert.doesNotMatch(pictures, /overflow-x-auto|min-w-\[/, "no horizontal scroll");
  }
}
