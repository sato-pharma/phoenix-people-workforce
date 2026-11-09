"use client";

import { AlertTriangle, ArrowRight, Loader2, X } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { ComboBox } from "@/components/sales/normalizer-controls";
import { parseBrickRelocation } from "@/lib/sales/master-data/brick-move-result";
import {
  areaChoices,
  blockChoicesInArea,
  brickCorrectionSubject,
  type BrickMasterRows,
} from "@/lib/sales/master-data/brick-correction";
import { phxFieldClassName } from "@/components/ui/form-tokens";

// "Correct in database" lands here: the Source Normalizer shows each mapped brick's area read-only and
// links a wrong one to this panel (owner request, 2026-09-18). A brick's area is always its block's,
// so the correction picks the area the brick really belongs to, then the block inside it, and moves
// the brick there in one database step (sos_relocate_brick): it gets a new ID in that area, its
// pharmacies and their open-month sales go with it, and the old brick stays switched on as history so
// published months keep their numbers.
//
// SQUARE EDGES throughout, and plain buttons rather than the rounded shared Button: tokens.css still
// rounds by default. The fields stack on a phone and sit side by side from md up; nothing scrolls
// sideways.

export type BrickCorrectionMoved = { lines: string[]; newBrickId: string; pendingFiles: number };

type MoveResponse = { error?: unknown; lines?: unknown; message?: unknown; move?: unknown; newBrickId?: unknown; success?: unknown };

const labelClass = "text-phx-sm font-black uppercase tracking-[0.12em] text-phx-ink-faint";

function Notice({ children, title }: { children: ReactNode; title: string }) {
  return (
    <AdminCallout tone="warning">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 space-y-2">
        <p className="font-semibold">{title}</p>
        {children}
      </div>
    </AdminCallout>
  );
}

export function BrickAreaCorrection({
  brickId,
  onClose,
  onMoved,
  onOpenBrick,
  rows,
}: {
  brickId: string;
  onClose: () => void;
  /** After a move: the page reloads the brick rows, rebuilds the moved files and opens the new brick. */
  onMoved: (moved: BrickCorrectionMoved) => Promise<void> | void;
  /** Opens this panel on another brick: the one a history brick moved to. */
  onOpenBrick: (brickId: string) => void;
  rows: BrickMasterRows;
}) {
  const subject = useMemo(() => brickCorrectionSubject(rows, brickId), [rows, brickId]);
  const currentBlock = subject.kind === "live" ? subject.blockCode : "";
  const areas = useMemo(() => areaChoices(rows, currentBlock), [rows, currentBlock]);
  const [areaCode, setAreaCode] = useState("");
  const blocks = useMemo(() => blockChoicesInArea(rows, areaCode, currentBlock), [rows, areaCode, currentBlock]);
  const [blockCode, setBlockCode] = useState("");
  const [name, setName] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const header = (
    <div className="flex items-start justify-between gap-3 border-b border-phx-line px-4 py-3">
      <div className="min-w-0">
        <p className={labelClass}>Correct in database</p>
        <h2 className="mt-1 text-lg font-black tracking-tight text-phx-ink [overflow-wrap:anywhere]">
          {subject.kind === "missing" ? "Brick not found" : subject.brickName}
        </h2>
      </div>
      <button
        aria-label="Close the correction"
        className="shrink-0 border border-phx-line bg-white p-1.5 text-phx-ink-soft transition hover:border-phx-ink hover:text-phx-ink"
        onClick={onClose}
        title="Close the correction"
        type="button"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );

  if (subject.kind !== "live") {
    return (
      <section className="border border-phx-line bg-white">
        {header}
        <div className="p-4">
          {subject.kind === "missing" ? (
            <Notice title="No brick with this link is in the brick master.">
              <p>Find it by name in the Brick Master rows below.</p>
            </Notice>
          ) : subject.kind === "history" ? (
            <Notice title={`${subject.brickName} is kept as history: it already moved to ${subject.successorName}.`}>
              <p>
                Published months keep their numbers through it, so it stays switched on and does not move again.
                Correct the brick it moved to instead.
              </p>
              <button
                className="inline-flex items-center gap-1.5 border border-[#0B0B0B] bg-[#0B0B0B] px-3 py-1.5 text-sm font-black text-white transition hover:bg-phx-accent"
                onClick={() => onOpenBrick(subject.successorId)}
                type="button"
              >
                Correct {subject.successorName}
                <ArrowRight className="h-4 w-4" />
              </button>
            </Notice>
          ) : (
            <Notice title={`${subject.brickName} is switched off.`}>
              <p>Switch it back on in the Brick Master rows below, then correct its area.</p>
            </Notice>
          )}
        </div>
      </section>
    );
  }

  const pickedAreaName = areas.find((choice) => choice.value === areaCode)?.name ?? "";
  const brickName = name ?? subject.brickName;
  const canMove = Boolean(blockCode) && brickName.trim() !== "" && !moving;

  function pickArea(value: string) {
    setAreaCode(value);
    setError(null);
    const inArea = blockChoicesInArea(rows, value, currentBlock);
    setBlockCode(inArea.length === 1 ? inArea[0].value : "");
  }

  async function move() {
    if (subject.kind !== "live" || !canMove) return;
    setMoving(true);
    setError(null);
    try {
      const response = await fetch(`/api/sales/database-mapping/bricks/${encodeURIComponent(subject.brickId)}/relocate`, {
        body: JSON.stringify({ brickName: brickName.trim(), newBlockCode: blockCode }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as MoveResponse;
      if (!response.ok || payload.success !== true) {
        setError(typeof payload.error === "string" && payload.error ? payload.error : "The brick could not be moved. Nothing was moved.");
        return;
      }
      const result = parseBrickRelocation(payload.move);
      const newBrickId = result?.newBrickId ?? (typeof payload.newBrickId === "string" ? payload.newBrickId : "");
      const lines = Array.isArray(payload.lines)
        ? payload.lines.filter((line): line is string => typeof line === "string" && line.trim() !== "")
        : typeof payload.message === "string" ? [payload.message] : [];
      await onMoved({ lines, newBrickId, pendingFiles: result?.pendingFiles ?? 0 });
    } catch {
      setError("The move could not be confirmed. Check the connection, then reload the page to see where the brick is now.");
    } finally {
      setMoving(false);
    }
  }

  return (
    <section className="border border-phx-line bg-white">
      {header}
      <div className="space-y-4 p-4">
        <dl className="grid gap-2 text-sm sm:grid-cols-3">
          <div className="min-w-0">
            <dt className={labelClass}>Area now</dt>
            <dd className="mt-0.5 font-semibold text-phx-ink [overflow-wrap:anywhere]">{subject.areaName || "No area on the brick master"}</dd>
          </div>
          <div className="min-w-0">
            <dt className={labelClass}>Region</dt>
            <dd className="mt-0.5 text-phx-ink-soft [overflow-wrap:anywhere]">{subject.regionName || "No region on the brick master"}</dd>
          </div>
          <div className="min-w-0">
            <dt className={labelClass}>Block</dt>
            <dd className="mt-0.5 text-phx-ink-soft [overflow-wrap:anywhere]">{subject.blockName || "No block on the brick master"}</dd>
          </div>
        </dl>

        <div className="grid gap-3 md:grid-cols-3">
          <label className="flex min-w-0 flex-col gap-1">
            <span className={labelClass}>Area it belongs to</span>
            <ComboBox className="min-w-0 w-full" disabled={moving} onChange={pickArea} options={areas} placeholder="Type an area or region" value={areaCode} />
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className={labelClass}>Block in that area</span>
            <ComboBox
              className="min-w-0 w-full"
              disabled={moving || !areaCode}
              onChange={(value) => {
                setBlockCode(value);
                setError(null);
              }}
              options={blocks}
              placeholder={areaCode ? "Pick the block" : "Pick the area first"}
              value={blockCode}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className={labelClass}>Brick name</span>
            <input
              className={`${phxFieldClassName} min-w-0`}
              disabled={moving}
              onChange={(event) => setName(event.target.value)}
              value={brickName}
            />
          </label>
        </div>

        <p className="text-sm text-phx-ink-soft">
          Moving gives the brick a new ID in the area you pick. Its pharmacies and their sales in every open month go
          with it. Published months never change: the old brick stays switched on as history so they keep their
          numbers.
        </p>

        {error ? (
          <AdminCallout tone="danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="min-w-0 [overflow-wrap:anywhere]">{error}</p>
          </AdminCallout>
        ) : null}

        <button
          className="inline-flex items-center gap-2 border border-[#0B0B0B] bg-[#0B0B0B] px-4 py-2 text-sm font-black text-white transition hover:bg-phx-accent disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!canMove}
          onClick={() => void move()}
          type="button"
        >
          {moving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
          {moving ? "Moving the brick" : pickedAreaName ? `Move to ${pickedAreaName}` : "Move"}
        </button>
      </div>
    </section>
  );
}
