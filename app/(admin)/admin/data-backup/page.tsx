import { redirect } from "next/navigation";

import { assertSystemAdministratorWorkspaceAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { ALL_BACKUP_TABLES, MODULE_META } from "@/lib/admin/data-backup";
import { DataBackupResetSection } from "@/components/admin/data-backup-reset-section";

export const dynamic = "force-dynamic";

type Scope = "all" | "sales" | "weekly" | "marketing";

function tableSummary(scope: Scope) {
  const rows = scope === "all" ? ALL_BACKUP_TABLES : ALL_BACKUP_TABLES.filter((t) => t.module === scope);
  const byModule: Record<string, string[]> = {};
  for (const t of rows) {
    (byModule[t.module] ??= []).push(t.name);
  }
  return { rows, byModule };
}

export default async function AdminDataBackupPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");

  try {
    assertSystemAdministratorWorkspaceAccess(access, "data backup");
  } catch {
    redirect("/admin");
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8 p-6 sm:p-8">
      {/* Header */}
      <div className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">System Administration</p>
        <h1 className="text-2xl font-bold tracking-tight text-slate-950">Data Backup</h1>
        <p className="max-w-2xl text-sm text-slate-600">
          Export a complete snapshot of uploaded data and configuration for each module.
          Download XLSX first — each table becomes its own color-coded sheet.
          JSON is available for scripting and automation.
        </p>
      </div>

      {/* Quick download — full backup */}
      <div className="border border-slate-900 bg-slate-950 p-5">
        <div className="mb-4 space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Recommended</p>
          <h2 className="text-base font-bold text-white">Complete Backup — All Modules</h2>
          <p className="text-sm text-slate-400">
            {ALL_BACKUP_TABLES.length} tables across Source of Sales, Weekly Sales, and Marketing Requests in one file.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            className="inline-block bg-orange-500 px-5 py-2 text-sm font-semibold text-white hover:bg-orange-600"
            href="/api/admin/data-backup?scope=all&format=xlsx"
          >
            Download XLSX — All Modules
          </a>
          <a
            className="inline-block border border-slate-600 px-5 py-2 text-sm font-semibold text-slate-300 hover:border-slate-400 hover:text-white"
            href="/api/admin/data-backup?scope=all&format=json"
          >
            Download JSON — All Modules
          </a>
        </div>
      </div>

      {/* Per-module download cards */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Download by Module</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {(["sales", "weekly", "marketing"] as const).map((mod) => {
            const meta = MODULE_META[mod];
            const { rows, byModule } = tableSummary(mod);
            const tables = byModule[mod] ?? [];
            return (
              <div key={mod} className="border border-slate-200 bg-white p-4">
                <div
                  className="mb-3 h-1 w-8"
                  style={{ backgroundColor: `#${meta.headerFill}` }}
                />
                <p className="mb-1 text-sm font-bold text-slate-900">{meta.label}</p>
                <p className="mb-3 text-xs text-slate-500">{rows.length} tables</p>
                <div className="mb-4 space-y-0.5">
                  {tables.map((name) => (
                    <p key={name} className="text-xs text-slate-400">
                      {name}
                    </p>
                  ))}
                </div>
                <div className="flex flex-col gap-1.5">
                  <a
                    className="block border border-slate-900 bg-slate-900 px-3 py-1.5 text-center text-xs font-semibold text-white hover:bg-slate-800"
                    href={`/api/admin/data-backup?scope=${mod}&format=xlsx`}
                  >
                    XLSX
                  </a>
                  <a
                    className="block border border-slate-300 px-3 py-1.5 text-center text-xs font-semibold text-slate-600 hover:border-slate-500 hover:text-slate-900"
                    href={`/api/admin/data-backup?scope=${mod}&format=json`}
                  >
                    JSON
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* What's backed up — full table list */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Tables Included in Full Backup</h2>
        <div className="border border-slate-200 bg-white">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-900 text-left text-white">
                <th className="px-3 py-2 font-semibold">Module</th>
                <th className="px-3 py-2 font-semibold">Table Name</th>
                <th className="px-3 py-2 font-semibold">Database Table</th>
              </tr>
            </thead>
            <tbody>
              {ALL_BACKUP_TABLES.map((t, i) => {
                const meta = MODULE_META[t.module];
                return (
                  <tr key={t.table} className={i % 2 === 0 ? "bg-white" : "bg-slate-50"}>
                    <td className="px-3 py-1.5">
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ backgroundColor: `#${meta.tabColor}` }}
                      />
                      <span className="ml-1.5 text-slate-500">{meta.label}</span>
                    </td>
                    <td className="px-3 py-1.5 font-medium text-slate-800">{t.name}</td>
                    <td className="px-3 py-1.5 font-mono text-slate-500">{t.table}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Footer note */}
      <p className="text-xs text-slate-400">
        Backup downloads are rate-limited. Large datasets (SoS Uploaded Rows, Weekly Sales Rows) may take 30–60 seconds.
        The XLSX file has one sheet per table plus a color-coded Contents sheet. JSON is a single structured document.
      </p>

      {/* Reset section */}
      <div className="space-y-3 border-t border-slate-200 pt-6">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-red-600">Reset Module Data</h2>
          <p className="text-sm text-slate-600">
            Permanently delete uploaded/transactional data for a module after you have downloaded the backup.
            Configuration, master data, and mapping tables are preserved.
          </p>
        </div>
        <DataBackupResetSection />
      </div>
    </div>
  );
}
