import type { Metadata } from "next";
import { ThemeProvider } from "@/components/layout/theme-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Phoenix Workforce",
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
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
