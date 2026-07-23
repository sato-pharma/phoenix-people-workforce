import type { Metadata, Viewport } from "next";
import { Toaster } from "sonner";
import { GlobalErrorReporter } from "@/components/layout/global-error-reporter";
import { ReportingErrorBoundary } from "@/components/layout/reporting-error-boundary";
import { ThemeProvider } from "@/components/layout/theme-provider";
import { systemIdentity } from "@/config/system-settings";
import "./globals.css";

// @font-face rules for the identity card signature name. Injected as a raw <style>
// tag so they bypass Tailwind v4 / Lightning CSS processing (@font-face inside or
// after @import "tailwindcss" gets silently dropped by the Turbopack CSS bundler).
const SCRIPT_FONT_CSS = `
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
