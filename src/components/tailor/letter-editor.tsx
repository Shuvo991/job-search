"use client";

import { useMemo, useRef, useState } from "react";
import { describeError, downloadPdf } from "@/components/tailor/api";
import { LabeledInput, LabeledTextarea, smallButtonClass } from "@/components/tailor/form-controls";
import type { TailorJob } from "@/components/tailor/job-types";
import { chipClass, hintClass, primaryButtonClass, secondaryButtonClass } from "@/components/ui/styles";
import { wordCount } from "@/lib/tailoring/guardrails";
import { draftToCoverLetterDocument } from "@/lib/tailoring/documents";
import type { ContactDraft, CoverLetterDraft, GenerationMeta, LetterParagraphDraft } from "@/lib/tailoring/types";

const todayText = (): string =>
  new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

export function LetterEditor({
  job,
  initial,
  warnings,
  meta,
  onRegenerate,
  regenerating,
}: {
  job: TailorJob;
  initial: CoverLetterDraft;
  warnings: string[];
  meta: GenerationMeta | null;
  onRegenerate: () => void;
  regenerating: boolean;
}) {
  const [contact, setContact] = useState<ContactDraft>(initial.contact);
  const [date, setDate] = useState(todayText);
  const [greeting, setGreeting] = useState(initial.greeting);
  const [paragraphs, setParagraphs] = useState<LetterParagraphDraft[]>(initial.paragraphs);
  const [closing, setClosing] = useState(initial.closing);
  const [signOff, setSignOff] = useState("Sincerely,");
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const counter = useRef(0);

  const patchContact = (patch: Partial<ContactDraft>) => setContact((c) => ({ ...c, ...patch }));
  const updateParagraph = (id: string, text: string) =>
    setParagraphs((list) => list.map((paragraph) => (paragraph.id === id ? { ...paragraph, text } : paragraph)));
  const removeParagraph = (id: string) => setParagraphs((list) => list.filter((paragraph) => paragraph.id !== id));
  const addParagraph = () => {
    counter.current += 1;
    setParagraphs((list) => [...list, { id: `para-new-${counter.current}`, text: "", evidence: [], flags: [] }]);
  };

  const letterDocument = useMemo(
    () =>
      draftToCoverLetterDocument(
        { contact, date, greeting, paragraphs: paragraphs.map((paragraph) => paragraph.text), closing, signOff },
        { title: job.title, company: job.company },
      ),
    [contact, date, greeting, paragraphs, closing, signOff, job.title, job.company],
  );
  const words = useMemo(
    () => letterDocument.paragraphs.reduce((total, paragraph) => total + wordCount(paragraph), 0),
    [letterDocument],
  );

  const hasParagraphs = letterDocument.paragraphs.length > 0;
  const canExport = contact.fullName.trim() !== "" && hasParagraphs && !exporting;

  async function onDownload() {
    setExportError(null);
    setExporting(true);
    try {
      await downloadPdf({ kind: "cover-letter", document: letterDocument });
    } catch (err) {
      setExportError(describeError(err));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-6 pb-28">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Review and edit your cover letter</h2>
          <p className="mt-1 max-w-3xl text-base text-neutral-800">
            Left: the lines of your CV that back up each paragraph. Right: the paragraph, editable. Delete or rewrite
            anything you cannot stand behind in an interview.
          </p>
          {meta ? (
            <p className="mt-1 text-sm text-neutral-700">
              Written locally by {meta.model} in {Math.max(1, Math.round(meta.durationMs / 1000))} s with{" "}
              <code className="rounded bg-neutral-200 px-1">{meta.promptFile}</code>.
            </p>
          ) : null}
        </div>
        {confirmRegenerate ? (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm writing the letter again">
            <span className="text-sm font-semibold text-neutral-900">Replace everything you edited?</span>
            <button
              type="button"
              className={primaryButtonClass}
              onClick={() => {
                setConfirmRegenerate(false);
                onRegenerate();
              }}
            >
              Yes, write it again
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => setConfirmRegenerate(false)}>
              Keep my edits
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={secondaryButtonClass}
            disabled={regenerating}
            onClick={() => setConfirmRegenerate(true)}
          >
            Write it again
          </button>
        )}
      </div>

      {warnings.length > 0 ? (
        <section aria-labelledby="letter-warnings-heading" className="rounded-lg border-2 border-amber-700 bg-amber-50 p-4">
          <h3 id="letter-warnings-heading" className="text-base font-semibold text-neutral-900">
            <span aria-hidden="true">⚠ </span>Safety checks: please read
          </h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-base text-neutral-900">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {initial.requirementsAddressed.length > 0 || initial.gaps.length > 0 ? (
        <section aria-labelledby="letter-coverage-heading" className="rounded-xl border border-neutral-400 bg-white p-4">
          <h3 id="letter-coverage-heading" className="text-lg font-semibold">
            Job requirements this letter touches
          </h3>
          <p className="mt-1 text-sm text-neutral-800">
            Matched to your CV by shared keywords, not judged by the AI, so it is only a guide. The letter is built from
            the CV lines on the left; check each claim against them.
          </p>
          {initial.requirementsAddressed.length > 0 ? (
            <ul role="list" className="mt-2 flex flex-wrap gap-2">
              {initial.requirementsAddressed.map((requirement) => (
                <li key={requirement} className={chipClass}>
                  <span aria-hidden="true">✓ </span>
                  {requirement}
                </li>
              ))}
            </ul>
          ) : null}
          {initial.gaps.length > 0 ? (
            <div className="mt-3">
              <h4 className="text-sm font-semibold text-neutral-900">Requirements your CV does not show (not claimed)</h4>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-base text-neutral-900">
                {initial.gaps.map((gap) => (
                  <li key={gap}>{gap}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby="letter-sender-heading" className="space-y-3 rounded-xl border border-neutral-400 bg-neutral-50 p-4">
        <div>
          <h3 id="letter-sender-heading" className="text-xl font-semibold">
            Sender and date
          </h3>
          <p className={hintClass}>
            Addressed to {job.company} about “{job.title}”. Contact details are read from your CV text.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <LabeledInput
            id="letter-name"
            label="Full name (required)"
            value={contact.fullName}
            onChange={(fullName) => patchContact({ fullName })}
            autoComplete="name"
            maxLength={120}
          />
          <LabeledInput
            id="letter-email"
            label="Email"
            value={contact.email}
            onChange={(email) => patchContact({ email })}
            autoComplete="email"
            maxLength={320}
          />
          <LabeledInput
            id="letter-phone"
            label="Phone"
            value={contact.phone}
            onChange={(phone) => patchContact({ phone })}
            autoComplete="tel"
            maxLength={60}
          />
          <LabeledInput
            id="letter-location"
            label="Location"
            value={contact.location}
            onChange={(location) => patchContact({ location })}
            maxLength={160}
          />
          <LabeledInput id="letter-date" label="Date" value={date} onChange={setDate} maxLength={40} />
          <LabeledInput id="letter-greeting" label="Greeting" value={greeting} onChange={setGreeting} maxLength={200} />
        </div>
      </section>

      <section aria-labelledby="letter-body-heading" className="space-y-3 rounded-xl border border-neutral-400 bg-neutral-50 p-4">
        <div>
          <h3 id="letter-body-heading" className="text-xl font-semibold">
            Letter
          </h3>
          <p className="text-sm text-neutral-800" aria-live="polite">
            {words} words. One page is about 250 to 350 words.
          </p>
        </div>

        <div className="hidden gap-4 px-3 text-sm font-semibold text-neutral-800 lg:grid lg:grid-cols-2" aria-hidden="true">
          <p>Lines from your CV that support it</p>
          <p>Paragraph (editable)</p>
        </div>

        <ul role="list" className="space-y-3">
          {paragraphs.map((paragraph, index) => {
            const flagsId = `${paragraph.id}-flags`;
            return (
              <li key={paragraph.id} className="rounded-lg border border-neutral-400 bg-white p-3">
                <div className="grid gap-4 lg:grid-cols-2">
                  <div>
                    <p className="text-sm font-semibold text-neutral-800 lg:hidden">Supporting lines from your CV</p>
                    {paragraph.evidence.length > 0 ? (
                      <ul className="mt-1 list-disc space-y-1 pl-5 text-base text-neutral-900 lg:mt-0">
                        {paragraph.evidence.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1 text-base text-neutral-700 lg:mt-0">
                        <em>
                          {paragraph.id.startsWith("para-new")
                            ? "Written by you."
                            : "No line of your CV was matched to this paragraph."}
                        </em>
                      </p>
                    )}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-neutral-800 lg:hidden" aria-hidden="true">
                      Paragraph (editable)
                    </p>
                    <LabeledTextarea
                      id={`${paragraph.id}-text`}
                      label={`Paragraph ${index + 1}`}
                      hideLabel
                      rows={6}
                      value={paragraph.text}
                      onChange={(text) => updateParagraph(paragraph.id, text)}
                      describedBy={paragraph.flags.length > 0 ? flagsId : undefined}
                    />
                    <div className="mt-2">
                      <button type="button" className={smallButtonClass} onClick={() => removeParagraph(paragraph.id)}>
                        Remove paragraph
                      </button>
                    </div>
                  </div>
                </div>
                {paragraph.flags.length > 0 ? (
                  <div id={flagsId} className="mt-3 rounded-md border-2 border-amber-700 bg-amber-50 p-3 text-sm text-neutral-900">
                    <p className="font-semibold">
                      <span aria-hidden="true">⚠ </span>The safety checks flagged this paragraph:
                    </p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5">
                      {paragraph.flags.map((flag) => (
                        <li key={flag}>{flag}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>

        <button type="button" className={secondaryButtonClass} onClick={addParagraph}>
          Add a paragraph
        </button>

        <div className="grid gap-3 sm:grid-cols-2">
          <LabeledInput id="letter-closing" label="Closing line" value={closing} onChange={setClosing} maxLength={300} />
          <LabeledInput id="letter-signoff" label="Sign-off" value={signOff} onChange={setSignOff} maxLength={60} />
        </div>
      </section>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-neutral-400 bg-white/95 shadow-lg backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <div className="text-sm text-neutral-900" aria-live="polite">
            {!contact.fullName.trim() ? (
              <p className="font-semibold text-red-800">Enter your full name to export.</p>
            ) : !hasParagraphs ? (
              <p className="font-semibold text-red-800">Write at least one paragraph to export.</p>
            ) : (
              <p className="text-neutral-700">Single-column PDF with a plain text layer.</p>
            )}
            {exportError ? (
              <p role="alert" className="font-semibold text-red-800">
                <span aria-hidden="true">⚠ </span>
                {exportError}
              </p>
            ) : null}
          </div>
          <button type="button" className={primaryButtonClass} disabled={!canExport} onClick={onDownload}>
            {exporting ? "Preparing PDF…" : "Download letter as PDF"}
          </button>
        </div>
      </div>
    </div>
  );
}
