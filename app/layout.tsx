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
      <body className="min-h-full flex flex-col">
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
