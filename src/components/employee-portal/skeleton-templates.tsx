import { Card } from "@/components/ui/card";

/**
 * Shared skeleton building blocks for employee-portal `loading.tsx` files.
 * Five templates cover every page shape in the portal:
 *
 *  - `RedirectSkeleton`  — for thin redirect pages and minimal flows
 *  - `FormSkeleton`      — for single-form pages (excuses, expenses, training-manager create)
 *  - `DashboardSkeleton` — for KPI + chart pages (incentive, marketing, coaching, etc.)
 *  - `TableSkeleton`     — for a filtered list or table, which is most of the portal
 *  - `DetailSkeleton`    — for one record opened on its own page (`[id]` routes)
 *
 * Each template renders the navy header placeholder + content placeholders
 * sized roughly to the real page, so the user sees something stable
 * during the SSR fetch + hydration window.
 *
 * WHY THE SHAPE MATTERS, and why there is now a single `PortalRouteSkeleton` door.
 * Measured 2026-09-29: **98 of the portal's 126 routes have no `loading.tsx` at all**, so they
 * show nothing whatever until the server render lands — on pages that routinely take seconds. Of
 * the 28 that do have one, 24 use `DashboardSkeleton` regardless of what the page actually is,
 * and `payslips` — a real page — fronts itself with `RedirectSkeleton`. A skeleton of the wrong
 * shape is worse than honest: the page appears to settle, then relays out under the reader.
 *
 * `PortalRouteSkeleton` exists so adding one to a route is three lines and naming the shape is the
 * only decision. Pick by what the page IS, not by what is convenient.
 */

/**
 * One placeholder bar. EXPORTED because nine portal `loading.tsx` files had each declared their
 * own byte-identical copy — 9 copies of one four-line component, and nothing keeping them in step
 * if the shimmer, the tint or the `aria-hidden` ever changed. Their page-accurate LAYOUTS are
 * worth keeping (a skeleton shaped like its page is the whole point); the duplicated primitive is
 * not.
 */
export function Pulse({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`animate-pulse rounded bg-slate-200/60 ${className ?? ""}`}
    />
  );
}

// The same frame as EmployeePortalPageShell's command header (navy #08111f, slate-800 rule, its
// padding), so the page does not change colour and size the moment it arrives. It used to be a
// black-to-brown gradient no portal page has. The bars are SHARES of the width under a max-w cap,
// never fixed pixels, so the placeholder can never push a 360px screen sideways.
export function HeroSkeleton({ badgeWidth = "max-w-[9rem]" }: { badgeWidth?: string }) {
  return (
    <section className="relative box-border w-full overflow-hidden rounded-sm border border-slate-800 bg-[#08111f] px-4 py-4 sm:px-5 sm:py-5 lg:px-6">
      <Pulse className={`h-5 w-full ${badgeWidth} !bg-white/10`} />
      <Pulse className="mt-3 h-8 w-full max-w-[18rem] !bg-white/15" />
      <Pulse className="mt-2 h-4 w-full max-w-[20rem] !bg-white/10" />
    </section>
  );
}

const cardShadow = "shadow-[0_1px_3px_rgba(15,23,42,0.06)]";

/* ------------------------------------------------------------------ */
/*  Template 1 — minimal redirect / thin pages                         */
/* ------------------------------------------------------------------ */

export function RedirectSkeleton() {
  return (
    <div className="mx-auto w-full space-y-5">
      <HeroSkeleton />
      <Card className={`rounded border border-slate-100 bg-white p-4 sm:p-5 ${cardShadow}`}>
        <Pulse className="h-4 w-40" />
        <Pulse className="mt-2 h-3 w-64" />
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Template 2 — single-form pages                                     */
/* ------------------------------------------------------------------ */

export function FormSkeleton({ fieldCount = 4 }: { fieldCount?: number }) {
  return (
    <div className="mx-auto w-full space-y-5">
      <HeroSkeleton />
      <Card className={`rounded border border-slate-100 bg-white ${cardShadow}`}>
        <div className="border-b border-slate-100 px-4 py-3 sm:px-5">
          <Pulse className="h-4 w-36" />
          <Pulse className="mt-1.5 h-3 w-56" />
        </div>
        <div className="space-y-4 px-4 py-4 sm:px-5 sm:py-5">
          {Array.from({ length: fieldCount }).map((_, i) => (
            <div key={i}>
              <Pulse className="mb-1.5 h-3 w-20" />
              <Pulse className="h-10 w-full" />
            </div>
          ))}
          <Pulse className="h-10 w-full" />
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Template 3 — KPI + 2-chart dashboards                              */
/* ------------------------------------------------------------------ */

export function DashboardSkeleton({
  kpiCount = 4,
  chartCount = 2,
}: {
  chartCount?: number;
  kpiCount?: number;
}) {
  return (
    <div className="mx-auto w-full space-y-5">
      <HeroSkeleton />

      {/* KPI strip */}
      <Card className={`rounded border border-slate-100 bg-white p-0 ${cardShadow}`}>
        <div
          className={`grid grid-cols-2 gap-px ${
            { 1: "sm:grid-cols-1", 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-4" }[
              Math.min(kpiCount, 4)
            ] ?? "sm:grid-cols-4"
          }`}
        >
          {Array.from({ length: kpiCount }).map((_, i) => (
            <div className="px-4 py-4" key={i}>
              <Pulse className="h-3 w-20" />
              <Pulse className="mt-2 h-6 w-24" />
              <Pulse className="mt-2 h-3 w-32" />
            </div>
          ))}
        </div>
      </Card>

      {/* Filters card */}
      <Card className={`rounded border border-slate-100 bg-white p-4 sm:p-5 ${cardShadow}`}>
        <Pulse className="mb-3 h-4 w-24" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i}>
              <Pulse className="mb-1.5 h-3 w-16" />
              <Pulse className="h-10 w-full" />
            </div>
          ))}
        </div>
      </Card>

      {/* Charts row */}
      <section
        className={`grid gap-4 ${chartCount >= 2 ? "xl:grid-cols-2" : ""}`}
      >
        {Array.from({ length: chartCount }).map((_, i) => (
          <Card
            className={`rounded border border-slate-100 bg-white p-4 sm:p-5 ${cardShadow}`}
            key={i}
          >
            <Pulse className="h-4 w-44" />
            <Pulse className="mt-1.5 h-3 w-56" />
            <Pulse className="mt-4 h-56 w-full" />
          </Card>
        ))}
      </section>

      {/* Table placeholder */}
      <RowsPlaceholder rowCount={5} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Shared rows block — the list body every table-ish page ends with   */
/* ------------------------------------------------------------------ */

// The last two bars are hidden below `sm`. On a phone the real page shows CARDS, not a table
// (the desktop/mobile split in enterprise-shell.tsx), so a five-column placeholder there would
// promise a layout the page never renders — and five bars plus their gaps is also the one way a
// skeleton could push a 360px screen sideways.
function RowsPlaceholder({ rowCount }: { rowCount: number }) {
  return (
    <Card className={`rounded border border-slate-100 bg-white ${cardShadow}`}>
      <div className="border-b border-slate-100 p-3">
        <Pulse className="h-5 w-32" />
      </div>
      <div className="divide-y divide-slate-100 p-3">
        {Array.from({ length: rowCount }).map((_, i) => (
          <div className="flex items-center gap-3 py-3" key={i}>
            <Pulse className="h-3 w-16" />
            <Pulse className="h-3 w-20" />
            <Pulse className="h-3 w-24 flex-1" />
            <Pulse className="hidden h-3 w-16 sm:block" />
            <Pulse className="hidden h-5 w-20 sm:block" />
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Template 4 — a filtered list or table (most of the portal)         */
/* ------------------------------------------------------------------ */

export function TableSkeleton({ rowCount = 8 }: { rowCount?: number }) {
  return (
    <div className="mx-auto w-full space-y-5">
      <HeroSkeleton />

      {/* Filter bar — one row of controls above the list, as PortalFilterBar renders it. */}
      <Card className={`rounded border border-slate-100 bg-white p-4 sm:p-5 ${cardShadow}`}>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i}>
              <Pulse className="mb-1.5 h-3 w-16" />
              <Pulse className="h-10 w-full" />
            </div>
          ))}
        </div>
      </Card>

      <RowsPlaceholder rowCount={rowCount} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Template 5 — one record on its own page (`[id]` routes)            */
/* ------------------------------------------------------------------ */

export function DetailSkeleton() {
  return (
    <div className="mx-auto w-full space-y-5">
      <HeroSkeleton badgeWidth="max-w-[11rem]" />

      {/* The summary panel a detail page opens with: a handful of labelled facts. */}
      <Card className={`rounded border border-slate-100 bg-white p-4 sm:p-5 ${cardShadow}`}>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i}>
              <Pulse className="h-3 w-20" />
              <Pulse className="mt-2 h-4 w-32" />
            </div>
          ))}
        </div>
      </Card>

      {/* The body — a longer block of content below the facts. */}
      <Card className={`rounded border border-slate-100 bg-white p-4 sm:p-5 ${cardShadow}`}>
        <Pulse className="h-4 w-40" />
        <Pulse className="mt-3 h-3 w-full" />
        <Pulse className="mt-2 h-3 w-full" />
        <Pulse className="mt-2 h-3 w-full max-w-[24rem]" />
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Template 6 — a month grid                                          */
/* ------------------------------------------------------------------ */

/**
 * Three of My Workspace's nine pages are calendars — Interview Calendar, Private Calendar,
 * Planning Calendar — and none of the five shapes above resembles one. A table skeleton under a
 * month grid is precisely the "appears to settle, then relays out" failure this file exists to
 * prevent, so a sixth shape is cheaper than the wrong one three times.
 *
 * `grid-cols-7` with square cells: seven equal fractions of whatever width there is, never a
 * fixed column, so the placeholder cannot widen a phone.
 */
export function CalendarSkeleton() {
  return (
    <div className="mx-auto w-full space-y-5">
      <HeroSkeleton />

      <Card className={`rounded border border-slate-100 bg-white p-4 sm:p-5 ${cardShadow}`}>
        {/* The month name and the two arrows every calendar opens with. */}
        <div className="flex items-center justify-between">
          <Pulse className="h-5 w-32" />
          <div className="flex gap-2">
            <Pulse className="h-8 w-8" />
            <Pulse className="h-8 w-8" />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-7 gap-1">
          {Array.from({ length: 7 }).map((_, i) => (
            <Pulse className="h-3 w-full" key={`head-${i}`} />
          ))}
          {Array.from({ length: 35 }).map((_, i) => (
            <Pulse className="aspect-square w-full !bg-slate-200/40" key={`cell-${i}`} />
          ))}
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  The one door a route's loading.tsx uses                            */
/* ------------------------------------------------------------------ */

export type PortalRouteShape = "calendar" | "dashboard" | "detail" | "form" | "redirect" | "table";

/**
 * The skeleton for a portal route, chosen by what the page IS.
 *
 *     export default function Loading() {
 *       return <PortalRouteSkeleton shape="table" />;
 *     }
 *
 * No default shape, deliberately: a default is how 24 of the 28 existing loading files ended up
 * as a dashboard regardless of the page behind them. Naming the shape is the whole decision.
 */
export function PortalRouteSkeleton({ shape }: { shape: PortalRouteShape }) {
  if (shape === "calendar") return <CalendarSkeleton />;
  if (shape === "dashboard") return <DashboardSkeleton />;
  if (shape === "detail") return <DetailSkeleton />;
  if (shape === "form") return <FormSkeleton />;
  if (shape === "redirect") return <RedirectSkeleton />;
  return <TableSkeleton />;
}
