"use client";

/**
 * Production Planner — the one workspace, rendered by both page shells.
 *
 * Ivyronc is toll-manufactured by EGPI and Sato supplies most of its raw materials. This screen
 * answers the question the owner used to send me in a message: for a production order of this size,
 * how much of each material is needed, how much is already held, how much to buy, how much to
 * deliver, and what is left at the factory afterwards.
 *
 * ── DUAL-SURFACE, and that is not a convenience ──────────────────────────────────────────────────
 *
 * Dr. Sahar Khalil, the R&D Manager and this module's main user, holds the `Manager` app role, and
 * Reham Elwiy holds `Employee`. Both are portal-shell roles (src/lib/auth/portal-shell-roles.ts),
 * and `app/(admin)/layout.tsx` redirects a portal-mode viewer to /employee-portals BEFORE any page
 * in that group runs. An admin-only module would therefore redirect its own main user straight back
 * out of it. So there are two thin page shells over this single component, the Visual Aids shape.
 *
 * ── RIGHT TO LEFT, AND LATIN DIGITS ─────────────────────────────────────────────────────────────
 *
 * The owner asked for Egyptian Arabic. The root carries `dir="rtl" lang="ar"` and the module's own
 * face stack. Two things follow that are easy to get wrong:
 *
 *   · Every NUMBER, unit and date sits in its own `dir="ltr"` element. Without that the bidi
 *     algorithm reorders digit groups beside Arabic text, and a quantity reads back wrong while the
 *     string itself is perfectly correct — the one class of defect in this file that nothing here
 *     can catch, because only a layout engine reorders. `Num` below is the only way a figure
 *     reaches the page.
 *   · The shared header tokens that are physically anchored are mirrored here rather than reused:
 *     `pageHeaderRailClassName` is `left-0`, and tokens.css and globals.css have no RTL awareness
 *     at all. The direction-agnostic text tokens ARE reused, so the type is the sibling pages' type.
 *
 * Digits are Latin by the owner's choice, formatted with `formatNumberLatin` (`en-EG`, never
 * `ar-EG`, which emits ٠١٢٣ and ج.م.). Money is a plain two-place string beside a separate currency
 * label, never `Intl.NumberFormat` with `style: "currency"` — that inserts a space whose character
 * depends on the reader's ICU build, a measured React #418 hydration failure in this app.
 *
 * ── IT FITS THE SCREEN (AGENTS.md §4) ───────────────────────────────────────────────────────────
 *
 * Four tables, every one `table-fixed` with a `<colgroup>` totalling exactly 100%, each paired with
 * a `lg:hidden` card list. No `overflow-x-*` anywhere in this file and no `min-w-[…]` floor: that
 * pairing IS the bug the golden rule names, because a scrolling wrapper absorbs the overflow and
 * the page-level check then certifies itself while content hangs off the side. The tab strip is
 * `flex flex-wrap`, never `inline-flex min-w-max` under a scroller — on a right-to-left page a
 * horizontal scroller opens at the LEFT, which is the end of every line.
 *
 * The binding width is 669px, not 1280: the admin shell's sidebar is `hidden lg:flex` at 292px, so
 * the content box NARROWS as the viewport crosses 1024px. The portal shell's sidebar is an overlay,
 * so there the box is near full width — both shells need measuring, and
 * tests/production-planning-fits-the-screen.test.ts pins the construct at birth.
 *
 * The planner tab LEADS WITH THE ROUNDING, because that is the one thing the owner will not take on
 * trust. Runs are whole, so a request for 100,000 boxes is answered by 8 runs yielding 106,000 — and
 * a planner that silently answers for 106,000 is wrong in the only way that matters while every
 * number under it is right. The surplus is a tile, and the sentence says it again in words.
 *
 * ── READ-ONLY IS A REAL STATE ───────────────────────────────────────────────────────────────────
 *
 * Mr. Ahmed Al Maraghi and Reham Elwiy are read-only ("read only, read only", the owner's words).
 * `canWrite` hides every form and disables every control rather than letting a save fail at the
 * API — a 403 the reader cannot act on is worse than a control that was never offered.
 *
 * ── NOTHING TRUNCATES ───────────────────────────────────────────────────────────────────────────
 *
 * No ellipsis anywhere, the owner's standing rule. Material names wrap, and `break-words` is on
 * every free-text line because an Arabic material name beside a Latin code is two runs the browser
 * will not break on its own.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";
import { downloadXlsxFrom } from "@/lib/export/download-xlsx-client";
import {
  BASIS_LABELS,
  formatNumberLatin,
  PP,
  PRODUCTION_PLANNING_FONT_STACK,
  PRODUCTION_PLANNING_TABS,
  SUPPLIER_LABELS,
  unitLabelAr,
  type ProductionPlanningTabKey,
} from "@/lib/production-planning/strings";
import type {
  WireGrant,
  WireMaterial,
  WirePlan,
  WirePlanRow,
  WireRequestMode,
  WireWorkspace,
} from "@/lib/production-planning/wire";

/**
 * The header rail, mirrored for right-to-left.
 *
 * `pageHeaderRailClassName` in admin-design-tokens is `left-0`, which on this page would put the
 * accent at the end of every line instead of its start. Same gradient, same 3px, same square
 * edge — only the side moves, and it lives here rather than in the shared token because no other
 * page in the app is right-to-left.
 */
const RTL_HEADER_RAIL =
  "pointer-events-none absolute right-0 top-[0.3rem] bottom-[0.3rem] w-[3px] " +
  "bg-[linear-gradient(180deg,#F97316_0%,#FB923C_45%,rgba(251,146,60,0.12)_100%)]";

const PANEL = "border border-slate-300 bg-white px-4 py-4";
const LABEL = "block text-[10px] font-black uppercase tracking-[0.14em] text-slate-500";
const INPUT =
  "mt-1 w-full min-w-0 border border-slate-300 bg-white px-2 py-1.5 text-[13px] text-slate-900 " +
  "tabular-nums outline-none focus:border-orange-500 disabled:bg-slate-50 disabled:text-slate-400";
const BUTTON =
  "inline-flex items-center justify-center gap-1.5 border border-slate-900 bg-slate-900 px-3 py-1.5 " +
  "text-[12px] font-bold text-white hover:bg-slate-800 disabled:border-slate-300 " +
  "disabled:bg-slate-200 disabled:text-slate-500";
const BUTTON_QUIET =
  "inline-flex items-center justify-center gap-1.5 border border-slate-300 bg-white px-3 py-1.5 " +
  "text-[12px] font-bold text-slate-700 hover:bg-slate-50 disabled:text-slate-400";
const TH = "px-3 py-2 text-right text-[9px] font-black uppercase tracking-[0.14em] text-slate-500";
const TD = "px-3 py-2 align-top text-[12px] leading-5 text-slate-800";
const CARD = "border border-slate-300 bg-white px-3 py-3 lg:hidden";

/**
 * Every number on this page goes through here, isolated per value rather than per block.
 *
 * A figure, a unit or a date inside right-to-left text is reordered by the bidi algorithm unless it
 * is isolated. The reordering happens in the layout engine: the string is correct, the HTML is
 * correct, and only the rendered line is wrong.
 */
function Num({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={className ? `tabular-nums ${className}` : "tabular-nums"} dir="ltr">
      {children}
    </span>
  );
}

/** A quantity with its unit, isolated together, so "72.1 kg" never arrives as "kg 72.1". */
/**
 * A quantity: the FIGURE inside its own `dir="ltr"` isolate, the Arabic unit OUTSIDE it.
 *
 * Both halves matter and for different reasons. The isolate is the house rule — without it bidi
 * reorders a digit group that sits next to Arabic text. Leaving the unit outside it is what puts
 * the two in Arabic order: inside one LTR isolate the reader gets `109,180 كجم` laid out
 * left-to-right, with the figure on the LEFT, which is backwards on an RTL line; outside it the
 * line's own direction places the figure on the right and its unit to the left, the way the unit
 * reads in the tiles above the table and in the sentence beside them.
 */
function Qty({ value, unit }: { value: string; unit?: string | null }) {
  const label = unitLabelAr(unit);
  return (
    <>
      <Num>{formatNumberLatin(value)}</Num>
      {label ? <> {label}</> : null}
    </>
  );
}

function Chip({
  tone,
  children,
}: {
  tone: "slate" | "amber" | "rose" | "emerald";
  children: ReactNode;
}) {
  const tones = {
    slate: "border-slate-300 bg-slate-50 text-slate-600",
    amber: "border-amber-300 bg-amber-50 text-amber-800",
    rose: "border-rose-300 bg-rose-50 text-rose-800",
    emerald: "border-emerald-300 bg-emerald-50 text-emerald-800",
  } as const;
  return (
    <span
      className={`inline-flex items-center border px-1.5 py-0.5 text-[10px] font-bold ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

function Tile({
  label,
  value,
  unit,
  tone,
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: "plain" | "warn";
}) {
  return (
    <div
      className={`border px-3 py-3 text-center ${
        tone === "warn" ? "border-amber-300 bg-amber-50" : "border-slate-300 bg-slate-50"
      }`}
    >
      <p className="text-[9px] font-black uppercase tracking-[0.14em] text-slate-500">{label}</p>
      <p className="mt-1 text-3xl font-black leading-none text-slate-900">
        <Num>{formatNumberLatin(value)}</Num>
      </p>
      {unit ? <p className="mt-1 text-[11px] font-semibold text-slate-500">{unit}</p> : null}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | null;
  children: ReactNode;
}) {
  return (
    <label className="block min-w-0">
      <span className={LABEL}>{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] leading-4 text-slate-500">{hint}</span> : null}
    </label>
  );
}

/**
 * The module's header, exported because BOTH page shells render it and neither can use the app's.
 *
 * `PremiumHero` and the admin pages' own header are anchored `left-0` / `pl-3.5`, which on a
 * right-to-left page puts the accent rail at the end of every line. The gradient, the width and the
 * square edge are the shared token's; only the side moves. The portal shell takes this as its
 * `hero`, which replaces its Latin badge/title banner rather than stacking a second header above it.
 */
export function ProductionPlanningHeader() {
  return (
    <section className="min-w-0" dir="rtl" lang="ar" style={{ fontFamily: PRODUCTION_PLANNING_FONT_STACK }}>
      <div className="flex flex-col gap-3 pb-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="relative min-w-0 space-y-1.5 pr-3.5">
          <span aria-hidden="true" className={RTL_HEADER_RAIL} />
          <p className={pageHeaderKickerClassName}>{PP.moduleKicker}</p>
          <h1 className={pageHeaderTitleClassName}>{PP.moduleTitle}</h1>
          <p className={`${pageHeaderDescriptionClassName} break-words`}>{PP.moduleSubtitle}</p>
        </div>
      </div>
      <div aria-hidden="true" className={pageHeaderRuleClassName} />
    </section>
  );
}

function SectionTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-3 min-w-0">
      <h2 className="text-[15px] font-black tracking-[-0.02em] text-slate-900">{title}</h2>
      {subtitle ? (
        <p className="mt-1 text-[12px] leading-5 text-slate-500 break-words">{subtitle}</p>
      ) : null}
    </div>
  );
}

/** The owner chip for a material: who brings it, and whether it counts toward the buy list. */
function supplierChip(row: WirePlanRow) {
  if (row.supplier === null) return <Chip tone="slate">{PP.chipNoComposition}</Chip>;
  if (row.supplier === "shared_unsettled") return <Chip tone="amber">{PP.chipUnsettled}</Chip>;
  if (row.supplier === "factory") return <Chip tone="slate">{PP.chipFactory}</Chip>;
  return <Chip tone="emerald">{PP.chipSato}</Chip>;
}

function excludedNote(row: WirePlanRow): string | null {
  if (row.excludedReason === "factory_supplies") return PP.excludedFactory;
  if (row.excludedReason === "supplier_unsettled") return PP.excludedUnsettled;
  if (row.excludedReason === "no_composition") return PP.excludedNoComposition;
  return null;
}

function overageHint(row: WirePlanRow): string {
  if (row.overageSource === "measured") return PP.overageHintMeasured;
  if (row.overageSource === "material") return PP.overageHintMaterial;
  return PP.overageHintDefault;
}

const FX_SOURCE_LABELS = {
  manual: PP.fxSourceManual,
  fetched: PP.fxSourceFetched,
  fallback: PP.fxSourceFallback,
  none: PP.fxSourceNone,
} as const;

const STOCK_SOURCE_LABELS: Record<string, string> = {
  factory_report: PP.stockSourceFactoryReport,
  own_count: PP.stockSourceOwnCount,
  delivery: PP.stockSourceDelivery,
  adjustment: PP.stockSourceAdjustment,
};

/**
 * The planner opens on the owner's own headline shape — a TOTAL of 100,000 boxes with 10,000 of them
 * samples. Named constants rather than two string literals because the FIRST READ sends them too: a
 * bare `GET /api/production-planning` computes no plan, so without them the screen would open with
 * the form filled in and the table beneath it empty, which reads as a module that cannot calculate.
 */
const DEFAULT_REQUESTED_QTY = "100000";
const DEFAULT_SAMPLE_UNITS = "10000";
const DEFAULT_MODE: WireRequestMode = "total_boxes";

export function ProductionPlanningWorkspace() {
  const [data, setData] = useState<WireWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<ProductionPlanningTabKey>("planner");

  // The planner form. The default is the owner's own headline shape: a TOTAL box count, with the
  // samples coming out of it rather than sitting on top — "انا 100 الف اقول لك 100 الف وعايز 10000
  // فده معناه انك هتديني 90 و100".
  const [productId, setProductId] = useState<string>("");
  const [mode, setMode] = useState<WireRequestMode>(DEFAULT_MODE);
  const [requestedQty, setRequestedQty] = useState(DEFAULT_REQUESTED_QTY);
  const [sampleUnits, setSampleUnits] = useState(DEFAULT_SAMPLE_UNITS);
  const [overridePct, setOverridePct] = useState("");
  const [willSend, setWillSend] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<WirePlan | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        mode: DEFAULT_MODE,
        requestedQty: DEFAULT_REQUESTED_QTY,
        sampleUnits: DEFAULT_SAMPLE_UNITS,
      });
      const response = await fetch(`/api/production-planning?${params.toString()}`, { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as WireWorkspace | { message?: string } | null;
      if (!response.ok) {
        setError((payload as { message?: string })?.message ?? PP.loadFailed);
        setData(null);
        return;
      }
      const workspace = payload as WireWorkspace;
      setData(workspace);
      setPlan(workspace.plan);
      if (workspace.products.length > 0) setProductId((current) => current || workspace.products[0].id);
    } catch {
      setError(PP.loadFailed);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // The repo's `react-hooks/set-state-in-effect` is an error, and a fetch-on-mount effect trips it
    // because `load` sets the loading flag before its first await. Disabled here, as the other
    // workspaces do, rather than deferring the fetch behind a timeout nobody needs.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const post = useCallback(
    async (path: string, body: Record<string, unknown>): Promise<unknown | null> => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const response = await fetch(`/api/production-planning${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const payload = (await response.json().catch(() => null)) as { message?: string } | null;
        if (!response.ok) {
          setError(payload?.message ?? PP.saveFailed);
          return null;
        }
        return payload;
      } catch {
        setError(PP.saveFailed);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const calculate = useCallback(async () => {
    const result = (await post("/plan", {
      productId,
      mode,
      requestedQty,
      sampleUnits,
      overridePct: overridePct.trim() === "" ? null : overridePct.trim(),
      willSendByMaterialId: willSend,
    })) as WirePlan | null;
    if (result) setPlan(result);
  }, [post, productId, mode, requestedQty, sampleUnits, overridePct, willSend]);

  const saveAndReload = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      const result = await post(path, body);
      if (result) {
        setNotice(PP.saved);
        await load();
      }
    },
    [post, load],
  );

  const materialsById = useMemo(() => {
    const map = new Map<string, WireMaterial>();
    for (const material of data?.materials ?? []) map.set(material.id, material);
    return map;
  }, [data]);

  const canWrite = data?.canWrite === true;

  if (loading && !data) {
    return (
      <div className="min-w-0 px-1 py-8 text-center text-[13px] text-slate-500" dir="rtl" lang="ar">
        {PP.loading}
      </div>
    );
  }

  return (
    <div
      className="min-w-0"
      dir="rtl"
      lang="ar"
      style={{ fontFamily: PRODUCTION_PLANNING_FONT_STACK }}
    >
      {!canWrite && data ? (
        <p className="border border-slate-300 bg-slate-50 px-3 py-2 text-[12px] font-bold text-slate-700">
          {PP.readOnlyNotice}
        </p>
      ) : null}

      {error ? (
        <p className="mt-4 border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-bold text-rose-900 break-words" role="alert">
          {error}
        </p>
      ) : null}

      {notice ? (
        <p className="mt-4 border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] font-bold text-emerald-900">
          {notice}
        </p>
      ) : null}

      {/* flex-wrap, never a scroller: on an RTL page a horizontal scroller opens at the line's end. */}
      <div className="mt-4 flex flex-wrap gap-2" role="tablist">
        {PRODUCTION_PLANNING_TABS.map((entry) => (
          <button
            aria-selected={tab === entry.key}
            className={`border px-3 py-1.5 text-[12px] font-bold ${
              tab === entry.key
                ? "border-slate-900 bg-slate-900 text-white"
                : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
            }`}
            key={entry.key}
            onClick={() => setTab(entry.key)}
            role="tab"
            type="button"
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="mt-4 space-y-4">
        {tab === "planner" ? (
          <PlannerTab
            busy={busy}
            canWrite={canWrite}
            data={data}
            mode={mode}
            onCalculate={calculate}
            onCommit={(commit) =>
              saveAndReload("/plans", {
                productId,
                mode,
                requestedQty,
                sampleUnits,
                overridePct: overridePct.trim() === "" ? null : overridePct.trim(),
                willSendByMaterialId: willSend,
                commit,
              })
            }
            onModeChange={setMode}
            onOverrideChange={setOverridePct}
            onProductChange={setProductId}
            onRequestedChange={setRequestedQty}
            onSamplesChange={setSampleUnits}
            onWillSendChange={(materialId, value) =>
              setWillSend((current) => ({ ...current, [materialId]: value }))
            }
            overridePct={overridePct}
            plan={plan}
            productId={productId}
            requestedQty={requestedQty}
            sampleUnits={sampleUnits}
            willSend={willSend}
          />
        ) : null}

        {tab === "stock" ? (
          <StockTab busy={busy} canWrite={canWrite} data={data} onSave={saveAndReload} />
        ) : null}

        {tab === "cost" ? (
          <CostTab busy={busy} canWrite={canWrite} data={data} onSave={saveAndReload} plan={plan} />
        ) : null}

        {tab === "run" ? (
          <RunTab
            busy={busy}
            canWrite={canWrite}
            data={data}
            materialsById={materialsById}
            onSave={saveAndReload}
          />
        ) : null}

        {tab === "settings" ? (
          <SettingsTab busy={busy} canWrite={canWrite} data={data} onSave={saveAndReload} />
        ) : null}
      </div>
    </div>
  );
}

// ── The planner tab ──────────────────────────────────────────────────────────────────────────────

type PlannerTabProps = {
  busy: boolean;
  canWrite: boolean;
  data: WireWorkspace | null;
  mode: WireRequestMode;
  onCalculate: () => void;
  onCommit: (commit: boolean) => void;
  onModeChange: (mode: WireRequestMode) => void;
  onOverrideChange: (value: string) => void;
  onProductChange: (value: string) => void;
  onRequestedChange: (value: string) => void;
  onSamplesChange: (value: string) => void;
  onWillSendChange: (materialId: string, value: string) => void;
  overridePct: string;
  plan: WirePlan | null;
  productId: string;
  requestedQty: string;
  sampleUnits: string;
  willSend: Record<string, string>;
};

function PlannerTab(props: PlannerTabProps) {
  const { data, plan } = props;
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // The workbook is built from the SAME four parameters the screen is looking at, so the file cannot
  // answer a different question from the page that offered it. It is offered to a read-only viewer
  // too: taking the costed plan away in Excel is the Finance Manager's whole use of this module.
  const exportWorkbook = useCallback(async () => {
    setExporting(true);
    setExportError(null);
    try {
      const params = new URLSearchParams({
        mode: props.mode,
        productId: props.productId,
        requestedQty: props.requestedQty,
        sampleUnits: props.sampleUnits,
      });
      if (props.overridePct.trim() !== "") params.set("overridePct", props.overridePct.trim());
      await downloadXlsxFrom(`/api/production-planning/workbook?${params.toString()}`, "production-plan.xlsx");
    } catch {
      setExportError(PP.exportFailed);
    } finally {
      setExporting(false);
    }
  }, [props.mode, props.productId, props.requestedQty, props.sampleUnits, props.overridePct]);

  if (!data) return <p className={`${PANEL} text-[13px] text-slate-500`}>{PP.notLoaded}</p>;

  return (
    <>
      <section className={PANEL}>
        <SectionTitle subtitle={PP.moduleSubtitle} title={PP.plannerTitle} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={PP.productLabel}>
            <select
              className={INPUT}
              onChange={(event) => props.onProductChange(event.target.value)}
              value={props.productId}
            >
              {data.products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.nameAr}
                </option>
              ))}
            </select>
          </Field>

          <Field label={PP.requestModeLabel}>
            <select
              className={INPUT}
              onChange={(event) => props.onModeChange(event.target.value as WireRequestMode)}
              value={props.mode}
            >
              <option value="total_boxes">{PP.requestModeTotalBoxes}</option>
              <option value="good_units">{PP.requestModeGoodUnits}</option>
              <option value="runs">{PP.requestModeRuns}</option>
            </select>
          </Field>

          <Field label={PP.requestedQtyLabel}>
            <input
              className={INPUT}
              dir="ltr"
              inputMode="numeric"
              onChange={(event) => props.onRequestedChange(event.target.value)}
              value={props.requestedQty}
            />
          </Field>

          <Field hint={PP.sampleUnitsHint} label={PP.sampleUnitsLabel}>
            <input
              className={INPUT}
              dir="ltr"
              inputMode="numeric"
              onChange={(event) => props.onSamplesChange(event.target.value)}
              value={props.sampleUnits}
            />
          </Field>

          <Field
            hint={`${PP.overageHintDefault}: ${formatNumberLatin(data.settings.defaultOveragePct)}%`}
            label={PP.overageLabel}
          >
            <input
              className={INPUT}
              dir="ltr"
              inputMode="decimal"
              onChange={(event) => props.onOverrideChange(event.target.value)}
              placeholder={data.settings.defaultOveragePct}
              value={props.overridePct}
            />
          </Field>

          <div className="flex flex-wrap items-end gap-2">
            <button className={BUTTON} disabled={props.busy} onClick={props.onCalculate} type="button">
              {PP.calculate}
            </button>
            {props.canWrite ? (
              <>
                <button
                  className={BUTTON_QUIET}
                  disabled={props.busy || !plan}
                  onClick={() => props.onCommit(false)}
                  type="button"
                >
                  {PP.saveDraft}
                </button>
                <button
                  className={BUTTON_QUIET}
                  disabled={props.busy || !plan}
                  onClick={() => props.onCommit(true)}
                  type="button"
                >
                  {PP.commitPlan}
                </button>
              </>
            ) : null}
            <button className={BUTTON_QUIET} disabled={exporting} onClick={() => void exportWorkbook()} type="button">
              {PP.exportWorkbook}
            </button>
          </div>
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-slate-500">{PP.exportHint}</p>
        {exportError ? <p className="mt-1 text-[12px] text-rose-700">{exportError}</p> : null}
      </section>

      {plan ? <PlannerResult {...props} plan={plan} /> : null}
    </>
  );
}

function PlannerResult({
  plan,
  canWrite,
  onWillSendChange,
  willSend,
}: PlannerTabProps & { plan: WirePlan }) {
  const shortfall = plan.oneRunFewer;

  return (
    <>
      <section className={PANEL}>
        {/* The rounding leads. A plan asked for 100,000 that silently answers for 106,000 is the
            worst way to be wrong on this screen, so the surplus is a tile and the sentence repeats
            it in words. */}
        {/* One column at 375px, not two. MEASURED in the browser on 2026-10-06: at two columns the
            admin shell gives each tile a 105px content box, and `106,000` at `text-3xl` needs 124px
            — so the headline total, the one figure this screen exists to produce, was clipped by
            19px, and a seven-digit total clips in the portal shell too. Fixed by merging the
            columns, never by shrinking the type (AGENTS.md §4), and it is now the same
            `grid-cols-1 sm:grid-cols-2` ladder every other grid in this file already used. */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label={PP.tileRuns} unit={PP.unitRuns} value={plan.runs} />
          <Tile label={PP.tileRunVolume} unit={PP.unitLitre} value={plan.runVolumeLitres} />
          <Tile label={PP.tileYield} unit={PP.unitBox} value={plan.totalBoxes} />
          {plan.surplusBoxes !== "0" ? (
            <Tile label={PP.tileSurplus} tone="warn" unit={PP.unitBox} value={plan.surplusBoxes} />
          ) : (
            <Tile label={PP.tileSurplus} unit={PP.unitBox} value="0" />
          )}
        </div>

        <p className="mt-3 text-[13px] font-semibold leading-6 text-slate-800 break-words">
          {plan.sentence}
        </p>

        <ul className="mt-2 space-y-1 text-[11px] leading-5 text-slate-500">
          {plan.rounded ? (
            <li>
              {PP.roundedUpNote} — {PP.exactRunsNote} <Num>{formatNumberLatin(plan.exactRuns)}</Num>
            </li>
          ) : null}
          {shortfall ? (
            <li>
              {PP.oneRunFewerNote}: <Num>{formatNumberLatin(shortfall.runs)}</Num> {PP.unitRuns} —{" "}
              <Num>{formatNumberLatin(shortfall.totalBoxes)}</Num> {PP.unitBox}
              {shortfall.shortfallBoxes !== "0" ? (
                <>
                  {" "}
                  ({PP.tileShortfall} <Num>{formatNumberLatin(shortfall.shortfallBoxes)}</Num>)
                </>
              ) : null}
            </li>
          ) : null}
          {plan.leftoverMl !== "0" ? (
            <li>
              {PP.leftoverNote}: <Qty unit={PP.unitMl} value={plan.leftoverMl} />
            </li>
          ) : null}
        </ul>
      </section>

      <section className="min-w-0">
        {/* 31/23/23/23. Four columns, because the fifth would take the delivery input below its
            natural width in the admin shell's 669px box — fit by MERGING, never by shrinking. */}
        <table className="hidden w-full table-fixed border border-slate-300 bg-white lg:table">
          <colgroup>
            <col className="w-[31%]" />
            <col className="w-[23%]" />
            <col className="w-[23%]" />
            <col className="w-[23%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-300 bg-slate-50">
              {[PP.colMaterial, PP.colNeeded, PP.colAvailable, PP.colAction].map((heading) => (
                <th className={TH} key={heading} scope="col">
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {plan.rows.map((row) => (
              <tr className="border-b border-slate-200 last:border-b-0" key={row.materialId}>
                <td className={TD}>
                  <p className="font-bold text-slate-900 break-words">{row.nameAr}</p>
                  <p className="mt-0.5 break-words text-[11px] text-slate-500">
                    <Num>{row.code}</Num>
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {supplierChip(row)}
                    {row.isImported ? <Chip tone="amber">{PP.chipImported}</Chip> : null}
                  </div>
                </td>
                <td className={TD}>
                  <p className="font-bold text-slate-900">
                    <Qty unit={row.displayUnit} value={row.needed} />
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    {PP.beforeOverage} <Qty unit={row.displayUnit} value={row.rawNeeded} /> +{" "}
                    <Num>{formatNumberLatin(row.overagePct)}%</Num>
                  </p>
                  <p className="mt-0.5 break-words text-[11px] text-slate-500">{overageHint(row)}</p>
                  {row.basis ? (
                    <p className="mt-0.5 break-words text-[11px] text-slate-500">
                      {BASIS_LABELS[row.basis]}
                    </p>
                  ) : null}
                </td>
                <td className={TD}>
                  <p>
                    {PP.atFactory} <Qty unit={row.displayUnit} value={row.heldAtFactory} />
                  </p>
                  <p className="mt-0.5">
                    {PP.atOwnStore} <Qty unit={row.displayUnit} value={row.heldElsewhere} />
                  </p>
                  <p className="mt-0.5 font-bold text-slate-900">
                    {PP.totalHeld} <Qty unit={row.displayUnit} value={row.heldTotal} />
                  </p>
                  {row.coverRuns ? (
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {PP.coverRuns} <Num>{formatNumberLatin(row.coverRuns)}</Num> {PP.unitRuns}
                    </p>
                  ) : null}
                </td>
                <td className={TD}>
                  <PlannerAction
                    canWrite={canWrite}
                    onWillSendChange={onWillSendChange}
                    row={row}
                    willSend={willSend}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="space-y-2 lg:hidden">
          {plan.rows.map((row) => (
            <article className={CARD} key={row.materialId}>
              <p className="font-bold text-slate-900 break-words">{row.nameAr}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {supplierChip(row)}
                {row.isImported ? <Chip tone="amber">{PP.chipImported}</Chip> : null}
              </div>
              <dl className="mt-2 space-y-1 text-[12px] text-slate-700">
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="font-bold">{PP.colNeeded}</dt>
                  <dd>
                    <Qty unit={row.displayUnit} value={row.needed} />
                  </dd>
                </div>
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="font-bold">{PP.totalHeld}</dt>
                  <dd>
                    <Qty unit={row.displayUnit} value={row.heldTotal} />
                  </dd>
                </div>
              </dl>
              <div className="mt-2">
                <PlannerAction
                  canWrite={canWrite}
                  onWillSendChange={onWillSendChange}
                  row={row}
                  willSend={willSend}
                />
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className={PANEL}>
        <SectionTitle title={PP.costTotal} />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <p className="text-[13px] text-slate-800">
            {PP.currencyUsd} <Num className="font-bold">{formatNumberLatin(plan.totals.costUsd)}</Num>
          </p>
          <p className="text-[13px] text-slate-800">
            {PP.currencyEgp} <Num className="font-bold">{formatNumberLatin(plan.totals.costEgp)}</Num>
          </p>
        </div>
        <ul className="mt-2 space-y-1 text-[11px] leading-5 text-slate-500">
          <li>
            {PP.fxRate}: {FX_SOURCE_LABELS[plan.totals.fxSource]}
            {plan.totals.fxRate ? (
              <>
                {" "}
                <Num>{formatNumberLatin(plan.totals.fxRate)}</Num>
              </>
            ) : null}
          </li>
          {plan.totals.unpricedMaterials > 0 ? (
            <li>
              {PP.costUnpriced}: <Num>{plan.totals.unpricedMaterials}</Num> — {PP.costNotWholeNotice}
            </li>
          ) : null}
          {plan.totals.incompleteMaterials > 0 ? (
            <li>
              {PP.costIncomplete}: <Num>{plan.totals.incompleteMaterials}</Num>
            </li>
          ) : null}
        </ul>
      </section>
    </>
  );
}

function PlannerAction({
  row,
  canWrite,
  willSend,
  onWillSendChange,
}: {
  row: WirePlanRow;
  canWrite: boolean;
  willSend: Record<string, string>;
  onWillSendChange: (materialId: string, value: string) => void;
}) {
  const note = excludedNote(row);
  if (!row.contributesToBuyList) {
    return <p className="break-words text-[11px] text-slate-500">{note ?? PP.noActionNeeded}</p>;
  }
  const short = row.balanceAfter.startsWith("-");
  return (
    <div className="min-w-0 space-y-1">
      {row.toBuy !== "0" ? (
        <p className="font-bold text-slate-900">
          {PP.toBuy} <Qty unit={row.displayUnit} value={row.toBuy} />
        </p>
      ) : null}
      <p>
        {PP.toDeliver} <Qty unit={row.displayUnit} value={row.minToDeliver} />
      </p>
      {canWrite ? (
        <label className="block">
          <span className="text-[10px] font-bold text-slate-500">{PP.willSend}</span>
          <input
            className={INPUT}
            dir="ltr"
            inputMode="decimal"
            onChange={(event) => onWillSendChange(row.materialId, event.target.value)}
            placeholder={row.minToDeliver}
            value={willSend[row.materialId] ?? ""}
          />
        </label>
      ) : null}
      <p className={short ? "font-bold text-rose-700" : "text-slate-700"}>
        {short ? PP.shortAfter : PP.balanceAfter}{" "}
        <Qty unit={row.displayUnit} value={row.balanceAfter} />
        {row.balanceAfterRuns ? (
          <>
            {" "}
            <span className="text-[11px] text-slate-500">
              ({PP.coverRuns} <Num>{formatNumberLatin(row.balanceAfterRuns)}</Num> {PP.unitRuns})
            </span>
          </>
        ) : null}
      </p>
    </div>
  );
}

// ── The stock tab ────────────────────────────────────────────────────────────────────────────────

type SaveFn = (path: string, body: Record<string, unknown>) => Promise<void>;

function StockTab({
  data,
  canWrite,
  busy,
  onSave,
}: {
  data: WireWorkspace | null;
  canWrite: boolean;
  busy: boolean;
  onSave: SaveFn;
}) {
  const [materialId, setMaterialId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [qty, setQty] = useState("");
  const [asOfDate, setAsOfDate] = useState("");
  const [source, setSource] = useState("factory_report");
  const [note, setNote] = useState("");

  if (!data) return <p className={`${PANEL} text-[13px] text-slate-500`}>{PP.notLoaded}</p>;
  const locationName = (id: string) =>
    data.locations.find((location) => location.id === id)?.nameAr ?? id;

  return (
    <>
      {canWrite ? (
        <section className={PANEL}>
          <SectionTitle subtitle={PP.stockSubtitle} title={PP.stockAdd} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label={PP.colMaterial}>
              <select
                className={INPUT}
                onChange={(event) => setMaterialId(event.target.value)}
                value={materialId}
              >
                <option value="">{PP.colMaterial}</option>
                {data.materials.map((material) => (
                  <option key={material.id} value={material.id}>
                    {material.nameAr}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={PP.stockLocation}>
              <select
                className={INPUT}
                onChange={(event) => setLocationId(event.target.value)}
                value={locationId}
              >
                <option value="">{PP.stockLocation}</option>
                {data.locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.nameAr}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={PP.stockQty}>
              <input
                className={INPUT}
                dir="ltr"
                inputMode="decimal"
                onChange={(event) => setQty(event.target.value)}
                value={qty}
              />
            </Field>
            <Field label={PP.stockAsOf}>
              <input
                className={INPUT}
                dir="ltr"
                onChange={(event) => setAsOfDate(event.target.value)}
                type="date"
                value={asOfDate}
              />
            </Field>
            <Field label={PP.stockSource}>
              <select
                className={INPUT}
                onChange={(event) => setSource(event.target.value)}
                value={source}
              >
                {Object.entries(STOCK_SOURCE_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={PP.stockNote}>
              <input className={INPUT} onChange={(event) => setNote(event.target.value)} value={note} />
            </Field>
          </div>
          <div className="mt-3">
            <button
              className={BUTTON}
              disabled={busy || !materialId || !locationId || qty.trim() === ""}
              onClick={() => {
                const material = data.materials.find((candidate) => candidate.id === materialId);
                void onSave("/stock", {
                  materialId,
                  locationId,
                  unitKind: material?.unitKind,
                  // Typed in the display unit the person reads; the service stores base units.
                  qty: toBaseUnits(qty, material),
                  asOfDate: asOfDate || undefined,
                  source,
                  note: note.trim() === "" ? null : note.trim(),
                });
              }}
              type="button"
            >
              {PP.save}
            </button>
          </div>
        </section>
      ) : null}

      <section className="min-w-0">
        <table className="hidden w-full table-fixed border border-slate-300 bg-white lg:table">
          <colgroup>
            <col className="w-[34%]" />
            <col className="w-[22%]" />
            <col className="w-[22%]" />
            <col className="w-[22%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-300 bg-slate-50">
              {[PP.colMaterial, PP.atFactory, PP.atOwnStore, PP.stockAsOf].map((heading) => (
                <th className={TH} key={heading} scope="col">
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.materials.map((material) => {
              const factory = material.stock.find(
                (row) => data.locations.find((location) => location.id === row.locationId)?.isFactory,
              );
              const own = material.stock.find(
                (row) => !data.locations.find((location) => location.id === row.locationId)?.isFactory,
              );
              const newest = material.stock
                .map((row) => row.asOfDate)
                .sort()
                .at(-1);
              return (
                <tr className="border-b border-slate-200 last:border-b-0" key={material.id}>
                  <td className={TD}>
                    <p className="font-bold text-slate-900 break-words">{material.nameAr}</p>
                    <p className="mt-0.5 break-words text-[11px] text-slate-500">
                      <Num>{material.code}</Num>
                    </p>
                  </td>
                  <td className={TD}>
                    {factory ? (
                      <Qty unit={material.displayUnit} value={factory.qtyDisplay} />
                    ) : (
                      <span className="text-[11px] text-slate-500">{PP.stockNoneYet}</span>
                    )}
                  </td>
                  <td className={TD}>
                    {own ? (
                      <Qty unit={material.displayUnit} value={own.qtyDisplay} />
                    ) : (
                      <span className="text-[11px] text-slate-500">{PP.stockNoneYet}</span>
                    )}
                  </td>
                  <td className={TD}>
                    {newest ? <Num>{newest}</Num> : <span className="text-[11px]">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="space-y-2 lg:hidden">
          {data.materials.map((material) => (
            <article className={CARD} key={material.id}>
              <p className="font-bold text-slate-900 break-words">{material.nameAr}</p>
              <dl className="mt-2 space-y-1 text-[12px] text-slate-700">
                {material.stock.length === 0 ? (
                  <p className="text-[11px] text-slate-500">{PP.stockNoneYet}</p>
                ) : (
                  material.stock.map((row) => (
                    <div
                      className="flex flex-wrap justify-between gap-2"
                      key={`${row.locationId}-${row.asOfDate}`}
                    >
                      <dt className="font-bold break-words">{locationName(row.locationId)}</dt>
                      <dd>
                        <Qty unit={material.displayUnit} value={row.qtyDisplay} /> <Num>{row.asOfDate}</Num>
                      </dd>
                    </div>
                  ))
                )}
              </dl>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}

/**
 * A figure typed in the display unit, into the base unit the service stores.
 *
 * Done as STRING arithmetic on purpose: `Number("4284.8") * 1000` is 4284799.999999999 in binary
 * floating point, and this module exists so the screen, the stored row and the Excel formula all
 * carry the same digits.
 */
function toBaseUnits(typed: string, material: WireMaterial | undefined): string {
  const text = typed.trim();
  if (!material || text === "" || !/^\d+(?:\.\d+)?$/.test(text)) return text;
  const factor = material.basePerDisplay;
  if (!/^\d+$/.test(factor) || factor === "1") return text;
  const zeros = factor.length - 1;
  if (factor !== `1${"0".repeat(zeros)}`) return text;
  const dot = text.indexOf(".");
  const whole = dot < 0 ? text : text.slice(0, dot);
  const fraction = dot < 0 ? "" : text.slice(dot + 1);
  if (fraction.length <= zeros) {
    return `${whole}${fraction.padEnd(zeros, "0")}`.replace(/^0+(?=\d)/, "");
  }
  const shifted = `${whole}${fraction.slice(0, zeros)}.${fraction.slice(zeros)}`;
  return shifted.replace(/^0+(?=\d)/, "");
}

// ── The cost tab ─────────────────────────────────────────────────────────────────────────────────

function CostTab({
  data,
  canWrite,
  busy,
  onSave,
  plan,
}: {
  data: WireWorkspace | null;
  canWrite: boolean;
  busy: boolean;
  onSave: SaveFn;
  plan: WirePlan | null;
}) {
  const [materialId, setMaterialId] = useState("");
  const [currency, setCurrency] = useState<"USD" | "EGP">("EGP");
  const [price, setPrice] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [fxRate, setFxRate] = useState("");

  if (!data) return <p className={`${PANEL} text-[13px] text-slate-500`}>{PP.notLoaded}</p>;

  return (
    <>
      <section className={PANEL}>
        <SectionTitle subtitle={PP.costSubtitle} title={PP.costTitle} />
        <p className="text-[13px] text-slate-800">
          {PP.fxRate}: {FX_SOURCE_LABELS[data.fx.source]}
          {data.fx.rate ? (
            <>
              {" "}
              <Num className="font-bold">{formatNumberLatin(data.fx.rate)}</Num>
            </>
          ) : null}
          {data.fx.rateDate ? (
            <>
              {" "}
              <span className="text-[11px] text-slate-500">
                {PP.fxRateDate} <Num>{data.fx.rateDate}</Num>
              </span>
            </>
          ) : null}
        </p>
        {canWrite ? (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div className="min-w-0 grow sm:max-w-xs">
              <Field label={PP.fxManualOverride}>
                <input
                  className={INPUT}
                  dir="ltr"
                  inputMode="decimal"
                  onChange={(event) => setFxRate(event.target.value)}
                  value={fxRate}
                />
              </Field>
            </div>
            <button
              className={BUTTON}
              disabled={busy || fxRate.trim() === ""}
              onClick={() => void onSave("/fx", { usdToEgp: fxRate.trim() })}
              type="button"
            >
              {PP.save}
            </button>
          </div>
        ) : null}
      </section>

      {canWrite ? (
        <section className={PANEL}>
          <SectionTitle title={PP.priceAdd} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={PP.colMaterial}>
              <select
                className={INPUT}
                onChange={(event) => setMaterialId(event.target.value)}
                value={materialId}
              >
                <option value="">{PP.colMaterial}</option>
                {data.materials.map((material) => (
                  <option key={material.id} value={material.id}>
                    {material.nameAr}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={PP.priceCurrency}>
              <select
                className={INPUT}
                onChange={(event) => setCurrency(event.target.value as "USD" | "EGP")}
                value={currency}
              >
                <option value="EGP">{PP.currencyEgp}</option>
                <option value="USD">{PP.currencyUsd}</option>
              </select>
            </Field>
            <Field label={PP.priceLabel}>
              <input
                className={INPUT}
                dir="ltr"
                inputMode="decimal"
                onChange={(event) => setPrice(event.target.value)}
                value={price}
              />
            </Field>
            <Field label={PP.priceEffectiveFrom}>
              <input
                className={INPUT}
                dir="ltr"
                onChange={(event) => setEffectiveFrom(event.target.value)}
                type="date"
                value={effectiveFrom}
              />
            </Field>
          </div>
          <div className="mt-3">
            <button
              className={BUTTON}
              disabled={busy || !materialId || price.trim() === ""}
              onClick={() => {
                const material = data.materials.find((candidate) => candidate.id === materialId);
                void onSave("/prices", {
                  materialId,
                  unitKind: material?.unitKind,
                  currency,
                  pricePerDisplayUnit: price.trim(),
                  effectiveFrom: effectiveFrom || undefined,
                });
              }}
              type="button"
            >
              {PP.save}
            </button>
          </div>
        </section>
      ) : null}

      <section className="min-w-0">
        <table className="hidden w-full table-fixed border border-slate-300 bg-white lg:table">
          <colgroup>
            <col className="w-[34%]" />
            <col className="w-[22%]" />
            <col className="w-[22%]" />
            <col className="w-[22%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-300 bg-slate-50">
              {[PP.colMaterial, PP.priceLabel, PP.priceEffectiveFrom, PP.costTotal].map((heading) => (
                <th className={TH} key={heading} scope="col">
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.materials.map((material) => {
              const row = plan?.rows.find((candidate) => candidate.materialId === material.id) ?? null;
              return (
                <tr className="border-b border-slate-200 last:border-b-0" key={material.id}>
                  <td className={TD}>
                    <p className="font-bold text-slate-900 break-words">{material.nameAr}</p>
                  </td>
                  <td className={TD}>
                    {material.price ? (
                      <>
                        <Num>{formatNumberLatin(material.price.pricePerDisplayUnit)}</Num>{" "}
                        {material.price.currency === "USD" ? PP.currencyUsd : PP.currencyEgp}{" "}
                        <span className="text-[11px] text-slate-500">
                          {PP.pricePerUnit} {unitLabelAr(material.displayUnit)}
                        </span>
                      </>
                    ) : (
                      <span className="text-[11px] text-slate-500">{PP.priceNoneYet}</span>
                    )}
                  </td>
                  <td className={TD}>
                    {material.price ? <Num>{material.price.effectiveFrom}</Num> : null}
                  </td>
                  <td className={TD}>
                    {row && row.costEgp ? (
                      <p>
                        <Num>{formatNumberLatin(row.costEgp)}</Num> {PP.currencyEgp}
                      </p>
                    ) : null}
                    {row && row.costUsd ? (
                      <p className="mt-0.5">
                        <Num>{formatNumberLatin(row.costUsd)}</Num> {PP.currencyUsd}
                      </p>
                    ) : null}
                    {row?.costDerivedMissing ? (
                      <p className="mt-0.5 break-words text-[11px] text-amber-800">
                        {PP.fxSourceNone}
                      </p>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="space-y-2 lg:hidden">
          {data.materials.map((material) => (
            <article className={CARD} key={material.id}>
              <p className="font-bold text-slate-900 break-words">{material.nameAr}</p>
              <p className="mt-1 text-[12px] text-slate-700">
                {material.price ? (
                  <>
                    <Num>{formatNumberLatin(material.price.pricePerDisplayUnit)}</Num>{" "}
                    {material.price.currency === "USD" ? PP.currencyUsd : PP.currencyEgp} {PP.pricePerUnit}{" "}
                    {unitLabelAr(material.displayUnit)}
                  </>
                ) : (
                  <span className="text-[11px] text-slate-500">{PP.priceNoneYet}</span>
                )}
              </p>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}

// ── The run tab ──────────────────────────────────────────────────────────────────────────────────

function RunTab({
  data,
  canWrite,
  busy,
  onSave,
  materialsById,
}: {
  data: WireWorkspace | null;
  canWrite: boolean;
  busy: boolean;
  onSave: SaveFn;
  materialsById: Map<string, WireMaterial>;
}) {
  const [runLabel, setRunLabel] = useState("");
  const [runsCount, setRunsCount] = useState("1");
  const [producedOn, setProducedOn] = useState("");
  const [goodUnits, setGoodUnits] = useState("");
  const [samples, setSamples] = useState("0");
  const [excluded, setExcluded] = useState(false);
  const [exclusionReason, setExclusionReason] = useState("");
  const [lines, setLines] = useState<Record<string, { opening: string; delivered: string; closing: string }>>({});

  if (!data) return <p className={`${PANEL} text-[13px] text-slate-500`}>{PP.notLoaded}</p>;

  const setLine = (materialId: string, field: "opening" | "delivered" | "closing", value: string) =>
    setLines((current) => ({
      ...current,
      [materialId]: {
        opening: current[materialId]?.opening ?? "",
        delivered: current[materialId]?.delivered ?? "",
        closing: current[materialId]?.closing ?? "",
        [field]: value,
      },
    }));

  return (
    <>
      {canWrite ? (
        <section className={PANEL}>
          <SectionTitle subtitle={PP.runSubtitle} title={PP.runTitle} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label={PP.runLabel}>
              <input className={INPUT} onChange={(event) => setRunLabel(event.target.value)} value={runLabel} />
            </Field>
            <Field label={PP.runCount}>
              <input
                className={INPUT}
                dir="ltr"
                inputMode="numeric"
                onChange={(event) => setRunsCount(event.target.value)}
                value={runsCount}
              />
            </Field>
            <Field label={PP.runProducedOn}>
              <input
                className={INPUT}
                dir="ltr"
                onChange={(event) => setProducedOn(event.target.value)}
                type="date"
                value={producedOn}
              />
            </Field>
            <Field label={PP.runActualGoodUnits}>
              <input
                className={INPUT}
                dir="ltr"
                inputMode="numeric"
                onChange={(event) => setGoodUnits(event.target.value)}
                value={goodUnits}
              />
            </Field>
            <Field label={PP.runActualSamples}>
              <input
                className={INPUT}
                dir="ltr"
                inputMode="numeric"
                onChange={(event) => setSamples(event.target.value)}
                value={samples}
              />
            </Field>
            <Field hint={excluded ? PP.runExcludeHint : null} label={PP.runExclude}>
              <select
                className={INPUT}
                onChange={(event) => setExcluded(event.target.value === "yes")}
                value={excluded ? "yes" : "no"}
              >
                <option value="no">{PP.no}</option>
                <option value="yes">{PP.yes}</option>
              </select>
            </Field>
            {excluded ? (
              <div className="sm:col-span-2 lg:col-span-3">
                <Field label={PP.runExcludeReason}>
                  <input
                    className={INPUT}
                    onChange={(event) => setExclusionReason(event.target.value)}
                    value={exclusionReason}
                  />
                </Field>
              </div>
            ) : null}
          </div>

          {/* 28/24/24/24. The three editable figures each need a real input, and a fifth column
              would take them under their natural width in the 669px box. */}
          <table className="mt-4 hidden w-full table-fixed border border-slate-300 lg:table">
            <colgroup>
              <col className="w-[28%]" />
              <col className="w-[24%]" />
              <col className="w-[24%]" />
              <col className="w-[24%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-slate-300 bg-slate-50">
                {[PP.colMaterial, PP.runOpening, PP.runDelivered, PP.runClosing].map((heading) => (
                  <th className={TH} key={heading} scope="col">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.materials.map((material) => (
                <tr className="border-b border-slate-200 last:border-b-0" key={material.id}>
                  <td className={TD}>
                    <p className="font-bold text-slate-900 break-words">{material.nameAr}</p>
                    <p className="mt-0.5 text-[11px] text-slate-500">{unitLabelAr(material.displayUnit)}</p>
                  </td>
                  {(["opening", "delivered", "closing"] as const).map((field) => (
                    <td className={TD} key={field}>
                      <input
                        className={INPUT}
                        dir="ltr"
                        inputMode="decimal"
                        onChange={(event) => setLine(material.id, field, event.target.value)}
                        value={lines[material.id]?.[field] ?? ""}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-4 space-y-2 lg:hidden">
            {data.materials.map((material) => (
              <article className="border border-slate-300 bg-white px-3 py-3" key={material.id}>
                <p className="font-bold text-slate-900 break-words">{material.nameAr}</p>
                <div className="mt-2 grid grid-cols-1 gap-2">
                  {(["opening", "delivered", "closing"] as const).map((field) => (
                    <Field
                      key={field}
                      label={
                        field === "opening"
                          ? PP.runOpening
                          : field === "delivered"
                            ? PP.runDelivered
                            : PP.runClosing
                      }
                    >
                      <input
                        className={INPUT}
                        dir="ltr"
                        inputMode="decimal"
                        onChange={(event) => setLine(material.id, field, event.target.value)}
                        value={lines[material.id]?.[field] ?? ""}
                      />
                    </Field>
                  ))}
                </div>
              </article>
            ))}
          </div>

          <div className="mt-3">
            <button
              className={BUTTON}
              disabled={busy || runLabel.trim() === "" || goodUnits.trim() === ""}
              onClick={() =>
                void onSave("/runs", {
                  productId: data.products[0]?.id,
                  runLabel: runLabel.trim(),
                  runsCount,
                  producedOn: producedOn || undefined,
                  actualGoodUnits: goodUnits,
                  actualSampleUnits: samples,
                  isExcludedFromLearning: excluded,
                  exclusionReason: excluded ? exclusionReason.trim() : null,
                  materials: Object.entries(lines)
                    .filter(([, line]) => line.closing.trim() !== "" || line.opening.trim() !== "")
                    .map(([id, line]) => {
                      const material = materialsById.get(id);
                      return {
                        materialId: id,
                        openingQty: toBaseUnits(line.opening || "0", material),
                        deliveredQty: toBaseUnits(line.delivered || "0", material),
                        closingQty: toBaseUnits(line.closing || "0", material),
                      };
                    }),
                })
              }
              type="button"
            >
              {PP.runSave}
            </button>
          </div>
        </section>
      ) : null}

      <section className={PANEL}>
        <SectionTitle title={PP.runHistory} />
        {data.runs.length === 0 ? (
          <p className="text-[12px] text-slate-500">{PP.runNoneYet}</p>
        ) : (
          <ul className="space-y-2">
            {data.runs.map((run) => (
              <li className="border border-slate-200 px-3 py-2" key={run.id}>
                <p className="font-bold text-slate-900 break-words">{run.runLabel}</p>
                <p className="mt-0.5 text-[12px] text-slate-700">
                  <Num>{run.producedOn}</Num> — <Num>{formatNumberLatin(run.runsCount)}</Num>{" "}
                  {PP.unitRuns}, <Num>{formatNumberLatin(run.actualGoodUnits)}</Num> {PP.unitBox},{" "}
                  <Num>{formatNumberLatin(run.actualSampleUnits)}</Num> {PP.unitSample}
                </p>
                {run.isExcludedFromLearning ? (
                  <p className="mt-1 break-words text-[11px] text-amber-800">
                    {PP.runExclude}: {run.exclusionReason}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={PANEL}>
        <SectionTitle title={PP.learnedOverage} />
        <ul className="space-y-1 text-[12px] text-slate-700">
          {data.materials
            .filter((material) => material.learning !== null)
            .map((material) => (
              <li className="break-words" key={material.id}>
                <span className="font-bold">{material.nameAr}</span>{" "}
                {material.learning?.recommendedOveragePct ? (
                  <Num>{formatNumberLatin(material.learning.recommendedOveragePct)}%</Num>
                ) : material.learning?.withheldReason === "not_enough_runs" ? (
                  PP.learnedNotEnoughRuns
                ) : (
                  PP.learnedNoTheoretical
                )}
              </li>
            ))}
          {data.materials.every((material) => material.learning === null) ? (
            <li className="text-slate-500">{PP.runNoneYet}</li>
          ) : null}
        </ul>
      </section>
    </>
  );
}

// ── The settings tab ─────────────────────────────────────────────────────────────────────────────

function SettingsTab({
  data,
  canWrite,
  busy,
  onSave,
}: {
  data: WireWorkspace | null;
  canWrite: boolean;
  busy: boolean;
  onSave: SaveFn;
}) {
  const [defaultOverage, setDefaultOverage] = useState("");
  const [reorderCover, setReorderCover] = useState("");
  const [grantHrId, setGrantHrId] = useState("");
  const [grantLevel, setGrantLevel] = useState<"read" | "full">("read");
  const [grants, setGrants] = useState<WireGrant[]>([]);

  const loadGrants = useCallback(async () => {
    if (!canWrite) return;
    try {
      const response = await fetch("/api/production-planning/access-grants", { cache: "no-store" });
      if (!response.ok) return;
      const payload = (await response.json()) as { grants?: WireGrant[] };
      setGrants(payload.grants ?? []);
    } catch {
      // A failed read leaves the list empty, which under-reports rather than inventing a grant.
      setGrants([]);
    }
  }, [canWrite]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadGrants();
  }, [loadGrants]);

  if (!data) return <p className={`${PANEL} text-[13px] text-slate-500`}>{PP.notLoaded}</p>;
  const settings = data.settings;

  return (
    <>
      <section className={PANEL}>
        <SectionTitle title={PP.settingsTitle} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            hint={`${PP.settingsLastUpdatedBy}: ${settings.updatedByLogin ?? "—"}`}
            label={PP.settingsDefaultOverage}
          >
            <input
              className={INPUT}
              dir="ltr"
              disabled={!canWrite}
              inputMode="decimal"
              onChange={(event) => setDefaultOverage(event.target.value)}
              placeholder={settings.defaultOveragePct}
              value={defaultOverage}
            />
          </Field>
          <Field hint={PP.settingsReorderCoverHint} label={PP.settingsReorderCover}>
            <input
              className={INPUT}
              dir="ltr"
              disabled={!canWrite}
              inputMode="decimal"
              onChange={(event) => setReorderCover(event.target.value)}
              placeholder={settings.reorderCoverRuns}
              value={reorderCover}
            />
          </Field>
        </div>
        {canWrite ? (
          <div className="mt-3">
            <button
              className={BUTTON}
              disabled={busy || (defaultOverage.trim() === "" && reorderCover.trim() === "")}
              onClick={() =>
                void onSave("/settings", {
                  defaultOveragePct: defaultOverage.trim() === "" ? undefined : defaultOverage.trim(),
                  reorderCoverRuns: reorderCover.trim() === "" ? undefined : reorderCover.trim(),
                })
              }
              type="button"
            >
              {PP.save}
            </button>
          </div>
        ) : null}
      </section>

      <section className={PANEL}>
        <SectionTitle title={PP.settingsAlarmEnabled} />
        {/* "Nothing sent" and "switched off" are different answers, so the screen says which one
            this is rather than showing a zero. */}
        <p
          className={`border px-3 py-2 text-[12px] font-bold ${
            settings.alarmEnabled
              ? settings.alarmDryRun
                ? "border-amber-300 bg-amber-50 text-amber-900"
                : "border-emerald-300 bg-emerald-50 text-emerald-900"
              : "border-slate-300 bg-slate-50 text-slate-700"
          }`}
        >
          {!settings.alarmEnabled
            ? PP.settingsAlarmOffNotice
            : settings.alarmDryRun
              ? PP.settingsAlarmDryRunNotice
              : PP.settingsAlarmEnabled}
        </p>
        <ul className="mt-2 space-y-1 text-[11px] text-slate-500">
          {settings.alarmLastEvaluatedOn ? (
            <li>
              {PP.stockAsOf} <Num>{settings.alarmLastEvaluatedOn}</Num>
            </li>
          ) : null}
          <li>
            {PP.settingsFxEnabled}: {settings.fxFetchEnabled ? PP.stateOn : PP.stateOff}
          </li>
        </ul>
        {canWrite ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className={BUTTON_QUIET}
              disabled={busy}
              onClick={() => void onSave("/settings", { alarmEnabled: !settings.alarmEnabled })}
              type="button"
            >
              {settings.alarmEnabled ? PP.alarmSwitchOff : PP.alarmSwitchOn}
            </button>
            <button
              className={BUTTON_QUIET}
              disabled={busy}
              onClick={() => void onSave("/settings", { alarmDryRun: !settings.alarmDryRun })}
              type="button"
            >
              {settings.alarmDryRun ? PP.dryRunSwitchOff : PP.dryRunSwitchOn}
            </button>
          </div>
        ) : null}
      </section>

      <section className={PANEL}>
        <SectionTitle subtitle={PP.settingsAccessHint} title={PP.settingsAccess} />
        {canWrite ? (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 grow sm:max-w-xs">
                <Field label={PP.accessHrId}>
                  <input
                    className={INPUT}
                    dir="ltr"
                    onChange={(event) => setGrantHrId(event.target.value)}
                    value={grantHrId}
                  />
                </Field>
              </div>
              <div className="min-w-0 grow sm:max-w-[12rem]">
                <Field label={PP.accessLevel}>
                  <select
                    className={INPUT}
                    onChange={(event) => setGrantLevel(event.target.value as "read" | "full")}
                    value={grantLevel}
                  >
                    <option value="read">{PP.accessLevelRead}</option>
                    <option value="full">{PP.accessLevelFull}</option>
                  </select>
                </Field>
              </div>
              <button
                className={BUTTON}
                disabled={busy || grantHrId.trim() === ""}
                onClick={async () => {
                  await onSave("/access-grants", { hrId: grantHrId.trim(), level: grantLevel });
                  setGrantHrId("");
                  await loadGrants();
                }}
                type="button"
              >
                {PP.save}
              </button>
            </div>

            {/* The five people the owner named are pinned in access.ts and cannot appear here, by
                design: a row in this table can admit a SIXTH person and can never demote one of
                them. So an empty list is the correct and expected state. */}
            {grants.length === 0 ? (
              <p className="mt-3 text-[12px] text-slate-500">{PP.accessNoneYet}</p>
            ) : (
              <ul className="mt-3 space-y-1">
                {grants.map((grant) => (
                  <li
                    className="flex flex-wrap items-center justify-between gap-2 border border-slate-200 px-3 py-2 text-[12px]"
                    key={grant.hrId}
                  >
                    <span className="min-w-0 break-words">
                      <Num className="font-bold">{grant.hrId}</Num>{" "}
                      {grant.level === "full" ? PP.accessLevelFull : PP.accessLevelRead}
                      {grant.note ? <span className="text-slate-500"> — {grant.note}</span> : null}
                    </span>
                    <button
                      className={BUTTON_QUIET}
                      disabled={busy}
                      onClick={async () => {
                        await onSave("/access-grants", { hrId: grant.hrId, remove: true });
                        await loadGrants();
                      }}
                      type="button"
                    >
                      {PP.accessRemove}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="text-[12px] text-slate-500">{PP.readOnlyNotice}</p>
        )}
      </section>

      <section className={PANEL}>
        <SectionTitle title={PP.settingsComposition} />
        <ul className="space-y-1 text-[12px] text-slate-700">
          {data.materials.map((material) => (
            <li className="break-words" key={material.id}>
              <span className="font-bold">{material.nameAr}</span>{" "}
              {material.composition ? (
                <>
                  <Qty unit={material.baseUnit} value={material.composition.qtyPerBasis} />{" "}
                  {BASIS_LABELS[material.composition.basis]} —{" "}
                  {SUPPLIER_LABELS[material.composition.supplier]}
                </>
              ) : (
                <span className="text-slate-500">{PP.excludedNoComposition}</span>
              )}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
