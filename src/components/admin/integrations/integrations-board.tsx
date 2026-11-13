import { AdminCallout, AdminTableShell } from "@/components/admin/admin-design-system";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import type { IntegrationConfiguredState } from "@/lib/integrations/registry";
import type { IntegrationHealthCell, IntegrationRow, IntegrationsBoard } from "@/lib/integrations/status";
import { cn } from "@/lib/utils";

/**
 * The Integrations board. One block per kind of service; in each, every integration with what it is used for,
 * whether it is configured, and when it last worked and last failed.
 *
 * It prints variable NAMES and states only. No value reaches this component: the loader never copies one.
 * A source that could not be read says "Unavailable"; an event Phoenix does not record says "Not recorded".
 * Fits its own width: a table from 860px of container, cards below. Nothing scrolls sideways, nothing is cut.
 */

const STATE_TONE: Record<IntegrationConfiguredState, string> = {
  configured: "text-emerald-700",
  on: "text-emerald-700",
  partly: "text-amber-800",
  "not-configured": "text-slate-600",
  off: "text-slate-600",
  outside: "text-slate-600",
  "no-credential": "text-slate-600",
};

const headCell = "px-3 py-2 text-left align-bottom text-phx-sm font-bold uppercase tracking-[0.06em] break-words";
const bodyCell = "px-3 py-2 align-top break-words";

function Configured({ row }: { row: IntegrationRow }) {
  const { configuration } = row;
  return (
    <div className="min-w-0 space-y-1">
      <p className={cn("font-bold", STATE_TONE[configuration.state])}>{configuration.label}</p>
      {configuration.detail ? <p className="break-words text-slate-500">{configuration.detail}</p> : null}
      {configuration.missing.length > 0 ? (
        <p className="break-all text-phx-sm text-slate-500">Not set: {configuration.missing.join(", ")}</p>
      ) : null}
    </div>
  );
}

function Health({ cell, failure = false }: { cell: IntegrationHealthCell; failure?: boolean }) {
  if (cell.kind === "time") {
    return <p className={cn("font-semibold", failure ? "text-rose-700" : "text-slate-800")}>{cairoDateTime(cell.at)}</p>;
  }
  if (cell.kind === "none-recorded") return <p className="text-slate-600">None recorded</p>;
  if (cell.kind === "unavailable") {
    return (
      <div className="min-w-0">
        <p className="font-semibold text-amber-800">Unavailable</p>
        <p className="break-words text-phx-sm text-slate-500">{cell.why}</p>
      </div>
    );
  }
  return (
    <div className="min-w-0">
      <p className="text-slate-600">Not recorded</p>
      <p className="break-words text-phx-sm text-slate-500">{cell.why}</p>
    </div>
  );
}

function Notes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1 border-l-2 border-slate-300 pl-3">
      {notes.map((note) => (
        <li className="break-words text-slate-700" key={note}>
          {note}
        </li>
      ))}
    </ul>
  );
}

function Label({ children }: { children: string }) {
  return <p className="text-phx-sm font-bold uppercase text-slate-400">{children}</p>;
}

function GroupTable({ rows }: { rows: IntegrationRow[] }) {
  return (
    <div className="@container min-w-0">
      <table className="hidden w-full table-fixed border-collapse text-xs @min-[860px]:table">
        <colgroup>
          <col className="w-[40%]" />
          <col className="w-[22%]" />
          <col className="w-[19%]" />
          <col className="w-[19%]" />
        </colgroup>
        <thead>
          <tr className="bg-[#0B0B0B] text-white">
            <th className={headCell} scope="col">Integration · provider · used for</th>
            <th className={headCell} scope="col">Configured</th>
            <th className={headCell} scope="col">Last success</th>
            <th className={headCell} scope="col">Last failure</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr className="border-b border-slate-100" key={row.id}>
              <td className={bodyCell}>
                <p className="break-words font-bold text-slate-900">{row.name}</p>
                <p className="text-slate-500">{row.provider}</p>
                <p className="mt-1 break-words text-slate-700">{row.usedFor}</p>
                <Notes notes={row.notes} />
              </td>
              <td className={bodyCell}>
                <Configured row={row} />
              </td>
              <td className={bodyCell}>
                <Health cell={row.health.lastSuccess} />
              </td>
              <td className={bodyCell}>
                <Health cell={row.health.lastFailure} failure />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="divide-y divide-slate-200 @min-[860px]:hidden">
        {rows.map((row) => (
          <li className="space-y-2 px-3 py-3 text-xs" key={row.id}>
            <div>
              <p className="break-words font-bold text-slate-900">{row.name}</p>
              <p className="text-slate-500">{row.provider}</p>
            </div>
            <p className="break-words text-slate-700">{row.usedFor}</p>
            <div>
              <Label>Configured</Label>
              <Configured row={row} />
            </div>
            <div className="grid grid-cols-1 gap-2 @min-[480px]:grid-cols-2">
              <div className="min-w-0">
                <Label>Last success</Label>
                <Health cell={row.health.lastSuccess} />
              </div>
              <div className="min-w-0">
                <Label>Last failure</Label>
                <Health cell={row.health.lastFailure} failure />
              </div>
            </div>
            <Notes notes={row.notes} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function IntegrationsBoardView({ board, error }: { board: IntegrationsBoard | null; error: string | null }) {
  if (!board) {
    return (
      <AdminCallout tone="warning">
        <p>Unavailable: the integrations could not be read. {error ?? "The source did not answer."}</p>
      </AdminCallout>
    );
  }
  const { counts } = board;
  return (
    <div className="space-y-6">
      <AdminCallout>
        <p>
          {counts.total} integrations: {counts.configured} configured or switched on, {counts.partly} partly set,{" "}
          {counts.notConfigured} not configured or switched off. The rest need no credential, or keep it where this
          app cannot read it. This page shows whether a credential is set and never its value. Times are Cairo time.
        </p>
      </AdminCallout>
      {board.groups.map((group) => (
        <AdminTableShell
          description={`${group.rows.length} ${group.rows.length === 1 ? "integration" : "integrations"}`}
          key={group.category}
          title={group.category}
        >
          <GroupTable rows={group.rows} />
        </AdminTableShell>
      ))}
      <p className="text-xs text-slate-500">
        Not listed: code libraries, browser features such as location and camera, and the two hosts the company
        left. None of them holds a credential.
      </p>
    </div>
  );
}
