"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ChevronDown, ChevronRight, Download, Layers, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LABEL_CLASS, SURFACE_CLASS, SectionCard, formatEgpFull, formatPeriod } from "@/components/sales/target-visuals";
import { cn } from "@/lib/utils";
import { phxSelectClassName } from "@/components/ui/form-tokens";

// ─────────────────────────────────────────────────────────────────────────────
// Targets — AUTHORING.
//
// This screen exists to set next quarter's numbers, and nothing else. It carries no achievement:
// no ring, no percentage, no region/DM roll-up, no sales column (owner, 2026-09-08 — achievement
// lives on Business Review and on the portal's read-only Targets tab, which is a different
// audience and keeps it).
//
// NO TABLE, AND NO SCROLLING BOX (owner, 2026-09-08: "I don't want this table, it looks very
// fragile"). The grid is a set of REGION buttons instead: press one and its areas open underneath,
// each area listing its products with the two inputs. Regions open and close independently, more
// than one at a time, and nothing is inside its own scrollbar — the page scrolls, once, like a
// page. This also satisfies the fits-the-screen golden rule by construction rather than by
// measurement: there is no fixed-width grid left to overflow, and the SAME markup serves the phone
// and the desktop.
//
// The rows come from the MODEL — every targetable area × every active product on the line — not
// from `au.f_monthly_achievement`, which only returns cells that already have a target or a sale.
// That is what makes an empty future month typeable; see the page for the full account.
//
// UNITS ARE NEVER TOTALLED. A unit total across different products is meaningless (owner rule), so
// every total here is VALUE, plus a count of how many cells are set. Units sort per area, which is
// a comparison, not a sum.
// ─────────────────────────────────────────────────────────────────────────────

export type TargetGridRow = {
  areaCode: string;
  areaName: string;
  regionCode: string | null;
  regionName: string;
  areaState: string | null;
  productCode: string;
  productName: string;
  unitPrice: number | null;
  targetUnits: number | null;
  targetValue: number | null;
};

/** What the file turned out to contain — the months are the half that needs confirming. */
type UploadPeriod = { period: string; lineCode: string; rows: number; overwrites: number };
type UploadPreview = {
  totalRows: number;
  validRows: number;
  periods: UploadPeriod[];
  errors: { rowNumber: number; message: string }[];
};

/** Month | Quarter | Semester — the span one template download covers. */
export const TEMPLATE_SCOPES = [
  { value: "month", label: "This month" },
  { value: "quarter", label: "This quarter (3 months)" },
  { value: "semester", label: "This semester (6 months)" },
] as const;

export type TemplateScope = (typeof TEMPLATE_SCOPES)[number]["value"];

const keyOf = (row: TargetGridRow): string => `${row.areaCode}|${row.productCode}`;

const SORTS = [
  { value: "area", label: "Area A → Z" },
  { value: "value-desc", label: "Highest target value" },
  { value: "units-desc", label: "Highest target units" },
] as const;

type Sort = (typeof SORTS)[number]["value"];

// ── The unsaved-edit draft ───────────────────────────────────────────────────
//
// A number typed into this grid used to exist in exactly one place — React state — and three
// ordinary actions threw it away in silence: switching the Line/Month dropdown, reloading, and
// clicking any link in the sidebar. On 2026-09-08 the SFE Manager re-entered a month of Pedia
// targets by hand and lost all of them. Nothing could be recovered: the Supabase gateway logged
// ZERO calls to phx_upsert_monthly_targets that day, `au.monthly_targets` keeps no history, and a
// daily backup holds only what was committed. The values had never left his browser.
//
// So the draft is the LOAD-BEARING half of the guard and the beforeunload prompt only the polite
// half — `beforeunload` cannot fire on a Next.js soft navigation, so a sidebar click is caught by
// the draft alone.
//
// `localStorage`, not `sessionStorage`: closing the tab and coming back is precisely the case that
// lost the work. SCOPED to one line + month, because restoring August's numbers onto September's
// grid is the one outcome worse than losing them.
const TARGET_DRAFT_KEY = "phoenix.sales.targets.draft.v1";

/** A draft older than this belongs to a different sitting — drop it rather than silently re-open it. */
const TARGET_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type TargetDraft = {
  savedAt: number;
  /** `${line}|${period}` — a draft is only ever restored onto the grid it was typed on. */
  scope: string;
  edits: Record<string, string>;
  unitEdits: Record<string, string>;
};

const draftScopeOf = (line: string, period: string): string => `${line}|${period}`;

/** Only entries that are still strings survive; anything else is treated as a corrupt draft. */
function draftStrings(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries((value ?? {}) as Record<string, unknown>)) {
    if (typeof raw === "string") out[key] = raw;
  }
  return out;
}

export function readTargetDraft(scope: string): TargetDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(TARGET_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TargetDraft> | null;
    if (!parsed || parsed.scope !== scope) return null;
    const savedAt = Number(parsed.savedAt);
    if (!Number.isFinite(savedAt) || Date.now() - savedAt > TARGET_DRAFT_MAX_AGE_MS) return null;
    return { savedAt, scope, edits: draftStrings(parsed.edits), unitEdits: draftStrings(parsed.unitEdits) };
  } catch {
    return null;
  }
}

export function writeTargetDraft(draft: TargetDraft | null): void {
  if (typeof window === "undefined") return;
  try {
    if (!draft) {
      window.localStorage.removeItem(TARGET_DRAFT_KEY);
      return;
    }
    window.localStorage.setItem(TARGET_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // A draft that cannot be written (private mode, a full quota) is exactly how this page behaved
    // before it had one. It must never surface as a save failure.
  }
}

const fmtUnits = (value: number | null): string =>
  value == null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 0 });

/**
 * The stored number as an input's default text.
 *
 * `String(4543.918236)` is what a target value looks like when it was computed as units × factory
 * price, and a column of those is unreadable. Trimmed to a precision that still says the same
 * number — 2 decimals for money, 3 for units — with trailing zeros dropped, so `74.79700` reads
 * `74.797` and `4543.918236` reads `4543.92`.
 *
 * Display only: an untouched row is never sent on save (only edited keys are), so trimming here
 * cannot rewrite a stored value behind anyone's back. A row he DOES retype saves what he can see,
 * which is the honest outcome — the alternative is a field showing a number that differs from the
 * one it would save.
 */
function fieldValue(value: number | null, decimals: number): string {
  if (value == null) return "";
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(decimals)));
}

// ── Premium polish ───────────────────────────────────────────────────────────
//
// DEPTH ONLY, NEVER RADII. The square-edge golden rule stands: no round or semi-round corners
// anywhere. PR #3114 once cut radii and depth together, so restoring "the premium look" out of
// history re-rounds every corner — the depth is the half worth having and the only half taken
// here. Every surface below is measured at `border-radius: 0px`.
//
// The visual language is the sibling one (the page header on Sales vs Target, 2026-09-14 light
// look): a white surface, an orange rule along the top, an orange kicker in wide tracking, calm
// slate-900 numerals. What is NOT borrowed is its height — the owner threw out the 580px hero on
// 2026-09-08, so this carries the same identity in a single line.
//
// An OPEN region lifts with the same soft two-layer shadow the shared white card carries.
const CARD_DEPTH = "shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_rgba(15,23,42,0.05)]";

/** A labelled native select. Never shrunk — the owner's fits-the-screen rule forbids it. */
function Picker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex min-w-0 items-center gap-1.5">
      <span className={LABEL_CLASS}>{label}</span>
      <select
        className={`${phxSelectClassName} max-w-full`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A quiet white action (a download link, a toggle) that turns orange on hover and focus. */
const OUTLINE_ACTION_CLASS =
  "inline-flex h-8 items-center border border-slate-200 bg-white px-3 text-phx-xs font-bold text-slate-700 transition-colors hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-orange-500";

/** Completeness, as a hairline. Square by construction — no rounded cap anywhere. */
function CompletionBar({ done, of }: { done: number; of: number }) {
  const fraction = of > 0 ? Math.max(0, Math.min(1, done / of)) : 0;
  return (
    <span className="block h-1.5 w-full bg-slate-100" aria-hidden>
      <span
        className={cn("block h-full transition-[width] duration-300", fraction === 1 ? "bg-emerald-500" : "bg-orange-500")}
        style={{ width: `${fraction * 100}%` }}
      />
    </span>
  );
}

export function TargetsAuthoring(props: {
  lines: ReadonlyArray<{ code: string; label: string }>;
  periods: string[];
  selectedLine: string;
  selectedPeriod: string;
  rows: TargetGridRow[];
  error: string | null;
  canEdit?: boolean;
  /** Super Admin only — renders "Drop this month". The route re-checks the role; this is UX. */
  canDrop?: boolean;
}) {
  const router = useRouter();
  const canEdit = props.canEdit !== false;
  const canDrop = canEdit && props.canDrop === true;

  const [edits, setEdits] = useState<Record<string, string>>({});
  const [unitEdits, setUnitEdits] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<UploadPreview | null>(null);
  const [busy, setBusy] = useState<null | "preview" | "commit" | "save" | "drop">(null);
  const [message, setMessage] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [region, setRegion] = useState("all");
  const [area, setArea] = useState("all");
  const [product, setProduct] = useState("all");
  const [status, setStatus] = useState<"all" | "set" | "blank">("all");
  const [sort, setSort] = useState<Sort>("area");
  const [scope, setScope] = useState<TemplateScope>("month");
  const [openRegions, setOpenRegions] = useState<Record<string, boolean>>({});

  const lineLabel = props.lines.find((line) => line.code === props.selectedLine)?.label ?? props.selectedLine;

  const rowByKey = useMemo(() => new Map(props.rows.map((row) => [keyOf(row), row])), [props.rows]);
  const editedKeys = useMemo(
    () => Array.from(new Set([...Object.keys(edits), ...Object.keys(unitEdits)])),
    [edits, unitEdits],
  );
  const hasUnsavedEdits = editedKeys.length > 0;
  const draftScope = draftScopeOf(props.selectedLine, props.selectedPeriod);
  // The SCOPE already restored, not a bare boolean: switching the Month dropdown re-renders this
  // same component instance with new props rather than remounting it, so a boolean would latch on
  // the first grid and the second month's draft would never come back.
  const draftRestoredRef = useRef<string | null>(null);

  // Bring back whatever was left unsaved last time, once per grid, and only once the rows are on
  // screen: a draft entry is only meaningful against a row that still exists.
  //
  // Shaped around `await Promise.resolve()` because a synchronous setState in an effect body is a
  // lint ERROR here (react-hooks/set-state-in-effect). This is the case that rule allows —
  // reconciling with a store outside React that cannot be read during render.
  useEffect(() => {
    if (draftRestoredRef.current === draftScope || !canEdit || props.rows.length === 0) return;
    draftRestoredRef.current = draftScope;

    let cancelled = false;
    async function restoreDraft() {
      await Promise.resolve();
      if (cancelled) return;

      const draft = readTargetDraft(draftScope);
      if (!draft) return;

      // An entry that now MATCHES the row on screen is not pending — it was saved, or somebody
      // else typed the same number. Carrying it would light a permanent "Not saved yet" badge
      // over nothing, which teaches the reader to ignore the badge.
      const pending = (
        stored: Record<string, string>,
        liveValue: (row: TargetGridRow) => number | null,
      ): Record<string, string> => {
        const out: Record<string, string> = {};
        for (const [key, raw] of Object.entries(stored)) {
          const row = rowByKey.get(key);
          if (!row) continue;
          const live = liveValue(row);
          const unchanged = raw === "" ? live == null : Number(raw) === live;
          if (!unchanged) out[key] = raw;
        }
        return out;
      };

      const values = pending(draft.edits, (row) => row.targetValue);
      const units = pending(draft.unitEdits, (row) => row.targetUnits);
      const count = new Set([...Object.keys(values), ...Object.keys(units)]).size;
      if (count === 0) {
        writeTargetDraft(null);
        return;
      }

      // Open the regions the restored edits belong to, or they come back invisible behind a
      // collapsed button and read as lost all over again.
      const regions = new Set<string>();
      for (const key of [...Object.keys(values), ...Object.keys(units)]) {
        const row = rowByKey.get(key);
        if (row) regions.add(row.regionName || "—");
      }

      // `...current` last: anything typed in the moment before this landed outranks the draft.
      setEdits((current) => ({ ...values, ...current }));
      setUnitEdits((current) => ({ ...units, ...current }));
      setOpenRegions((current) => ({ ...Object.fromEntries([...regions].map((name) => [name, true])), ...current }));
      setMessage(
        `Restored ${count} unsaved edit${count === 1 ? "" : "s"} from your last visit to this grid. `
          + "Nothing is stored until you press \"Save edits\".",
      );
    }

    void restoreDraft();
    return () => {
      cancelled = true;
    };
  }, [canEdit, draftScope, props.rows.length, rowByKey]);

  // Persist on every keystroke, so the draft is never more than one character behind the screen.
  useEffect(() => {
    if (draftRestoredRef.current !== draftScope) return;
    writeTargetDraft(hasUnsavedEdits ? { savedAt: Date.now(), scope: draftScope, edits, unitEdits } : null);
  }, [draftScope, edits, hasUnsavedEdits, unitEdits]);

  // Reload / tab close / a link out of the app. The browser writes its own sentence; all a page
  // can do is ASK for the prompt, which needs preventDefault AND the legacy returnValue.
  useEffect(() => {
    if (!hasUnsavedEdits) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [hasUnsavedEdits]);

  function navigate(line: string, period: string) {
    // Both dropdowns funnel through here, and both used to wipe the grid without a word. This is
    // the one exit that is DELIBERATE, so confirming it drops the draft with the edits; the draft
    // is there for the exits nobody chose — a reload, a sidebar click, a closed tab.
    if (
      hasUnsavedEdits
      && !window.confirm(
        `${editedKeys.length} unsaved target edit${editedKeys.length === 1 ? "" : "s"} on this grid will be discarded.\n\n`
          + "Press Cancel to go back and press \"Save edits\" first — nothing typed here is stored until you do.",
      )
    ) {
      return;
    }
    setEdits({});
    setUnitEdits({});
    setPreview(null);
    setMessage(null);
    router.push(`/sales/targets?line=${encodeURIComponent(line)}&period=${encodeURIComponent(period)}`);
  }

  /** The live value of a cell — the pending edit when there is one, else what is stored. */
  const liveValueOf = (row: TargetGridRow): number | null => {
    const raw = edits[keyOf(row)];
    if (raw === undefined) return row.targetValue;
    if (raw === "") return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const liveUnitsOf = (row: TargetGridRow): number | null => {
    const raw = unitEdits[keyOf(row)];
    if (raw === undefined) return row.targetUnits;
    if (raw === "") return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const productOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of props.rows) seen.set(row.productCode, row.productName || row.productCode);
    return [
      { value: "all", label: "All products" },
      ...[...seen.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label })),
    ];
  }, [props.rows]);

  const regionOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const row of props.rows) if (row.regionName) seen.add(row.regionName);
    return [{ value: "all", label: "All regions" }, ...[...seen].sort().map((name) => ({ value: name, label: name }))];
  }, [props.rows]);

  // The Area list follows the Region choice, so it can never offer an area that the current
  // region filter would immediately hide — a picker wider than its own result is how an empty
  // board reads as broken data rather than as a filter.
  const areaOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of props.rows) {
      if (region !== "all" && row.regionName !== region) continue;
      seen.set(row.areaCode, row.areaName || row.areaCode);
    }
    return [
      { value: "all", label: "All areas" },
      ...[...seen.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label })),
    ];
  }, [props.rows, region]);

  // ── Region → area → products ────────────────────────────────────────────────
  //
  // Built once per render from the filtered rows. Every total is VALUE; `set` counts filled cells.
  const regions = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matching = props.rows.filter((row) => {
      if (region !== "all" && row.regionName !== region) return false;
      if (area !== "all" && row.areaCode !== area) return false;
      if (product !== "all" && row.productCode !== product) return false;
      if (status !== "all") {
        // The LIVE value, so a cell you have just typed counts as set before it is saved.
        const filled = liveValueOf(row) != null;
        if (status === "set" && !filled) return false;
        if (status === "blank" && filled) return false;
      }
      if (!needle) return true;
      return `${row.areaName} ${row.areaCode} ${row.productName} ${row.productCode} ${row.regionName}`
        .toLowerCase()
        .includes(needle);
    });

    type Area = { areaCode: string; areaName: string; areaState: string | null; rows: TargetGridRow[]; value: number; units: number | null; set: number };
    type Region = { name: string; areas: Area[]; value: number; set: number; cells: number };

    const byRegion = new Map<string, Map<string, Area>>();
    for (const row of matching) {
      const regionName = row.regionName || "—";
      let areas = byRegion.get(regionName);
      if (!areas) {
        areas = new Map<string, Area>();
        byRegion.set(regionName, areas);
      }
      let area = areas.get(row.areaCode);
      if (!area) {
        area = { areaCode: row.areaCode, areaName: row.areaName || row.areaCode, areaState: row.areaState, rows: [], value: 0, units: null, set: 0 };
        areas.set(row.areaCode, area);
      }
      area.rows.push(row);
      const value = liveValueOf(row);
      if (value != null) {
        area.value += value;
        area.set += 1;
      }
      // A single-product filter makes a unit comparison between areas meaningful; with several
      // products in view there is no such number, and none is shown.
      const units = liveUnitsOf(row);
      if (product !== "all" && units != null) area.units = (area.units ?? 0) + units;
    }

    const desc = (left: number | null, right: number | null): number => {
      if (left == null && right == null) return 0;
      if (left == null) return 1;
      if (right == null) return -1;
      return right - left;
    };

    const out: Region[] = [...byRegion.entries()].map(([name, areas]) => {
      const list = [...areas.values()];
      for (const area of list) area.rows.sort((a, b) => a.productName.localeCompare(b.productName));
      list.sort((left, right) => {
        if (sort === "value-desc") return desc(left.value || null, right.value || null) || left.areaName.localeCompare(right.areaName);
        if (sort === "units-desc") return desc(left.units, right.units) || left.areaName.localeCompare(right.areaName);
        return left.areaName.localeCompare(right.areaName);
      });
      return {
        name,
        areas: list,
        value: list.reduce((sum, area) => sum + area.value, 0),
        set: list.reduce((sum, area) => sum + area.set, 0),
        cells: list.reduce((sum, area) => sum + area.rows.length, 0),
      };
    });

    out.sort((left, right) =>
      sort === "value-desc" || sort === "units-desc" ? right.value - left.value || left.name.localeCompare(right.name) : left.name.localeCompare(right.name),
    );
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- edits/unitEdits are read via liveValueOf/liveUnitsOf
  }, [area, edits, product, props.rows, region, search, sort, status, unitEdits]);

  const totals = useMemo(
    () => ({
      value: regions.reduce((sum, region) => sum + region.value, 0),
      set: regions.reduce((sum, region) => sum + region.set, 0),
      cells: regions.reduce((sum, region) => sum + region.cells, 0),
    }),
    [regions],
  );

  const allOpen = regions.length > 0 && regions.every((region) => openRegions[region.name]);

  async function runUpload(commit: boolean) {
    if (!file) {
      setMessage("Choose an .xlsx file first.");
      return;
    }

    // ── The month guard ──────────────────────────────────────────────────────
    //
    // The sheet carries its own Period column, so the month it writes is whatever is inside the
    // FILE, not the month on screen. Last quarter's sheet uploaded by mistake would overwrite
    // three closed months with no trace, so the save names every month first and asks. The server
    // checks the same list again (`confirmPeriods`) — a confirmation nothing verifies is
    // decoration. One question covers however many months the file holds.
    const confirmPeriods = (preview?.periods ?? []).map((entry) => entry.period);
    if (commit) {
      if (confirmPeriods.length === 0) {
        setMessage("Check the file first — the months it writes have to be confirmed before saving.");
        return;
      }
      const lines = (preview?.periods ?? []).map(
        (entry) =>
          `  • ${formatPeriod(entry.period)} — ${entry.rows.toLocaleString("en-US")} row(s)`
          + (entry.overwrites > 0 ? `, ${entry.overwrites.toLocaleString("en-US")} replacing a target already set` : ""),
      );
      const months = [...new Set(confirmPeriods)];
      if (
        !window.confirm(
          `This file writes targets for ${months.length} month${months.length === 1 ? "" : "s"}:\n\n${lines.join("\n")}\n\n`
            + "A replaced target cannot be recovered — nothing keeps its previous value. Save?",
        )
      ) {
        return;
      }
    }

    setBusy(commit ? "commit" : "preview");
    setMessage(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("commit", commit ? "true" : "false");
      if (commit) form.append("confirmPeriods", confirmPeriods.join(","));
      const res = await fetch("/api/sales/targets/upload", { method: "POST", body: form });
      const json = await res.json();
      if (!json.success) {
        // A 409 means the file's months are not the ones that were confirmed — re-check it rather
        // than letting a second press through.
        if (json.code === "period_confirmation_required") setPreview(null);
        setMessage(json.error ?? "Upload failed.");
        return;
      }
      if (commit) {
        setPreview(null);
        setFile(null);
        setMessage(`Saved ${json.upserted} target row(s).${json.errors?.length ? ` ${json.errors.length} row(s) rejected.` : ""}`);
        router.refresh();
      } else {
        setPreview({
          totalRows: json.totalRows,
          validRows: json.validRows,
          periods: json.periods ?? [],
          errors: json.errors ?? [],
        });
      }
    } catch {
      setMessage("Upload failed (network).");
    } finally {
      setBusy(null);
    }
  }

  async function saveEdits() {
    const parse = (raw: string | undefined, fallback: number | null): number | null => {
      if (raw === undefined) return fallback;
      if (raw === "") return null;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const rows = editedKeys
      .map((key) => {
        const [areaCode, productCode] = key.split("|");
        const existing = rowByKey.get(key);
        return {
          areaCode,
          productCode,
          targetUnits: parse(unitEdits[key], existing?.targetUnits ?? null),
          targetValue: parse(edits[key], existing?.targetValue ?? null),
        };
      })
      .filter(
        (row) =>
          (row.targetUnits != null && Number.isFinite(row.targetUnits) && row.targetUnits >= 0)
          || (row.targetValue != null && Number.isFinite(row.targetValue) && row.targetValue >= 0),
      );
    if (rows.length === 0) {
      setMessage("No valid edited values to save.");
      return;
    }
    setBusy("save");
    setMessage(null);
    try {
      const res = await fetch("/api/sales/targets/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ period: props.selectedPeriod, line: props.selectedLine, rows }),
      });
      const json = await res.json();
      if (!json.success) {
        setMessage(json.error ?? "Save failed.");
        return;
      }
      setEdits({});
      setUnitEdits({});
      setMessage(`Saved ${json.upserted} target row(s).${json.errors?.length ? ` ${json.errors.length} rejected.` : ""}`);
      router.refresh();
    } catch {
      setMessage("Save failed (network).");
    } finally {
      setBusy(null);
    }
  }

  // Targets stored for this line + month (not counting unsaved typing) — what a drop would remove.
  const storedCells = props.rows.filter((row) => row.targetUnits != null || row.targetValue != null).length;

  async function dropMonth() {
    if (
      !window.confirm(
        `Drop ALL ${lineLabel} targets for ${formatPeriod(props.selectedPeriod)}?\n\n`
          + `${storedCells.toLocaleString("en-US")} stored target cell(s) will be removed from this line and month only. `
          + "They are archived first, but nothing on this screen brings them back.\n\nPress OK to drop them.",
      )
    ) {
      return;
    }
    setBusy("drop");
    setMessage(null);
    try {
      const res = await fetch("/api/sales/targets/drop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ period: props.selectedPeriod, line: props.selectedLine }),
      });
      const json = await res.json();
      if (!json.success) {
        setMessage(json.error ?? "Drop failed.");
        return;
      }
      // Typing for the dropped grid is stale now; leaving it would offer to re-save the dropped numbers.
      setEdits({});
      setUnitEdits({});
      setMessage(`Dropped ${json.dropped} ${lineLabel} target row(s) for ${formatPeriod(props.selectedPeriod)}.`);
      router.refresh();
    } catch {
      setMessage("Drop failed (network).");
    } finally {
      setBusy(null);
    }
  }

  /** Typing units auto-fills Target value = units × unit price. The value stays editable after. */
  const onUnitsChange = (row: TargetGridRow, raw: string) => {
    const key = keyOf(row);
    setUnitEdits((current) => ({ ...current, [key]: raw }));
    const units = Number(raw);
    if (raw !== "" && Number.isFinite(units) && row.unitPrice != null) {
      setEdits((current) => ({ ...current, [key]: String(Math.round(units * row.unitPrice!)) }));
    }
  };

  const onValueChange = (key: string, raw: string) => setEdits((current) => ({ ...current, [key]: raw }));

  const templateHref = (populated: boolean): string =>
    `/api/sales/targets/template?line=${encodeURIComponent(props.selectedLine)}`
    + `&period=${encodeURIComponent(props.selectedPeriod)}`
    + `&scope=${encodeURIComponent(scope)}`
    + `&populated=${populated ? "true" : "false"}`;

  return (
    <div className="space-y-4 p-3 md:p-4">
      {/* ── Command strip. One line, no hero: line, month, and the two figures that describe the
             month being authored. Wraps rather than scrolls (fits-the-screen golden rule).
             SURFACE_CLASS goes FIRST: its `border` would otherwise erase the orange top rule
             when the class list is merged. ── */}
      <section className={cn(SURFACE_CLASS, "relative border-t-[3px] border-t-orange-500")}>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-3.5 sm:px-5">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <span className="min-w-0">
              <span className="block text-phx-sm font-black uppercase tracking-[0.24em] text-orange-600">
                Sales Operations
              </span>
              <h1 className="block text-xl font-black leading-tight tracking-tight text-slate-900">Targets</h1>
            </span>
            <Picker
              label="Line"
              value={props.selectedLine}
              options={props.lines.map((line) => ({ value: line.code, label: line.label }))}
              onChange={(value) => navigate(value, props.selectedPeriod)}
            />
            <Picker
              label="Month"
              value={props.selectedPeriod}
              options={props.periods.map((period) => ({ value: period, label: formatPeriod(period) }))}
              onChange={(value) => navigate(props.selectedLine, value)}
            />
          </div>
          <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
            <span className="min-w-0">
              <span className={`block ${LABEL_CLASS}`}>Target</span>
              <span className="block whitespace-nowrap text-xl font-black leading-tight tabular-nums text-sky-600">
                {formatEgpFull(totals.value)}
              </span>
            </span>
            <span className="min-w-0">
              <span className={`block ${LABEL_CLASS}`}>Set</span>
              <span className="block whitespace-nowrap text-xl font-black leading-tight tabular-nums text-slate-900">
                {totals.set.toLocaleString("en-US")}
                <span className="text-sm text-slate-400"> / {totals.cells.toLocaleString("en-US")}</span>
              </span>
            </span>
            <span className="w-28 shrink-0 pb-2">
              <CompletionBar done={totals.set} of={totals.cells} />
            </span>
          </div>
        </div>
      </section>

      {props.error ? (
        <div className="flex items-start gap-3 border border-l-[3px] border-red-200 border-l-red-500 bg-red-50 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
          <p className="min-w-0 text-xs font-semibold leading-5 text-red-800">{props.error}</p>
        </div>
      ) : null}

      {message ? (
        <div className="border border-l-[3px] border-slate-200 border-l-orange-500 bg-white px-4 py-3 text-xs font-semibold text-slate-800">{message}</div>
      ) : null}

      {/* ── Templates. Empty or populated, for a month, a quarter or a semester. ── */}
      {canEdit ? (
        <SectionCard title="Template" subtitle={`${lineLabel} · fill it in Excel and upload it back`} icon={Download}>
          <div className="flex flex-wrap items-center gap-2 p-4">
            <Picker
              label="Covering"
              value={scope}
              options={TEMPLATE_SCOPES.map((entry) => ({ value: entry.value, label: entry.label }))}
              onChange={(value) => setScope(value as TemplateScope)}
            />
            <a className={OUTLINE_ACTION_CLASS} href={templateHref(false)}>
              Download empty
            </a>
            <a
              className="inline-flex h-8 items-center border border-orange-500 bg-orange-500 px-3 text-phx-xs font-bold text-white shadow-[0_2px_8px_rgba(249,115,22,0.25)] transition-colors hover:border-orange-600 hover:bg-orange-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-orange-500"
              href={templateHref(true)}
            >
              Download with current targets
            </a>
            <p className="min-w-0 text-phx-xs leading-5 text-slate-500">
              Both lay out one row per area and product for every month in range, with dropdowns. The second is the
              same sheet with the numbers already in it.
            </p>
          </div>
        </SectionCard>
      ) : null}

      {/* ── Upload ── */}
      {canEdit ? (
        <SectionCard title="Upload" subtitle="Checked before anything is written" icon={Upload}>
          <div className="flex flex-wrap items-center gap-2 p-4">
            <input
              type="file"
              accept=".xlsx"
              className="h-8 max-w-full text-phx-xs text-slate-600 file:mr-2 file:h-8 file:border file:border-slate-200 file:bg-white file:px-3 file:text-phx-xs file:font-bold file:text-slate-700 hover:file:border-orange-300 hover:file:bg-orange-50"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setPreview(null);
              }}
            />
            <Button size="sm" variant="outline" disabled={!file || busy !== null} onClick={() => runUpload(false)}>
              {busy === "preview" ? "Checking…" : "Check the file"}
            </Button>
            <Button
              size="sm"
              disabled={!preview || preview.validRows === 0 || preview.periods.length === 0 || busy !== null}
              onClick={() => runUpload(true)}
            >
              {busy === "commit" ? "Saving…" : "Save the file"}
            </Button>
          </div>
          {preview ? (
            <div className="border-t border-slate-100 bg-slate-50/70 px-4 py-3 text-xs">
              <p className="font-bold text-slate-900">
                {preview.validRows.toLocaleString("en-US")} of {preview.totalRows.toLocaleString("en-US")} row(s) are valid.
              </p>

              {/* The months the FILE holds — not the month on screen. Shown before the save, and
                  confirmed again by the server, because an upload aimed at the wrong month
                  replaces targets that nothing keeps a previous value for. */}
              {preview.periods.length > 0 ? (
                <div className="mt-2 border border-l-[3px] border-amber-200 border-l-amber-500 bg-amber-50 px-3 py-2">
                  <p className="text-phx-sm font-black uppercase tracking-[0.14em] text-amber-900">
                    This file writes {preview.periods.length} month{preview.periods.length === 1 ? "" : "s"}
                  </p>
                  <ul className="mt-1 space-y-0.5 text-amber-900">
                    {preview.periods.map((entry) => (
                      <li key={`${entry.period}|${entry.lineCode}`}>
                        <span className="font-bold">{formatPeriod(entry.period)}</span>
                        {" — "}
                        {entry.rows.toLocaleString("en-US")} row{entry.rows === 1 ? "" : "s"}
                        {entry.overwrites > 0
                          ? `, ${entry.overwrites.toLocaleString("en-US")} replacing a target already set`
                          : ", all new"}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {preview.errors.length > 0 ? (
                <ul className="mt-1.5 space-y-1 text-amber-900">
                  {preview.errors.slice(0, 12).map((issue) => (
                    <li key={issue.rowNumber}>
                      Row {issue.rowNumber}: {issue.message}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </SectionCard>
      ) : null}

      {/* ── The grid: regions as buttons, areas underneath ── */}
      <SectionCard
        title={`${lineLabel} · ${formatPeriod(props.selectedPeriod)}`}
        subtitle={`${regions.length.toLocaleString("en-US")} region${regions.length === 1 ? "" : "s"} · press one to open its areas`}
        icon={Layers}
        actions={
          canEdit ? (
            <div className="flex flex-wrap items-center gap-2">
              {/* The one signal that survives a soft navigation — beforeunload cannot fire on a
                  sidebar click, so this has to be visible enough to stop him leaving. */}
              {hasUnsavedEdits ? (
                <span className="inline-flex items-center gap-1.5 border border-amber-300 bg-amber-50 px-2.5 py-1 text-phx-sm font-black uppercase tracking-[0.14em] text-amber-900">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />
                  Not saved yet
                </span>
              ) : null}
              {canDrop ? (
                <button
                  type="button"
                  className="inline-flex h-8 items-center border border-red-200 bg-white px-3 text-phx-xs font-bold text-red-700 transition-colors hover:border-red-400 hover:bg-red-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={storedCells === 0 || busy !== null}
                  onClick={dropMonth}
                >
                  {busy === "drop" ? "Dropping…" : "Drop this month"}
                </button>
              ) : null}
              <Button size="sm" disabled={editedKeys.length === 0 || busy !== null} onClick={saveEdits}>
                {busy === "save" ? "Saving…" : `Save edits${editedKeys.length ? ` (${editedKeys.length})` : ""}`}
              </Button>
            </div>
          ) : (
            <span className="border border-slate-200 bg-slate-50 px-2.5 py-1 text-phx-sm font-black uppercase tracking-[0.14em] text-slate-500">
              View only
            </span>
          )
        }
      >
        {/* Filters + sort. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-100 bg-slate-50/70 px-4 py-3">
          <Input
            className="h-8 w-full max-w-[14rem] text-phx-xs"
            placeholder="Search area or product"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Picker
            label="Region"
            value={region}
            options={regionOptions}
            onChange={(value) => {
              setRegion(value);
              setArea("all");
            }}
          />
          <Picker label="Area" value={area} options={areaOptions} onChange={setArea} />
          <Picker label="Product" value={product} options={productOptions} onChange={setProduct} />
          <Picker
            label="Show"
            value={status}
            options={[
              { value: "all", label: "Everything" },
              { value: "blank", label: "Not set yet" },
              { value: "set", label: "Already set" },
            ]}
            onChange={(value) => setStatus(value as "all" | "set" | "blank")}
          />
          <Picker
            label="Sort"
            value={sort}
            options={SORTS.map((entry) => ({ value: entry.value, label: entry.label }))}
            onChange={(value) => setSort(value as Sort)}
          />
          <button
            type="button"
            className={OUTLINE_ACTION_CLASS}
            onClick={() =>
              setOpenRegions(allOpen ? {} : Object.fromEntries(regions.map((region) => [region.name, true])))
            }
          >
            {allOpen ? "Collapse all" : "Open all"}
          </button>
        </div>

        {regions.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm font-bold text-slate-900">Nothing matches these filters.</p>
            <p className="mx-auto mt-1.5 max-w-xl text-xs leading-5 text-slate-500">
              Clear the search or pick another product.
            </p>
          </div>
        ) : (
          <div className="space-y-2.5 p-3 sm:p-4">
            {regions.map((region) => {
              const open = openRegions[region.name] === true;
              return (
                <div
                  className={cn("border bg-white transition-shadow", open ? "border-orange-200" : "border-slate-200", open && CARD_DEPTH)}
                  key={region.name}
                >
                  {/* The region BUTTON. Full width, so it is a target on a phone too. */}
                  <button
                    type="button"
                    aria-expanded={open}
                    className={cn(
                      "flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-l-[3px] px-4 py-3.5 text-left transition-colors hover:bg-orange-50/40 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-orange-500",
                      open ? "border-l-orange-500 bg-orange-50/40" : "border-l-transparent",
                    )}
                    onClick={() => setOpenRegions((current) => ({ ...current, [region.name]: !open }))}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {open ? (
                        <ChevronDown className="h-4 w-4 shrink-0 text-orange-600" aria-hidden />
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                      )}
                      <span className="break-words text-sm font-black tracking-tight text-slate-900">{region.name}</span>
                      <span className={LABEL_CLASS}>
                        {region.areas.length} area{region.areas.length === 1 ? "" : "s"}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      <span className="w-24 shrink-0">
                        <CompletionBar done={region.set} of={region.cells} />
                      </span>
                      <span className={LABEL_CLASS}>
                        {region.set} of {region.cells} set
                      </span>
                      <span className="whitespace-nowrap text-base font-black tabular-nums text-slate-900">
                        {formatEgpFull(region.value)}
                      </span>
                    </span>
                  </button>
                  {open ? <div className="border-b border-slate-100" /> : null}

                  {open ? (
                    <div className="space-y-2.5 p-3">
                      {region.areas.map((area) => (
                        <div className="border border-slate-200 bg-white" key={area.areaCode}>
                          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-slate-100 bg-slate-50 px-3 py-2">
                            <p className="break-words text-xs font-black text-slate-900">
                              {area.areaName}
                              {area.areaState === "vacant_will_hire" ? (
                                <span className="ml-2 border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-phx-sm font-black uppercase tracking-[0.14em] text-amber-800">
                                  vacant
                                </span>
                              ) : null}
                            </p>
                            <p className="text-phx-xs font-black tabular-nums text-slate-700">
                              {formatEgpFull(area.value)}
                            </p>
                          </div>
                          <ul className="divide-y divide-slate-100">
                            {area.rows.map((row) => {
                              const key = keyOf(row);
                              const dirty = edits[key] !== undefined || unitEdits[key] !== undefined;
                              const unitValue = unitEdits[key] ?? fieldValue(row.targetUnits, 3);
                              const editValue = edits[key] ?? fieldValue(row.targetValue, 2);
                              return (
                                <li
                                  className={cn(
                                    "flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2.5 transition-colors",
                                    dirty ? "bg-amber-50/60" : "hover:bg-orange-50/40",
                                  )}
                                  key={key}
                                >
                                  <span className="min-w-0 flex-1 basis-[10rem]">
                                    <span className="block break-words text-xs font-semibold text-slate-900">
                                      {row.productName || row.productCode}
                                    </span>
                                    <span className="block text-phx-sm tabular-nums text-slate-500">
                                      {row.unitPrice == null
                                        ? "no price"
                                        : `@ ${row.unitPrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EGP`}
                                    </span>
                                  </span>
                                  {canEdit ? (
                                    <span className="flex flex-wrap items-center gap-2">
                                      <label className="flex items-center gap-1.5">
                                        <span className={LABEL_CLASS}>
                                          Units
                                        </span>
                                        <Input
                                          type="number"
                                          inputMode="decimal"
                                          className={cn(
                                            "h-8 w-24 text-right tabular-nums transition-colors",
                                            // A gap you can see without reading: an unset cell is
                                            // tinted, so a half-finished month shows itself.
                                            unitValue === "" && "bg-amber-50/70",
                                          )}
                                          value={unitValue}
                                          onChange={(event) => onUnitsChange(row, event.target.value)}
                                        />
                                      </label>
                                      <label className="flex items-center gap-1.5">
                                        <span className={LABEL_CLASS}>
                                          Value
                                        </span>
                                        <Input
                                          type="number"
                                          inputMode="decimal"
                                          className={cn(
                                            "h-8 w-32 text-right tabular-nums",
                                            editValue === "" && "bg-amber-50/70",
                                          )}
                                          value={editValue}
                                          onChange={(event) => onValueChange(key, event.target.value)}
                                        />
                                      </label>
                                    </span>
                                  ) : (
                                    <span className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs tabular-nums">
                                      <span className="text-slate-500">{fmtUnits(row.targetUnits)} units</span>
                                      <span className="font-bold text-slate-900">
                                        {row.targetValue == null ? "—" : formatEgpFull(row.targetValue)}
                                      </span>
                                    </span>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
