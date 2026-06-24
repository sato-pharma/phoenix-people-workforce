import { redirect } from "next/navigation";

import { assertSystemAdministratorWorkspaceAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

const scopes = [
  { value: "all", label: "All Modules (Sales + Weekly + Marketing)" },
  { value: "sales", label: "Sales Uploads & Mapping" },
  { value: "weekly", label: "Weekly Sales Uploads & Mapping" },
  { value: "marketing", label: "Marketing Requests (all request data)" },
] as const;

export default async function AdminDataBackupPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");

  try {
    assertSystemAdministratorWorkspaceAccess(access, "data backup");
  } catch {
    redirect("/admin");
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6 sm:p-8">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">System Administration</p>
        <h1 className="text-2xl font-bold tracking-tight text-slate-950">Data Backup</h1>
        <p className="max-w-3xl text-sm text-slate-600">
          Export uploaded sales, weekly sales, and marketing request data for backup and recovery.
          XLSX is the default export format; JSON is also available for API and automation use.
        </p>
      </div>

      <form
        action="/api/admin/data-backup"
        method="GET"
        className="space-y-4 rounded-lg border border-slate-200 bg-white p-5"
      >
        <div className="space-y-2">
          <label className="block text-sm font-medium text-slate-800" htmlFor="scope">
            Scope
          </label>
          <select
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
            defaultValue="all"
            id="scope"
            name="scope"
          >
            {scopes.map((scope) => (
              <option key={scope.value} value={scope.value}>
                {scope.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap gap-2">
          <button className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800" name="format" type="submit" value="xlsx">
            Download XLSX (default)
          </button>
          <button className="rounded bg-slate-700 px-4 py-2 text-sm font-medium text-white hover:bg-slate-600" name="format" type="submit" value="json">
            Download JSON
          </button>
        </div>
      </form>
    </div>
  );
}
