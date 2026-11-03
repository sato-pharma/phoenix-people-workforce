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
 * The five tab components are EXPORTED for `scripts/measure-production-planning-fit.mjs`, which
 * renders them inside each shell's own container chain to measure the fit in the portal surface -
 * the one the owner's own Super Admin session can never render, because each twin redirects the
 * other shell's viewer to its sibling. Nothing else imports them, and nothing should: the workspace
 * owns their state.
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

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import {
  adminInsetPanelClassName,
  adminPanelClassName,
  adminSoftPanelClassName,
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";
import { downloadXlsxFrom } from "@/lib/export/download-xlsx-client";
// The three enums from the module's own pure kernel — it declares no imports at all and is
// explicitly client-safe, so the editor's selects offer exactly the values the service accepts.
// Retyping them here is how a select and a server-side CHECK start to disagree.
import { costCoverage } from "@/lib/production-planning/costing";
import { fromBaseUnits, toBaseUnits } from "@/lib/production-planning/display-units";
import { createRequestSequence, planForSelection } from "@/lib/production-planning/request-sequence";
import { COMPOSITION_BASES, isBoughtBySato, MATERIAL_SUPPLIERS, SETTLED_SUPPLIERS } from "@/lib/production-planning/rules";
import {
  coerceProductionPlanningLanguage,
  formatNumberLatin,
  PRODUCTION_PLANNING_DEFAULT_LANGUAGE,
  productionPlanningStrings,
  type ProductionPlanningLanguage,
  type ProductionPlanningStrings,
  type ProductionPlanningStringKey,
  type ProductionPlanningTabKey,
  type ProductMeasure,
} from "@/lib/production-planning/strings";
import type {
  WireBasis,
  WireExpiryVerdict,
  WireGrant,
  WireMaterial,
  WireStockRow,
  WirePlan,
  WirePlanRow,
  WireProduct,
  WireRequestMode,
  WireSupplier,
  WireWorkspace,
} from "@/lib/production-planning/wire";
import { phxSelectClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

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

/**
 * The same rail on the other side, for English.
 *
 * Two literals rather than a logical property: the shared primitives in this app are styled with
 * PHYSICAL properties (`pr-*`, `border-l`) and `tokens.css` has no RTL awareness at all, so a
 * `start-0` here would be the only logical property on the page and would not match anything
 * around it. The gradient is identical; only the edge moves.
 */
const LTR_HEADER_RAIL =
  "pointer-events-none absolute left-0 top-[0.3rem] bottom-[0.3rem] w-[3px] " +
  "bg-[linear-gradient(180deg,#F97316_0%,#FB923C_45%,rgba(251,146,60,0.12)_100%)]";

/**
 * The product's own measurement, for every label that states a size or a unit.
 *
 * 🔴 NO LABEL IN THIS FILE MAY WRITE "مل" OR "ml" OF ITS OWN ANY MORE. The geometry columns are named
 * `…_ml` because the first product was a syrup; Guamusin is a powder in 5 g sachets, and a tile
 * reading "100 لتر" over 100 kg or a hint reading "العينة 40 مل" is a label following a column name
 * instead of the product. Every size here comes from the product row, and the unit word from
 * `S.measureUnitLabels(...)`.
 *
 * The sizes are formatted with Latin digits before they reach a label, which is the module's own
 * rule: `toLocaleString` under an Arabic locale emits ٠١٢٣.
 */
function measureOf(product: WireProduct | null | undefined): ProductMeasure {
  return {
    dose: formatNumberLatin(product?.doseMl ?? "0"),
    goodUnit: formatNumberLatin(product?.goodUnitMl ?? "0"),
    measureUnit: product?.measureUnit ?? "ml",
    sampleUnit: formatNumberLatin(product?.sampleUnitMl ?? "0"),
  };
}

/** The product a payload belongs to — `data.productId` is the server's own answer. */
function selectedProductOf(data: WireWorkspace | null): WireProduct | null {
  if (!data) return null;
  return data.products.find((product) => product.id === data.productId) ?? data.products[0] ?? null;
}

/**
 * 🔒 PREMIUM POLISH, the owner's golden rule of 2026-09-08 — depth is the default, and this module
 * was built after the flat pass and never got it. Every surface here now takes the SHARED admin
 * token rather than its own hairline border, so a planner panel sits on the page exactly the way a
 * payroll or closing panel does instead of reading as an unstyled div.
 *
 * SHADOWS AND GRADIENTS ONLY — nothing in this pass changes a single box's width, height or
 * padding. That is deliberate and it is what keeps the fits-the-screen golden rule intact: the
 * `<colgroup>` percentages, `table-fixed` and the absence of `overflow-x-auto` are untouched, so
 * the measured no-horizontal-scroll result cannot move. The square-edge golden rule is equally
 * safe: the admin tokens carry no radius at all (see the corner note in admin-design-tokens.ts).
 */
const PANEL = `${adminPanelClassName} px-4 py-4`;
/** The desktop table IS the panel — it was a flat bordered grid sitting on the page background. */
const TABLE = `hidden w-full table-fixed ${adminPanelClassName} lg:table`;
/** A notice strip is RECESSED, so it takes the inset token: its depth goes inward, never up. */
const NOTICE = `${adminInsetPanelClassName} px-3 py-2`;
const LABEL = "block text-[10px] font-black uppercase tracking-[0.14em] text-slate-500";
const INPUT = cn(phxSelectClassName, "mt-1 w-full min-w-0 px-2 py-1.5 text-[13px] tabular-nums disabled:text-slate-400");
/**
 * The primary action LIFTS, and a disabled one does not — `disabled:shadow-none` is the whole
 * point of putting the shadow here rather than on each call site: a greyed-out button that still
 * floats reads as clickable.
 */
const BUTTON =
  "inline-flex items-center justify-center gap-1.5 border border-slate-900 bg-slate-900 px-3 py-1.5 " +
  "text-[12px] font-bold text-white shadow-[0_1px_2px_rgba(15,23,42,0.2),0_8px_18px_rgba(15,23,42,0.16)] " +
  "transition-shadow hover:bg-slate-800 disabled:border-slate-300 disabled:bg-slate-200 " +
  "disabled:text-slate-500 disabled:shadow-none";
const BUTTON_QUIET =
  "inline-flex items-center justify-center gap-1.5 border border-slate-300 bg-white px-3 py-1.5 " +
  "text-[12px] font-bold text-slate-700 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-shadow " +
  "hover:bg-slate-50 hover:shadow-[0_1px_2px_rgba(15,23,42,0.06),0_8px_16px_rgba(15,23,42,0.06)] " +
  "disabled:text-slate-400 disabled:shadow-none";
const TH = "px-3 py-2 text-right text-[9px] font-black uppercase tracking-[0.14em] text-slate-500";
const TD = "px-3 py-2 align-top text-[12px] leading-5 text-slate-800";
/** The mobile card is the same row of the same table, so it gets the soft panel, one step quieter. */
const CARD = `${adminSoftPanelClassName} px-3 py-3 lg:hidden`;

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
  const S = useProductionPlanningStrings();

  const label = S.unitLabel(unit);
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
  const warn = tone === "warn";
  return (
    /* A KPI tile is the one thing on the page a reader looks at before anything else, so it is the
       one that most needed lifting off the grey: a white ground, the panel's two-layer shadow, and
       a 3px accent across the top — the hero's own gradient, amber when the tile is a warning. The
       bar is absolutely positioned inside the existing padding box, so the tile's size is
       unchanged and the KPI strip still wraps the way it did. */
    <div
      className={`relative px-3 py-3 text-center ${
        warn
          ? "border border-amber-300 bg-amber-50 shadow-[0_1px_2px_rgba(146,64,14,0.06),0_12px_28px_rgba(146,64,14,0.07)]"
          : adminPanelClassName
      }`}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute inset-x-0 top-0 h-[3px] ${
          warn
            ? "bg-gradient-to-r from-amber-400/0 via-amber-500/80 to-amber-400/0"
            : "bg-gradient-to-r from-orange-500/0 via-orange-400/80 to-orange-500/0"
        }`}
      />
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
/**
 * Which language the module is in, shared by the header and the workspace.
 *
 * A CONTEXT and not a prop, for one structural reason: the portal page passes the header to
 * `EmployeePortalPageShell` as its `hero` and the workspace as its children, so the two are
 * siblings in different prop slots and no prop could reach both from one piece of state. Context
 * resolves where an element is RENDERED, which for both of them is inside the shell — so a provider
 * wrapped around the shell covers the header and the workspace together, and the toggle cannot
 * leave one of them in the other language.
 *
 * The default is ARABIC, which is the language the owner specified the module in; the toggle is a
 * per-reader choice over that, never a replacement for it.
 */
const ProductionPlanningLanguageContext = createContext<{
  lang: ProductionPlanningLanguage;
  setLang: (lang: ProductionPlanningLanguage) => void;
}>({ lang: PRODUCTION_PLANNING_DEFAULT_LANGUAGE, setLang: () => {} });

/**
 * Remembered per browser, not per account.
 *
 * `localStorage` on purpose: the choice is a reading preference, it is worth nothing to anybody
 * else, and storing it in `prodplan_settings` would make one reader's toggle change the language
 * for all five of them. Every access is wrapped — a private window, cleared site data or a blocked
 * store all throw rather than returning null, and the module must render in Arabic in that case
 * instead of not rendering at all.
 */
const LANGUAGE_STORAGE_KEY = "phoenix.production-planning.language";

export function ProductionPlanningLanguageProvider({
  children,
  initialLang = PRODUCTION_PLANNING_DEFAULT_LANGUAGE,
}: {
  children: ReactNode;
  /**
   * The language rendered before the stored choice is read. Both pages leave it alone, because
   * Arabic is the language the owner specified the module in. It exists so
   * `scripts/measure-production-planning-fit.mjs` can render the module in each language and
   * measure the fit of BOTH — the English layout is left-to-right, so it is a different layout
   * and not a translation of a measured one.
   */
  initialLang?: ProductionPlanningLanguage;
}) {
  const [lang, setLang] = useState<ProductionPlanningLanguage>(initialLang);

  // Read AFTER mount, never during render: the server has no localStorage, so reading it in the
  // initial state would make the server and the client disagree on the first paint, which is a
  // hydration error rather than a language.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
      // The remembered language IS an external system being read into React, which is what this
      // rule exempts in prose and flags in code. The alternative - resolving it during render -
      // is the hydration error this comment above describes.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (stored !== null) setLang(coerceProductionPlanningLanguage(stored));
    } catch {
      // A blocked or cleared store leaves the Arabic default standing, which is the right answer.
    }
  }, []);

  const choose = useCallback((next: ProductionPlanningLanguage) => {
    setLang(next);
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
    } catch {
      // The toggle still works for this visit; only remembering it fails.
    }
  }, []);

  const value = useMemo(() => ({ lang, setLang: choose }), [choose, lang]);
  return (
    <ProductionPlanningLanguageContext.Provider value={value}>
      {children}
    </ProductionPlanningLanguageContext.Provider>
  );
}

/** The bundle in force. Every string, label map and sentence in this file comes from here. */
function useProductionPlanningStrings(): ProductionPlanningStrings {
  const { lang } = useContext(ProductionPlanningLanguageContext);
  return productionPlanningStrings(lang);
}

/**
 * The toggle itself — two buttons, not a `<select>`, because the choice is binary and a reader
 * should see both options and which one is on without opening anything.
 *
 * "English" is always the Latin word. The Arabic option reads in the language being read: the
 * Arabic script on the Arabic screen and the word "Arabic" on the English one (owner, 2026-10-08:
 * "every single Arabic word" - the English screen carries no Arabic character at all).
 */
function ProductionPlanningLanguageToggle() {
  const { lang, setLang } = useContext(ProductionPlanningLanguageContext);
  const S = productionPlanningStrings(lang);
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1" dir="ltr" role="group">
      {(
        [
          { key: "ar", label: S.t.languageArabic },
          { key: "en", label: "English" },
        ] as const
      ).map((option) => (
        <button
          aria-pressed={lang === option.key}
          className={`border px-2.5 py-1 text-[12px] font-bold transition-shadow ${
            lang === option.key
              ? "border-slate-900 bg-slate-900 text-white shadow-[0_1px_2px_rgba(15,23,42,0.22),0_10px_22px_rgba(15,23,42,0.18)]"
              : "border-slate-300 bg-white text-slate-700 shadow-[0_1px_2px_rgba(15,23,42,0.04)] hover:bg-slate-50 hover:shadow-[0_1px_2px_rgba(15,23,42,0.06),0_8px_18px_rgba(15,23,42,0.07)]"
          }`}
          key={option.key}
          onClick={() => setLang(option.key)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function ProductionPlanningHeader() {
  const S = useProductionPlanningStrings();
  const t = S.t;

  return (
    <section className="min-w-0" dir={S.dir} lang={S.lang} style={{ fontFamily: S.fontStack }}>
      <div className="flex flex-col gap-3 pb-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        {/* The rail is a right-hand accent, which only means "the start of the line" in Arabic. In
            English the line starts on the left, so the rail and its padding move with it. */}
        <div className={`relative min-w-0 space-y-1.5 ${S.dir === "rtl" ? "pr-3.5" : "pl-3.5"}`}>
          <span aria-hidden="true" className={S.dir === "rtl" ? RTL_HEADER_RAIL : LTR_HEADER_RAIL} />
          <p className={pageHeaderKickerClassName}>{t.moduleKicker}</p>
          <h1 className={pageHeaderTitleClassName}>{t.moduleTitle}</h1>
          <p className={`${pageHeaderDescriptionClassName} break-words`}>{t.moduleSubtitle}</p>
        </div>
        <ProductionPlanningLanguageToggle />
      </div>
      <div aria-hidden="true" className={pageHeaderRuleClassName} />
    </section>
  );
}

/**
 * A section heading, carrying the page header's own rail.
 *
 * One gradient serves the module's header and every heading under it, which is the point: two
 * accents drawn separately drift, and a plain bold line is what a heading looks like when nobody
 * chose it. The rail is mirrored for Arabic exactly as the header's is — on an RTL line `left-0`
 * would put the accent at the END of the title — and the padding moves with it.
 */
function SectionTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  const S = useProductionPlanningStrings();

  return (
    <div className={`relative mb-3 min-w-0 ${S.dir === "rtl" ? "pr-3" : "pl-3"}`}>
      <span aria-hidden="true" className={S.dir === "rtl" ? RTL_HEADER_RAIL : LTR_HEADER_RAIL} />
      <h2 className="text-[15px] font-black tracking-[-0.02em] text-slate-900">{title}</h2>
      {subtitle ? (
        <p className="mt-1 text-[12px] leading-5 text-slate-500 break-words">{subtitle}</p>
      ) : null}
    </div>
  );
}

/** The owner chip for a material: who brings it, and whether it counts toward the buy list. */
function supplierChip(row: WirePlanRow, t: Record<ProductionPlanningStringKey, string>) {
  if (row.supplier === null) return <Chip tone="slate">{t.chipNoComposition}</Chip>;
  if (row.supplier === "shared_unsettled") return <Chip tone="amber">{t.chipUnsettled}</Chip>;
  if (row.supplier === "factory") return <Chip tone="slate">{t.chipFactory}</Chip>;
  return <Chip tone="emerald">{t.chipSato}</Chip>;
}

function excludedNote(row: WirePlanRow, t: Record<ProductionPlanningStringKey, string>): string | null {
  if (row.excludedReason === "factory_supplies") return t.excludedFactory;
  if (row.excludedReason === "supplier_unsettled") return t.excludedUnsettled;
  // Royanoxicam's foil: Sato's on his word, with no amount yet ("leave empty for now").
  if (row.excludedReason === "no_composition" && row.supplier === "sato") return t.excludedSatoNoAmount;
  if (row.excludedReason === "no_composition") return t.excludedNoComposition;
  return null;
}

function overageHint(row: WirePlanRow, t: Record<ProductionPlanningStringKey, string>): string {
  if (row.overageSource === "measured") return t.overageHintMeasured;
  if (row.overageSource === "material") return t.overageHintMaterial;
  return t.overageHintDefault;
}

/**
 * Built from the catalogue IN FORCE, not at import time.
 *
 * These two were module-level constants over the Arabic catalogue, which a language toggle cannot
 * have: the module object is evaluated once, so the first language to load would have been frozen
 * into every later render in the other one.
 */
function fxSourceLabels(t: Record<ProductionPlanningStringKey, string>): Record<"manual" | "fetched" | "fallback" | "none", string> {
  return {
    fallback: t.fxSourceFallback,
    fetched: t.fxSourceFetched,
    manual: t.fxSourceManual,
    none: t.fxSourceNone,
  };
}

function stockSourceLabels(t: Record<ProductionPlanningStringKey, string>): Record<string, string> {
  return {
    adjustment: t.stockSourceAdjustment,
    delivery: t.stockSourceDelivery,
    factory_report: t.stockSourceFactoryReport,
    own_count: t.stockSourceOwnCount,
  };
}

/**
 * The planner opens on the owner's own headline shape — a TOTAL of 100,000 boxes with 10,000 of them
 * samples. Named constants rather than two string literals because the FIRST READ sends them too: a
 * bare `GET /api/production-planning` computes no plan, so without them the screen would open with
 * the form filled in and the table beneath it empty, which reads as a module that cannot calculate.
 *
 * 🔴 THE SAMPLE COUNT IS NOT SENT ON THAT READ — it is the PRODUCT's (`default_sample_units`), and the
 * server fills it in. Sending this 10,000 for every product put Ivyronc's samples into Royanoxicam, a
 * tablet with none: 3 runs read "590,000 tablets and 10,000 samples" (owner, 2026-10-24). The
 * constant below is only what the field shows for the instant before the first answer lands.
 */
const DEFAULT_REQUESTED_QTY = "100000";
const DEFAULT_SAMPLE_UNITS = "10000";
const DEFAULT_MODE: WireRequestMode = "total_boxes";

export function ProductionPlanningWorkspace() {
  const S = useProductionPlanningStrings();
  const t = S.t;

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
  // 🔴 ONE TICKET PER REQUEST, AND ONLY THE NEWEST MAY WRITE (audit P7-04). Switching the product
  // fires a new GET while the old one may still be in flight; without this a late answer for the
  // product he left painted its figures under the one he is on, and Save posted them as that one.
  const [loads] = useState(createRequestSequence);
  const [calculations] = useState(createRequestSequence);

  const load = useCallback(async () => {
    const ticket = loads.begin();
    // A plan still being calculated belongs to the payload this load replaces.
    calculations.invalidate();
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        mode: DEFAULT_MODE,
        requestedQty: DEFAULT_REQUESTED_QTY,
      });
      // 🔴 THE WHOLE PAYLOAD IS PER PRODUCT, so the product has to travel on the GET.
      //
      // The materials, the formula, the stock, the runs, the saved plans and the expiry verdicts in
      // the response all belong to ONE product. Before Guamusin the server defaulted to the only one
      // there was; with two, a Stock tab reading a payload fetched for the other product shows the
      // wrong thirteen rows with nothing on screen to say so. Empty on the first load, which is the
      // server's cue to answer for its own first product and TELL us which (`data.productId`).
      if (productId) params.set("productId", productId);
      const response = await fetch(`/api/production-planning?${params.toString()}`, { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as WireWorkspace | { message?: string } | null;
      if (!loads.isCurrent(ticket)) return;
      if (!response.ok) {
        setError((payload as { message?: string })?.message ?? t.loadFailed);
        setData(null);
        return;
      }
      const workspace = payload as WireWorkspace;
      setData(workspace);
      setPlan(workspace.plan);
      // The form follows the plan it is showing. A load replaces the plan with this product's default
      // one, so a form still holding the last product's mode, count and samples would sit above
      // figures it did not ask for — and Calculate would carry those samples into this product.
      if (workspace.plan) {
        setMode(workspace.plan.mode);
        setRequestedQty(workspace.plan.requestedQty);
        setSampleUnits(workspace.plan.sampleUnits);
      }
      // 🔴 `productId` is NOT seeded from the response, deliberately. Seeding it would change the
      // state this `load` depends on and fire a SECOND identical fetch on every mount. The selected
      // product is read as `productId || data.productId`, so an unset choice follows the server's
      // own default and only an actual change refetches.
    } catch {
      if (!loads.isCurrent(ticket)) return;
      setError(t.loadFailed);
      setData(null);
    } finally {
      if (loads.isCurrent(ticket)) setLoading(false);
    }
    // The failure MESSAGE is language-dependent, so it is a real dependency: without it a reader who
    // flips the toggle and then loses the network would be shown the message in the language they
    // just left. The refetch a language change now triggers costs one request and returns the same
    // payload - the query carries no language - so it is a message correctness fix, not a reload.
  }, [loads, calculations, productId, t.loadFailed]);

  useEffect(() => {
    // The repo's `react-hooks/set-state-in-effect` is an error, and a fetch-on-mount effect trips
    // it because `load` sets the loading flag before its first await. Disabled here, as the other
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
          // The language rides on EVERY write, in one place rather than at each call site: the
          // server's validation messages come from the same catalogue the screen is reading, so a
          // refusal lands in the language the reader is in rather than in the module's default.
          body: JSON.stringify({ lang: S.lang, ...body }),
        });
        const payload = (await response.json().catch(() => null)) as { message?: string } | null;
        if (!response.ok) {
          setError(payload?.message ?? t.saveFailed);
          return null;
        }
        return payload;
      } catch {
        setError(t.saveFailed);
        return null;
      } finally {
        setBusy(false);
      }
    },
    // `S.lang` is in the body now, so a toggle must give back a new `post`.
    [S.lang, t.saveFailed],
  );

  /**
   * The product every tab is showing — the explicit choice, or the one the server answered with.
   *
   * Two sources and not one because `productId` stays empty until somebody picks from the dropdown
   * (see `load`), and every POST still has to name a product.
   */
  const selectedProductId = productId || data?.productId || "";

  const calculate = useCallback(async () => {
    const ticket = calculations.begin();
    const result = (await post("/plan", {
      productId: selectedProductId,
      mode,
      requestedQty,
      sampleUnits,
      overridePct: overridePct.trim() === "" ? null : overridePct.trim(),
      willSendByMaterialId: willSend,
    })) as WirePlan | null;
    if (result && calculations.isCurrent(ticket)) setPlan(result);
  }, [calculations, post, selectedProductId, mode, requestedQty, sampleUnits, overridePct, willSend]);

  // The plan on screen, only while it is the selected product's. A plan for the product he just left
  // is withheld — which also disables Save, so it can never be posted under the other product's id.
  const shownPlan = planForSelection(plan, selectedProductId);

  const saveAndReload = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      const result = await post(path, body);
      if (result) {
        setNotice(t.saved);
        await load();
      }
    },
    [post, load, t.saved],
  );

  const materialsById = useMemo(() => {
    const map = new Map<string, WireMaterial>();
    for (const material of data?.materials ?? []) map.set(material.id, material);
    return map;
  }, [data]);

  const canWrite = data?.canWrite === true;

  if (loading && !data) {
    return (
      <div
        className="min-w-0 px-1 py-8 text-center text-[13px] text-slate-500"
        dir={S.dir}
        lang={S.lang}
        style={{ fontFamily: S.fontStack }}
      >
        {t.loading}
      </div>
    );
  }

  return (
    <div className="min-w-0" dir={S.dir} lang={S.lang} style={{ fontFamily: S.fontStack }}>
      {!canWrite && data ? (
        <p className={`${NOTICE} text-[12px] font-bold text-slate-700`}>{t.readOnlyNotice}</p>
      ) : null}

      {/* An alert LIFTS — it is the one thing on the page that arrived after the reader did, so it
          carries the panel's two-layer shadow in its own tone rather than the inset notice's. */}
      {error ? (
        <p
          className="mt-4 border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-bold text-rose-900 shadow-[0_1px_2px_rgba(127,29,29,0.06),0_12px_28px_rgba(127,29,29,0.08)] break-words"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {notice ? (
        <p className="mt-4 border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] font-bold text-emerald-900 shadow-[0_1px_2px_rgba(6,78,59,0.06),0_12px_28px_rgba(6,78,59,0.07)]">
          {notice}
        </p>
      ) : null}

      {/* flex-wrap, never a scroller: on an RTL page a horizontal scroller opens at the line's end. */}
      <div className="mt-4 flex flex-wrap gap-2" role="tablist">
        {S.tabs.map((entry) => (
          <button
            aria-selected={tab === entry.key}
            className={`border px-3 py-1.5 text-[12px] font-bold transition-shadow ${
              tab === entry.key
                ? "border-slate-900 bg-slate-900 text-white shadow-[0_1px_2px_rgba(15,23,42,0.22),0_10px_22px_rgba(15,23,42,0.18)]"
                : "border-slate-300 bg-white text-slate-700 shadow-[0_1px_2px_rgba(15,23,42,0.04)] hover:bg-slate-50 hover:shadow-[0_1px_2px_rgba(15,23,42,0.06),0_8px_18px_rgba(15,23,42,0.07)]"
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
            onCommit={(commit) => {
              if (!shownPlan) return;
              void saveAndReload("/plans", {
                productId: selectedProductId,
                mode,
                requestedQty,
                sampleUnits,
                overridePct: overridePct.trim() === "" ? null : overridePct.trim(),
                willSendByMaterialId: willSend,
                commit,
              });
            }}
            onModeChange={setMode}
            onOverrideChange={setOverridePct}
            onProductChange={setProductId}
            onRequestedChange={setRequestedQty}
            onSamplesChange={setSampleUnits}
            onWillSendChange={(materialId, value) =>
              setWillSend((current) => ({ ...current, [materialId]: value }))
            }
            overridePct={overridePct}
            plan={shownPlan}
            productId={selectedProductId}
            requestedQty={requestedQty}
            sampleUnits={sampleUnits}
            willSend={willSend}
          />
        ) : null}

        {tab === "stock" ? (
          <StockTab busy={busy} canWrite={canWrite} data={data} onSave={saveAndReload} />
        ) : null}

        {tab === "cost" ? (
          <CostTab busy={busy} canWrite={canWrite} data={data} onSave={saveAndReload} plan={shownPlan} />
        ) : null}

        {tab === "run" ? (
          <RunTab
            busy={busy}
            canWrite={canWrite}
            data={data}
            materialsById={materialsById}
            onSave={saveAndReload}
            productId={selectedProductId}
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

/** Exported for scripts/measure-production-planning-fit.mjs - see the note at the top of this file. */
export function PlannerTab(props: PlannerTabProps) {
  const S = useProductionPlanningStrings();
  const t = S.t;

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
        // The language the screen is in, so the file matches the page that offered it.
        lang: S.lang,
        mode: props.mode,
        productId: props.productId,
        requestedQty: props.requestedQty,
        sampleUnits: props.sampleUnits,
      });
      if (props.overridePct.trim() !== "") params.set("overridePct", props.overridePct.trim());
      await downloadXlsxFrom(`/api/production-planning/workbook?${params.toString()}`, "production-plan.xlsx");
    } catch {
      setExportError(t.exportFailed);
    } finally {
      setExporting(false);
    }
  }, [props.mode, props.productId, props.requestedQty, props.sampleUnits, props.overridePct, S.lang, t.exportFailed]);

  if (!data) return <p className={`${PANEL} text-[13px] text-slate-500`}>{t.notLoaded}</p>;

  // The product the dropdown is on, and the unit pair every label below takes from it.
  const product = data.products.find((candidate) => candidate.id === props.productId) ?? selectedProductOf(data);
  const measure = measureOf(product);
  // The two quantity modes mean BOXES to the engine. On a product whose box holds more than one
  // saleable unit the label says so, because "إجمالي العلب" alone let the owner read the field as a
  // sachet count — and his 120,000 typed there is 72 runs rather than 6.
  const modeLabels = S.requestModeLabels({
    measureUnit: measure.measureUnit,
    unitsPerBox: product?.unitsPerBox ?? "1",
  });

  return (
    <>
      <section className={PANEL}>
        <SectionTitle subtitle={t.moduleSubtitle} title={t.plannerTitle} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={t.productLabel}>
            <select
              className={INPUT}
              onChange={(event) => props.onProductChange(event.target.value)}
              value={props.productId}
            >
              {data.products.map((product) => (
                <option key={product.id} value={product.id}>
                  {S.name(product)}
                </option>
              ))}
            </select>
          </Field>

          <Field label={t.requestModeLabel}>
            <select
              className={INPUT}
              onChange={(event) => props.onModeChange(event.target.value as WireRequestMode)}
              value={props.mode}
            >
              <option value="total_boxes">{modeLabels.total}</option>
              <option value="good_units">{modeLabels.goodUnits}</option>
              <option value="runs">{modeLabels.runs}</option>
            </select>
          </Field>

          <Field label={t.requestedQtyLabel}>
            <input
              className={INPUT}
              dir="ltr"
              inputMode="numeric"
              onChange={(event) => props.onRequestedChange(event.target.value)}
              value={props.requestedQty}
            />
          </Field>

          <Field hint={S.sampleUnitsHint(measure)} label={t.sampleUnitsLabel}>
            <input
              className={INPUT}
              dir="ltr"
              inputMode="numeric"
              onChange={(event) => props.onSamplesChange(event.target.value)}
              value={props.sampleUnits}
            />
          </Field>

          <Field
            hint={`${t.overageHintDefault}: ${formatNumberLatin(data.settings.defaultOveragePct)}%`}
            label={t.overageLabel}
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
              {t.calculate}
            </button>
            {props.canWrite ? (
              <>
                <button
                  className={BUTTON_QUIET}
                  disabled={props.busy || !plan}
                  onClick={() => props.onCommit(false)}
                  type="button"
                >
                  {t.saveDraft}
                </button>
                <button
                  className={BUTTON_QUIET}
                  disabled={props.busy || !plan}
                  onClick={() => props.onCommit(true)}
                  type="button"
                >
                  {t.commitPlan}
                </button>
              </>
            ) : null}
            <button className={BUTTON_QUIET} disabled={exporting} onClick={() => void exportWorkbook()} type="button">
              {t.exportWorkbook}
            </button>
          </div>
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-slate-500">{t.exportHint}</p>
        {exportError ? <p className="mt-1 text-[12px] text-rose-700">{exportError}</p> : null}
      </section>

      {plan ? <PlannerResult {...props} plan={plan} /> : null}
    </>
  );
}

function PlannerResult({
  data,
  plan,
  canWrite,
  onWillSendChange,
  willSend,
}: PlannerTabProps & { plan: WirePlan }) {
  const S = useProductionPlanningStrings();
  const t = S.t;
  const shortfall = plan.oneRunFewer;

  // The sentence is rebuilt HERE from the plan's own figures, rather than rendering the
  // `plan.sentence` the server sent: the request carries no language, so the server's copy is in
  // whichever language this payload was asked for, and the toggle would leave an Arabic sentence
  // sitting under four English tiles until the next calculate. The server's copy still exists and
  // is what the WORKBOOK's header line reads - the sheet is built server-side - and it stays the
  // fallback here for a plan whose product is somehow not in the list.
  // `data` is nullable on these props (the tab renders before the first load answers), and a plan
  // cannot exist without it - but the compiler cannot know that, so it is narrowed rather than
  // asserted: the fallback below is the server's own sentence, which is a correct sentence in the
  // language the payload was asked for.
  const sentenceProduct = data
    ? (data.products.find((candidate) => candidate.id === plan.productId) ?? data.products[0])
    : undefined;
  const sentence = sentenceProduct
    ? S.plannerSentence({
        runs: formatNumberLatin(plan.runs),
        runVolumeLitres: formatNumberLatin(plan.runVolumeLitres),
        totalVolumeLitres: formatNumberLatin(plan.totalVolumeLitres),
        goodUnits: formatNumberLatin(plan.goodUnits),
        goodUnitMl: formatNumberLatin(sentenceProduct.goodUnitMl),
        sampleUnits: formatNumberLatin(plan.sampleUnits),
        sampleUnitMl: formatNumberLatin(sentenceProduct.sampleUnitMl),
        surplusBoxes: formatNumberLatin(plan.surplusBoxes),
        shortfallBoxes: null,
        // From the PLAN, not the product row: the plan is what these figures were computed under.
        measureUnit: plan.measureUnit,
        // The owner's bracket. `unitsPerBox` comes off the PRODUCT because it is a packing fact
        // rather than a plan one, and it is what decides whether a bracket appears at all.
        totalBoxes: formatNumberLatin(plan.totalBoxes),
        unitsPerBox: sentenceProduct.unitsPerBox,
      })
    : plan.sentence;

  // The unit words the tiles and the leftover line carry. `Tile` prints its `unit` verbatim, so a
  // hard-coded `t.unitLitre` here would label 600 kg of powder as litres.
  const units = S.measureUnitLabels(plan.measureUnit);
  const basisLabels = S.basisLabels(measureOf(sentenceProduct));
  // The saleable-unit word, and whether a box holds more than one of them. Everything below counts
  // in SACHETS with the box count in brackets when it does — the owner's 2026-10-08 instruction —
  // and in boxes alone when a box is one unit, which is every Ivyronc figure.
  const perBox = sentenceProduct?.unitsPerBox ?? "1";
  const saleableWord = S.saleableUnitWord(plan.measureUnit);
  const boxed = (boxes: string) =>
    perBox === "1" ? saleableWord : `${saleableWord} (${formatNumberLatin(boxes)} ${t.unitBox})`;
  // How much of the cost total is actually covered by prices — see the note at the total itself.
  const coverage = costCoverage(plan.totals);

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
          <Tile label={t.tileRuns} unit={t.unitRuns} value={plan.runs} />
          <Tile label={S.runSizeLabel(plan.measureUnit)} unit={units.large} value={plan.runVolumeLitres} />
          {/* The TOTAL, never the saleable count — 106,000 and not 96,000 (his headline rule). What
              changed is the UNIT it is counted in: `packagingSets` is the saleable-unit count, so
              Guamusin reads 120,000 with its 10,000 boxes in brackets, and Ivyronc at one bottle a
              box reads exactly the 106,000 علبة it always did. */}
          <Tile label={t.tileYield} unit={boxed(plan.totalBoxes)} value={plan.packagingSets} />
          {plan.surplusBoxes !== "0" ? (
            <Tile label={t.tileSurplus} tone="warn" unit={t.unitBox} value={plan.surplusBoxes} />
          ) : (
            <Tile label={t.tileSurplus} unit={t.unitBox} value="0" />
          )}
        </div>

        <p className="mt-3 text-[13px] font-semibold leading-6 text-slate-800 break-words">
          {sentence}
        </p>

        <ul className="mt-2 space-y-1 text-[11px] leading-5 text-slate-500">
          {plan.rounded ? (
            <li>
              {t.roundedUpNote} — {t.exactRunsNote} <Num>{formatNumberLatin(plan.exactRuns)}</Num>
            </li>
          ) : null}
          {shortfall ? (
            <li>
              {t.oneRunFewerNote}: <Num>{formatNumberLatin(shortfall.runs)}</Num> {t.unitRuns} —{" "}
              <Num>{formatNumberLatin(shortfall.packagingSets)}</Num> {boxed(shortfall.totalBoxes)}
              {shortfall.shortfallBoxes !== "0" ? (
                <>
                  {" "}
                  ({t.tileShortfall} <Num>{formatNumberLatin(shortfall.shortfallBoxes)}</Num>)
                </>
              ) : null}
            </li>
          ) : null}
          {plan.leftoverMl !== "0" ? (
            <li>
              {t.leftoverNote}: <Qty unit={units.small} value={plan.leftoverMl} />
            </li>
          ) : null}
        </ul>
      </section>

      <section className="min-w-0">
        {/* 31/23/23/23. Four columns, because the fifth would take the delivery input below its
            natural width in the admin shell's 669px box — fit by MERGING, never by shrinking. */}
        <table className={TABLE}>
          <colgroup>
            <col className="w-[31%]" />
            <col className="w-[23%]" />
            <col className="w-[23%]" />
            <col className="w-[23%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-300 bg-slate-50">
              {[t.colMaterial, t.colNeeded, t.colAvailable, t.colAction].map((heading) => (
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
                  <p className="font-bold text-slate-900 break-words">{S.name(row)}</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {supplierChip(row, t)}
                    {row.isImported ? <Chip tone="amber">{t.chipImported}</Chip> : null}
                  </div>
                </td>
                <td className={TD}>
                  <p className="font-bold text-slate-900">
                    <Qty unit={row.displayUnit} value={row.needed} />
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    {t.beforeOverage} <Qty unit={row.displayUnit} value={row.rawNeeded} /> +{" "}
                    <Num>{formatNumberLatin(row.overagePct)}%</Num>
                  </p>
                  <p className="mt-0.5 break-words text-[11px] text-slate-500">{overageHint(row, t)}</p>
                  {row.basis ? (
                    <p className="mt-0.5 break-words text-[11px] text-slate-500">
                      {basisLabels[row.basis]}
                    </p>
                  ) : null}
                </td>
                <td className={TD}>
                  {row.supplier === "factory" ? (
                    // Sato holds none of what the factory brings, so three zeros would read as a
                    // shortage of his own.
                    <p className="break-words text-[11px] text-slate-500">{t.heldFactoryBrings}</p>
                  ) : (
                    <>
                      <p>
                        {t.atFactory} <Qty unit={row.displayUnit} value={row.heldAtFactory} />
                      </p>
                      <p className="mt-0.5">
                        {t.atOwnStore} <Qty unit={row.displayUnit} value={row.heldElsewhere} />
                      </p>
                      <p className="mt-0.5 font-bold text-slate-900">
                        {t.totalHeld} <Qty unit={row.displayUnit} value={row.heldTotal} />
                      </p>
                      {row.coverRuns ? (
                        <p className="mt-0.5 text-[11px] text-slate-500">
                          {t.coverRuns} <Num>{formatNumberLatin(row.coverRuns)}</Num> {t.unitRuns}
                        </p>
                      ) : null}
                    </>
                  )}
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
              <p className="font-bold text-slate-900 break-words">{S.name(row)}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {supplierChip(row, t)}
                {row.isImported ? <Chip tone="amber">{t.chipImported}</Chip> : null}
              </div>
              <dl className="mt-2 space-y-1 text-[12px] text-slate-700">
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="font-bold">{t.colNeeded}</dt>
                  <dd>
                    <Qty unit={row.displayUnit} value={row.needed} />
                  </dd>
                </div>
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="font-bold">{t.totalHeld}</dt>
                  <dd className="break-words">
                    {row.supplier === "factory" ? (
                      t.heldFactoryBrings
                    ) : (
                      <Qty unit={row.displayUnit} value={row.heldTotal} />
                    )}
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
        <SectionTitle title={t.costTotal} />
        {/* 🔴 A STRUCTURAL ZERO IS NOT A COST. Measured on production 2026-10-09: 10 of 12
            materials are on the buy list and all 10 are unpriced, so both totals are "0.00" — and
            they were rendered as the two bold figures here with the explanation as an 11px grey
            footnote two lines down. The number the eye lands on said "this costs nothing" when it
            meant "nothing here is priced". So when no buy-list line carries a price, the figure is
            replaced by words; when SOME do, the figure stays and is labelled partial, at a weight
            that can actually be seen. AGENTS.md §7: the UI says a source is unavailable rather than
            showing a misleading zero. The coverage arithmetic — including that the denominator is
            `toBuyCount` and never `materials` — lives in `costCoverage`, so it is tested by being
            run. */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <p className="text-[13px] text-slate-800">
            {t.currencyUsd}{" "}
            {coverage.none ? (
              <span className="font-bold break-words text-amber-900">{t.costNoPrices}</span>
            ) : (
              <Num className="font-bold">{formatNumberLatin(plan.totals.costUsd)}</Num>
            )}
          </p>
          <p className="text-[13px] text-slate-800">
            {t.currencyEgp}{" "}
            {coverage.none ? (
              <span className="font-bold break-words text-amber-900">{t.costNoPrices}</span>
            ) : (
              <Num className="font-bold">{formatNumberLatin(plan.totals.costEgp)}</Num>
            )}
          </p>
        </div>
        {coverage.partial ? (
          <p className="mt-2 border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] font-bold break-words text-amber-900">
            {t.costPartialTotal} — {t.costPricedOnBuyList}: <Num>{coverage.priced}</Num> /{" "}
            <Num>{coverage.onBuyList}</Num>
          </p>
        ) : null}
        <ul className="mt-2 space-y-1 text-[11px] leading-5 text-slate-500">
          <li>
            {t.fxRate}: {fxSourceLabels(t)[plan.totals.fxSource]}
            {plan.totals.fxRate ? (
              <>
                {" "}
                <Num>{formatNumberLatin(plan.totals.fxRate)}</Num>
              </>
            ) : null}
          </li>
          {plan.totals.unpricedMaterials > 0 ? (
            <li>
              {t.costUnpriced}: <Num>{plan.totals.unpricedMaterials}</Num> — {t.costNotWholeNotice}
            </li>
          ) : null}
          {plan.totals.incompleteMaterials > 0 ? (
            <li>
              {t.costIncomplete}: <Num>{plan.totals.incompleteMaterials}</Num>
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
  const S = useProductionPlanningStrings();
  const t = S.t;
  const note = excludedNote(row, t);
  if (!row.contributesToBuyList) {
    return <p className="break-words text-[11px] text-slate-500">{note ?? t.noActionNeeded}</p>;
  }
  const short = row.balanceAfter.startsWith("-");
  return (
    <div className="min-w-0 space-y-1">
      {row.toBuy !== "0" ? (
        <p className="font-bold text-slate-900">
          {t.toBuy} <Qty unit={row.displayUnit} value={row.toBuy} />
        </p>
      ) : null}
      <p>
        {t.toDeliver} <Qty unit={row.displayUnit} value={row.minToDeliver} />
      </p>
      {canWrite ? (
        <label className="block">
          <span className="text-[10px] font-bold text-slate-500">{t.willSend}</span>
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
        {short ? t.shortAfter : t.balanceAfter}{" "}
        <Qty unit={row.displayUnit} value={row.balanceAfter} />
        {row.balanceAfterRuns ? (
          <>
            {" "}
            <span className="text-[11px] text-slate-500">
              ({t.coverRuns} <Num>{formatNumberLatin(row.balanceAfterRuns)}</Num> {t.unitRuns})
            </span>
          </>
        ) : null}
      </p>
    </div>
  );
}

// ── The stock tab ────────────────────────────────────────────────────────────────────────────────

type SaveFn = (path: string, body: Record<string, unknown>) => Promise<void>;

/** Exported for scripts/measure-production-planning-fit.mjs - see the note at the top of this file. */
/**
 * The workspace as the Stock and Cost tabs see it — only the materials SATO buys and holds.
 *
 * Owner, 2026-10-29, on Royanoxicam: "we only supply the active material, Laura Noxicam boxes,
 * pamphlet, and aluminium foil only. We don't supply inactive materials." He chose to keep the
 * formula complete, so the Formula and Planner screens still list the factory's lines; only the
 * money and the store leave them out. The count comes back so each tab can say how many it hid.
 */
function satoBoughtView(workspace: WireWorkspace | null): { data: WireWorkspace | null; factoryHidden: number } {
  if (!workspace) return { data: null, factoryHidden: 0 };
  const materials = workspace.materials.filter((material) => isBoughtBySato(material.supplier));
  return { data: { ...workspace, materials }, factoryHidden: workspace.materials.length - materials.length };
}

/** The one visible line saying the list is short on purpose, never a silent omission. */
function FactoryHiddenNote({ count }: { count: number }) {
  const t = useProductionPlanningStrings().t;
  if (count === 0) return null;
  return (
    <p className="mb-2 break-words text-[12px] text-slate-500">
      {t.factoryHiddenNote} <Num>{count}</Num>
    </p>
  );
}

export function StockTab({
  data: workspace,
  canWrite,
  busy,
  onSave,
}: {
  data: WireWorkspace | null;
  canWrite: boolean;
  busy: boolean;
  onSave: SaveFn;
}) {

  const S = useProductionPlanningStrings();
  const t = S.t;
  const { data, factoryHidden } = satoBoughtView(workspace);
  const [materialId, setMaterialId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [qty, setQty] = useState("");
  const [asOfDate, setAsOfDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [source, setSource] = useState("factory_report");
  const [note, setNote] = useState("");

  if (!data) return <p className={`${PANEL} text-[13px] text-slate-500`}>{t.notLoaded}</p>;
  const locationName = (id: string) => {
    const found = data.locations.find((location) => location.id === id);
    return found ? S.name(found) : id;
  };
  // 🔴 THIS product's factory, never the first location flagged as one. Royanoxicam is made at two
  // factories, and the other one's store is no place to record this product's stock.
  const ownFactoryId = selectedProductOf(data)?.factoryLocationId ?? null;
  const ownLocations = data.locations.filter((location) => !location.isFactory || location.id === ownFactoryId);

  // A delivery is the amount SENT and is added to what is already held, so the field asks for a
  // different number from the other three sources and says which balance it lands on. The sum
  // itself is never computed here: the service owns that arithmetic in base units, and a second
  // implementation in floats is how the screen and the stored figure start to disagree.
  const isDelivery = source === "delivery";
  const formMaterial = data.materials.find((candidate) => candidate.id === materialId) ?? null;
  // 🔴 THE LOT, not the location. A delivery of the batch expiring in April 2027 lands on THAT
  // batch's standing figure; the batch expiring in 2029 is a different balance and the hint must not
  // offer it. An empty expiry field means the undated lot — packaging, which never expires.
  const typedExpiry = expiryDate.trim() === "" ? null : expiryDate.trim();
  const standingHere =
    [...(formMaterial?.stock ?? []), ...(formMaterial?.expiredStock ?? [])].find(
      (row) => row.locationId === locationId && row.expiryDate === typedExpiry,
    ) ?? null;
  const qtyHint = isDelivery
    ? standingHere
      ? `${t.stockDeliveryAdds}: ${standingHere.qtyDisplay} ${formMaterial?.displayUnit ?? ""}`.trim()
      : t.stockDeliveryAdds
    : t.stockBalanceAfter;

  return (
    <>
      {canWrite ? (
        <section className={PANEL}>
          <SectionTitle subtitle={t.stockSubtitle} title={t.stockAdd} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label={t.colMaterial}>
              <select
                className={INPUT}
                onChange={(event) => setMaterialId(event.target.value)}
                value={materialId}
              >
                <option value="">{t.colMaterial}</option>
                {data.materials.map((material) => (
                  <option key={material.id} value={material.id}>
                    {S.name(material)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t.stockLocation}>
              <select
                className={INPUT}
                onChange={(event) => setLocationId(event.target.value)}
                value={locationId}
              >
                <option value="">{t.stockLocation}</option>
                {ownLocations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {S.name(location)}
                  </option>
                ))}
              </select>
            </Field>
            <Field hint={qtyHint} label={isDelivery ? t.stockDeliveredQty : t.stockQty}>
              <input
                className={INPUT}
                dir="ltr"
                inputMode="decimal"
                onChange={(event) => setQty(event.target.value)}
                value={qty}
              />
            </Field>
            <Field label={t.stockAsOf}>
              <input
                className={INPUT}
                dir="ltr"
                onChange={(event) => setAsOfDate(event.target.value)}
                type="date"
                value={asOfDate}
              />
            </Field>
            {/* The owner, 2026-10-08: "خانة الاكسبايري ديت مهمة جدا جدا جدا يا عمر" — and left blank
                for packaging, because the film, the cartons and the stickers do not expire. */}
            <Field hint={t.stockExpiryHint} label={t.stockExpiry}>
              <input
                className={INPUT}
                dir="ltr"
                onChange={(event) => setExpiryDate(event.target.value)}
                type="date"
                value={expiryDate}
              />
            </Field>
            <Field label={t.stockSource}>
              <select
                className={INPUT}
                onChange={(event) => setSource(event.target.value)}
                value={source}
              >
                {Object.entries(stockSourceLabels(t)).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t.stockNote}>
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
                  // `null` is the undated lot, which is what packaging has — not "unknown".
                  expiryDate: typedExpiry,
                  source,
                  note: note.trim() === "" ? null : note.trim(),
                });
              }}
              type="button"
            >
              {t.save}
            </button>
          </div>
        </section>
      ) : null}

      {canWrite ? (
        <LotExpiryEditor busy={busy} locationName={locationName} materials={data.materials} onSave={onSave} />
      ) : null}

      {data.expiry.length > 0 ? <ExpiryBanner rows={data.expiry} /> : null}

      <section className="min-w-0">
        <FactoryHiddenNote count={factoryHidden} />
        {/* 34/22/22/22, UNCHANGED. The Expired column made four figures for four columns, so the
            factory and the Sato store are MERGED into one Available column, the way the planner
            table carries them: a fifth column takes this table below its natural width, and merging
            is the fits-the-screen rule's own remedy (AGENTS.md §4). */}
        <table className={TABLE}>
          <colgroup>
            <col className="w-[34%]" />
            <col className="w-[22%]" />
            <col className="w-[22%]" />
            <col className="w-[22%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-300 bg-slate-50">
              {[t.colMaterial, t.colAvailable, t.stockExpiry, t.stockExpired].map((heading) => (
                <th className={TH} key={heading} scope="col">
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.materials.map((material) => {
              // 🔴 The SUMMED figure the server computed, not `stock.find(...)`. With lots, several
              // rows share a location, and `find` would show one batch as if it were the whole
              // balance — reading 100 kg where 230 kg is held.
              const factory = material.heldByLocation.find((row) => row.locationId === ownFactoryId);
              const own = material.heldByLocation.find(
                (row) => !data.locations.find((location) => location.id === row.locationId)?.isFactory,
              );
              const dated = material.stock.filter((row) => row.expiryDate !== null);
              const soonest = dated[0] ?? null;
              const expiredLots = material.expiredStock ?? [];
              return (
                <tr className="border-b border-slate-200 last:border-b-0" key={material.id}>
                  <td className={TD}>
                    <p className="font-bold text-slate-900 break-words">{S.name(material)}</p>
                  </td>
                  <td className={TD}>
                    {factory || own ? (
                      [
                        { held: factory, label: t.atFactory },
                        { held: own, label: t.atOwnStore },
                      ].map(({ held, label }) =>
                        held ? (
                          <div className="mt-1 first:mt-0" key={label}>
                            <p className="break-words">
                              <span className="text-[11px] text-slate-500">{label}</span>{" "}
                              <Qty unit={material.displayUnit} value={held.qtyDisplay} />
                            </p>
                            <p className="text-[11px] text-slate-500">
                              <Num>{held.newestAsOfDate}</Num>
                              {held.lots > 1 ? ` · ${formatNumberLatin(held.lots)}` : ""}
                            </p>
                          </div>
                        ) : null,
                      )
                    ) : (
                      <span className="break-words text-[11px] text-slate-500">{t.stockNoneYet}</span>
                    )}
                  </td>
                  <td className={TD}>
                    {soonest?.expiryDate ? (
                      <>
                        <Num>{soonest.expiryDate}</Num>
                        {dated.length > 1 ? (
                          <p className="mt-0.5 break-words text-[11px] text-slate-500">{t.stockLotNote}</p>
                        ) : null}
                      </>
                    ) : expiredLots.length > 0 ? (
                      "—"
                    ) : (
                      <span className="break-words text-[11px] text-slate-500">{t.stockNoExpiry}</span>
                    )}
                  </td>
                  <td className={TD}>
                    {material.expiredTotalDisplay ? (
                      <>
                        <Qty unit={material.displayUnit} value={material.expiredTotalDisplay} />
                        <p className="mt-0.5 text-[11px] text-slate-500">
                          <Num>{expiredLots.at(-1)?.expiryDate}</Num>
                          {expiredLots.length > 1 ? ` · ${formatNumberLatin(expiredLots.length)}` : ""}
                        </p>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="space-y-2 lg:hidden">
          {data.materials.map((material) => (
            <article className={CARD} key={material.id}>
              <p className="font-bold text-slate-900 break-words">{S.name(material)}</p>
              <dl className="mt-2 space-y-1 text-[12px] text-slate-700">
                {material.stock.length === 0 ? (
                  <p className="text-[11px] text-slate-500">{t.stockNoneYet}</p>
                ) : (
                  // One line per LOT on mobile, which is where the detail belongs: the card has the
                  // room the desktop table does not, so each batch shows its own expiry rather than
                  // only the soonest.
                  material.stock.map((row) => (
                    <div
                      className="flex flex-wrap justify-between gap-2"
                      key={`${row.locationId}-${row.expiryDate ?? "none"}-${row.asOfDate}`}
                    >
                      <dt className="font-bold break-words">
                        {locationName(row.locationId)}
                        <span className="ms-1 font-normal text-slate-500">
                          {row.expiryDate ? <Num>{row.expiryDate}</Num> : t.stockNoExpiry}
                        </span>
                      </dt>
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

      <ExpiredStock locationName={locationName} materials={data.materials} />
    </>
  );
}

/**
 * Every expired lot, for the accounts: what it was, where it stood, its date and how much.
 *
 * The Expired column gives each material's total. This is the detail behind it, and on a phone,
 * where the table is hidden, it is the whole of it. Quantities only: not one material carries a
 * price yet (measured on production 2026-11-03), so a value here would read zero for every lot.
 */
function ExpiredStock({
  materials,
  locationName,
}: {
  materials: WireMaterial[];
  locationName: (id: string) => string;
}) {
  const S = useProductionPlanningStrings();
  const t = S.t;
  const rows = materials.flatMap((material) => (material.expiredStock ?? []).map((lot) => ({ lot, material })));
  if (rows.length === 0) return null;
  return (
    <section className={PANEL}>
      <SectionTitle subtitle={t.expiredSubtitle} title={t.expiredTitle} />
      <ul className="space-y-1">
        {rows.map(({ lot, material }) => (
          <li
            className="border border-slate-300 bg-slate-50 px-3 py-2 text-[12px] font-semibold break-words text-slate-700"
            key={`${material.id}-${lot.locationId}-${lot.expiryDate}`}
          >
            {S.name(material)} — {locationName(lot.locationId)} · <Num>{lot.expiryDate}</Num> ·{" "}
            <Qty unit={material.displayUnit} value={lot.qtyDisplay} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Change the expiry date of a lot already in stock, or give an undated one its date.
 *
 * The add form cannot do this: a report carrying a new date opens a second lot beside the old one,
 * and the material is then counted twice. Expired lots are offered too, because a wrong date is how
 * a good lot gets written off, and correcting it is what brings the lot back.
 */
function LotExpiryEditor({
  materials,
  locationName,
  busy,
  onSave,
}: {
  materials: WireMaterial[];
  locationName: (id: string) => string;
  busy: boolean;
  onSave: SaveFn;
}) {
  const S = useProductionPlanningStrings();
  const t = S.t;
  const [materialId, setMaterialId] = useState("");
  const [lotKey, setLotKey] = useState("");
  const [newExpiry, setNewExpiry] = useState("");

  const keyOf = (lot: WireStockRow) => `${lot.locationId}/${lot.expiryDate ?? ""}`;
  const lotsOf = (material: WireMaterial) =>
    [...material.stock, ...(material.expiredStock ?? [])].filter((lot) => /[1-9]/.test(lot.qty));
  const material = materials.find((candidate) => candidate.id === materialId) ?? null;
  const lots = material ? lotsOf(material) : [];
  const lot = lots.find((candidate) => keyOf(candidate) === lotKey) ?? null;
  const toExpiryDate = newExpiry.trim() === "" ? null : newExpiry.trim();

  return (
    <section className={PANEL}>
      <SectionTitle subtitle={t.stockChangeExpirySubtitle} title={t.stockChangeExpiry} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label={t.colMaterial}>
          <select
            className={INPUT}
            onChange={(event) => {
              setMaterialId(event.target.value);
              setLotKey("");
            }}
            value={materialId}
          >
            <option value="">{t.colMaterial}</option>
            {materials
              .filter((candidate) => lotsOf(candidate).length > 0)
              .map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {S.name(candidate)}
                </option>
              ))}
          </select>
        </Field>
        <Field label={t.stockLot}>
          <select className={INPUT} onChange={(event) => setLotKey(event.target.value)} value={lot ? lotKey : ""}>
            <option value="">{t.stockLot}</option>
            {lots.map((candidate) => (
              <option key={keyOf(candidate)} value={keyOf(candidate)}>
                {locationName(candidate.locationId)} · {candidate.expiryDate ?? t.stockNoExpiry} ·{" "}
                {formatNumberLatin(candidate.qtyDisplay)} {S.unitLabel(material?.displayUnit)}
              </option>
            ))}
          </select>
        </Field>
        <Field hint={t.stockNewExpiryHint} label={t.stockNewExpiry}>
          <input
            className={INPUT}
            dir="ltr"
            onChange={(event) => setNewExpiry(event.target.value)}
            type="date"
            value={newExpiry}
          />
        </Field>
      </div>
      <div className="mt-3">
        <button
          className={BUTTON}
          disabled={busy || !lot || lot.expiryDate === toExpiryDate}
          onClick={() => {
            if (!lot) return;
            void onSave("/stock/expiry", {
              materialId,
              locationId: lot.locationId,
              fromExpiryDate: lot.expiryDate,
              toExpiryDate,
            });
          }}
          type="button"
        >
          {t.save}
        </button>
      </div>
    </section>
  );
}

/**
 * The expiry warning, on the Stock tab.
 *
 * On screen ALWAYS, armed or not. The email is a separate switch the owner has not turned on, and
 * the thing he actually asked for is to be able to see it: "انا عندي حاجات هتنتهي 4 27 فانا لازم
 * انتبه لها". Three tones, worst first, and never an ellipsis — a material name wraps.
 */
function ExpiryBanner({ rows }: { rows: WireExpiryVerdict[] }) {
  const S = useProductionPlanningStrings();
  const t = S.t;
  const TONES: Record<WireExpiryVerdict["severity"], string> = {
    critical: "border-amber-300 bg-amber-50 text-amber-900",
    expired: "border-rose-300 bg-rose-50 text-rose-900",
    warning: "border-slate-300 bg-slate-50 text-slate-700",
  };
  return (
    <section className={PANEL}>
      <SectionTitle subtitle={t.stockLotNote} title={t.expiryTitle} />
      <ul className="space-y-1">
        {rows.map((row) => (
          <li
            className={`border px-3 py-2 text-[12px] font-semibold break-words ${TONES[row.severity]}`}
            key={`${row.materialId}-${row.locationId}-${row.expiryDate}`}
          >
            {S.name(row)} — <Num>{row.expiryDate}</Num> · {S.expirySeverityLabels[row.severity]} ·{" "}
            {S.expiryDaysNote(
              formatNumberLatin(Math.abs(row.daysLeft)),
              row.daysLeft < 0,
              row.daysLeft === 0,
            )}{" "}
            · <Qty unit={row.displayUnit} value={row.qtyDisplay} />
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── The cost tab ─────────────────────────────────────────────────────────────────────────────────

/** Exported for scripts/measure-production-planning-fit.mjs - see the note at the top of this file. */
export function CostTab({
  data: workspace,
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

  const S = useProductionPlanningStrings();
  const t = S.t;
  const { data, factoryHidden } = satoBoughtView(workspace);
  const [materialId, setMaterialId] = useState("");
  const [currency, setCurrency] = useState<"USD" | "EGP">("EGP");
  const [price, setPrice] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [fxRate, setFxRate] = useState("");

  if (!data) return <p className={`${PANEL} text-[13px] text-slate-500`}>{t.notLoaded}</p>;

  return (
    <>
      <section className={PANEL}>
        <SectionTitle subtitle={t.costSubtitle} title={t.costTitle} />
        <p className="text-[13px] text-slate-800">
          {t.fxRate}: {fxSourceLabels(t)[data.fx.source]}
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
                {t.fxRateDate} <Num>{data.fx.rateDate}</Num>
              </span>
            </>
          ) : null}
        </p>
        {canWrite ? (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div className="min-w-0 grow sm:max-w-xs">
              <Field label={t.fxManualOverride}>
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
              {t.save}
            </button>
          </div>
        ) : null}
      </section>

      {canWrite ? (
        <section className={PANEL}>
          <SectionTitle title={t.priceAdd} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t.colMaterial}>
              <select
                className={INPUT}
                onChange={(event) => setMaterialId(event.target.value)}
                value={materialId}
              >
                <option value="">{t.colMaterial}</option>
                {data.materials.map((material) => (
                  <option key={material.id} value={material.id}>
                    {S.name(material)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t.priceCurrency}>
              <select
                className={INPUT}
                onChange={(event) => setCurrency(event.target.value as "USD" | "EGP")}
                value={currency}
              >
                <option value="EGP">{t.currencyEgp}</option>
                <option value="USD">{t.currencyUsd}</option>
              </select>
            </Field>
            <Field label={t.priceLabel}>
              <input
                className={INPUT}
                dir="ltr"
                inputMode="decimal"
                onChange={(event) => setPrice(event.target.value)}
                value={price}
              />
            </Field>
            <Field label={t.priceEffectiveFrom}>
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
              {t.save}
            </button>
          </div>
        </section>
      ) : null}

      <section className="min-w-0">
        <FactoryHiddenNote count={factoryHidden} />
        <table className={TABLE}>
          <colgroup>
            <col className="w-[34%]" />
            <col className="w-[22%]" />
            <col className="w-[22%]" />
            <col className="w-[22%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-300 bg-slate-50">
              {[t.colMaterial, t.priceLabel, t.priceEffectiveFrom, t.costTotal].map((heading) => (
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
                    <p className="font-bold text-slate-900 break-words">{S.name(material)}</p>
                  </td>
                  <td className={TD}>
                    {material.price ? (
                      <>
                        <Num>{formatNumberLatin(material.price.pricePerDisplayUnit)}</Num>{" "}
                        {material.price.currency === "USD" ? t.currencyUsd : t.currencyEgp}{" "}
                        <span className="text-[11px] text-slate-500">
                          {t.pricePerUnit} {S.unitLabel(material.displayUnit)}
                        </span>
                      </>
                    ) : (
                      <span className="text-[11px] text-slate-500">{t.priceNoneYet}</span>
                    )}
                  </td>
                  <td className={TD}>
                    {material.price ? <Num>{material.price.effectiveFrom}</Num> : null}
                  </td>
                  <td className={TD}>
                    {row && row.costEgp ? (
                      <p>
                        <Num>{formatNumberLatin(row.costEgp)}</Num> {t.currencyEgp}
                      </p>
                    ) : null}
                    {row && row.costUsd ? (
                      <p className="mt-0.5">
                        <Num>{formatNumberLatin(row.costUsd)}</Num> {t.currencyUsd}
                      </p>
                    ) : null}
                    {row?.costDerivedMissing ? (
                      <p className="mt-0.5 break-words text-[11px] text-amber-800">
                        {t.fxSourceNone}
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
              <p className="font-bold text-slate-900 break-words">{S.name(material)}</p>
              <p className="mt-1 text-[12px] text-slate-700">
                {material.price ? (
                  <>
                    <Num>{formatNumberLatin(material.price.pricePerDisplayUnit)}</Num>{" "}
                    {material.price.currency === "USD" ? t.currencyUsd : t.currencyEgp} {t.pricePerUnit}{" "}
                    {S.unitLabel(material.displayUnit)}
                  </>
                ) : (
                  <span className="text-[11px] text-slate-500">{t.priceNoneYet}</span>
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

/** Exported for scripts/measure-production-planning-fit.mjs - see the note at the top of this file. */
export function RunTab({
  data,
  canWrite,
  busy,
  onSave,
  materialsById,
  productId,
}: {
  data: WireWorkspace | null;
  canWrite: boolean;
  busy: boolean;
  onSave: SaveFn;
  materialsById: Map<string, WireMaterial>;
  /**
   * The product the Planner tab is on.
   *
   * 🔴 It used to be `data.products[0]?.id` at the POST, which recorded every run against the FIRST
   * product whatever the screen was showing — and a run recorded against the wrong product is what
   * the consumption learner then measures its overage from.
   */
  productId: string;
}) {

  const S = useProductionPlanningStrings();
  const t = S.t;
  const [runLabel, setRunLabel] = useState("");
  const [runsCount, setRunsCount] = useState("1");
  const [producedOn, setProducedOn] = useState("");
  const [goodUnits, setGoodUnits] = useState("");
  const [samples, setSamples] = useState("0");
  const [excluded, setExcluded] = useState(false);
  const [exclusionReason, setExclusionReason] = useState("");
  const [lines, setLines] = useState<Record<string, { opening: string; delivered: string; closing: string }>>({});

  if (!data) return <p className={`${PANEL} text-[13px] text-slate-500`}>{t.notLoaded}</p>;

  // The run tab records what the factory actually produced, and it counts in the product's own
  // saleable unit — "العلب الناتجة فعليًا" was asking DBK for a box count and storing it as a sachet
  // one. `actual_good_units` has always been a saleable-unit column; only the label was wrong.
  const runProduct = data.products.find((candidate) => candidate.id === productId);
  const runSaleableWord = S.saleableUnitWord(runProduct?.measureUnit ?? "ml");

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
          <SectionTitle subtitle={t.runSubtitle} title={t.runTitle} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label={t.runLabel}>
              <input className={INPUT} onChange={(event) => setRunLabel(event.target.value)} value={runLabel} />
            </Field>
            <Field label={t.runCount}>
              <input
                className={INPUT}
                dir="ltr"
                inputMode="numeric"
                onChange={(event) => setRunsCount(event.target.value)}
                value={runsCount}
              />
            </Field>
            <Field label={t.runProducedOn}>
              <input
                className={INPUT}
                dir="ltr"
                onChange={(event) => setProducedOn(event.target.value)}
                type="date"
                value={producedOn}
              />
            </Field>
            <Field label={S.runActualLabel(runProduct?.measureUnit ?? "ml")}>
              <input
                className={INPUT}
                dir="ltr"
                inputMode="numeric"
                onChange={(event) => setGoodUnits(event.target.value)}
                value={goodUnits}
              />
            </Field>
            <Field label={t.runActualSamples}>
              <input
                className={INPUT}
                dir="ltr"
                inputMode="numeric"
                onChange={(event) => setSamples(event.target.value)}
                value={samples}
              />
            </Field>
            <Field hint={excluded ? t.runExcludeHint : null} label={t.runExclude}>
              <select
                className={INPUT}
                onChange={(event) => setExcluded(event.target.value === "yes")}
                value={excluded ? "yes" : "no"}
              >
                <option value="no">{t.no}</option>
                <option value="yes">{t.yes}</option>
              </select>
            </Field>
            {excluded ? (
              <div className="sm:col-span-2 lg:col-span-3">
                <Field label={t.runExcludeReason}>
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
          <table className={`mt-4 ${TABLE}`}>
            <colgroup>
              <col className="w-[28%]" />
              <col className="w-[24%]" />
              <col className="w-[24%]" />
              <col className="w-[24%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-slate-300 bg-slate-50">
                {[t.colMaterial, t.runOpening, t.runDelivered, t.runClosing].map((heading) => (
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
                    <p className="font-bold text-slate-900 break-words">{S.name(material)}</p>
                    <p className="mt-0.5 text-[11px] text-slate-500">{S.unitLabel(material.displayUnit)}</p>
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

          {/* The card's own `lg:hidden` is on this wrapper, so each one takes the soft panel's
              depth alone rather than the shared CARD constant. */}
          <div className="mt-4 space-y-2 lg:hidden">
            {data.materials.map((material) => (
              <article className={`${adminSoftPanelClassName} px-3 py-3`} key={material.id}>
                <p className="font-bold text-slate-900 break-words">{S.name(material)}</p>
                <div className="mt-2 grid grid-cols-1 gap-2">
                  {(["opening", "delivered", "closing"] as const).map((field) => (
                    <Field
                      key={field}
                      label={
                        field === "opening"
                          ? t.runOpening
                          : field === "delivered"
                            ? t.runDelivered
                            : t.runClosing
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
                  productId: productId || data.productId,
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
              {t.runSave}
            </button>
          </div>
        </section>
      ) : null}

      <section className={PANEL}>
        <SectionTitle title={t.runHistory} />
        {data.runs.length === 0 ? (
          <p className="text-[12px] text-slate-500">{t.runNoneYet}</p>
        ) : (
          <ul className="space-y-2">
            {data.runs.map((run) => (
              <li className="border border-slate-200 px-3 py-2" key={run.id}>
                <p className="font-bold text-slate-900 break-words">{run.runLabel}</p>
                <p className="mt-0.5 text-[12px] text-slate-700">
                  <Num>{run.producedOn}</Num> — <Num>{formatNumberLatin(run.runsCount)}</Num>{" "}
                  {t.unitRuns}, <Num>{formatNumberLatin(run.actualGoodUnits)}</Num> {runSaleableWord},{" "}
                  <Num>{formatNumberLatin(run.actualSampleUnits)}</Num> {t.unitSample}
                </p>
                {run.isExcludedFromLearning ? (
                  <p className="mt-1 break-words text-[11px] text-amber-800">
                    {t.runExclude}: {run.exclusionReason}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={PANEL}>
        <SectionTitle title={t.learnedOverage} />
        <ul className="space-y-1 text-[12px] text-slate-700">
          {data.materials
            .filter((material) => material.learning !== null)
            .map((material) => (
              <li className="break-words" key={material.id}>
                <span className="font-bold">{S.name(material)}</span>{" "}
                {material.learning?.recommendedOveragePct ? (
                  <Num>{formatNumberLatin(material.learning.recommendedOveragePct)}%</Num>
                ) : material.learning?.withheldReason === "not_enough_runs" ? (
                  t.learnedNotEnoughRuns
                ) : (
                  t.learnedNoTheoretical
                )}
              </li>
            ))}
          {data.materials.every((material) => material.learning === null) ? (
            <li className="text-slate-500">{t.runNoneYet}</li>
          ) : null}
        </ul>
      </section>
    </>
  );
}

// ── The settings tab ─────────────────────────────────────────────────────────────────────────────

/** Exported for scripts/measure-production-planning-fit.mjs - see the note at the top of this file. */
export function SettingsTab({
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

  const S = useProductionPlanningStrings();
  const t = S.t;
  const [defaultOverage, setDefaultOverage] = useState("");
  const [reorderCover, setReorderCover] = useState("");
  const [expiryWarnDays, setExpiryWarnDays] = useState("");
  const [grantHrId, setGrantHrId] = useState("");
  const [grantLevel, setGrantLevel] = useState<"read" | "full">("read");
  const [grants, setGrants] = useState<WireGrant[]>([]);

  // ── The composition editor ──────────────────────────────────────────────────────────────────────
  //
  // ONE line open at a time, in a panel under the table rather than inside a row. The table is
  // `table-fixed` on a four-column colgroup because a fifth column takes the whole thing below its
  // natural width in the admin shell's 669px box — so five editable fields cannot live in a row, and
  // squeezing them in is the fits-the-screen rule's own named failure.
  const [editingMaterialId, setEditingMaterialId] = useState<string | null>(null);
  const [lineQty, setLineQty] = useState("");
  const [lineBasis, setLineBasis] = useState<WireBasis>("per_dose");
  const [lineSupplier, setLineSupplier] = useState<WireSupplier>("factory");
  const [lineOverage, setLineOverage] = useState("");
  const [lineFrom, setLineFrom] = useState("");
  const [lineError, setLineError] = useState<string | null>(null);

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

  if (!data) return <p className={`${PANEL} text-[13px] text-slate-500`}>{t.notLoaded}</p>;
  const settings = data.settings;
  // Built once, not per row: the per-dose label states this product's own dose and unit.
  const basisLabels = S.basisLabels(measureOf(selectedProductOf(data)));

  const editingMaterial = editingMaterialId
    ? (data.materials.find((material) => material.id === editingMaterialId) ?? null)
    : null;

  /**
   * Open the editor on one material, seeded from the line IN FORCE.
   *
   * 🔴 The quantity is converted OUT of base units for the field. The row stores 18 g of aluminium
   * film; DBK's own table says 0.018 kg per box; the field is labelled in kilograms. Seeding it with
   * the stored 18 and saving that back through `toBaseUnits` would store 18,000 g.
   *
   * A material with NO line opens on empty-and-sensible rather than on nothing: `per_dose` is the
   * basis thirteen of Ivyronc's fourteen lines carry, and `factory` is the supplier for everything
   * except the four the owner supplies — so the common case is two fields, not five.
   */
  const openLine = (material: WireMaterial) => {
    const line = material.composition;
    setEditingMaterialId(material.id);
    setLineError(null);
    setLineQty(line ? fromBaseUnits(line.qtyPerBasis, material) : "");
    setLineBasis(line?.basis ?? "per_dose");
    // A material with no line opens on who the product link says brings it — Royanoxicam's foil
    // opens on Sato, not on the factory default.
    setLineSupplier(line?.supplier ?? material.supplier ?? "factory");
    setLineOverage(line?.overagePct ?? "");
    setLineFrom("");
  };

  const closeLine = () => {
    setEditingMaterialId(null);
    setLineError(null);
  };

  // What the typed figure will actually become in the database, shown back before the save. This is
  // the whole defence against the thousandfold slip: he reads the stored figure, in its own unit,
  // next to the one he typed.
  const storedPreview = editingMaterial ? toBaseUnits(lineQty.trim(), editingMaterial) : "";

  const saveLine = async () => {
    if (!editingMaterial || !data.productId) return;
    const typed = lineQty.trim();
    // Zero is refused HERE as well as in the service, with the sentence that says what to do
    // instead: a line cannot be removed, the material is retired. The service's own refusal is the
    // gate; this one is so the answer arrives before the round trip.
    if (typed === "" || !/^\d+(?:\.\d+)?$/.test(typed) || Number(typed) <= 0) {
      setLineError(typed !== "" && Number(typed) === 0 ? t.compositionNoRemoval : t.compositionQtyRequired);
      return;
    }
    setLineError(null);
    await onSave("/materials", {
      materialId: editingMaterial.id,
      productId: data.productId,
      qtyPerBasis: toBaseUnits(typed, editingMaterial),
      basis: lineBasis,
      supplier: lineSupplier,
      // Blank means INHERIT the module default, which is why it is null and not "0" — Guamusin's
      // explicit 0 is a Guamusin decision and must not become every material's.
      overagePct: lineOverage.trim() === "" ? null : lineOverage.trim(),
      ...(lineFrom.trim() === "" ? {} : { effectiveFrom: lineFrom.trim() }),
    });
    closeLine();
  };

  return (
    <>
      {/* The formula, and the only screen that can change it.
          FIRST in the tab deliberately: it is the thing he opens this tab to read, and it used to
          sit under the numbers, both alarms and the access list. */}
      <section className={PANEL}>
        <SectionTitle subtitle={t.settingsCompositionHint} title={t.settingsComposition} />

        {/* 37/21/21/21 — the material column carries a wrapping Arabic name, a Latin code and the
            shared-product line, so it takes the largest share. FOUR columns, with the two row
            actions MERGED under the supplier rather than given a fifth: a fifth column takes this
            table below its natural width in the admin shell's 669px box, which is the
            fits-the-screen rule's own named remedy (AGENTS.md §4). */}
        <table className={TABLE}>
          <colgroup>
            <col className="w-[37%]" />
            <col className="w-[21%]" />
            <col className="w-[21%]" />
            <col className="w-[21%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-300 bg-slate-50">
              {[t.compositionColMaterial, t.compositionColQty, t.compositionColBasis, t.compositionColSupplier].map((heading) => (
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
                  <p className="font-bold break-words text-slate-900">{S.name(material)}</p>
                  {/* 🔴 Named BEFORE the retire click, never after it. Retiring is a MATERIAL-level
                      switch, so a material both products use leaves the other product's buy list
                      short — and the citric acid anhydrous and the lemon flavour genuinely are
                      shared. The ids come from the server and the names resolve through `S.name`,
                      so an English reader never reads an Arabic product name. */}
                  {material.alsoUsedByProductIds.length > 0 ? (
                    <p className="mt-1 break-words text-[11px] font-bold text-slate-900">
                      {t.settingsRetireAlsoUsedBy}:{" "}
                      {material.alsoUsedByProductIds
                        .map((id) => {
                          const product = data.products.find((candidate) => candidate.id === id);
                          return product ? S.name(product) : id;
                        })
                        .join(" · ")}
                    </p>
                  ) : null}
                </td>
                <td className={TD}>
                  {material.composition ? (
                    <Qty unit={material.baseUnit} value={material.composition.qtyPerBasis} />
                  ) : (
                    <span className="text-[11px] text-slate-500">{t.excludedNoComposition}</span>
                  )}
                </td>
                <td className={TD}>
                  {material.composition ? (
                    <span className="break-words">{basisLabels[material.composition.basis]}</span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td className={TD}>
                  {material.composition ? (
                    <span className="break-words">{S.supplierLabels[material.composition.supplier]}</span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                  {canWrite ? (
                    <span className="mt-1.5 flex flex-wrap gap-1.5">
                      {data.productId ? (
                        <button
                          className={BUTTON_QUIET}
                          disabled={busy}
                          onClick={() => openLine(material)}
                          type="button"
                        >
                          {material.composition ? t.compositionEdit : t.compositionEnter}
                        </button>
                      ) : null}
                      <button
                        className={BUTTON_QUIET}
                        disabled={busy}
                        onClick={() => void onSave("/materials", { materialId: material.id, active: false })}
                        type="button"
                      >
                        {t.settingsRetire}
                      </button>
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* The phone half of the same rows. The owner's standing rule: desktop gets the table,
            mobile never does. */}
        <div className="space-y-2 lg:hidden">
          {data.materials.map((material) => (
            <div className={CARD} key={material.id}>
              <p className="font-bold break-words text-slate-900">{S.name(material)}</p>
              <p className="mt-1.5 text-[12px] text-slate-800">
                {material.composition ? (
                  <>
                    <Qty unit={material.baseUnit} value={material.composition.qtyPerBasis} />{" "}
                    {basisLabels[material.composition.basis]} —{" "}
                    {S.supplierLabels[material.composition.supplier]}
                  </>
                ) : (
                  <span className="text-slate-500">{t.excludedNoComposition}</span>
                )}
              </p>
              {material.alsoUsedByProductIds.length > 0 ? (
                <p className="mt-1 break-words text-[11px] font-bold text-slate-900">
                  {t.settingsRetireAlsoUsedBy}:{" "}
                  {material.alsoUsedByProductIds
                    .map((id) => {
                      const product = data.products.find((candidate) => candidate.id === id);
                      return product ? S.name(product) : id;
                    })
                    .join(" · ")}
                </p>
              ) : null}
              {canWrite ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {data.productId ? (
                    <button className={BUTTON_QUIET} disabled={busy} onClick={() => openLine(material)} type="button">
                      {material.composition ? t.compositionEdit : t.compositionEnter}
                    </button>
                  ) : null}
                  <button
                    className={BUTTON_QUIET}
                    disabled={busy}
                    onClick={() => void onSave("/materials", { materialId: material.id, active: false })}
                    type="button"
                  >
                    {t.settingsRetire}
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>

        {/* ── The editor ──────────────────────────────────────────────────────────────────────────
            One line at a time, under the rows. Before this existed the formula could only be
            changed by a migration: `saveMaterialAndComposition` and its route were correct, tested
            and reached by no control at all — this tab posted to /stock, /fx, /prices, /runs,
            /settings, /access-grants and /materials-with-an-active-flag, and never to the field
            save.

            It opens INSIDE the panel, so its depth goes inward: the heavy slate-900 edge says
            "this is the thing you are now working on", and the inner shadow says it is a well cut
            into the panel rather than a second card floating on top of it. */}
        {canWrite && editingMaterial ? (
          <div className="mt-4 border border-slate-900 bg-slate-50 px-3 py-3 shadow-[inset_0_1px_3px_rgba(15,23,42,0.08)]">
            <p className="text-[10px] font-black tracking-[0.14em] text-slate-500 uppercase">
              {t.compositionEditorFor}
            </p>
            <p className="mt-0.5 font-bold break-words text-slate-900">{S.name(editingMaterial)}</p>

            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field
                hint={`${t.compositionQtyTypedIn} ${S.unitLabel(editingMaterial.displayUnit)} ${t.compositionQtyStoredAs} ${S.unitLabel(editingMaterial.baseUnit)}`}
                label={t.compositionQty}
              >
                <input
                  className={INPUT}
                  dir="ltr"
                  inputMode="decimal"
                  onChange={(event) => setLineQty(event.target.value)}
                  value={lineQty}
                />
              </Field>
              <Field hint={t.compositionEffectiveFromHint} label={t.compositionEffectiveFrom}>
                <input
                  className={INPUT}
                  dir="ltr"
                  onChange={(event) => setLineFrom(event.target.value)}
                  placeholder="YYYY-MM-DD"
                  type="date"
                  value={lineFrom}
                />
              </Field>
              <Field label={t.compositionBasis}>
                <select
                  className={INPUT}
                  onChange={(event) => setLineBasis(event.target.value as WireBasis)}
                  value={lineBasis}
                >
                  {COMPOSITION_BASES.map((basis) => (
                    <option key={basis} value={basis}>
                      {basisLabels[basis]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t.compositionSupplier}>
                <select
                  className={INPUT}
                  onChange={(event) => setLineSupplier(event.target.value as WireSupplier)}
                  value={lineSupplier}
                >
                  {MATERIAL_SUPPLIERS.map((supplier) => (
                    <option key={supplier} value={supplier}>
                      {S.supplierLabels[supplier]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field hint={t.compositionOverageHint} label={t.compositionOverage}>
                <input
                  className={INPUT}
                  dir="ltr"
                  inputMode="decimal"
                  onChange={(event) => setLineOverage(event.target.value)}
                  placeholder={settings.defaultOveragePct}
                  value={lineOverage}
                />
              </Field>
            </div>

            {/* 🔴 The stored figure, echoed back in its own unit before the save. The aluminium film
                is 0.018 kg a box and 18 g in the row; a thousandfold slip in either direction reads
                as a perfectly ordinary number, and this line is where it becomes visible. */}
            {storedPreview !== "" && storedPreview !== lineQty.trim() ? (
              <p className="mt-2 text-[12px] font-bold text-slate-900">
                {t.compositionQtyStoredPreview} <Qty unit={editingMaterial.baseUnit} value={storedPreview} />
              </p>
            ) : null}

            {/* An unsettled supplier is a real state and not a mistake — the owner supplies the
                lemon flavour sometimes and the factory the rest of the time — but a plan cannot be
                COMMITTED while a line carries it, because prodplan_plan_lines refuses that
                supplier. Said here rather than discovered at the commit. */}
            {!SETTLED_SUPPLIERS.includes(lineSupplier) ? (
              <p className="mt-2 border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] font-bold break-words text-amber-900">
                {t.compositionUnsettledWarning}
              </p>
            ) : null}

            {lineError ? (
              <p className="mt-2 text-[12px] font-bold break-words text-rose-700">{lineError}</p>
            ) : null}

            <div className="mt-3 flex flex-wrap gap-2">
              <button className={BUTTON} disabled={busy} onClick={() => void saveLine()} type="button">
                {t.save}
              </button>
              <button className={BUTTON_QUIET} disabled={busy} onClick={closeLine} type="button">
                {t.compositionCancel}
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {/* The way back. Without it the control above would be a one-way door: the workspace reads
          materials with `is_active = true`, so a retired material leaves every tab and only a
          database write could return it — the very hole the retire control closes, reversed. The
          list is GLOBAL rather than per product, because retiring switches the product links off
          too, so a product-scoped list would always be empty. */}
      {canWrite ? (
        <section className={PANEL}>
          <SectionTitle subtitle={t.settingsRestoreHint} title={t.settingsRetired} />
          {data.retiredMaterials.length === 0 ? (
            <p className="text-[12px] text-slate-500">{t.settingsRetiredNone}</p>
          ) : (
            <ul className="space-y-1">
              {data.retiredMaterials.map((material) => (
                <li
                  className="flex flex-wrap items-center justify-between gap-2 border border-slate-200 px-3 py-2 text-[12px]"
                  key={material.id}
                >
                  <span className="min-w-0 break-words">
                    <span className="font-bold">{S.name(material)}</span>
                  </span>
                  <button
                    className={BUTTON_QUIET}
                    disabled={busy}
                    onClick={() => void onSave("/materials", { materialId: material.id, active: true })}
                    type="button"
                  >
                    {t.settingsRestore}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section className={PANEL}>
        <SectionTitle title={t.settingsTitle} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            hint={`${t.settingsLastUpdatedBy}: ${settings.updatedByLogin ?? "—"}`}
            label={t.settingsDefaultOverage}
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
          <Field hint={t.settingsReorderCoverHint} label={t.settingsReorderCover}>
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
          <Field hint={t.settingsExpiryWarnDaysHint} label={t.settingsExpiryWarnDays}>
            <input
              className={INPUT}
              dir="ltr"
              disabled={!canWrite}
              inputMode="numeric"
              onChange={(event) => setExpiryWarnDays(event.target.value)}
              placeholder={formatNumberLatin(settings.expiryWarnDays)}
              value={expiryWarnDays}
            />
          </Field>
        </div>
        {canWrite ? (
          <div className="mt-3">
            <button
              className={BUTTON}
              disabled={
                busy ||
                (defaultOverage.trim() === "" && reorderCover.trim() === "" && expiryWarnDays.trim() === "")
              }
              onClick={() =>
                void onSave("/settings", {
                  defaultOveragePct: defaultOverage.trim() === "" ? undefined : defaultOverage.trim(),
                  reorderCoverRuns: reorderCover.trim() === "" ? undefined : reorderCover.trim(),
                  expiryWarnDays: expiryWarnDays.trim() === "" ? undefined : expiryWarnDays.trim(),
                })
              }
              type="button"
            >
              {t.save}
            </button>
          </div>
        ) : null}
      </section>

      <section className={PANEL}>
        <SectionTitle title={t.settingsAlarmEnabled} />
        {/* "Nothing sent" and "switched off" are different answers, so the screen says which one
            this is rather than showing a zero. */}
        <p
          className={`border px-3 py-2 text-[12px] font-bold shadow-[inset_0_1px_2px_rgba(15,23,42,0.05)] ${
            settings.alarmEnabled
              ? settings.alarmDryRun
                ? "border-amber-300 bg-amber-50 text-amber-900"
                : "border-emerald-300 bg-emerald-50 text-emerald-900"
              : "border-slate-300 bg-slate-50 text-slate-700"
          }`}
        >
          {!settings.alarmEnabled
            ? t.settingsAlarmOffNotice
            : settings.alarmDryRun
              ? t.settingsAlarmDryRunNotice
              : t.settingsAlarmEnabled}
        </p>
        <ul className="mt-2 space-y-1 text-[11px] text-slate-500">
          {settings.alarmLastEvaluatedOn ? (
            <li>
              {t.stockAsOf} <Num>{settings.alarmLastEvaluatedOn}</Num>
            </li>
          ) : null}
          <li>
            {t.settingsFxEnabled}: {settings.fxFetchEnabled ? t.stateOn : t.stateOff}
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
              {settings.alarmEnabled ? t.alarmSwitchOff : t.alarmSwitchOn}
            </button>
            <button
              className={BUTTON_QUIET}
              disabled={busy}
              onClick={() => void onSave("/settings", { alarmDryRun: !settings.alarmDryRun })}
              type="button"
            >
              {settings.alarmDryRun ? t.dryRunSwitchOff : t.dryRunSwitchOn}
            </button>
          </div>
        ) : null}
      </section>

      {/* The SECOND alarm, with its own independent pair of switches. It is a separate section and
          not a row in the one above because the two answer different questions — "order more" and
          "use this batch first" — and a material can be plentiful AND dying at the same time. */}
      <section className={PANEL}>
        <SectionTitle title={t.settingsExpiryAlarmEnabled} />
        <p
          className={`border px-3 py-2 text-[12px] font-bold break-words shadow-[inset_0_1px_2px_rgba(15,23,42,0.05)] ${
            settings.expiryAlarmEnabled
              ? settings.expiryAlarmDryRun
                ? "border-amber-300 bg-amber-50 text-amber-900"
                : "border-emerald-300 bg-emerald-50 text-emerald-900"
              : "border-slate-300 bg-slate-50 text-slate-700"
          }`}
        >
          {!settings.expiryAlarmEnabled
            ? t.settingsExpiryOffNotice
            : settings.expiryAlarmDryRun
              ? t.settingsExpiryDryRunNotice
              : t.settingsExpiryAlarmEnabled}
        </p>
        <ul className="mt-2 space-y-1 text-[11px] text-slate-500">
          {settings.expiryLastEvaluatedOn ? (
            <li>
              {t.expiryLastEvaluated} <Num>{settings.expiryLastEvaluatedOn}</Num>
            </li>
          ) : null}
          {settings.expiryLastSentOn ? (
            <li>
              {t.expiryLastSent} <Num>{settings.expiryLastSentOn}</Num>
            </li>
          ) : null}
        </ul>
        {canWrite ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className={BUTTON_QUIET}
              disabled={busy}
              onClick={() => void onSave("/settings", { expiryAlarmEnabled: !settings.expiryAlarmEnabled })}
              type="button"
            >
              {settings.expiryAlarmEnabled ? t.alarmSwitchOff : t.alarmSwitchOn}
            </button>
            <button
              className={BUTTON_QUIET}
              disabled={busy}
              onClick={() => void onSave("/settings", { expiryAlarmDryRun: !settings.expiryAlarmDryRun })}
              type="button"
            >
              {settings.expiryAlarmDryRun ? t.dryRunSwitchOff : t.dryRunSwitchOn}
            </button>
          </div>
        ) : null}
      </section>

      <section className={PANEL}>
        <SectionTitle subtitle={t.settingsAccessHint} title={t.settingsAccess} />
        {canWrite ? (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 grow sm:max-w-xs">
                <Field label={t.accessHrId}>
                  <input
                    className={INPUT}
                    dir="ltr"
                    onChange={(event) => setGrantHrId(event.target.value)}
                    value={grantHrId}
                  />
                </Field>
              </div>
              <div className="min-w-0 grow sm:max-w-[12rem]">
                <Field label={t.accessLevel}>
                  <select
                    className={INPUT}
                    onChange={(event) => setGrantLevel(event.target.value as "read" | "full")}
                    value={grantLevel}
                  >
                    <option value="read">{t.accessLevelRead}</option>
                    <option value="full">{t.accessLevelFull}</option>
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
                {t.save}
              </button>
            </div>

            {/* The five people the owner named are pinned in access.ts and cannot appear here, by
                design: a row in this table can admit a SIXTH person and can never demote one of
                them. So an empty list is the correct and expected state. */}
            {grants.length === 0 ? (
              <p className="mt-3 text-[12px] text-slate-500">{t.accessNoneYet}</p>
            ) : (
              <ul className="mt-3 space-y-1">
                {grants.map((grant) => (
                  <li
                    className="flex flex-wrap items-center justify-between gap-2 border border-slate-200 px-3 py-2 text-[12px]"
                    key={grant.hrId}
                  >
                    {/* 🔴 The NAME, not the id — the owner's standing "names, never codes or ids"
                        rule, and this list showed a bare HR id until now. The id stays beside it as
                        the secondary identifier, because he types ids into the field above. A person
                        the lookup could not name falls back to the id rather than to a blank. */}
                    <span className="min-w-0 break-words">
                      <span className="font-bold">{grant.personName ?? grant.hrId}</span>{" "}
                      {grant.personName ? (
                        <Num className="text-[11px] text-slate-500">{grant.hrId}</Num>
                      ) : null}{" "}
                      {grant.level === "full" ? t.accessLevelFull : t.accessLevelRead}
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
                      {t.accessRemove}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="text-[12px] text-slate-500">{t.readOnlyNotice}</p>
        )}
      </section>
    </>
  );
}
