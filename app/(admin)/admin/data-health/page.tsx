import { redirect } from "next/navigation";

// Data Health was retired on 23 Oct 2026. Six of its queue cards could never be non-zero, its
// health rate subtracted one population from another, its pharmacy coverage read 100% when the
// read failed, and its salary flags stopped at 500. Role coverage and salary flags moved to the
// System Audit intact; the linkage checks became nightly System Audit findings. Kept as a forward.
export const dynamic = "force-dynamic";

export default async function DataHealthPage() {
  redirect("/admin/system-audit");
}
