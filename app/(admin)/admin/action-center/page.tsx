import { redirect } from "next/navigation";

// Permanent redirect — the Action Center has been renamed to Approvals Hub.
export default async function LegacyActionCenterRedirect({
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
  redirect(`/admin/approvals-hub${qs ? `?${qs}` : ""}`);
}
