/**
 * Shared Tailwind class strings. Colours are chosen for WCAG 2.1 AA contrast on white:
 *  - body text neutral-900 / secondary neutral-700 (>= 10:1)
 *  - control borders neutral-500 (4.7:1, passes the 3:1 non-text rule)
 *  - links and primary buttons indigo-700/800 (>= 8:1)
 *  - error text red-800 (8:1)
 */
export const controlClass =
  "block w-full min-h-11 rounded-md border border-neutral-500 bg-white px-3 py-2 text-base text-neutral-900 placeholder:text-neutral-600";

export const invalidControlClass = "border-2 border-red-700";

export const labelClass = "block text-sm font-semibold text-neutral-900";

export const hintClass = "mt-0.5 text-sm text-neutral-700";

export const primaryButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-indigo-700 px-4 py-2 text-base font-semibold text-white hover:bg-indigo-800 disabled:cursor-not-allowed disabled:bg-neutral-600";

export const secondaryButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-neutral-500 bg-white px-4 py-2 text-base font-semibold text-neutral-900 hover:bg-neutral-100";

export const linkClass = "font-medium text-indigo-800 underline underline-offset-2 hover:text-indigo-950";

export const chipClass =
  "inline-flex items-center rounded-full border border-neutral-400 bg-neutral-50 px-2.5 py-0.5 text-sm text-neutral-900";
