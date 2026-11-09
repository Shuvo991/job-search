import { primaryButtonClass, secondaryButtonClass } from "@/components/ui/styles";
import type { OllamaStatus } from "@/lib/ollama-client";

/**
 * Shown when the local AI cannot be used. It says what is wrong in plain words, lists the exact steps
 * to fix it, and still lets the user continue by writing the documents themselves.
 */
export function OllamaFallback({
  status,
  steps,
  message,
  checking,
  onCheckAgain,
  onWriteManually,
}: {
  status: OllamaStatus | null;
  /** Steps from a failed generation request (take precedence over the status check's steps). */
  steps?: string[];
  message?: string;
  checking: boolean;
  onCheckAgain: () => void;
  onWriteManually: () => void;
}) {
  const shownSteps = steps && steps.length > 0 ? steps : (status?.steps ?? []);
  const shownMessage =
    message ?? status?.message ?? "The local AI service (Ollama) could not be reached from this app.";
  const installed = status?.installedModels ?? [];

  return (
    <section
      aria-labelledby="ai-fallback-heading"
      className="rounded-lg border-2 border-amber-700 bg-amber-50 p-5"
      role="region"
    >
      <h2 id="ai-fallback-heading" className="text-lg font-semibold text-neutral-900">
        <span aria-hidden="true">⚠ </span>The local AI is not available
      </h2>
      <p className="mt-1 text-base text-neutral-900">{shownMessage}</p>
      <p className="mt-1 text-sm text-neutral-800">
        Your CV never leaves this computer: tailoring runs on Ollama, a free program on your own machine. Nothing is
        sent to any online AI service.
      </p>

      {shownSteps.length > 0 ? (
        <ol className="mt-3 list-decimal space-y-1 pl-6 text-base text-neutral-900">
          {shownSteps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      ) : null}

      {installed.length > 0 ? (
        <p className="mt-3 text-sm text-neutral-800">
          Models installed now: <span className="font-medium">{installed.join(", ")}</span>
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-3">
        <button type="button" onClick={onCheckAgain} disabled={checking} className={primaryButtonClass}>
          {checking ? "Checking…" : "Check again"}
        </button>
        <button type="button" onClick={onWriteManually} className={secondaryButtonClass}>
          Write it myself (no AI)
        </button>
      </div>
      <p className="mt-2 text-sm text-neutral-800">
        Writing it yourself opens the same editor with empty fields. You can still export the PDF.
      </p>
    </section>
  );
}
