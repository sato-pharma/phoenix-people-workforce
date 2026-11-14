import { createHash } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// THE FINGERPRINT OF AN UPLOADED SALES FILE (enterprise audit REC-069, F-SAL-002; 14 Nov 2026).
//
// Every batch on `source_of_sales_import_batches` keeps `file_sha256`: the SHA-256 of the bytes it was
// read from. The duplicate guard (import-duplicate-guard.ts) refuses the same bytes under a different
// month or a different distributor, even renamed — the owner's choice, 14 Nov 2026.
//
// What is hashed is ALWAYS the bytes the person chose, never a workbook the server built from them: the
// Normalizer writes a coded copy in memory, and that copy carries its own creation time, so it would
// hash differently every time and match nothing.
//
//   one file                      → its digest
//   several files in one batch    → sha256("multi:" + their digests, sorted) — the order they were
//                                   chosen in does not matter
//   one upload stored as several  → the above, qualified by what tells the batches apart (the
//   batches (a Phoenix template     distributor, the month, or both). Without it the second batch of
//   naming several distributors,    the SAME upload would read as the first one's bytes under another
//   or a sheet spanning months)     distributor and be refused. The months of such a sheet are its own
//                                   dates, never a month someone picked, so the qualifier hides no
//                                   re-dating; a template split only by distributor is not qualified
//                                   by month, so the same template re-dated is still refused.
// ─────────────────────────────────────────────────────────────────────────────

/** The SHA-256 (hex) of one file's bytes. */
export function fileSha256(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return createHash("sha256").update(view).digest("hex");
}

/**
 * The fingerprint a batch stores, from the digests of the files it was read from. `part` names the
 * batch inside an upload stored as several (see the header); null or empty when the upload is one batch.
 * Null when no file was hashed — a batch with no fingerprint is compared by name and figures alone.
 */
export function uploadFingerprint(digests: readonly string[], part?: string | null): string | null {
  const clean = [...new Set(digests.map((d) => d.trim().toLowerCase()).filter(Boolean))].sort();
  if (clean.length === 0) return null;
  const base = clean.length === 1 ? clean[0] : createHash("sha256").update(`multi:${clean.join(",")}`).digest("hex");
  const qualifier = String(part ?? "").trim();
  return qualifier ? createHash("sha256").update(`part:${qualifier}|${base}`).digest("hex") : base;
}

/**
 * What tells one batch apart from the others stored from the SAME upload: the distributor when the
 * upload carries several, the month when it carries several. Empty when the upload is one batch.
 */
export function uploadPartQualifier(
  part: { distributorCode: string; period: string | null },
  parts: ReadonlyArray<{ distributorCode: string; period: string | null }>,
): string {
  const manyDistributors = new Set(parts.map((p) => p.distributorCode)).size > 1;
  const manyMonths = new Set(parts.map((p) => p.period ?? "")).size > 1;
  return [manyDistributors ? `distributor=${part.distributorCode}` : "", manyMonths ? `period=${part.period ?? ""}` : ""]
    .filter(Boolean)
    .join(";");
}

/** The digests of the chosen files a part was read from, matched by name in the order chosen. */
export async function digestsOfNamedFiles(files: readonly File[], fileNames: readonly string[]): Promise<string[]> {
  const wanted = new Set(fileNames);
  const digests: string[] = [];
  for (const file of files) {
    if (wanted.has(file.name)) digests.push(fileSha256(await file.arrayBuffer()));
  }
  return digests;
}
