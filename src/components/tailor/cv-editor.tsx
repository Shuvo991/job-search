"use client";

import { useDeferredValue, useMemo, useRef, useState, type ReactNode } from "react";
import { describeError, downloadPdf } from "@/components/tailor/api";
import { LabeledInput, LabeledTextarea, smallButtonClass } from "@/components/tailor/form-controls";
import type { TailorJob } from "@/components/tailor/job-types";
import { ReviewRow } from "@/components/tailor/review-row";
import { chipClass, hintClass, primaryButtonClass, secondaryButtonClass } from "@/components/ui/styles";
import { scoreResume } from "@/lib/ats-scorer";
import { cvToPlainText, draftToCvDocument } from "@/lib/tailoring/documents";
import type {
  AdditionalDraft,
  ContactDraft,
  CvDraft,
  EducationDraft,
  ExperienceDraft,
  GenerationMeta,
  TextDraft,
} from "@/lib/tailoring/types";

function SectionCard({
  id,
  title,
  hint,
  children,
}: {
  id: string;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-heading`} className="space-y-3 rounded-xl border border-neutral-400 bg-neutral-50 p-4">
      <div>
        <h2 id={`${id}-heading`} className="text-xl font-semibold text-neutral-900">
          {title}
        </h2>
        {hint ? <p className={hintClass}>{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Captions() {
  return (
    <div className="hidden gap-4 px-3 text-sm font-semibold text-neutral-800 lg:grid lg:grid-cols-2" aria-hidden="true">
      <p>Your original CV (dropped words struck through)</p>
      <p>Tailored version (editable; new words underlined)</p>
    </div>
  );
}

const linesOf = (text: string): string[] => text.split("\n");

export function CvEditor({
  job,
  initial,
  warnings,
  meta,
  originalResumeText,
  onRegenerate,
  regenerating,
}: {
  job: TailorJob;
  initial: CvDraft;
  warnings: string[];
  meta: GenerationMeta | null;
  originalResumeText: string;
  onRegenerate: () => void;
  regenerating: boolean;
}) {
  const [draft, setDraft] = useState<CvDraft>(initial);
  const [skillsText, setSkillsText] = useState(() => initial.skills.join(", "));
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const counter = useRef(0);
  const nextId = (prefix: string): string => {
    counter.current += 1;
    return `${prefix}-new-${counter.current}`;
  };

  // ---- state updates ------------------------------------------------------
  const setContact = (patch: Partial<ContactDraft>) =>
    setDraft((d) => ({ ...d, contact: { ...d.contact, ...patch } }));
  const setSummary = (patch: Partial<TextDraft>) => setDraft((d) => ({ ...d, summary: { ...d.summary, ...patch } }));

  const updateExperience = (id: string, patch: Partial<ExperienceDraft>) =>
    setDraft((d) => ({ ...d, experience: d.experience.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));
  const updateBullet = (experienceId: string, bulletId: string, patch: Partial<TextDraft>) =>
    setDraft((d) => ({
      ...d,
      experience: d.experience.map((e) =>
        e.id !== experienceId ? e : { ...e, bullets: e.bullets.map((b) => (b.id === bulletId ? { ...b, ...patch } : b)) },
      ),
    }));
  const addBullet = (experienceId: string) =>
    setDraft((d) => ({
      ...d,
      experience: d.experience.map((e) =>
        e.id !== experienceId
          ? e
          : { ...e, bullets: [...e.bullets, { id: nextId("b"), original: null, suggested: "", text: "", flags: [] }] },
      ),
    }));
  const removeBullet = (experienceId: string, bulletId: string) =>
    setDraft((d) => ({
      ...d,
      experience: d.experience.map((e) =>
        e.id !== experienceId ? e : { ...e, bullets: e.bullets.filter((b) => b.id !== bulletId) },
      ),
    }));
  const addExperience = () =>
    setDraft((d) => ({
      ...d,
      experience: [
        ...d.experience,
        {
          id: nextId("exp"),
          title: "",
          company: "",
          location: "",
          startDate: "",
          endDate: "",
          issues: [],
          bullets: [{ id: nextId("b"), original: null, suggested: "", text: "", flags: [] }],
        },
      ],
    }));
  const removeExperience = (id: string) =>
    setDraft((d) => ({ ...d, experience: d.experience.filter((e) => e.id !== id) }));

  const updateEducation = (id: string, patch: Partial<EducationDraft>) =>
    setDraft((d) => ({ ...d, education: d.education.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));
  const addEducation = () =>
    setDraft((d) => ({
      ...d,
      education: [...d.education, { id: nextId("edu"), institution: "", degree: "", startDate: "", endDate: "" }],
    }));
  const removeEducation = (id: string) =>
    setDraft((d) => ({ ...d, education: d.education.filter((e) => e.id !== id) }));

  const updateAdditional = (id: string, patch: Partial<AdditionalDraft>) =>
    setDraft((d) => ({ ...d, additional: d.additional.map((a) => (a.id === id ? { ...a, ...patch } : a)) }));
  const addAdditional = () =>
    setDraft((d) => ({
      ...d,
      additional: [...d.additional, { id: nextId("add"), heading: "Certifications", items: [""] }],
    }));
  const removeAdditional = (id: string) =>
    setDraft((d) => ({ ...d, additional: d.additional.filter((a) => a.id !== id) }));

  const onSkillsChange = (text: string) => {
    setSkillsText(text);
    setDraft((d) => ({
      ...d,
      skills: text
        .split(/[,\n]/)
        .map((skill) => skill.trim())
        .filter((skill) => skill !== ""),
    }));
  };

  const addSkill = (skill: string) => {
    const base = skillsText.replace(/[,\s]+$/, "");
    onSkillsChange(base === "" ? skill : `${base}, ${skill}`);
  };

  // ---- derived: final document, ATS score before / after ------------------
  const finalDocument = useMemo(() => draftToCvDocument(draft), [draft]);
  const deferredDocument = useDeferredValue(finalDocument);
  const currentText = useMemo(() => cvToPlainText(deferredDocument), [deferredDocument]);
  const before = useMemo(
    () => scoreResume({ resumeText: originalResumeText, jobSkills: job.skills }),
    [originalResumeText, job.skills],
  );
  const after = useMemo(
    () => scoreResume({ resumeText: currentText, jobSkills: job.skills }),
    [currentText, job.skills],
  );
  const lostSkills = useMemo(() => {
    const now = new Set(after.keywords.matched.map((skill) => skill.toLowerCase()));
    return before.keywords.matched.filter((skill) => !now.has(skill.toLowerCase()));
  }, [before.keywords.matched, after.keywords.matched]);
  const skillsHave = useMemo(() => new Set(draft.skills.map((skill) => skill.toLowerCase())), [draft.skills]);

  const canExport = draft.contact.fullName.trim() !== "" && !exporting;

  async function onDownload() {
    setExportError(null);
    setExporting(true);
    try {
      await downloadPdf({ kind: "cv", document: finalDocument });
    } catch (err) {
      setExportError(describeError(err));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-6 pb-28">
      {/* ---- header and safety report ---- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Review and edit your tailored CV</h2>
          <p className="mt-1 max-w-3xl text-base text-neutral-800">
            Left: your CV as you wrote it. Right: the version for <span className="font-semibold">{job.title}</span> at{" "}
            {job.company}. Edit anything. Only facts, numbers and tools that are already in your CV are allowed in.
          </p>
          {meta ? (
            <p className="mt-1 text-sm text-neutral-700">
              Written locally by {meta.model} in {Math.max(1, Math.round(meta.durationMs / 1000))} s with{" "}
              <code className="rounded bg-neutral-200 px-1">{meta.promptFile}</code>.
            </p>
          ) : null}
        </div>
        {confirmRegenerate ? (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm generating again">
            <span className="text-sm font-semibold text-neutral-900">Replace everything you edited?</span>
            <button
              type="button"
              className={primaryButtonClass}
              onClick={() => {
                setConfirmRegenerate(false);
                onRegenerate();
              }}
            >
              Yes, generate again
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
            Generate again
          </button>
        )}
      </div>

      {warnings.length > 0 ? (
        <section aria-labelledby="cv-warnings-heading" className="rounded-lg border-2 border-amber-700 bg-amber-50 p-4">
          <h3 id="cv-warnings-heading" className="text-base font-semibold text-neutral-900">
            <span aria-hidden="true">⚠ </span>Safety checks: please read
          </h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-base text-neutral-900">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="rounded-lg border border-emerald-700 bg-emerald-50 p-3 text-base text-neutral-900">
          <span aria-hidden="true">✓ </span>The safety checks found no invented employers, titles, dates, skills or
          numbers.
        </p>
      )}

      {/* ---- ATS score ---- */}
      <section aria-labelledby="ats-heading" className="rounded-xl border border-neutral-400 bg-white p-4">
        <h3 id="ats-heading" className="text-lg font-semibold">
          ATS match with this job
        </h3>
        <p className="mt-1 text-base text-neutral-900" aria-live="polite">
          Your original CV: <span className="font-semibold">{before.overallScore}/100</span> ({before.grade}).{" "}
          This version: <span className="font-semibold">{after.overallScore}/100</span> ({after.grade}).{" "}
          Job skills found: {after.keywords.matched.length} of {after.keywords.total} (was {before.keywords.matched.length}).
        </p>
        {lostSkills.length > 0 ? (
          <p className="mt-2 text-sm text-neutral-900">
            <span className="font-semibold">Job skills in your original CV but not in this version: </span>
            {lostSkills.join(", ")}. Put them back (Skills box or a bullet) to recover the points.
          </p>
        ) : null}
        {after.keywords.missing.length > 0 ? (
          <p className="mt-2 text-sm text-neutral-800">
            <span className="font-semibold">Not in your CV: </span>
            {after.keywords.missing.slice(0, 12).join(", ")}. Add a skill only if you really have it (type it in the
            Skills box and back it with a real bullet).
          </p>
        ) : null}
        <p className="mt-2 text-sm text-neutral-700">
          Scored offline with <code className="rounded bg-neutral-200 px-1">config/ats-rules.json</code> on the exact text
          the PDF will contain.
        </p>
      </section>

      {draft.gaps.length > 0 || draft.notes.length > 0 || draft.matchedKeywords.length > 0 ? (
        <SectionCard id="coach" title="Coach notes">
          {draft.matchedKeywords.length > 0 ? (
            <div>
              <h3 className="text-sm font-semibold text-neutral-900">Job keywords your CV already proves</h3>
              <ul role="list" className="mt-1 flex flex-wrap gap-2">
                {draft.matchedKeywords.map((keyword) => (
                  <li key={keyword} className={chipClass}>
                    {keyword}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {draft.gaps.length > 0 ? (
            <div>
              <h3 className="text-sm font-semibold text-neutral-900">Requirements your CV does not show (not added)</h3>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-base text-neutral-900">
                {draft.gaps.map((gap) => (
                  <li key={gap}>{gap}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {draft.notes.length > 0 ? (
            <div>
              <h3 className="text-sm font-semibold text-neutral-900">Tips (for you; not written into the CV)</h3>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-base text-neutral-900">
                {draft.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </SectionCard>
      ) : null}

      <details className="rounded-lg border border-neutral-400 bg-white p-3">
        <summary className="cursor-pointer text-base font-semibold text-neutral-900">
          Show my original CV text (for reference)
        </summary>
        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-sm text-neutral-900">{originalResumeText}</pre>
      </details>

      {/* ---- contact ---- */}
      <SectionCard
        id="contact"
        title="Contact details"
        hint="Read from your CV text, never invented. Check them; they are printed at the top of the PDF."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <LabeledInput
            id="cv-name"
            label="Full name (required)"
            value={draft.contact.fullName}
            onChange={(fullName) => setContact({ fullName })}
            autoComplete="name"
            maxLength={120}
          />
          <LabeledInput
            id="cv-email"
            label="Email"
            value={draft.contact.email}
            onChange={(email) => setContact({ email })}
            autoComplete="email"
            maxLength={320}
          />
          <LabeledInput
            id="cv-phone"
            label="Phone"
            value={draft.contact.phone}
            onChange={(phone) => setContact({ phone })}
            autoComplete="tel"
            maxLength={60}
          />
          <LabeledInput
            id="cv-location"
            label="Location"
            value={draft.contact.location}
            onChange={(location) => setContact({ location })}
            maxLength={160}
          />
        </div>
        <LabeledTextarea
          id="cv-links"
          label="Links (one per line)"
          rows={2}
          value={draft.contact.links.join("\n")}
          onChange={(text) => setContact({ links: linesOf(text) })}
          maxLength={1_200}
        />
      </SectionCard>

      {/* ---- summary ---- */}
      <SectionCard id="summary" title="Professional summary">
        <Captions />
        <ul role="list" className="space-y-3">
          <ReviewRow item={draft.summary} label="Professional summary" rows={5} onChange={setSummary} />
        </ul>
      </SectionCard>

      {/* ---- skills ---- */}
      <SectionCard
        id="skills"
        title="Skills"
        hint="Only skills your CV already names were kept. Add one only if it is true and you can back it up."
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <h3 className="text-sm font-semibold text-neutral-900">Skills the job asks for</h3>
            <p className="mt-1 text-sm text-neutral-800">
              A skill you do not have yet can be added with one press. Add only what is true and what you could back
              up in an interview: the score then shows what it is worth.
            </p>
            {job.skills.length > 0 ? (
              <ul role="list" className="mt-1 flex flex-wrap gap-2">
                {job.skills.map((skill) => {
                  const present = skillsHave.has(skill.toLowerCase());
                  return (
                    <li key={skill}>
                      {present ? (
                        <span className={chipClass}>
                          <span aria-hidden="true">✓ </span>
                          {skill}
                          <span className="sr-only"> (in your skills)</span>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className={`${chipClass} cursor-pointer hover:bg-neutral-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-700`}
                          onClick={() => addSkill(skill)}
                        >
                          <span aria-hidden="true">+ </span>
                          {skill}
                          <span className="sr-only"> (not in your skills, press to add it)</span>
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="mt-1 text-base text-neutral-800">The posting lists no specific skills.</p>
            )}
          </div>
          <LabeledTextarea
            id="cv-skills"
            label="Your skills (separated by commas)"
            rows={4}
            value={skillsText}
            onChange={onSkillsChange}
            maxLength={4_000}
          />
        </div>
      </SectionCard>

      {/* ---- experience ---- */}
      <SectionCard
        id="experience"
        title="Work experience"
        hint="Employers, titles and dates are copied from your CV. Anything that could not be matched is left blank for you."
      >
        <Captions />
        {draft.experience.length === 0 ? (
          <p className="text-base text-neutral-800">No jobs yet. Use “Add a job” below.</p>
        ) : null}
        <div className="space-y-5">
          {draft.experience.map((entry, entryIndex) => {
            const heading = [entry.title, entry.company].filter((part) => part !== "").join(" at ") || `Job ${entryIndex + 1}`;
            return (
              <article
                key={entry.id}
                aria-label={heading}
                className="space-y-3 rounded-lg border border-neutral-500 bg-white p-3"
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <LabeledInput
                    id={`${entry.id}-title`}
                    label="Job title"
                    value={entry.title}
                    onChange={(title) => updateExperience(entry.id, { title })}
                    maxLength={200}
                  />
                  <LabeledInput
                    id={`${entry.id}-company`}
                    label="Company"
                    value={entry.company}
                    onChange={(company) => updateExperience(entry.id, { company })}
                    maxLength={200}
                  />
                  <LabeledInput
                    id={`${entry.id}-location`}
                    label="Location"
                    value={entry.location}
                    onChange={(location) => updateExperience(entry.id, { location })}
                    maxLength={160}
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <LabeledInput
                      id={`${entry.id}-start`}
                      label="Start"
                      value={entry.startDate}
                      onChange={(startDate) => updateExperience(entry.id, { startDate })}
                      maxLength={40}
                    />
                    <LabeledInput
                      id={`${entry.id}-end`}
                      label="End"
                      value={entry.endDate}
                      onChange={(endDate) => updateExperience(entry.id, { endDate })}
                      maxLength={40}
                    />
                  </div>
                </div>

                {entry.issues.length > 0 ? (
                  <div role="alert" className="rounded-md border-2 border-amber-700 bg-amber-50 p-3 text-sm text-neutral-900">
                    <p className="font-semibold">
                      <span aria-hidden="true">⚠ </span>Please check this entry against your CV:
                    </p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5">
                      {entry.issues.map((issue) => (
                        <li key={issue}>{issue}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <ul role="list" className="space-y-3">
                  {entry.bullets.map((bullet, bulletIndex) => (
                    <ReviewRow
                      key={bullet.id}
                      item={bullet}
                      label={`Bullet ${bulletIndex + 1} of ${heading}`}
                      onChange={(patch) => updateBullet(entry.id, bullet.id, patch)}
                      onRemove={() => removeBullet(entry.id, bullet.id)}
                    />
                  ))}
                </ul>

                <div className="flex flex-wrap gap-2">
                  <button type="button" className={smallButtonClass} onClick={() => addBullet(entry.id)}>
                    Add a bullet
                  </button>
                  <button type="button" className={smallButtonClass} onClick={() => removeExperience(entry.id)}>
                    Remove this job from the CV
                  </button>
                </div>
              </article>
            );
          })}
        </div>
        <button type="button" className={secondaryButtonClass} onClick={addExperience}>
          Add a job
        </button>
      </SectionCard>

      {/* ---- education ---- */}
      <SectionCard id="education" title="Education" hint="Not rewritten by the AI; only matched against your CV.">
        <div className="space-y-4">
          {draft.education.map((entry, index) => (
            <div key={entry.id} className="space-y-3 rounded-lg border border-neutral-500 bg-white p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <LabeledInput
                  id={`${entry.id}-institution`}
                  label={`Institution ${index + 1}`}
                  value={entry.institution}
                  onChange={(institution) => updateEducation(entry.id, { institution })}
                  maxLength={200}
                />
                <LabeledInput
                  id={`${entry.id}-degree`}
                  label="Degree"
                  value={entry.degree}
                  onChange={(degree) => updateEducation(entry.id, { degree })}
                  maxLength={250}
                />
                <LabeledInput
                  id={`${entry.id}-start`}
                  label="Start"
                  value={entry.startDate}
                  onChange={(startDate) => updateEducation(entry.id, { startDate })}
                  maxLength={40}
                />
                <LabeledInput
                  id={`${entry.id}-end`}
                  label="End"
                  value={entry.endDate}
                  onChange={(endDate) => updateEducation(entry.id, { endDate })}
                  maxLength={40}
                />
              </div>
              <button type="button" className={smallButtonClass} onClick={() => removeEducation(entry.id)}>
                Remove this entry
              </button>
            </div>
          ))}
        </div>
        <button type="button" className={secondaryButtonClass} onClick={addEducation}>
          Add education
        </button>
      </SectionCard>

      {/* ---- additional sections ---- */}
      <SectionCard
        id="additional"
        title="Other sections"
        hint="Certifications, languages, projects: copied word for word from your CV."
      >
        <div className="space-y-4">
          {draft.additional.map((section) => (
            <div key={section.id} className="space-y-3 rounded-lg border border-neutral-500 bg-white p-3">
              <LabeledInput
                id={`${section.id}-heading`}
                label="Section heading"
                value={section.heading}
                onChange={(heading) => updateAdditional(section.id, { heading })}
                maxLength={80}
              />
              <LabeledTextarea
                id={`${section.id}-items`}
                label="Lines (one per line)"
                rows={3}
                value={section.items.join("\n")}
                onChange={(text) => updateAdditional(section.id, { items: linesOf(text) })}
                maxLength={12_000}
              />
              <button type="button" className={smallButtonClass} onClick={() => removeAdditional(section.id)}>
                Remove this section
              </button>
            </div>
          ))}
        </div>
        <button type="button" className={secondaryButtonClass} onClick={addAdditional}>
          Add a section
        </button>
      </SectionCard>

      {/* ---- export (sticky) ---- */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-neutral-400 bg-white/95 shadow-lg backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <div className="text-sm text-neutral-900" aria-live="polite">
            <p>
              <span className="font-semibold">ATS match {after.overallScore}/100</span> (original {before.overallScore}).
            </p>
            {!draft.contact.fullName.trim() ? (
              <p className="font-semibold text-red-800">Enter your full name to export.</p>
            ) : (
              <p className="text-neutral-700">Single-column PDF, plain text layer, standard headings.</p>
            )}
            {exportError ? (
              <p role="alert" className="font-semibold text-red-800">
                <span aria-hidden="true">⚠ </span>
                {exportError}
              </p>
            ) : null}
          </div>
          <button type="button" className={primaryButtonClass} disabled={!canExport} onClick={onDownload}>
            {exporting ? "Preparing PDF…" : "Download CV as PDF"}
          </button>
        </div>
      </div>
    </div>
  );
}
