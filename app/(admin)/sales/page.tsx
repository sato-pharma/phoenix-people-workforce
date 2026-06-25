import { redirect } from "next/navigation";

export default function LegacySalesDashboardRedirectPage() {
  redirect("/admin/analytics/source-sales");
}
