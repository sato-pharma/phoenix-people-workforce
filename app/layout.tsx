import type { Metadata } from "next";
import { PageTitleSync } from "@/components/layout/page-title-sync";
import { ThemeProvider } from "@/components/layout/theme-provider";
import { appTitle, appTitleTemplate } from "@/lib/page-title";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: appTitle,
    template: appTitleTemplate,
  },
  description: "A premium workforce intelligence foundation for Phoenix.",
  icons: {
    apple: [{ type: "image/png", sizes: "180x180", url: "/apple-icon.png?v=phoenix-transparent-2" }],
    icon: [
      { sizes: "16x16 32x32 48x48 64x64", url: "/favicon.ico?v=phoenix-transparent-2" },
      { type: "image/png", sizes: "512x512", url: "/icon.png?v=phoenix-transparent-2" },
    ],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full bg-bg font-sans text-text">
        <a
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[9999] focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-black focus:shadow-lg"
          href="#main-content"
        >
          Skip to main content
        </a>
        <ThemeProvider>
          <PageTitleSync />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
