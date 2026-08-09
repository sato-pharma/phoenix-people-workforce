import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { extractHeaders } from "@/lib/sales/distributor-detection";
import { normalizeHeaderKey } from "@/lib/sales/normalizer/header-normalize";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only "are my column aliases actually in this file?" preview for the MONTHLY column editor.
// The monthly engine matches columns by header NAME (aliases), so the preview reads the file's real
// header row and reports, per field, whether ANY configured alias was found (and which one). Nothing is
// persisted; only header text is read.

type FieldAliases = { key: string; label?: string; aliases: string[] };
type PreviewField = { key: string; label: string; foundAlias: string | null; status: "found" | "missing" | "empty" };

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const form = await request.formData();
    let fields: FieldAliases[] = [];
    try {
      fields = JSON.parse(String(form.get("fields") ?? "[]")) as FieldAliases[];
    } catch {
      return NextResponse.json({ success: false, error: "Invalid fields payload." }, { status: 400 });
    }
    const file = form.get("file");
    if (!file || typeof file !== "object" || !("arrayBuffer" in file)) {
      return NextResponse.json({ success: false, error: "Attach a sample file to preview." }, { status: 400 });
    }

    // Build the known-header set from every configured alias so extractHeaders picks the right header row.
    const known = new Set<string>();
    for (const f of fields) for (const a of f.aliases ?? []) { const k = normalizeHeaderKey(a); if (k) known.add(k); }

    let headers: string[];
    try {
      headers = await extractHeaders(await (file as File).arrayBuffer(), known);
    } catch {
      return NextResponse.json({ success: false, error: "Could not read the file as an .xlsx workbook." }, { status: 400 });
    }
    const headerKeys = new Set(headers.map((h) => normalizeHeaderKey(h)).filter(Boolean));

    const result: PreviewField[] = fields.map((f) => {
      const aliases = (f.aliases ?? []).filter((a) => a.trim());
      if (aliases.length === 0) return { key: f.key, label: f.label ?? f.key, foundAlias: null, status: "empty" };
      const hit = aliases.find((a) => headerKeys.has(normalizeHeaderKey(a)));
      return { key: f.key, label: f.label ?? f.key, foundAlias: hit ?? null, status: hit ? "found" : "missing" };
    });

    return NextResponse.json({ success: true, fields: result, headerSample: headers.slice(0, 40) });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Preview failed.") }, { status: 500 });
  }
}
