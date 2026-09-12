import { NextResponse } from "next/server";

import { deleteCvFolder, moveCvFolder, renameCvFolder } from "@/lib/recruitment/cv-folder-tree-db";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  recruitmentProblem,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Rename a folder, move it under a different parent, or both.
 *
 * TWO OPERATIONS ON ONE VERB, and they are separated by which KEY is present rather than by a mode
 * string. `name` renames; `parentId` moves. `parentId: null` is a real instruction — "move this to
 * the top level" — and is therefore distinguished from the key being absent, which is the one place
 * a bare `str()` coercion would silently turn "move to the top" into "do not move".
 *
 * Applied in that order so a folder can be renamed and moved in one gesture without the rename's
 * sibling-name check being run against the folder's old neighbours.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    await requireRecruitmentAccess(request, "candidates", "update");
    const { id } = await params;
    const body = await readJsonObject(request);

    const wantsRename = Object.prototype.hasOwnProperty.call(body, "name");
    // `hasOwnProperty` and not a truthiness test: `parentId: null` means the top level and must not
    // read as "no move requested".
    const wantsMove = Object.prototype.hasOwnProperty.call(body, "parentId");
    if (!wantsRename && !wantsMove) {
      return recruitmentProblem("Send a new name, a new parent folder, or both.", 400);
    }

    let folder = null;
    if (wantsRename) folder = await renameCvFolder(id, String(body.name ?? ""));
    if (wantsMove) folder = await moveCvFolder(id, str(body.parentId));

    return NextResponse.json({ folder, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to update the folder.");
  }
}

/**
 * Delete a folder and its empty subfolders.
 *
 * REFUSES WHILE ANY CV IS STILL INSIDE, anywhere beneath it — `deleteCvFolder` counts the whole
 * subtree and returns a sentence naming the number. Without that check the foreign key's cascade
 * would quietly return every CV under the folder to the pool: no candidate record is lost, but
 * somebody's filing work is, and that is discovered weeks later. Emptying is a separate action the
 * recruiter has to mean.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    await requireRecruitmentAccess(request, "candidates", "update");
    const { id } = await params;

    const result = await deleteCvFolder(id);
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to delete the folder.");
  }
}
