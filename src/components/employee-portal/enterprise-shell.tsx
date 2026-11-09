import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowUpRight, CircleDashed } from "lucide-react";
import { Card } from "@/components/ui/card";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";

/* ------------------------------------------------------------------ */
/*  Canonical cross-cutting stylesheet                                 */
/*  Injected once per shell render so every employee-portal page       */
/*  inherits print support and `prefers-reduced-motion` respect        */
/*  without each page having to opt in.                                */
/* ------------------------------------------------------------------ */

const portalGlobalStyles = `
/* clip, never hidden: hidden makes body a scroll container, so its height equals its
   content and it never scrolls - which silently anchors every position:sticky in the
   portal (the whole sidebar nav included) to a scrollport that never moves, so they
   scroll away with the page. clip blocks a sideways page scroll just as firmly without
   creating that container. Same reasoning as .admin-shell in globals.css.
   NOTE: this block is inside a JS template literal - no backticks below this line. */
html, body { overflow-x: clip; }
.employee-portal-command-grid {
  background-image:
    linear-gradient(rgba(255,255,255,0.045) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.045) 1px, transparent 1px);
  background-size: 28px 28px;
}
/* The command hero's premium depth. A compound selector (both classes) outranks the plain
   .employee-portal-command-grid above, so ONLY the shell hero — which carries both classes —
   gets the two corner glows layered over the same grid; plans-workspace.tsx, which reuses the
   bare -grid class, keeps its plain grid untouched. Owner-approved premium look, 2026-09-21:
   a warm orange wash from the top-right and a cool blue depth from the bottom-left, both very
   low alpha over the #08111f navy, so the title and description stay first to the eye. */
.employee-portal-command-header.employee-portal-command-grid {
  background-image:
    radial-gradient(120% 150% at 88% -35%, rgba(249,115,22,0.16), transparent 44%),
    radial-gradient(95% 130% at 0% 132%, rgba(20,130,194,0.12), transparent 52%),
    linear-gradient(rgba(255,255,255,0.045) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.045) 1px, transparent 1px);
  background-size: 100% 100%, 100% 100%, 28px 28px, 28px 28px;
}
.employee-portal-command-header::before {
  content: "";
  position: absolute;
  inset: 0;
  border-top: 3px solid #f97316;
  pointer-events: none;
}
.employee-portal-page-frame {
  min-width: 0;
}
.employee-portal-page-frame :where(section, article, aside) {
  scroll-margin-top: 84px;
}
.employee-portal-page-frame :where(input, select, textarea, button, a) {
  -webkit-tap-highlight-color: transparent;
}
.employee-portal-page-frame :where(table) {
  font-variant-numeric: tabular-nums;
}
@media print {
  body { background: #fff !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  nav, header, footer, button, [data-no-print] { display: none !important; }
  .print\\:break-inside-avoid { break-inside: avoid; }
  .print\\:shadow-none { box-shadow: none !important; }
  * { border-color: #e2e8f0 !important; }
}
@media (prefers-reduced-motion: reduce) {
  .animate-spin, .animate-pulse, .animate-bounce { animation: none !important; }
  *, *::before, *::after {
    transition-duration: 0.001ms !important;
    animation-duration: 0.001ms !important;
  }
}
@media (max-width: 767px) {
  [data-portal-desktop-table] { display: none !important; }
  /* 8.5rem = the 61px bar + a 12px gap + the 48px action button floating above it + breathing room.
     It MUST stay equal to the padding on main in employee-portal-layout.tsx: this rule covers up to
     767px and that class covers every width, so the two disagreeing means the last row of a long
     page hides under the button at one size and not the other. */
  .employee-portal-mobile-safe {
    padding-bottom: calc(8.5rem + env(safe-area-inset-bottom));
  }
  .employee-portal-page-transition {
    min-width: 0;
  }
}
`;

type EmployeePortalPageShellProps = {
  badge?: string;
  children: ReactNode;
  /**
   * The sentence under the title. OPTIONAL, and an empty one renders NOTHING — not an empty
   * paragraph, which would leave the `mt-2` gap behind and read as a broken header. KPIs is the
   * first page to want the bare title (owner, 2026-09-04); every other page still passes one.
   */
  description?: string;
  descriptionClassName?: string;
  /**
   * Opt-out for the rare page that needs to scope its own
   * WorkspaceErrorBoundary (e.g. when a custom fallback must be shown
   * for sub-regions instead of swallowing the whole page).
   * Defaults to false — the shell wraps children automatically.
   */
  disableErrorBoundary?: boolean;
  errorBoundaryTitle?: string;
  /**
   * Optional custom hero. When provided it REPLACES the default
   * badge/title/description banner (the `title` is still used for the error
   * boundary fallback). Lets a premium module page render the shared
   * a module-specific header instead of the standard portal command header.
   */
  hero?: ReactNode;
  title: string;
};

export function EmployeePortalPageShell({
  badge,
  children,
  description,
  descriptionClassName,
  disableErrorBoundary = false,
  errorBoundaryTitle,
  hero,
  title,
}: EmployeePortalPageShellProps) {
  const body = disableErrorBoundary ? (
    children
  ) : (
    <WorkspaceErrorBoundary
      fallbackTitle={errorBoundaryTitle ?? `${title} unavailable`}
    >
      {children}
    </WorkspaceErrorBoundary>
  );

  return (
    <div className="employee-portal-page-frame mx-auto w-full space-y-5" dir="auto">
      {/* Portal-wide print + prefers-reduced-motion stylesheet (one inject per page) */}
      <style dangerouslySetInnerHTML={{ __html: portalGlobalStyles }} />
      {hero ?? (
        <section className="employee-portal-command-header employee-portal-command-grid relative overflow-hidden rounded-sm border border-slate-800 bg-[#08111f] px-4 py-4 text-white shadow-[0_24px_70px_rgba(8,17,31,0.20)] sm:px-5 sm:py-5 lg:px-6">
          <div className="relative flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-2 rounded-sm border border-orange-400/35 bg-orange-500/12 px-2.5 py-1 text-phx-sm font-black uppercase tracking-[0.18em] text-orange-200">
                  <span aria-hidden className="h-1 w-1 bg-orange-400 shadow-[0_0_6px_rgba(249,115,22,0.9)]" />
                  {badge ?? "Employee Portal"}
                </span>
              </div>
              <h1 className="mt-3 max-w-4xl text-2xl font-black leading-tight tracking-tight text-white sm:text-3xl">
                {title}
              </h1>
              {description ? (
                <p className={`mt-2 max-w-3xl text-sm font-semibold leading-6 text-slate-300 ${descriptionClassName ?? ""}`}>
                  {description}
                </p>
              ) : null}
            </div>
          </div>
        </section>
      )}
      <div className="space-y-5 lg:space-y-6">{body}</div>
    </div>
  );
}

export function EmployeePortalActionBar({
  actions,
}: {
  actions: ReactNode;
}) {
  return (
    <div className="mb-4 flex max-w-full flex-col items-stretch gap-2 overflow-hidden rounded border border-white/80 bg-white/90 px-3 py-2.5 shadow-[0_14px_34px_rgba(15,23,42,0.06)] ring-1 ring-slate-200/70 backdrop-blur sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
      {actions}
    </div>
  );
}

export function EmployeePortalActionLink({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  return (
    <Link
      className="inline-flex min-w-0 items-center justify-center gap-1.5 rounded border border-slate-200/80 bg-white px-4 py-1.5 text-phx-xs font-bold tracking-wide text-slate-600 shadow-[0_4px_12px_rgba(15,23,42,0.06)] transition duration-200 hover:-translate-y-px hover:border-orange-300/80 hover:bg-gradient-to-r hover:from-orange-50 hover:to-amber-50/60 hover:text-orange-700 hover:shadow-[0_8px_20px_rgba(249,115,22,0.12)]"
      href={href}
    >
      <span className="min-w-0 whitespace-nowrap">{label}</span>
      <ArrowUpRight className="h-3.5 w-3.5" />
    </Link>
  );
}

export function EmployeePortalEmptyState({
  title,
  message,
  children,
}: {
  children?: ReactNode;
  message: string;
  title: string;
}) {
  return (
    <Card className="rounded border border-slate-200 bg-white p-8 text-center shadow-[0_18px_46px_rgba(15,23,42,0.07)]">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded bg-orange-50 text-orange-600 ring-1 ring-orange-100">
        <CircleDashed className="h-5 w-5" />
      </div>
      <p className="mt-4 text-lg font-semibold text-slate-900">{title}</p>
      <p className="mt-2 text-sm text-slate-600">{message}</p>
      {children ? <div className="mt-4">{children}</div> : null}
    </Card>
  );
}
