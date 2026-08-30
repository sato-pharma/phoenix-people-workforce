// Recruitment / ATS — the three JSON fetch helpers the module's client components share.
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

export async function deleteRequest(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { method: "DELETE" });
  return readJson(res, "Delete failed.");
}
