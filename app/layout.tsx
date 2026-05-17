import type { Metadata } from "next";
import { ThemeProvider } from "@/components/layout/theme-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Phoenix Workforce",
  description: "A premium workforce intelligence foundation for Phoenix.",
  icons: {
    apple: "/apple-icon.png",
    icon: [
      { url: "/favicon.ico" },
      { type: "image/png", url: "/icon.png" },
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
