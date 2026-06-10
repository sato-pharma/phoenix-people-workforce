import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowUpRight, CircleDashed } from "lucide-react";
import { Card } from "@/components/ui/card";
import { PremiumHero } from "@/components/ui/premium-hero";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";

/* ------------------------------------------------------------------ */
/*  Canonical cross-cutting stylesheet                                 */
/*  Injected once per shell render so every employee-portal page       */
/*  inherits print support and `prefers-reduced-motion` respect        */
/*  without each page having to opt in.                                */
/* ------------------------------------------------------------------ */

const portalGlobalStyles = `
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
`;

type EmployeePortalPageShellProps = {
  badge?: string;
  children: ReactNode;
  description: string;
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
   * PremiumHero instead of the standard portal header.
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
    <div className="mx-auto w-full space-y-5" dir="auto">
      {/* Portal-wide print + prefers-reduced-motion stylesheet (one inject per page) */}
      <style dangerouslySetInnerHTML={{ __html: portalGlobalStyles }} />
      {hero ?? (
        <PremiumHero
          kicker={badge ?? "Employee Portal"}
          title={title}
          subtitle={description}
          subtitleClassName={descriptionClassName}
        />
      )}
      <div className="space-y-6">{body}</div>
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
      className="inline-flex min-w-0 items-center justify-center gap-1.5 rounded border border-slate-200/80 bg-white px-4 py-1.5 text-[11px] font-bold tracking-wide text-slate-600 shadow-[0_4px_12px_rgba(15,23,42,0.06)] transition duration-200 hover:-translate-y-px hover:border-orange-300/80 hover:bg-gradient-to-r hover:from-orange-50 hover:to-amber-50/60 hover:text-orange-700 hover:shadow-[0_8px_20px_rgba(249,115,22,0.12)]"
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
