import { redirect } from "next/navigation";

export default function LegacyMonthlySalesDashboardRedirectPage() {
  redirect("/admin/analytics/monthly-closing");
}
