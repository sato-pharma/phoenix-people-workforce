import type { Metadata } from "next";
import { ThemeProvider } from "@/components/layout/theme-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Phoenix Workforce",
  description: "A premium workforce intelligence foundation for Phoenix.",
  icons: {
    apple: [{ type: "image/png", sizes: "180x180", url: "/apple-icon.png" }],
    icon: [
      { sizes: "16x16 32x32 48x48 64x64", url: "/favicon.ico" },
      { type: "image/png", sizes: "512x512", url: "/icon.png" },
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
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
