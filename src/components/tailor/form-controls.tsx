import { controlClass, hintClass, labelClass } from "@/components/ui/styles";

export function LabeledInput({
  id,
  label,
  value,
  onChange,
  hint,
  maxLength,
  autoComplete,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  maxLength?: number;
  autoComplete?: string;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      {hint ? (
        <p id={hintId} className={hintClass}>
          {hint}
        </p>
      ) : null}
      <input
        id={id}
        type="text"
        value={value}
        maxLength={maxLength ?? 300}
        autoComplete={autoComplete ?? "off"}
        aria-describedby={hintId}
        onChange={(event) => onChange(event.target.value)}
        className={`${controlClass} mt-1`}
      />
    </div>
  );
}

export function LabeledTextarea({
  id,
  label,
  value,
  onChange,
  rows,
  hint,
  maxLength,
  describedBy,
  hideLabel = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  hint?: string;
  maxLength?: number;
  describedBy?: string | undefined;
  hideLabel?: boolean;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const described = [hintId, describedBy].filter(Boolean).join(" ") || undefined;
  return (
    <div>
      <label htmlFor={id} className={hideLabel ? "sr-only" : labelClass}>
        {label}
      </label>
      {hint ? (
        <p id={hintId} className={hintClass}>
          {hint}
        </p>
      ) : null}
      <textarea
        id={id}
        value={value}
        rows={rows ?? 3}
        maxLength={maxLength ?? 2_500}
        aria-describedby={described}
        onChange={(event) => onChange(event.target.value)}
        className={`${controlClass} mt-1 resize-y leading-relaxed`}
      />
    </div>
  );
}

export const smallButtonClass =
  "inline-flex min-h-9 items-center justify-center rounded-md border border-neutral-500 bg-white px-3 py-1 text-sm font-semibold text-neutral-900 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:border-neutral-400 disabled:bg-neutral-100 disabled:text-neutral-600";
