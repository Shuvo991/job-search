"use client";

import { useMemo } from "react";
import { DiffText } from "@/components/tailor/diff-text";
import { LabeledTextarea, smallButtonClass } from "@/components/tailor/form-controls";
import { diffWords } from "@/lib/tailoring/diff";
import type { TextDraft } from "@/lib/tailoring/types";

function statusOf(item: TextDraft): string {
  if (item.text.trim() === "") return "Empty";
  if (item.original !== null && item.text === item.original) return "Your original wording";
  if (item.text === item.suggested) return "AI version";
  return "Edited by you";
}

/**
 * One reviewable text, side by side: the user's original (words the new version drops are
 * highlighted) and an editable box for the final text (words that are new are highlighted live
 * underneath). The AI version and the original are one click away; nothing is applied silently.
 */
export function ReviewRow({
  item,
  label,
  rows = 3,
  onChange,
  onRemove,
}: {
  item: TextDraft;
  /** Accessible name of the editable box, e.g. "Bullet 2 of Product Manager at Acme". */
  label: string;
  rows?: number;
  onChange: (patch: Partial<TextDraft>) => void;
  onRemove?: () => void;
}) {
  const diff = useMemo(
    () => (item.original === null ? null : diffWords(item.original, item.text)),
    [item.original, item.text],
  );
  const flagsId = `${item.id}-flags`;
  const usingFlaggedAiText = item.flags.length > 0 && item.text === item.suggested;
  const changed = item.original !== null && item.text !== item.original;

  return (
    <li className="rounded-lg border border-neutral-400 bg-white p-3">
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <p className="text-sm font-semibold text-neutral-800 lg:hidden">Your original</p>
          <p className="mt-1 whitespace-pre-wrap text-base leading-relaxed text-neutral-900 lg:mt-0">
            {item.original === null || diff === null ? (
              <em className="text-neutral-700">Not in your CV (added by the AI or by you).</em>
            ) : (
              <DiffText segments={diff.before} mark="removed" />
            )}
          </p>
        </div>

        <div>
          <p className="text-sm font-semibold text-neutral-800 lg:hidden" aria-hidden="true">
            Tailored (editable)
          </p>
          <LabeledTextarea
            id={`${item.id}-text`}
            label={label}
            hideLabel
            rows={rows}
            value={item.text}
            onChange={(text) => onChange({ text })}
            describedBy={item.flags.length > 0 ? flagsId : undefined}
          />

          <p className="mt-1 text-sm text-neutral-800" aria-live="polite">
            {changed && diff !== null ? (
              <>
                <span className="font-semibold">Changes: </span>
                <DiffText segments={diff.after} mark="added" />
              </>
            ) : item.original !== null ? (
              "Same as your original."
            ) : null}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-neutral-500 bg-neutral-50 px-2 py-0.5 text-xs font-semibold text-neutral-900">
              {statusOf(item)}
            </span>
            <button
              type="button"
              className={smallButtonClass}
              disabled={item.original === null || item.text === item.original}
              onClick={() => item.original !== null && onChange({ text: item.original })}
            >
              Use my original
            </button>
            <button
              type="button"
              className={smallButtonClass}
              disabled={item.suggested === "" || item.text === item.suggested}
              onClick={() => onChange({ text: item.suggested })}
            >
              Use the AI version
            </button>
            {onRemove ? (
              <button type="button" className={smallButtonClass} onClick={onRemove}>
                Remove
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {item.flags.length > 0 ? (
        <div id={flagsId} className="mt-3 rounded-md border-2 border-amber-700 bg-amber-50 p-3 text-sm text-neutral-900">
          <p className="font-semibold">
            <span aria-hidden="true">⚠ </span>
            {usingFlaggedAiText
              ? "You are using an AI version that the safety checks flagged. Make sure every claim is true."
              : "The AI version was held back:"}
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {item.flags.map((flag) => (
              <li key={flag}>{flag}</li>
            ))}
          </ul>
          {item.suggested !== "" && item.suggested !== item.text ? (
            <p className="mt-2">
              <span className="font-semibold">AI suggestion: </span>
              {item.suggested}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
