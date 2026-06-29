import { redirect } from "next/navigation";

// Permanent redirect — the Actions tab has been renamed to Approvals Hub.
// All notification deep-links and bookmarks pointing at /employee-portals/actions
// are preserved by forwarding the full query string.
export default async function LegacyActionsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const key of ["module", "id", "tab"]) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) query.set(key, value);
  }
  const qs = query.toString();
  redirect(`/employee-portals/approvals-hub${qs ? `?${qs}` : ""}`);
}
