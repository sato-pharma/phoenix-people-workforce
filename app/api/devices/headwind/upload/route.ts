import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { headwindErrorResponse } from "@/lib/devices/headwind/http";
import type { HeadwindRulesTarget } from "@/lib/devices/headwind/configurations";
import {
  headwindUploadLengthDecision,
  HeadwindUploadError,
  uploadHeadwindApp,
  uploadHeadwindFile,
} from "@/lib/devices/headwind/uploads";
import { hrIdForStorage } from "@/lib/hr-id";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * 🔴 FIVE MINUTES, NOT THE DEFAULT. An APK is tens of megabytes and crosses the network twice — into
 * Phoenix and out to the Headwind box. On the platform default this times out mid-transfer and leaves
 * a part-written file in the server's staging area, which reads to the next person as a corrupt app.
 */
export const maxDuration = 300;

/**
 * Send an APK or a file up to the company's Headwind server, and optionally put it straight into a set
 * of tablet rules — which is what actually installs it.
 *
 * Multipart, so it is its own route rather than a branch of the JSON one. Fields: `file`, `kind`
 * (`app` or `file`), and optionally `configurationId` (a set's id, or `rep` for every rep set of rules),
 * `showIcon`, `description`, `path`.
 *
 * 🔴 THE DECLARED LENGTH IS READ BEFORE THE BODY (`headwindUploadLengthDecision`): this route sits
 * outside the proxy, so nothing else stops an oversized body being buffered whole by `formData()`.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    const length = headwindUploadLengthDecision(request.headers.get("content-length"));
    if (!length.ok) return NextResponse.json({ message: length.message }, { status: length.status });

    const form = await request.formData().catch(() => null);
    if (!form) throw new HeadwindUploadError("Choose a file to send.");

    const actor =
      hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;
    const rules = uploadRules(form.get("configurationId"));
    const file = form.get("file");
    const headers = { "cache-control": "no-store" };

    if (form.get("kind") === "file") {
      return NextResponse.json(
        await uploadHeadwindFile(
          {
            description: typeof form.get("description") === "string" ? String(form.get("description")) : null,
            file,
            path: typeof form.get("path") === "string" ? String(form.get("path")) : null,
            rules,
          },
          actor,
        ),
        { headers },
      );
    }

    return NextResponse.json(
      await uploadHeadwindApp({ file, rules, showIcon: form.get("showIcon") !== "false" }, actor),
      { headers },
    );
  } catch (error) {
    return headwindErrorResponse(error, "Could not send that to the Headwind server.");
  }
}

/**
 * Which rules the upload goes to: none, one set by id, or `rep` — every rep set of rules.
 *
 * 🔴 A VALUE THAT IS NEITHER IS REFUSED. It used to become `NaN`, the link was skipped without a word,
 * and the reply said "on the server, on NO tablet yet" to someone who had asked for it on the tablets.
 */
function uploadRules(value: FormDataEntryValue | null): HeadwindRulesTarget | null {
  if (typeof value !== "string" || !value.trim()) return null;
  if (value.trim() === "rep") return "rep";
  const id = Number(value);
  if (!Number.isInteger(id)) throw new HeadwindUploadError("That is not a set of tablet rules. Reload the page and pick one.");
  return [id];
}
