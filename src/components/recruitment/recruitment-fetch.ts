// Recruitment / ATS — the JSON fetch helpers the module's client components share.
//
// Lifted out of recruitment-workspace.tsx unchanged, so the candidate-folders view can use them
// without a second copy. Duplicating them is not a theoretical risk here: `patchJson` exists at all
// because the status control had been calling `postJson` against a PATCH-only route, which Next.js
// answers with 405 — every "Update status" click in the module's history failed silently, and a
// large part of why 225 of 226 production candidates still carried the database default. One copy
// is how that stays fixed.

async function readJson(res: Response, fallback: string): Promise<Record<string, unknown>> {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : fallback);
  return data;
}

export async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url);
  return readJson(res, "Request failed.");
}

export async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson(res, "Request failed.");
}

export async function patchJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson(res, "Request failed.");
}

export async function putJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson(res, "Request failed.");
}

export async function deleteRequest(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { method: "DELETE" });
  return readJson(res, "Delete failed.");
}

/**
 * A DELETE that carries a body — used where the thing being deleted is a LIST rather than the
 * resource in the path (taking several CVs out of one folder, say).
 *
 * Separate from `deleteRequest` rather than an optional second argument, because a caller that meant
 * to send a body and reached for the bodiless helper gets a route refusing "pick at least one" — a
 * sentence that points at the screen instead of at the call.
 */
export async function deleteJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "DELETE",
  });
  return readJson(res, "Delete failed.");
}
