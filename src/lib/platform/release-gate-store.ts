// The one database read behind the release gate (release-gate.ts, docs/deployment.md "The release gate").
//
// Server-only: it uses the service-role client, and release_gates is readable by service_role alone. It
// throws on any failure so the caller can tell "no row yet" (a clean false) from "could not read" (an
// error), because the gate fails closed on the second and merely waits on the first.

import { getSupabaseAdmin } from "@/lib/supabase/server";

/** Is there a row recording that every required check passed on this exact commit? */
export async function releaseGateHasRecord(sha: string): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin({ requestTimeoutMs: 4000 })
    .from("release_gates")
    .select("sha")
    .eq("sha", sha)
    .limit(1);
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}
