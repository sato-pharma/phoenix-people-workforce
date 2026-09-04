import type { Metadata, Viewport } from "next";
import { Toaster } from "sonner";
import { GlobalErrorReporter } from "@/components/layout/global-error-reporter";
import { ReportingErrorBoundary } from "@/components/layout/reporting-error-boundary";
import { ThemeProvider } from "@/components/layout/theme-provider";
import { systemIdentity } from "@/config/system-settings";
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
    apple: [{ type: "image/png", sizes: "180x180", url: "/apple-icon.png?v=phoenix-transparent-3" }],
    icon: [
      { sizes: "16x16 32x32 48x48 64x64", url: "/favicon.ico?v=phoenix-transparent-3" },
      { type: "image/png", sizes: "512x512", url: "/icon.png?v=phoenix-transparent-3" },
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
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full bg-bg font-sans text-text">
        {/* FIRST, and before anything renders — see DISPLAY_SCALE_BOOT_SCRIPT. Moving this below
            the shell reintroduces the paint-at-100%-then-snap flash it exists to prevent. */}
        <script dangerouslySetInnerHTML={{ __html: DISPLAY_SCALE_BOOT_SCRIPT }} />
        {/* React 19 / Next.js hoists <style> to <head> automatically */}
        <style dangerouslySetInnerHTML={{ __html: SCRIPT_FONT_CSS }} />
        <GlobalErrorReporter />
        <ThemeProvider>
          <ReportingErrorBoundary>{children}</ReportingErrorBoundary>
        </ThemeProvider>
        <Toaster closeButton position="top-right" richColors theme="light" />
      </body>
    </html>
  );
}
