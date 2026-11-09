"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, MoveRight } from "lucide-react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import type { SalesDistributorEntry } from "@/lib/sales/distributor-registry";
import type { AddressFindingRow } from "@/lib/sales/normalizer/address-findings";

const label = "mb-1 block text-phx-sm font-black uppercase tracking-[0.12em] text-phx-ink-faint";
const headRow = "bg-[#020617] text-left text-phx-xs font-black uppercase tracking-[0.12em] text-white";

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  try { return JSON.parse(text) as T; } catch { return { success: false, error: text } as unknown as T; }
}

type ScanPage = { success: boolean; done?: boolean; error?: string; findings?: AddressFindingRow[]; nextAfter?: number; scanned?: number };

// The list of pharmacies whose address names another town than their brick. Reading it changes
// nothing; only Move and Keep here write, one row at a time, as a ruling the next upload will not undo.
export function WrongTownFinder({ distributors }: { distributors: SalesDistributorEntry[] }) {
  const [rows, setRows] = useState<AddressFindingRow[]>([]);
  const [scanned, setScanned] = useState(0);
  const [scanning, setScanning] = useState(true);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const resumeFrom = useRef(0);
  const alive = useRef(true);
  const walking = useRef(false);

  const distributorName = (code: string) => distributors.find((d) => d.code === code)?.name ?? code;

  // Starts already scanning, so the effect below sets no state before its first await.
  const walk = useCallback(async () => {
    if (walking.current) return;
    walking.current = true;
    try {
      for (;;) {
        const res = await fetch(`/api/sales/mapping-database/address-findings?after=${resumeFrom.current}`);
        const page = await readJson<ScanPage>(res);
        if (!alive.current) return;
        if (!page.success) { setError(page.error ?? "Could not read the list."); return; }
        resumeFrom.current = page.nextAfter ?? resumeFrom.current;
        setScanned((n) => n + (page.scanned ?? 0));
        setRows((list) => [...list, ...(page.findings ?? [])]);
        if (page.done) { setDone(true); return; }
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : "Could not read the list.");
    } finally {
      walking.current = false;
      if (alive.current) setScanning(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void walk();
    return () => { alive.current = false; };
  }, [walk]);

  async function rule(row: AddressFindingRow, decision: "keep" | "move") {
    setBusyId(row.id); setError(null); setNotice(null);
    try {
      const res = await fetch("/api/sales/mapping-database/address-findings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, expectedBrickId: row.current.brickId, expectedTargetBrickId: row.suggested.brickId, expectedUpdatedAt: row.updatedAt, id: row.id }),
      });
      const payload = await readJson<{ success: boolean; backfilled?: number; brickName?: string; error?: string }>(res);
      if (!payload.success) { setError(payload.error ?? "The ruling was not saved."); return; }
      setRows((list) => list.filter((r) => r.id !== row.id));
      setNotice(decision === "move"
        ? `${row.customerName || row.customerCode} moved to ${payload.brickName ?? row.suggested.brickName}.`
        : `${row.customerName || row.customerCode} stays on ${row.current.brickName}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The ruling was not saved.");
    } finally {
      setBusyId(null);
    }
  }

  const pharmacy = (r: AddressFindingRow) => (
    <>
      <span className="block break-words font-semibold text-phx-ink" dir="auto">{r.customerName || r.customerCode}</span>
      <span className="block break-words text-xs text-phx-ink-soft">{distributorName(r.distributorCode)} · <span className="font-mono">{r.customerCode}</span></span>
      <span className="mt-1 block break-words text-sm text-phx-ink" dir="auto">{r.address}</span>
      <span className="mt-1 block text-xs text-phx-ink-soft">
        {r.kind === "longer-name" ? "The address gives a longer place name than this brick's." : "The address names another town and nothing in this area."}
        {r.nextUploadMoves ? " The next upload would make this same move." : ""}
      </span>
    </>
  );
  const brick = (b: AddressFindingRow["current"]) => (
    <>
      <span className="block break-words font-semibold text-phx-ink" dir="auto">{b.brickName}</span>
      <span className="block break-words text-xs text-phx-ink-soft">{b.areaName}</span>
    </>
  );
  const facts = (r: AddressFindingRow) => (
    <div className="space-y-1 text-xs text-phx-ink-soft">
      <p>
        {r.sales === null ? "Sales could not be read."
          : r.sales.rows > 0 ? `${r.sales.rows.toLocaleString()} sale rows in ${r.sales.months} ${r.sales.months === 1 ? "month" : "months"}. On Move, published months stay as they are and unpublished months follow overnight.`
          : "No sales on file."}
      </p>
      {r.twins === null ? <p>The other Ibn Sina copies could not be read.</p> : null}
      {(r.twins ?? []).map((t) => (
        <p key={`${t.distributorCode}-${t.customerCode}`}>
          Also at {distributorName(t.distributorCode)} under <span className="font-mono">{t.customerCode}</span>, on <span dir="auto">{t.brickName}</span>. Rule on that copy too.
        </p>
      ))}
    </div>
  );
  const actions = (r: AddressFindingRow) => (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button className="h-8 gap-1 bg-[#0B0B0B] font-black text-white hover:bg-phx-accent" disabled={busyId !== null} onClick={() => void rule(r, "move")} type="button">
        {busyId === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoveRight className="h-3.5 w-3.5" />}Move
      </Button>
      <Button className="h-8" disabled={busyId !== null} onClick={() => void rule(r, "keep")} type="button" variant="secondary">Keep here</Button>
    </div>
  );

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm text-phx-ink-soft">
        {scanning ? <Loader2 className="h-4 w-4 animate-spin text-phx-accent" /> : null}
        <span>
          {done ? `All ${scanned.toLocaleString()} mappings read.` : `${scanned.toLocaleString()} mappings read so far.`}{" "}
          {rows.length.toLocaleString()} {rows.length === 1 ? "needs" : "need"} a ruling.
        </span>
        {error && !scanning && !done ? <Button className="h-8" onClick={() => { setScanning(true); setError(null); void walk(); }} type="button" variant="secondary">Carry on reading</Button> : null}
      </div>
      <p className="text-xs text-phx-ink-soft">Only what is clear is listed: an address that could mean two places is left out. A ruling sticks, and no upload changes it afterwards.</p>

      {error ? <AdminCallout tone="danger"><span>{error}</span></AdminCallout> : null}
      {notice ? <AdminCallout tone="success"><span>{notice}</span></AdminCallout> : null}

      {rows.length === 0 && done ? <p className="border border-phx-line p-4 text-center text-xs text-phx-ink-soft">No address names another town.</p> : null}

      <div className="space-y-2 md:hidden">
        {rows.map((r) => (
          <div className="space-y-2 border border-phx-line p-3" key={r.id}>
            <div>{pharmacy(r)}</div>
            <div><span className={label}>Now on</span>{brick(r.current)}</div>
            <div><span className={label}>The address says</span>{brick(r.suggested)}</div>
            {facts(r)}
            {actions(r)}
          </div>
        ))}
      </div>

      <div className="hidden border border-phx-line md:block">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col className="w-[36%]" /><col className="w-[16%]" /><col className="w-[16%]" /><col className="w-[32%]" />
          </colgroup>
          <thead className={headRow}><tr>
            <th className="px-3 py-2">Pharmacy and address</th>
            <th className="px-3 py-2">Now on</th>
            <th className="px-3 py-2">The address says</th>
            <th className="px-3 py-2">Sales and ruling</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr className="border-b border-[#FFE8D6] align-top" key={r.id}>
                <td className="px-3 py-2">{pharmacy(r)}</td>
                <td className="px-3 py-2">{brick(r.current)}</td>
                <td className="px-3 py-2">{brick(r.suggested)}</td>
                <td className="space-y-2 px-3 py-2">{facts(r)}{actions(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
