// Owner instruction, 2026-10-03, on /employee-portals/vacation-request: *"here in sick leaves, make
// the employee able to upload multiple photos or multiple PDFs, and also make him able after he
// upload and submit to re-upload — but that does not replace the one he uploaded before, no, it is
// an add-on on them. And I get the admin get that till the day — for example 3 October he uploaded
// this, by 10 October he uploaded those."*
//
// Three rules are pinned here, and each has exactly one plausible way of being "fixed" back:
//
//  1. THE ADD IS APPEND-ONLY. The obvious implementation of "re-upload" is to overwrite the slot —
//     which is what the six legacy `sick_attachment_*` columns can physically do and what every
//     earlier version of this feature did. So the add path must never UPDATE or DELETE an
//     attachment row, and must never write the legacy columns.
//  2. A REPEATED FILE NAME MUST NOT COLLIDE. Append-only in the database is worthless if the object
//     store overwrites: two phone photos are routinely both called `IMG_0001.jpg`, and the same
//     certificate gets re-sent. The path therefore carries a per-file unique id, and the upload
//     stays `upsert: false`.
//  3. EVERY FILE CARRIES ITS OWN DATE, AND THE ADMIN SEES IT. One `uploaded_at` per request cannot
//     say "3 October this, 10 October those" — only one per FILE can. So the date is a column on
//     the attachment row, and the review surface prints it per file.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import { cairoDateTime12h } from "../src/lib/format/cairo-datetime.ts";
import { buildAdditionalVacationEvidenceObjectPath } from "../src/lib/vacation/service.ts";

function src(path: string) {
  return readFileSync(path, "utf8");
}

// Comments are stripped with the repo's shared `stripComments`, never a local regex: this repo
// documents its rules IN PLACE, so every file below EXPLAINS that it must not replace an earlier
// upload — and a raw substring scan would fire on the explanation and never on a violation.
function code(path: string) {
  return stripComments(src(path));
}

/**
 * The body of ONE function, so a `.update(` somewhere else in a 6,000-line file is never read as
 * this one's.
 *
 * The parameter list is walked first, by PARENTHESIS depth: an inline parameter type is itself a
 * `{ … }` block, so a brace counter started at the declaration closes on the parameters and returns
 * the signature instead of the body — which passes a "must not contain" assertion for free.
 */
function functionBody(source: string, declaration: string) {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `${declaration} must exist — the test is pinning a function that was renamed or removed`);

  let parens = 0;
  let cursor = start;
  let sawParams = false;
  for (; cursor < source.length; cursor += 1) {
    if (source[cursor] === "(") {
      parens += 1;
      sawParams = true;
    } else if (source[cursor] === ")") {
      parens -= 1;
      if (sawParams && parens === 0) {
        cursor += 1;
        break;
      }
    }
  }
  const bodyStart = source.indexOf("{", cursor);
  assert.notEqual(bodyStart, -1, `Could not find the body of ${declaration}`);

  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, i + 1);
    }
  }
  throw new Error(`Could not find the end of ${declaration}`);
}

export function runVacationSickAttachmentsTests() {
  const service = code("src/lib/vacation/service.ts");
  const addRoute = code("app/api/vacations/requests/[id]/attachments/route.ts");
  const submitRoute = code("app/api/vacations/requests/route.ts");
  const form = code("src/components/vacation/vacation-request-form.tsx");
  const history = code("src/components/vacation/vacation-attachment-history.tsx");

  // ── 1. The add is APPEND-ONLY ────────────────────────────────────────────────────────────────
  const addFunction = functionBody(service, "export async function addVacationRequestAttachments");

  assert.match(
    addFunction,
    /insertVacationAttachmentRows\(/,
    "adding documents goes through insertVacationAttachmentRows — the one writer, which only inserts",
  );
  assert.doesNotMatch(
    addFunction,
    /\.update\(/,
    "a later upload must never UPDATE an existing attachment row — the owner's ruling is that it is an add-on, never a replacement",
  );
  assert.doesNotMatch(
    addFunction,
    /\.upsert\(/,
    "an upsert would silently overwrite the row whose object path repeats, which is exactly the replacement that is forbidden",
  );
  assert.doesNotMatch(
    addFunction,
    /sick_attachment_object_path|compensatory_attachment_object_path/,
    "the legacy single-attachment columns name the FIRST file for ever; the add path must not touch them, or the earlier document disappears from every older read path",
  );

  const insertFunction = functionBody(service, "async function insertVacationAttachmentRows");
  assert.match(insertFunction, /\.insert\(/, "insertVacationAttachmentRows inserts");
  assert.doesNotMatch(
    insertFunction,
    /\.update\(|\.upsert\(|\.delete\(/,
    "the single writer of the attachment history may only insert — an update or delete here is how append-only would be lost without any screen looking different",
  );

  // ── 2. A repeated file name must NOT collide ─────────────────────────────────────────────────
  const firstUpload = buildAdditionalVacationEvidenceObjectPath({
    employeeHrId: "B-10",
    fileName: "IMG_0001.jpg",
    kind: "sick",
    requestId: "11111111-1111-1111-1111-111111111111",
    uniqueId: "aaaaaaaa",
  });
  const secondUpload = buildAdditionalVacationEvidenceObjectPath({
    employeeHrId: "B-10",
    fileName: "IMG_0001.jpg",
    kind: "sick",
    requestId: "11111111-1111-1111-1111-111111111111",
    uniqueId: "bbbbbbbb",
  });

  assert.notEqual(
    firstUpload,
    secondUpload,
    "two files with the SAME name on the same request must get different storage paths — two phone photos are routinely both IMG_0001.jpg, and a shared path means the second upload erases the first",
  );
  assert.match(
    firstUpload,
    /^sick\/B-10\/11111111-1111-1111-1111-111111111111\/aaaaaaaa-IMG_0001\.jpg$/,
    "the path stays <kind>/<HR id>/<request id>/<unique>-<file name>, one sanitized segment each",
  );
  assert.equal(
    buildAdditionalVacationEvidenceObjectPath({
      employeeHrId: "B-10",
      fileName: "../../etc/passwd",
      kind: "sick",
      requestId: "r1",
      uniqueId: "aaaaaaaa",
    }).split("/").length,
    4,
    "a traversal attempt in the file name is sanitized to ONE segment — the path depth is fixed at four whatever the name says",
  );
  assert.match(
    functionBody(service, "async function uploadAdditionalVacationEvidenceFile"),
    /upsert:\s*false/,
    "upsert stays false: the storage write must fail rather than overwrite a document the company already holds",
  );

  // ── 3. Every file carries its own date, and the admin sees it ────────────────────────────────
  const migration = src("supabase/migrations/20261003125818_vacation_request_attachments_multi.sql");
  assert.match(
    migration,
    /uploaded_at timestamptz not null default now\(\)/,
    "the upload date is a column on the FILE, not on the request — one date per request cannot say '3 October this, 10 October those'",
  );
  assert.match(
    migration,
    /create unique index if not exists v2_vacation_request_attachments_object_idx/,
    "one row per stored object, so a retried upload cannot double a line in the admin's list",
  );
  assert.match(
    migration,
    /revoke all on table public\.v2_vacation_request_attachments from public, anon, authenticated/,
    "medical documents are never readable with the key that ships in the browser bundle",
  );
  assert.doesNotMatch(
    migration,
    /update public\.v2_vacation_requests/,
    "the migration backfills OUT of the legacy columns and never rewrites them — they keep naming the first file",
  );

  assert.match(
    history,
    /formatUploadedAt\(attachment\.uploadedAt\)/,
    "the review list prints each file's OWN upload date; a single date for the request is the defect this feature exists to remove",
  );
  // Cairo local through the shared digits-only formatter, not a browser Intl call: the Intl call
  // drew PM with a different space on Apple devices and threw React #418 on the approval page
  // (31 Oct 2026; tests/react-418-hydration-safe-text.test.ts §4 (d)).
  assert.match(
    history,
    /function formatUploadedAt\([^)]*\)\s*\{\s*return cairoDateTime12h\(value\);/,
    "every time on screen is Cairo local (AGENTS.md §4), never raw UTC",
  );
  assert.equal(
    cairoDateTime12h("2026-10-26T14:29:14Z"),
    "Oct 26, 2026, 05:29 PM",
    "a sick note uploaded at 14:29 UTC on 26 Oct reads 05:29 PM, Cairo summer time — never the raw UTC hour",
  );
  assert.match(
    history,
    /attachments\/file\/\$\{encodeURIComponent\(attachment\.id\)\}/,
    "each file opens by its OWN row id — the /attachments/<kind> route signs the first file only, so without this the second and third documents could not be opened at all",
  );
  assert.doesNotMatch(
    history,
    /truncate|text-ellipsis|\btext-nowrap\b/,
    "a file name wraps and is never truncated with an ellipsis (AGENTS.md §4), and nothing here may force a horizontal scroll",
  );

  // ── The two entry points: several files in, append semantics in the picker ───────────────────
  assert.match(
    submitRoute,
    /body\.getAll\("sickDocument"\)/,
    "the submit route reads EVERY sickDocument part; a .get() would keep the first and silently drop the rest of what the employee attached",
  );
  assert.match(
    submitRoute,
    /sickAttachmentsExtra/,
    "documents beyond the first ride into the attachments table — the first stays in the legacy columns so no older read path changes",
  );
  assert.match(
    form,
    /multiple/,
    "the medical-document picker accepts several files at once",
  );
  assert.match(
    functionBody(form, "function addSickDocuments"),
    /setSickDocuments\(\(current\) => \{\s*const next = \[\.\.\.current\]/,
    "picking documents ADDS to the list already chosen — a phone gallery hands them over one at a time, and replacing the state here is the same defect as replacing the stored file",
  );

  assert.match(
    addRoute,
    /isOwnPendingVacationAttachmentPath/,
    "an added file may only come from the caller's OWN pending upload slot — the service-role client copies then deletes that object, so an unchecked path let a signed-in employee lift, and then erase, another employee's medical document",
  );
  assert.match(
    functionBody(service, "export async function addVacationRequestAttachments"),
    /hrIdsMatch\(request\.employeeHrId, access\.hrId\)/,
    "only the employee who filed the request, or HR/Super Admin, may add to it",
  );
}
