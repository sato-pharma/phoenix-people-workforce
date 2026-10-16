import type { Metadata, Viewport } from "next";
import { Toaster } from "sonner";
import { GlobalErrorReporter } from "@/components/layout/global-error-reporter";
import { PhxLiveBanner } from "@/components/layout/phx-live-banner";
import { ReportingErrorBoundary } from "@/components/layout/reporting-error-boundary";
import { ThemeProvider } from "@/components/layout/theme-provider";
import { systemIdentity } from "@/config/system-settings";
import { DOM_TRANSLATE_GUARD_BOOT_SCRIPT } from "@/lib/error-monitor/dom-translate-guard";
import {
  DEFAULT_DISPLAY_SCALE,
  DISPLAY_SCALE_CSS_VAR,
  DISPLAY_SCALE_OPTIONS,
  DISPLAY_SCALE_STORAGE_KEY,
} from "@/lib/ui/display-scale";
import "./globals.css";

// @font-face rules for the identity card signature name. Injected as a raw <style>
// tag so they bypass Tailwind v4 / Lightning CSS processing (@font-face inside or
// after @import "tailwindcss" gets silently dropped by the Turbopack CSS bundler).
//
// There is deliberately NO webfont for the UI face. #2541 self-hosted Inter and put it
// first in --phx-font-ui; the owner reverted that on 2026-08-28 because Inter renders
// optically larger than the Aptos it displaced — same font-size, a far bigger x-height
// (~0.73em against ~0.50em) and wider advances — so the shell read as bigger and bolder
// and sidebar labels that used to fit began clipping to an ellipsis. The app's optical
// size moved, not just the rail; the rail is only where a hard width budget made it
// visible. Do NOT re-add a UI webfont without size-matching it to Aptos first
// (`size-adjust` on the @font-face) and re-running `pnpm run ui:measure-sidebar-labels`,
// or the same regression ships again. The type scale in src/styles/tokens.css was
// calibrated by eye against Aptos across ~4,800 call sites.
const SCRIPT_FONT_CSS = `
@font-face{font-family:"Great Vibes";font-style:normal;font-weight:400;font-display:swap;src:url("/fonts/great-vibes.woff2") format("woff2")}
@font-face{font-family:"Pinyon Script";font-style:normal;font-weight:400;font-display:swap;src:url("/fonts/pinyon-script.woff2") format("woff2")}
`;

/**
 * The display scale, applied BEFORE first paint.
 *
 * This has to be a blocking inline script and not a React effect. The scale is a per-device value
 * in localStorage, which the server cannot know at render time, so a component that reads it in
 * useEffect would paint the whole shell at 100% and then snap it to 80% — a visible lurch on every
 * page load and every navigation. ThemeProvider gets away with an effect because its default is
 * light and the correction is usually a no-op; a zoom correction never is.
 *
 * Parsed here rather than imported as a function because this string runs before any bundle has
 * loaded. The values are interpolated from the domain module so there is still exactly one list of
 * allowed steps in the system — a second hand-typed copy here is precisely how the control and the
 * stylesheet would drift apart later.
 *
 * try/catch, and a default in the catch: localStorage throws outright in some privacy modes, and
 * this runs above every error boundary React has. The failure mode of getting this wrong is a blank
 * page, so the worst case is deliberately "render at the default scale".
 */
const DISPLAY_SCALE_BOOT_SCRIPT = `(function(){try{var a=${JSON.stringify(
  DISPLAY_SCALE_OPTIONS,
)};var v=parseFloat(window.localStorage.getItem(${JSON.stringify(
  DISPLAY_SCALE_STORAGE_KEY,
)}));var s=a.indexOf(v)>=0?v:${DEFAULT_DISPLAY_SCALE};document.documentElement.style.setProperty(${JSON.stringify(
  DISPLAY_SCALE_CSS_VAR,
)},String(s));}catch(e){document.documentElement.style.setProperty(${JSON.stringify(
  DISPLAY_SCALE_CSS_VAR,
)},${JSON.stringify(String(DEFAULT_DISPLAY_SCALE))});}})();`;

export const metadata: Metadata = {
  title: systemIdentity.appName,
  description: systemIdentity.description,
  icons: {
    apple: [{ type: "image/png", sizes: "180x180", url: "/apple-icon.png?v=phoenix-ringed-1" }],
    icon: [
      { sizes: "16x16 32x32 48x48 64x64", url: "/favicon.ico?v=phoenix-ringed-1" },
      { type: "image/png", sizes: "512x512", url: "/icon.png?v=phoenix-ringed-1" },
    ],
  },
  // manifest.json + appleWebApp: iOS Safari only supports Web Push (16.4+) for a site
  // the user has added to their Home Screen as an installed web app — these are what
  // make that "Add to Home Screen" install a real PWA instead of a plain bookmark.
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: systemIdentity.appName,
  },
};

// viewport-fit=cover is required for env(safe-area-inset-*) to resolve to real
// values on notched devices; the mobile employee-portal bottom nav and planner
// bars rely on it to clear the iOS home indicator.
export const viewport: Viewport = {
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  /*
    NO translate="no" HERE, AND THAT IS A DECISION — do not re-add it without reading this.

    It was here from 2026-09-08 to 2026-09-11, paired with a google=notranslate meta in the
    metadata export above, as a TEST of one hypothesis about React hydration error #418: a browser
    translation rewrites text nodes, and if that lands before or during hydration the text no
    longer matches what the server sent, so React discards the server HTML. Always the
    `args[]=text` variant, never `args[]=html`, because translation changes content and not
    structure.

    The hypothesis was worth testing because #418 was concentrated in PEOPLE, not pages: user B-10
    alone produced 63 events across 23 unrelated routes and three desktop browsers, which no
    page-level defect can do. The commit that added it named its own falsification test — if the
    two routes still erroring went quiet the diagnosis was right, and if they kept erroring the
    attribute should come back out.

    MEASURED ON PRODUCTION 2026-09-11, three days in. Across the whole platform exactly ONE route
    still threw #418: /employee-portals/recruitment-candidates, 12 events, every one of them from
    a single District Sales Manager on a Samsung Galaxy A12 (Samsung Internet 20 / Chrome 106).
    Every other route, /employee-portals/vacation-report included, went silent. So the attribute
    did not close the case it was added for, and the reader it was meant to help is on an engine
    that need not honour Chrome's signal at all.

    THE COST IT WAS PAYING, which is why it is gone rather than left in place harmlessly: it stops
    browsers offering to translate Phoenix for everybody, and the workforce is Arabic-speaking.
    Owner's decision to remove, 2026-09-11, having been shown that one reader on one page is all
    that is left.

    The remaining #418 on that page is NOT explained by this removal and is still open.

    WHAT KEEPS A TRANSLATED PAGE ALIVE INSTEAD is DOM_TRANSLATE_GUARD_BOOT_SCRIPT below: a
    translation that has moved a node React is about to remove or insert beside no longer
    unmounts the tree ("Failed to execute 'insertBefore' on 'Node'", 88 rows in the 30 days to
    2026-10-16, mostly Arabic readers on /login). The translate offer stays.
  */
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full bg-bg font-sans text-text">
        {/* FIRST, and before anything renders — see DISPLAY_SCALE_BOOT_SCRIPT. Moving this below
            the shell reintroduces the paint-at-100%-then-snap flash it exists to prevent. */}
        <script dangerouslySetInnerHTML={{ __html: DISPLAY_SCALE_BOOT_SCRIPT }} />
        {/* Also before any bundle: React's first DOM write must already see the guarded prototype.
            See src/lib/error-monitor/dom-translate-guard.ts. */}
        <script dangerouslySetInnerHTML={{ __html: DOM_TRANSLATE_GUARD_BOOT_SCRIPT }} />
        {/* React 19 / Next.js hoists <style> to <head> automatically */}
        <style dangerouslySetInnerHTML={{ __html: SCRIPT_FONT_CSS }} />
        <GlobalErrorReporter />
        <PhxLiveBanner />
        <ThemeProvider>
          <ReportingErrorBoundary>{children}</ReportingErrorBoundary>
        </ThemeProvider>
        <Toaster closeButton position="top-right" richColors theme="light" />
      </body>
    </html>
  );
}
