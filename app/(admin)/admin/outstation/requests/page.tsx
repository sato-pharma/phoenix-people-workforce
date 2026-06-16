import { redirect } from "next/navigation";

// The /admin/outstation/requests page is retired — the Expense Requests queue is
// now the Queue tab on /admin/outstation/expense-command. Preserve all existing
// query params (requestId, action, etc.) so email deep-links and the "Add Manual
// Expense" nav shortcut continue to work after the rename.
export const dynamic = "force-dynamic";

export default async function OutstationRequestsRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolved = await searchParams;
  const params = new URLSearchParams();
  params.set("tab", "queue");
  for (const [key, value] of Object.entries(resolved)) {
    if (key === "tab") continue;
    if (Array.isArray(value)) value.filter(Boolean).forEach((entry) => params.append(key, entry));
    else if (value) params.set(key, value);
  }
  redirect(`/admin/outstation/expense-command?${params.toString()}`);
}
