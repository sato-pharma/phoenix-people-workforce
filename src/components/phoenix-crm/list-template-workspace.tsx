"use client";

/**
 * Phoenix CRM — the SFE's list template: pick a territory, download the sheet, upload it filled.
 *
 * Owner's ask, 2026-10-02: *"the SFE will send him an Excel sheet and he will populate it with the list
 * … then the SFE upload this sheet so his list appears."* This is the whole surface of it, and it sits
 * under `/admin` for the structural reason the duplicates board does: Golden Rule #1 says the rep is
 * never shown what judges his work, and the Phoenix CRM tabs are the same component tree the field app
 * renders — one wrong role check there and this would be in front of the rep whose grades it sets. A rep
 * cannot open `/admin` at all.
 *
 * 🔴 NOTHING HERE GRADES A CUSTOMER BY ITSELF, AND THE SHEET IS WHERE THE GRADING HAPPENS. The upload
 * takes what the SFE wrote in the sheet; the screen offers no grade control, because a second way to set
 * a grade is a second authority over a number the whole module divides by.
 */

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Loader2, Upload } from "lucide-react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { SearchableSelect } from "@/components/ui/searchable-select";

export type ListTemplateTerritory = { seatId: string; territoryName: string; repName: string | null; customers: number };

type ImportResult = {
  seatId: string;
  territoryName: string;
  read: number;
  loaded: number;
  hoursSet: number;
  refused: Array<{ row: number; reason: string }>;
};

const CONTROL = "w-full px-3";
const BUTTON =
  "inline-flex h-10 items-center justify-center gap-2 rounded-none border border-slate-300 bg-white px-4 text-sm font-bold text-slate-800 transition hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * 🔴 THE TERRITORIES ARRIVE AS A PROP, READ ON THE SERVER. They were fetched in an effect, which this
 * repo lints as an ERROR rather than a warning — a setState run from an effect triggers a cascading
 * render — and the page is server-rendered and `force-dynamic` anyway, so the fetch was a round trip
 * buying nothing. After a load the counts have moved, and `router.refresh()` re-reads them on the server.
 */
export function PhoenixCrmListTemplateWorkspace({ territories }: { territories: readonly ListTemplateTerritory[] }) {
  const router = useRouter();
  const [seatId, setSeatId] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const chosen = territories.find((entry) => entry.seatId === seatId) ?? null;

  async function upload(file: File) {
    setUploading(true);
    setProblem(null);
    setResult(null);
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("seatId", seatId);
      const response = await fetch("/api/phoenix-crm/list/template/import", { body, method: "POST" });
      const payload = (await response.json()) as { success?: boolean; message?: string; result?: ImportResult };
      if (!response.ok || !payload.success || !payload.result) {
        setProblem(payload.message ?? "That sheet could not be loaded.");
        return;
      }
      setResult(payload.result);
      // The counts on the picker have moved, so the server reads them again.
      router.refresh();
    } catch {
      setProblem("That sheet could not be loaded. Check the connection and try again.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-5 py-4">
          <h2 className="text-sm font-black uppercase tracking-wide text-slate-900">1 · The territory</h2>
          <p className="mt-1 text-sm font-medium leading-6 text-slate-600">
            One sheet is one territory. It carries the territory&rsquo;s code, and an upload for a different territory is refused.
          </p>
        </div>
        <div className="grid gap-3 px-5 py-4 sm:max-w-xl">
          <label className="block text-phx-sm font-black uppercase tracking-[0.16em] text-slate-500" htmlFor="phoenix-crm-template-seat">
            Territory
          </label>
          {/* A COMBO BOX, not a dropdown (owner, 2026-10-03: *"make any droplist have a combo box"*).
              This page is `/admin` only, so it names the shared component directly rather than going
              through `CrmBareSelect`'s surface check — there is no surface here but the admin's. The
              SFE picks one of 74 seats by typing a place or a rep's name. */}
          <SearchableSelect
            className={CONTROL}
            id="phoenix-crm-template-seat"
            onChange={(event) => {
              setSeatId(event.target.value);
              setResult(null);
              setProblem(null);
            }}
            value={seatId}
          >
            <option value="">Choose a territory</option>
            {territories.map((entry) => (
              <option key={entry.seatId} value={entry.seatId}>
                {entry.territoryName} · {entry.repName ?? "seat vacant"} · {entry.customers} on the list
              </option>
            ))}
          </SearchableSelect>
          {territories.length === 0 ? (
            <AdminCallout tone="warning">
              <span>No territory is in your scope with a line in the organogram, so there is no list to load.</span>
            </AdminCallout>
          ) : null}
        </div>
      </section>

      <section className="border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-5 py-4">
          <h2 className="text-sm font-black uppercase tracking-wide text-slate-900">2 · Send the sheet</h2>
          <p className="mt-1 text-sm font-medium leading-6 text-slate-600">
            The sheet lists what the territory already holds, and has a blank table for the rest. Send it to the rep to fill in — one
            customer per row, with the grade and the potential you want on each.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 px-5 py-4">
          <a
            aria-disabled={!seatId}
            className={BUTTON}
            href={seatId ? `/api/phoenix-crm/list/template?seatId=${encodeURIComponent(seatId)}` : undefined}
            onClick={(event) => {
              if (!seatId) event.preventDefault();
            }}
          >
            <Download aria-hidden className="h-4 w-4" />
            Download the template
          </a>
          {chosen ? <span className="text-sm font-semibold text-slate-600">{chosen.territoryName}</span> : null}
        </div>
      </section>

      <section className="border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-5 py-4">
          <h2 className="text-sm font-black uppercase tracking-wide text-slate-900">3 · Load it back</h2>
          <p className="mt-1 text-sm font-medium leading-6 text-slate-600">
            Every customer on the sheet appears on the rep&rsquo;s list under <strong>To validate</strong>. They validate each one at the
            clinic with a live photo and the location, as they do a customer carried over from iReports360 — that part cannot come from a
            sheet, and the grades you set here are not theirs to change.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 px-5 py-4">
          <input
            accept=".xlsx"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void upload(file);
            }}
            ref={fileInput}
            type="file"
          />
          <button className={BUTTON} disabled={!seatId || uploading} onClick={() => fileInput.current?.click()} type="button">
            {uploading ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Upload aria-hidden className="h-4 w-4" />}
            {uploading ? "Loading the list…" : "Upload the filled sheet"}
          </button>
          {!seatId ? <span className="text-sm font-semibold text-slate-500">Choose a territory first.</span> : null}
        </div>
      </section>

      {problem ? (
        <AdminCallout tone="danger">
          <span>{problem}</span>
        </AdminCallout>
      ) : null}

      {result ? (
        <section className="border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-5 py-4">
            <h2 className="text-sm font-black uppercase tracking-wide text-slate-900">What was loaded</h2>
            <p className="mt-1 text-sm font-medium leading-6 text-slate-600">
              {result.loaded} of {result.read} row{result.read === 1 ? "" : "s"} loaded onto {result.territoryName}.
              {result.hoursSet > 0
                ? ` Days and hours were filled in for ${result.hoursSet} customer${result.hoursSet === 1 ? "" : "s"} already waiting to be validated.`
                : ""}
              {result.refused.length > 0
                ? " The rows below were not: fix them on the sheet and upload it again — the ones that landed are not loaded twice."
                : " Every row was taken."}
            </p>
          </div>
          {result.refused.length > 0 ? (
            // A list, not a table: two facts a row, which on a phone is a sentence and on a desktop is
            // still a sentence. The module's fits-the-screen rule asks for no horizontal scroll, and the
            // cheapest way to honour it is not to build a grid that could need one.
            <ul className="space-y-2 px-5 py-4">
              {result.refused.map((entry) => (
                <li className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-slate-100 pb-2 last:border-b-0" key={`${entry.row}:${entry.reason}`}>
                  <span className="shrink-0 text-phx-sm font-black uppercase tracking-[0.16em] text-slate-500">Row {entry.row}</span>
                  <span className="min-w-0 break-words text-sm text-slate-700">{entry.reason}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
