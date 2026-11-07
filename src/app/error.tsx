"use client";

import { useEffect } from "react";

// Route-level error boundary. Shows a generic message only; details stay in the console/server logs.
export default function RouteError({
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
    <main className="mx-auto max-w-xl p-8" role="alert">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="mt-2 text-neutral-600">An unexpected error occurred. You can try again.</p>
      {error.digest ? <p className="mt-2 text-xs text-neutral-500">Reference: {error.digest}</p> : null}
      <button
        type="button"
        onClick={reset}
        className="mt-4 rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100"
      >
        Try again
      </button>
    </main>
  );
}
