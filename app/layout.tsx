import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import "@toeverything/theme/style.css";
import "./globals.css";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { Toaster } from "@/components/ui/toaster";

const themeInitScript = `
(function () {
  try {
    var theme = localStorage.getItem('theme') || 'system';
    var isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', isDark);
  } catch (e) {}
})();
`;

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "NotionForge",
  description: "A fast, self-hosted, Notion-like collaborative workspace",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      {/* Extensions inject attributes and nodes into <body> before React
          hydrates — the Chrome extensions in normal use here do exactly that
          — and React reports it as a hydration mismatch (#418) on every page,
          which buries any real one. <html> is already suppressed for the
          theme script above; this covers the same class of noise one level
          down. Suppression applies to this element only, so a genuine
          mismatch inside the app still reports. */}
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        <ThemeProvider>{children}</ThemeProvider>
        {/* ROADMAP B-6 "Finish" (state-craft sweep) — components/ui/toast.tsx
            + hooks/use-toast.ts have existed since B-0, but no route ever
            mounted <Toaster/>, so every `toast()` call anywhere in this app
            was a silent no-op (the memory-store dispatch had no subscriber
            to render it). Mounted once, globally, so the plan's "toast that
            says what failed" standard for optimistic updates has an actual
            place to land. */}
        <Toaster />
      </body>
    </html>
  );
}
