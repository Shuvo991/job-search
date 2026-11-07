import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Tech Job Board", template: "%s · Tech Job Board" },
  description: "Local-first job board, ATS analyzer and application tracker for technical roles.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-neutral-900 antialiased">
        {/* Bypass block (WCAG 2.4.1): first focusable element, visible when focused. */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:font-semibold focus:text-indigo-900 focus:shadow-lg"
        >
          Skip to main content
        </a>

        <header className="border-b border-neutral-300 bg-white">
          <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
            <Link href="/" className="text-lg font-bold text-neutral-900 hover:underline">
              Tech Job Board
            </Link>
            <p className="hidden text-sm text-neutral-700 sm:block">Local-first. Your data stays on this computer.</p>
          </div>
        </header>

        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8"
        >
          {children}
        </main>

        <footer className="mt-8 border-t border-neutral-300">
          <p className="mx-auto w-full max-w-6xl px-4 py-4 text-sm text-neutral-700 sm:px-6 lg:px-8">
            Skills are detected with a fixed dictionary, not an AI model.
          </p>
        </footer>
      </body>
    </html>
  );
}
