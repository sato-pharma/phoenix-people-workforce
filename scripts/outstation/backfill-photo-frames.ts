/**
 * Measure the stored photos of the claims still WAITING on Expense Approvals, so a blank arrival or
 * departure photo filed before the capture refused one is flagged on the desk too (owner, 2026-11-23,
 * after the District Manager expense inspection; src/lib/outstation/blank-frame.ts).
 *
 * The claim form and the server measure every photo from 23 Nov on and keep the reading as `frame` on
 * the photo's metadata. A claim filed before that carries no `frame`, so the desk cannot see that its
 * photo is blank — the inspection found seven such waiting claims (one white frame filed on three of
 * them). This reads each waiting photo that has no `frame`, measures it with the server's own
 * `measureEvidencePhoto`, and writes the reading beside it. Nothing else on the claim changes: no
 * status, no amount, no decision.
 *
 *   node --env-file-if-exists=.env.local --experimental-strip-types --experimental-specifier-resolution=node \
 *     --import ./tests/register-alias-loader.mjs scripts/outstation/backfill-photo-frames.ts            report only
 *   … scripts/outstation/backfill-photo-frames.ts --apply                                               write
 *
 * 🔴 `--apply` WRITES PRODUCTION when `.env.local` points there (it does). Announce it before running it.
 * 🔴 Each write is guarded by the photo path read with it: a photo retaken since the read is not
 *    touched, and its new reading comes from the capture itself.
 * 🔴 Only `submitted` and `needs_review` claims — a decided claim is never touched.
 */
import { createClient } from "@supabase/supabase-js";

import { refuseUnknownFlags } from "../lib/refuse-arguments.mjs";

import { measureEvidencePhoto } from "@/lib/outstation/blank-frame-server";
import { frameOfMetadata, type FrameReading } from "@/lib/outstation/blank-frame";
import { OUTSTATION_UNDECIDED_STATUSES } from "@/lib/outstation/undecided-claim";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "backfill-photo-frames",
  entry: import.meta.url,
  known: ["--apply"],
});

const BUCKET = "outstation-evidence";
const PHOTOS = [
  { metadata: "car_evidence_metadata", path: "car_evidence_image_path", word: "arrival" },
  { metadata: "departure_evidence_metadata", path: "departure_evidence_image_path", word: "departure" },
] as const;

type Row = Record<string, unknown> & { id: number; employee_name: string | null };

const describe = (frame: FrameReading | null) =>
  frame === null ? "could not be opened" : frame.blank ? `BLANK (sd ${frame.sd}, edge ${frame.edge})` : `fine (sd ${frame.sd}, edge ${frame.edge})`;

async function main() {
  const apply = process.argv.includes("--apply");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  const ref = url.replace(/^https:\/\//, "").split(".")[0];
  console.log(`project ${ref} · ${apply ? "APPLY — writing each reading" : "report only (add --apply to write)"}`);
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data, error } = await supabase
    .from("outstation_expense_requests")
    .select("id, employee_name, status, car_evidence_image_path, car_evidence_metadata, departure_evidence_image_path, departure_evidence_metadata")
    .in("status", [...OUTSTATION_UNDECIDED_STATUSES])
    .order("id", { ascending: true });
  if (error || !data) throw new Error(`the waiting claims could not be read: ${error?.message ?? "no data"}`);

  let measured = 0;
  let blank = 0;
  let unopened = 0;
  let written = 0;
  for (const row of data as Row[]) {
    for (const photo of PHOTOS) {
      const path = typeof row[photo.path] === "string" ? (row[photo.path] as string) : "";
      const metadata = row[photo.metadata];
      if (!path || !metadata || typeof metadata !== "object" || frameOfMetadata(metadata)) continue;
      const file = await supabase.storage.from(BUCKET).download(path);
      const frame = file.data ? await measureEvidencePhoto(Buffer.from(await file.data.arrayBuffer())) : null;
      measured += 1;
      if (frame === null) unopened += 1;
      if (frame?.blank) blank += 1;
      console.log(`claim ${row.id} · ${row.employee_name ?? "unnamed"} · ${photo.word} photo ${describe(frame)}`);
      if (!apply || frame === null) continue;
      const { data: updated, error: writeError } = await supabase
        .from("outstation_expense_requests")
        .update({ [photo.metadata]: { ...(metadata as Record<string, unknown>), frame } })
        .eq("id", row.id)
        .eq(photo.path, path)
        .in("status", [...OUTSTATION_UNDECIDED_STATUSES])
        .select("id");
      if (writeError) throw new Error(`claim ${row.id}: ${writeError.message}`);
      if ((updated ?? []).length === 1) written += 1;
      else console.log(`claim ${row.id}: not written — the photo was retaken or the claim decided since it was read`);
    }
  }
  console.log(`${data.length} waiting claims · ${measured} photos measured · ${blank} blank · ${unopened} could not be opened · ${written} written`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
