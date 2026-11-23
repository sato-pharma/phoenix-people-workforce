import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { LandingTick, landingActionClassName } from "@/components/employee-portal/landing-kit";
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
   * NOT RENDERED. Every portal header is the badge and the title, nothing under them (owner,
   * 2026-11-20: "REMOVE ALL THESE TEXTS UNDER HEADERS", "ALL HEADERS"). The 160-odd pages that still
   * pass a sentence keep compiling; the shell simply never draws it. Never bring the paragraph back.
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
        // THE PAGE TITLE BAND (owner, 2026-11-20: every portal page redesigned onto the landing's
        // language). It used to be a navy block with a grid texture, two corner glows and a glowing
        // orange badge. On a phone that navy block sat straight under the night-navy top bar, so
        // every page opened on two stacked dark slabs, and navy on every page left the one board a
        // page keeps for its headline figures nothing to stand out against. The title now stands
        // on the page itself: the small-capital section name after the orange tick, the title in
        // navy, and one hairline under it. Flat, square, and it wraps instead of clipping.
        // A div, not a <header>: the portal's print rule hides every header element, and the title
        // is the one thing a printed page must keep.
        <div className="employee-portal-page-header min-w-0 border-b border-slate-200 pb-3 pt-0.5">
          <p className="flex min-w-0 items-center gap-2 text-phx-xs font-bold uppercase tracking-[0.14em] text-slate-500">
            <LandingTick />
            <span className="min-w-0 break-words">{badge ?? "Employee Portal"}</span>
          </p>
          <h1 className="mt-1.5 max-w-4xl break-words text-[22px] font-bold leading-tight tracking-[-0.015em] text-[#08111f] sm:text-[28px]">
            {title}
          </h1>
        </div>
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
  // A flat white strip with a hairline: no glass, no ring, no floating shadow.
  return (
    <div className={`mb-4 flex max-w-full flex-col items-stretch gap-2 border border-slate-200 bg-white px-3 py-2.5 ${adminSoftDepthClassName} sm:flex-row sm:flex-wrap sm:items-center sm:justify-between`}>
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
  // The landing kit's one action shape: a navy frame that fills navy on hover. The label wraps on a
  // narrow phone rather than pushing the bar wider than the screen.
  return (
    <Link className={landingActionClassName("outline", "min-w-0")} href={href}>
      <span className="min-w-0 break-words">{label}</span>
      <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
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
  // A refusal or a failure explains itself on a white sheet: the title after the orange tick, the
  // reason in slate on a 4px rail. No tinted icon square, no floating shadow.
  return (
    <section className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
      <div className="flex min-w-0 items-center gap-2 border-b border-slate-200 px-4 py-3">
        <LandingTick />
        <p className="min-w-0 break-words text-phx-sm font-black uppercase tracking-[0.12em] text-[#08111f]">{title}</p>
      </div>
      <div className="flex min-w-0 gap-3 px-4 py-4">
        <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-slate-300" />
        <p className="min-w-0 break-words text-sm leading-6 text-slate-600">{message}</p>
      </div>
      {children ? <div className="border-t border-slate-200 px-4 py-3">{children}</div> : null}
    </section>
  );
}
