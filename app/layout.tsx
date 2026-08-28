import type { Metadata, Viewport } from "next";
import { Toaster } from "sonner";
import { GlobalErrorReporter } from "@/components/layout/global-error-reporter";
import { ReportingErrorBoundary } from "@/components/layout/reporting-error-boundary";
import { ThemeProvider } from "@/components/layout/theme-provider";
import { systemIdentity } from "@/config/system-settings";
import "./globals.css";

// Every @font-face in the app. Injected as a raw <style> tag so they bypass Tailwind
// v4 / Lightning CSS processing (@font-face inside or after @import "tailwindcss" gets
// silently dropped by the Turbopack CSS bundler).
//
// Inter is the UI face — self-hosted rather than linked from Google, so the app has no
// third-party request on first paint and renders identically on a machine with no
// internet. Until now the app named no webfont at all: the stack started with "Aptos",
// which only exists on a Windows machine that has Office installed, so the typeface
// changed from desk to desk. Two subsets, both variable (one file covers 400-700):
// the browser downloads latin-ext only if a page actually uses a character in its
// range, so shipping it costs nothing on an all-English screen and stops accented
// names — French, Turkish, transliterated Arabic — falling back to a different face
// mid-word. font-display:swap renders in the fallback immediately and swaps on
// arrival; the alternative, blocking paint on a font file, is worse on a slow link.
const FONT_FACE_CSS = `
@font-face{font-family:"Inter";font-style:normal;font-weight:100 900;font-display:swap;src:url("/fonts/inter-latin.woff2") format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"Inter";font-style:normal;font-weight:100 900;font-display:swap;src:url("/fonts/inter-latin-ext.woff2") format("woff2");unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:"Great Vibes";font-style:normal;font-weight:400;font-display:swap;src:url("/fonts/great-vibes.woff2") format("woff2")}
@font-face{font-family:"Pinyon Script";font-style:normal;font-weight:400;font-display:swap;src:url("/fonts/pinyon-script.woff2") format("woff2")}
`;

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
        {/* React 19 / Next.js hoists <style> to <head> automatically */}
        <style dangerouslySetInnerHTML={{ __html: FONT_FACE_CSS }} />
        <GlobalErrorReporter />
        <ThemeProvider>
          <ReportingErrorBoundary>{children}</ReportingErrorBoundary>
        </ThemeProvider>
        <Toaster closeButton position="top-right" richColors theme="light" />
      </body>
    </html>
  );
}
