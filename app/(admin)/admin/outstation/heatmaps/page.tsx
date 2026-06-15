import { redirect } from "next/navigation";

// The standalone heatmaps page has been superseded by the Outstation Expense
// Command Center, which includes a weighted Google Maps heatmap plus full
// expense intelligence. Keep this route so existing bookmarks/links resolve.
export const dynamic = "force-dynamic";

export default function OutstationHeatmapsRedirect() {
  redirect("/admin/outstation/expense-command");
}
