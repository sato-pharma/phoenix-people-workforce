import { NextResponse } from "next/server";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";

import { fileCandidateToFolder, returnCandidateToPool } from "@/lib/recruitment/candidates";
import {
  candidateStorageFolderKinds,
  cleanFolderKey,
  isStorableFolderKind,
} from "@/lib/recruitment/candidate-folder";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How long a folder name may be — long enough for the longest real job title, short enough to read. */
const FOLDER_KEY_MAX_LENGTH = 120;

function validationError(message: string) {
  return NextResponse.json({ error: "validation", message, success: false }, { status: 400 });
}

/**
 * "File this CV on the shelf" — PATCH with a kind and a key.
 *
 * `candidates: update` and not `read`, unlike the neighbouring `seen` route: this changes the
 * candidate row and, by design, removes the CV from the pool every other recruiter is looking at.
 * That is a change to shared state, so it needs the grant that says you may make one.
 *
 * The vocabulary is enforced HERE because this is the only path a browser can file through. The
 * table does carry a CHECK constraint on the kind — unusually for this module, since `status`
 * deliberately has none — because a half-filed row is not merely wrong data, it is a CV that one
 * screen shows and another hides. Validating at the boundary as well is what makes a bad kind a 400
 * naming the three shelves rather than a 500 from Postgres.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "update");
    const { id } = await params;
    await assertCandidateVisible(access, id);
    const body = await readJsonObject(request);

    const kind = str(body.kind);
    if (!kind) return validationError("A folder kind is required.");
    // The four shelves OR the duplicate archive, which shares the columns and is not a shelf.
    if (!isStorableFolderKind(kind)) {
      return validationError(
        `"${kind}" is not a folder kind. Use one of: ${candidateStorageFolderKinds.join(", ")}.`,
      );
    }

    const key = cleanFolderKey(str(body.key));
    if (!key) return validationError("A folder needs a name.");
    if (key.length > FOLDER_KEY_MAX_LENGTH) {
      return validationError(`Keep the folder name under ${FOLDER_KEY_MAX_LENGTH} characters.`);
    }

    const candidate = await fileCandidateToFolder(access, id, kind, key);
    return NextResponse.json({ candidate, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to file this CV.");
  }
}

/**
 * "Put it back in the pool."
 *
 * DELETE rather than a PATCH carrying nulls, because that is what it is: the filing is removed and
 * the candidate is untouched otherwise. Deliberately succeeds on a CV that is already back — two
 * people can have the folder open, and the honest answer to the second click is yes.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "update");
    const { id } = await params;
    await assertCandidateVisible(access, id);

    const candidate = await returnCandidateToPool(id);
    return NextResponse.json({ candidate, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to return this CV to the pool.");
  }
}
