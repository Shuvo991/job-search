import type { DiffSegment } from "@/lib/tailoring/diff";

const REMOVED_CLASS = "rounded-sm bg-red-100 px-0.5 text-red-950 line-through decoration-red-700 decoration-2";
const ADDED_CLASS = "rounded-sm bg-emerald-100 px-0.5 text-emerald-950 underline decoration-emerald-700 decoration-2";

/**
 * Renders a word diff. Changed words are marked with a background colour AND a line style
 * (strike-through for removed, underline for added) plus a screen-reader label, so the meaning never
 * depends on colour alone (WCAG 1.4.1).
 */
export function DiffText({ segments, mark }: { segments: DiffSegment[]; mark: "removed" | "added" }) {
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === mark ? (
          <mark key={index} className={mark === "removed" ? REMOVED_CLASS : ADDED_CLASS}>
            <span className="sr-only">{mark === "removed" ? "[removed: " : "[added: "}</span>
            {segment.text}
            <span className="sr-only">]</span>
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}
