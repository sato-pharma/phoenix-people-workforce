import { redirect } from "next/navigation";

// The Error Monitor was retired long ago into System Issues, and System Issues itself was retired
// on 23 Oct 2026 for the System Audit. Kept as a forward so old bookmarks and alert buttons land
// on the page that replaced both.
export const dynamic = "force-dynamic";

export default async function ErrorMonitorPage() {
  redirect("/admin/system-audit");
}
