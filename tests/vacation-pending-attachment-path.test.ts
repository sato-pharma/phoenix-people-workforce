import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  buildPendingVacationAttachmentPath,
  isOwnPendingVacationAttachmentPath,
  parsePendingVacationAttachmentPath,
} from "../src/lib/vacation/attachment-transport.ts";

const submitRouteSource = readFileSync(new URL("../app/api/vacations/requests/route.ts", import.meta.url), "utf8");
const uploadUrlRouteSource = readFileSync(
  new URL("../app/api/vacations/attachments/upload-url/route.ts", import.meta.url),
  "utf8",
);
const transportSource = readFileSync(new URL("../src/lib/vacation/attachment-transport.ts", import.meta.url), "utf8");

// POST /api/vacations/requests takes a large sick or compensatory file BY STORAGE PATH, then downloads
// that object into the new request and deletes it with the service-role client. Before this guard the
// path was never checked, so any signed-in employee could name another employee's filed medical
// document, get a copy attached to their own request, and erase the original from storage.
export function runVacationPendingAttachmentPathTests() {
  const uploadId = "0b7f8a52-3c1e-4d6a-9f2b-5e8c7d1a4b30";
  const ownSick = `pending/sick/B-10/${uploadId}/sick-leave-scan.jpg`;
  const ownCompensatory = `pending/compensatory/B-10/${uploadId}/event-photo.jpg`;

  // 1. The caller's own pending upload is accepted.
  assert.equal(
    isOwnPendingVacationAttachmentPath({ hrId: "B-10", kind: "sick", storagePath: ownSick }),
    true,
    "an employee's own pending sick upload is exactly what the submit route exists to accept",
  );
  assert.equal(
    isOwnPendingVacationAttachmentPath({ hrId: "B-10", kind: "compensatory", storagePath: ownCompensatory }),
    true,
    "an employee's own pending compensatory photo is accepted the same way",
  );
  assert.deepEqual(
    parsePendingVacationAttachmentPath(ownSick),
    { fileName: "sick-leave-scan.jpg", kind: "sick", owner: "B-10", uploadId },
    "a pending slot parses into its kind, owner, upload id and file name",
  );
  // Whatever upload-url mints, the submit route must take back from the same caller, or every large
  // sick note that employee attaches is refused.
  for (const kind of ["sick", "compensatory"] as const) {
    for (const hrId of ["B-10", "b 10", "", null]) {
      for (const fileName of ["IMG 2031 (1).HEIC", "تقرير طبي.pdf", "..", "../../sick/B-11/report.pdf", "", null]) {
        const minted = buildPendingVacationAttachmentPath({ fileName, hrId, kind, uploadId: randomUUID() });
        assert.equal(
          isOwnPendingVacationAttachmentPath({ hrId, kind, storagePath: minted }),
          true,
          `upload-url mints ${minted} for ${JSON.stringify(hrId)}; the submit route must accept it back from that caller`,
        );
      }
    }
  }

  // 2. Another employee's pending upload is refused.
  assert.equal(
    isOwnPendingVacationAttachmentPath({ hrId: "B-11", kind: "sick", storagePath: ownSick }),
    false,
    "one employee must never reference, and so delete, another employee's pending upload",
  );
  assert.equal(
    isOwnPendingVacationAttachmentPath({ hrId: null, kind: "sick", storagePath: ownSick }),
    false,
    "a caller with no HR id owns only the unknown-employee slot, never a named employee's",
  );

  // 3. A filed document's canonical path is refused, the caller's own included.
  for (const [kind, storagePath] of [
    ["sick", `sick/B-11/${uploadId}/medical-report.pdf`],
    ["sick", `sick/B-10/${uploadId}/medical-report.pdf`],
    ["compensatory", `compensatory/B-11/${uploadId}/event-photo.jpg`],
  ] as const) {
    assert.equal(
      isOwnPendingVacationAttachmentPath({ hrId: "B-10", kind, storagePath }),
      false,
      `${storagePath} is a filed document, not a pending upload; accepting it copies and then deletes it`,
    );
  }

  // 4. The kind must match the form field that carried the path.
  assert.equal(
    isOwnPendingVacationAttachmentPath({ hrId: "B-10", kind: "compensatory", storagePath: ownSick }),
    false,
    "a sick upload named in the compensatory field is refused",
  );
  assert.equal(
    isOwnPendingVacationAttachmentPath({ hrId: "B-10", kind: "sick", storagePath: ownCompensatory }),
    false,
    "a compensatory upload named in the sick field is refused",
  );

  // 5. Traversal, extra or empty segments, and anything outside pending/ are refused.
  for (const storagePath of [
    `pending/sick/B-10/${uploadId}/../../../../sick/B-11/${uploadId}/medical-report.pdf`,
    `pending/sick/B-10/../B-11/${uploadId}/medical-report.pdf`,
    `pending/sick/B-10/${uploadId}/..`,
    `pending/sick/B-10/${uploadId}/.`,
    `pending/sick/B-10/..`,
    `pending/sick/B-10/${uploadId}/extra/medical-report.pdf`,
    `/pending/sick/B-10/${uploadId}/medical-report.pdf`,
    `pending/sick/B-10/${uploadId}/medical-report.pdf/`,
    `pending//sick/B-10/${uploadId}/medical-report.pdf`,
    `pending\\sick\\B-10\\${uploadId}\\medical-report.pdf`,
    `pending/sick/B-10/${uploadId}/..%2F..%2Fsick%2FB-11%2Fmedical-report.pdf`,
    `pending/sick/B-10/not-an-upload-id/medical-report.pdf`,
    `pending/sick/B-10/${uploadId}/`,
    `pending/sick/-B-10-/${uploadId}/medical-report.pdf`,
    `uploads/sick/B-10/${uploadId}/medical-report.pdf`,
    "",
  ]) {
    assert.equal(
      isOwnPendingVacationAttachmentPath({ hrId: "B-10", kind: "sick", storagePath }),
      false,
      `${JSON.stringify(storagePath)} is not a single pending upload slot and must be refused`,
    );
    assert.equal(parsePendingVacationAttachmentPath(storagePath), null, `${JSON.stringify(storagePath)} does not parse`);
  }

  // 6. The submit route asserts leave:create, then matches BOTH referenced paths to the caller and
  //    refuses with a 400, before it collects any for the finally-block delete or downloads one.
  const permissionAt = submitRouteSource.indexOf('await assertPermission(access, "leave", "create")');
  const lastOwnershipCheckAt = submitRouteSource.lastIndexOf("isOwnPendingVacationAttachmentPath(");
  const refusalAt = submitRouteSource.indexOf('error: "invalid_attachment_path"');
  const firstCollectAt = submitRouteSource.indexOf("pendingAttachmentPaths.push(");
  const firstDownloadAt = submitRouteSource.indexOf("await resolvePendingVacationAttachment(");
  assert.ok(
    firstCollectAt > 0 && firstDownloadAt > firstCollectAt,
    "the submit route still collects each referenced path, then downloads it",
  );
  assert.ok(
    permissionAt > 0 && permissionAt < firstDownloadAt,
    "leave:create is asserted before any storage call, not only inside createVacationRequest",
  );
  assert.ok(
    lastOwnershipCheckAt > 0 && lastOwnershipCheckAt < refusalAt && refusalAt < firstCollectAt,
    "both referenced paths are matched to the caller, and refused, before any is collected for the finally-block delete",
  );
  assert.match(
    submitRouteSource.slice(refusalAt, firstCollectAt),
    /status: 400/,
    "a path that is not the caller's own pending upload answers 400",
  );
  // A sick request may reference SEVERAL pending uploads since 2026-10-03, so the check runs over
  // the whole list rather than over one field. `.some(` is asserted separately and is the
  // load-bearing half: a `[0]`, a `.find(` on the first match or a check of only one element would
  // satisfy the call shape below while leaving every later path unmatched to the caller — and those
  // are the ones the finally block then deletes with the service-role client.
  assert.match(
    submitRouteSource,
    /sickAttachmentStoragePaths\.some\(/,
    "EVERY referenced sick path is matched to the caller, not just the first — the unchecked ones are exactly the objects the finally block deletes",
  );
  assert.match(
    submitRouteSource,
    /isOwnPendingVacationAttachmentPath\(\{\s*hrId: access\.hrId,\s*kind: "sick",\s*storagePath: path,?\s*\}\)/,
    "each sick path is checked as a sick upload owned by the caller",
  );
  assert.match(
    submitRouteSource,
    /isOwnPendingVacationAttachmentPath\(\{\s*hrId: access\.hrId,\s*kind: "compensatory",\s*storagePath: compensatoryAttachmentStoragePath,?\s*\}\)/,
    "the compensatory field is checked as a compensatory upload owned by the caller",
  );

  // 7. upload-url mints through the same definition the submit route checks against.
  assert.match(
    uploadUrlRouteSource,
    /buildPendingVacationAttachmentPath\(\{/,
    "upload-url must mint its path with buildPendingVacationAttachmentPath",
  );
  assert.doesNotMatch(
    uploadUrlRouteSource,
    /`pending\//,
    "a hand-built pending path can drift from the shape the submit route accepts and refuse every large upload",
  );

  // 8. The two service-role storage helpers refuse anything that is not a pending upload slot themselves.
  for (const [helper, storageCall] of [
    ["resolvePendingVacationAttachment", ".download(storagePath)"],
    ["removePendingVacationAttachment", ".remove([storagePath])"],
  ] as const) {
    const start = transportSource.indexOf(`export async function ${helper}(`);
    assert.ok(start >= 0, `${helper} is still defined in attachment-transport.ts`);
    const rest = transportSource.slice(start);
    const end = /\r?\n\}\r?\n/.exec(rest);
    const body = end ? rest.slice(0, end.index) : "";
    const guardAt = body.indexOf("parsePendingVacationAttachmentPath(storagePath)");
    const callAt = body.indexOf(storageCall);
    assert.ok(
      guardAt >= 0 && callAt > guardAt,
      `${helper} must refuse a path that is not a pending upload slot before its service-role ${storageCall} call`,
    );
  }
}
