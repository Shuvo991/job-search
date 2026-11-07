"use client";

import { useEffect } from "react";

// Root-level error boundary. It replaces the root layout, so it renders its own <html>/<body>
// and uses inline styles (the global stylesheet may not be available here).
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: "2rem" }}>
        <main role="alert" style={{ maxWidth: "36rem", margin: "0 auto" }}>
          <h1 style={{ fontSize: "1.25rem" }}>Something went wrong</h1>
          <p>A critical error occurred. You can try reloading the application.</p>
          {error.digest ? <p style={{ fontSize: "0.75rem", color: "#666" }}>Reference: {error.digest}</p> : null}
          <button type="button" onClick={reset}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
