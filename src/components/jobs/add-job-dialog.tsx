"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  chipClass,
  controlClass,
  hintClass,
  invalidControlClass,
  labelClass,
  linkClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/components/ui/styles";
import { analyzeRawPosting, uniqueSkills } from "@/lib/jobs/analyze";
import {
  EMPLOYMENT_TYPE_LABELS,
  ROLE_LABELS,
  SECTOR_LABELS,
  SENIORITY_LABELS,
  WORK_MODE_LABELS,
} from "@/lib/jobs/labels";
import { isLoneUrl, sanitizeText } from "@/lib/sanitize";
import { extractSkillNames } from "@/lib/skills-extractor";
import { EMPLOYMENT_TYPES, ROLE_CATEGORIES, SECTORS, SENIORITIES, WORK_MODES } from "@/schemas/enums";

type Mode = "structured" | "raw";
type FieldErrors = Record<string, string>;

/** Preview work is capped so pasting a huge page cannot freeze the tab. */
const PREVIEW_CHARS = 50_000;

interface Notice {
  id: string;
  title: string;
  company: string;
}

interface ApiErrorPayload {
  error?: { message?: string; details?: Array<{ path?: string; message?: string }> };
}

// ---------------------------------------------------------------------------
// Small accessible building blocks
// ---------------------------------------------------------------------------

interface ControlProps {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
  "aria-required": true | undefined;
  className: string;
}

function Field({
  id,
  label,
  required = false,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  hint?: string;
  error?: string | undefined;
  children: (props: ControlProps) => ReactNode;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
        {required ? (
          <>
            <span aria-hidden="true" className="text-red-800">
              {" "}
              *
            </span>
            <span className="sr-only"> (required)</span>
          </>
        ) : null}
      </label>
      {hint ? (
        <p id={hintId} className={hintClass}>
          {hint}
        </p>
      ) : null}
      <div className="mt-1">
        {children({
          id,
          "aria-describedby": describedBy,
          "aria-invalid": error ? true : undefined,
          "aria-required": required ? true : undefined,
          className: `${controlClass} ${error ? invalidControlClass : ""}`,
        })}
      </div>
      {error ? (
        <p id={errorId} className="mt-1 text-sm font-semibold text-red-800">
          <span aria-hidden="true">⚠ </span>
          <span className="sr-only">Error: </span>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function optionList<T extends string>(values: readonly T[], labels: Record<T, string>, skip: readonly T[] = []) {
  return values
    .filter((value) => !skip.includes(value))
    .map((value) => (
      <option key={value} value={value}>
        {labels[value]}
      </option>
    ));
}

/** Split "React, SQL\nDocker" into trimmed, non-empty entries. */
function parseList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

export function AddJobDialog() {
  const router = useRouter();
  const uid = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const skillsRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  const [mode, setMode] = useState<Mode>("structured");
  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  const [location, setLocation] = useState("");
  const [rawText, setRawText] = useState("");
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [detectMessage, setDetectMessage] = useState("");

  const fieldId = (name: string) => `${uid}-${name}`;
  const titleId = `${uid}-dialog-title`;
  const errorEntries = Object.entries(errors);
  const hasProblems = errorEntries.length > 0 || formError !== null;

  // Move focus to the error summary after each failed submit so screen reader users hear it.
  useEffect(() => {
    if (attempt > 0 && hasProblems) summaryRef.current?.focus();
  }, [attempt]);

  const deferredText = useDeferredValue(rawText);
  const preview = useMemo(
    () =>
      mode === "raw"
        ? analyzeRawPosting({ title, company, location, text: deferredText.slice(0, PREVIEW_CHARS) })
        : null,
    [mode, title, company, location, deferredText],
  );

  function openDialog() {
    setErrors({});
    setFormError(null);
    setDetectMessage("");
    dialogRef.current?.showModal();
    requestAnimationFrame(() => document.getElementById(fieldId("title"))?.focus());
  }

  function closeDialog() {
    dialogRef.current?.close();
  }

  function focusField(name: string) {
    document.getElementById(fieldId(name))?.focus();
  }

  function detectSkills() {
    const description = descriptionRef.current?.value ?? "";
    const detected = extractSkillNames(`${title}\n${sanitizeText(description)}`);
    const current = parseList(skillsRef.current?.value ?? "");
    const merged = uniqueSkills([...current, ...detected]);
    if (skillsRef.current) skillsRef.current.value = merged.join(", ");
    setDetectMessage(
      detected.length === 0
        ? "No known skills found in the description."
        : `${detected.length} skill${detected.length === 1 ? "" : "s"} detected and added to the list.`,
    );
  }

  function validate(data: FormData): FieldErrors {
    const found: FieldErrors = {};
    const text = (name: string) => String(data.get(name) ?? "").trim();
    if (!text("title")) found["title"] = "Enter the job title.";
    if (!text("company")) found["company"] = "Enter the company name.";

    if (mode === "structured") {
      if (!text("roleCategory")) found["roleCategory"] = "Choose a role type.";
      if (!text("description")) found["description"] = "Paste or write the job description.";
      for (const name of ["salaryMin", "salaryMax"]) {
        const value = text(name);
        if (value !== "" && !/^\d{1,9}$/.test(value)) found[name] = "Use whole numbers only, for example 65000.";
      }
      const currency = text("salaryCurrency");
      if (currency !== "" && !/^[A-Za-z]{3}$/.test(currency)) found["salaryCurrency"] = "Use a 3-letter code such as SEK.";
    } else {
      const pasted = text("text");
      if (!pasted) found["text"] = "Paste the job posting text.";
      else if (isLoneUrl(pasted)) {
        found["text"] = "That looks like a link. Paste the job description text itself and put the link in the URL field.";
      }
    }
    return found;
  }

  function buildPayload(data: FormData): Record<string, unknown> {
    const text = (name: string) => String(data.get(name) ?? "").trim();
    const optional = (name: string) => (text(name) === "" ? {} : { [name]: text(name) });

    if (mode === "raw") {
      return {
        mode: "raw",
        title: text("title"),
        company: text("company"),
        ...optional("location"),
        ...optional("roleCategory"),
        text: String(data.get("text") ?? ""),
        ...(text("url") === "" ? {} : { url: text("url") }),
      };
    }
    return {
      mode: "structured",
      title: text("title"),
      company: text("company"),
      ...optional("location"),
      ...optional("country"),
      roleCategory: text("roleCategory"),
      sector: text("sector") || "TECH",
      workMode: text("workMode") || "UNKNOWN",
      seniority: text("seniority") || "UNKNOWN",
      employmentType: text("employmentType") || "UNKNOWN",
      description: String(data.get("description") ?? ""),
      skills: parseList(text("skills")),
      ...(text("salaryMin") === "" ? {} : { salaryMin: Number(text("salaryMin")) }),
      ...(text("salaryMax") === "" ? {} : { salaryMax: Number(text("salaryMax")) }),
      ...(text("salaryCurrency") === "" ? {} : { salaryCurrency: text("salaryCurrency").toUpperCase() }),
      ...(text("applyUrl") === "" ? {} : { applyUrl: text("applyUrl") }),
    };
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);

    setFormError(null);
    const clientErrors = validate(data);
    if (Object.keys(clientErrors).length > 0) {
      setErrors(clientErrors);
      setAttempt((count) => count + 1);
      return;
    }
    setErrors({});
    setPending(true);

    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildPayload(data)),
      });

      if (response.status === 201) {
        const body = (await response.json()) as { job: { id: string; title: string; company: string } };
        form.reset();
        setTitle("");
        setCompany("");
        setLocation("");
        setRawText("");
        setNotice({ id: body.job.id, title: body.job.title, company: body.job.company });
        closeDialog();
        router.refresh();
        return;
      }

      const payload = (await response.json().catch(() => ({}))) as ApiErrorPayload;
      const fromServer: FieldErrors = {};
      for (const detail of payload.error?.details ?? []) {
        if (detail.path && detail.message && !fromServer[detail.path]) fromServer[detail.path] = detail.message;
      }
      const knownFields = new Set(Array.from(form.elements).map((element) => (element as HTMLInputElement).name));
      const unmatched = Object.keys(fromServer).filter((path) => !knownFields.has(path));
      setErrors(Object.fromEntries(Object.entries(fromServer).filter(([path]) => knownFields.has(path))));
      setFormError(
        unmatched.length > 0
          ? unmatched.map((path) => `${path}: ${fromServer[path] ?? ""}`).join(" ")
          : Object.keys(fromServer).length === 0
            ? (payload.error?.message ?? "The job could not be saved. Please try again.")
            : null,
      );
    } catch {
      setFormError("Could not reach the server. Check that the app is running and try again.");
    } finally {
      setPending(false);
      setAttempt((count) => count + 1);
    }
  }

  return (
    <div className="flex flex-col items-start gap-3 sm:items-end">
      <button type="button" onClick={openDialog} className={primaryButtonClass} aria-haspopup="dialog">
        <span aria-hidden="true">＋</span> Add job
      </button>

      {/* Always in the DOM so assistive technology announces it when its text appears. */}
      <p role="status" className="max-w-sm text-sm text-neutral-900 sm:text-right">
        {notice ? (
          <>
            Added “{notice.title}” at {notice.company}.{" "}
            <Link href={`/jobs/${notice.id}`} className={linkClass}>
              View job
            </Link>
          </>
        ) : null}
      </p>

      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        className="m-auto max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-2xl overflow-y-auto rounded-xl border border-neutral-500 bg-white p-0 text-neutral-900 shadow-2xl"
      >
        <form onSubmit={onSubmit} noValidate aria-busy={pending}>
          <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-neutral-300 bg-white px-5 py-4">
            <div>
              <h2 id={titleId} className="text-xl font-bold">
                Add a job
              </h2>
              <p className="mt-1 text-sm text-neutral-700">
                Fields marked <span aria-hidden="true">*</span>
                <span className="sr-only">with an asterisk</span> are required.
              </p>
            </div>
            <button type="button" onClick={closeDialog} className={secondaryButtonClass} aria-label="Close dialog">
              <span aria-hidden="true">✕</span>
            </button>
          </div>

          <div className="space-y-5 px-5 py-5">
            {hasProblems ? (
              <div
                ref={summaryRef}
                tabIndex={-1}
                role="alert"
                className="rounded-md border-2 border-red-700 bg-red-50 p-4 text-red-900"
              >
                <h3 className="font-bold">
                  {errorEntries.length > 1 ? `There are ${errorEntries.length} problems` : "There is a problem"}
                </h3>
                {formError ? <p className="mt-1">{formError}</p> : null}
                {errorEntries.length > 0 ? (
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {errorEntries.map(([name, message]) => (
                      <li key={name}>
                        <a
                          href={`#${fieldId(name)}`}
                          className="font-medium underline"
                          onClick={(event) => {
                            event.preventDefault();
                            focusField(name);
                          }}
                        >
                          {message}
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            <fieldset className="rounded-md border border-neutral-400 p-3">
              <legend className="px-1 text-sm font-semibold">How do you want to add the job?</legend>
              <div className="flex flex-col gap-1 sm:flex-row sm:gap-6">
                {(
                  [
                    ["structured", "Fill in the details"],
                    ["raw", "Paste a job posting"],
                  ] as const
                ).map(([value, text]) => (
                  <label key={value} className="flex min-h-11 items-center gap-2 text-base">
                    <input
                      type="radio"
                      name="mode"
                      value={value}
                      checked={mode === value}
                      onChange={() => {
                        setMode(value);
                        setErrors({});
                        setFormError(null);
                      }}
                      className="size-5 accent-indigo-700"
                    />
                    {text}
                  </label>
                ))}
              </div>
            </fieldset>

            {/* Shared fields: kept in both modes so switching modes never loses what was typed. */}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id={fieldId("title")} label="Job title" required error={errors["title"]}>
                {(props) => (
                  <input
                    {...props}
                    name="title"
                    type="text"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    autoComplete="off"
                    maxLength={400}
                  />
                )}
              </Field>
              <Field id={fieldId("company")} label="Company" required error={errors["company"]}>
                {(props) => (
                  <input
                    {...props}
                    name="company"
                    type="text"
                    value={company}
                    onChange={(event) => setCompany(event.target.value)}
                    autoComplete="off"
                    maxLength={400}
                  />
                )}
              </Field>
              <Field id={fieldId("location")} label="Location" error={errors["location"]} hint="City, or “Remote (EU)”">
                {(props) => (
                  <input
                    {...props}
                    name="location"
                    type="text"
                    value={location}
                    onChange={(event) => setLocation(event.target.value)}
                    autoComplete="off"
                    maxLength={400}
                  />
                )}
              </Field>
              {mode === "structured" ? (
                <Field id={fieldId("country")} label="Country" error={errors["country"]}>
                  {(props) => <input {...props} name="country" type="text" autoComplete="off" maxLength={200} />}
                </Field>
              ) : null}
            </div>

            {mode === "structured" ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field id={fieldId("roleCategory")} label="Role type" required error={errors["roleCategory"]}>
                    {(props) => (
                      <select {...props} name="roleCategory" defaultValue="">
                        <option value="">Choose a role type</option>
                        {optionList(ROLE_CATEGORIES, ROLE_LABELS)}
                      </select>
                    )}
                  </Field>
                  <Field id={fieldId("sector")} label="Sector" error={errors["sector"]}>
                    {(props) => (
                      <select {...props} name="sector" defaultValue="TECH">
                        {optionList(SECTORS, SECTOR_LABELS)}
                      </select>
                    )}
                  </Field>
                  <Field id={fieldId("workMode")} label="Work mode" error={errors["workMode"]}>
                    {(props) => (
                      <select {...props} name="workMode" defaultValue="UNKNOWN">
                        {optionList(WORK_MODES, WORK_MODE_LABELS)}
                      </select>
                    )}
                  </Field>
                  <Field id={fieldId("seniority")} label="Level" error={errors["seniority"]}>
                    {(props) => (
                      <select {...props} name="seniority" defaultValue="UNKNOWN">
                        {optionList(SENIORITIES, SENIORITY_LABELS)}
                      </select>
                    )}
                  </Field>
                  <Field id={fieldId("employmentType")} label="Employment type" error={errors["employmentType"]}>
                    {(props) => (
                      <select {...props} name="employmentType" defaultValue="UNKNOWN">
                        {optionList(EMPLOYMENT_TYPES, EMPLOYMENT_TYPE_LABELS)}
                      </select>
                    )}
                  </Field>
                </div>

                <Field
                  id={fieldId("description")}
                  label="Job description"
                  required
                  error={errors["description"]}
                  hint="Plain text. HTML tags are removed when you save."
                >
                  {(props) => (
                    <textarea
                      {...props}
                      ref={descriptionRef}
                      name="description"
                      rows={8}
                      maxLength={200_000}
                    />
                  )}
                </Field>

                <div>
                  <Field
                    id={fieldId("skills")}
                    label="Skills"
                    error={errors["skills"]}
                    hint="Separate with commas. Leave empty to detect them from the description."
                  >
                    {(props) => (
                      <input
                        {...props}
                        ref={skillsRef}
                        name="skills"
                        type="text"
                        autoComplete="off"
                        placeholder="TypeScript, React, PostgreSQL"
                      />
                    )}
                  </Field>
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <button type="button" onClick={detectSkills} className={secondaryButtonClass}>
                      Detect skills from description
                    </button>
                    <p role="status" className="text-sm text-neutral-800">
                      {detectMessage}
                    </p>
                  </div>
                </div>

                <fieldset className="rounded-md border border-neutral-400 p-3">
                  <legend className="px-1 text-sm font-semibold">Yearly salary (optional)</legend>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field id={fieldId("salaryMin")} label="From" error={errors["salaryMin"]}>
                      {(props) => <input {...props} name="salaryMin" type="text" inputMode="numeric" autoComplete="off" />}
                    </Field>
                    <Field id={fieldId("salaryMax")} label="To" error={errors["salaryMax"]}>
                      {(props) => <input {...props} name="salaryMax" type="text" inputMode="numeric" autoComplete="off" />}
                    </Field>
                    <Field id={fieldId("salaryCurrency")} label="Currency" error={errors["salaryCurrency"]} hint="e.g. SEK, EUR">
                      {(props) => (
                        <input {...props} name="salaryCurrency" type="text" autoComplete="off" maxLength={3} />
                      )}
                    </Field>
                  </div>
                </fieldset>

                <Field
                  id={fieldId("applyUrl")}
                  label="Link to apply (optional)"
                  error={errors["applyUrl"]}
                  hint="Must start with http:// or https://"
                >
                  {(props) => <input {...props} name="applyUrl" type="url" inputMode="url" autoComplete="off" />}
                </Field>
              </>
            ) : (
              <>
                <Field id={fieldId("roleCategory")} label="Role type" error={errors["roleCategory"]} hint="Leave on automatic to detect it from the title.">
                  {(props) => (
                    <select {...props} name="roleCategory" defaultValue="">
                      <option value="">Detect from title (automatic)</option>
                      {optionList(ROLE_CATEGORIES, ROLE_LABELS)}
                    </select>
                  )}
                </Field>

                <Field
                  id={fieldId("text")}
                  label="Job posting"
                  required
                  error={errors["text"]}
                  hint="Paste plain text or HTML. Scripts and markup are removed; only the text is kept."
                >
                  {(props) => (
                    <textarea
                      {...props}
                      name="text"
                      rows={10}
                      value={rawText}
                      onChange={(event) => setRawText(event.target.value)}
                      maxLength={200_000}
                    />
                  )}
                </Field>

                <Field
                  id={fieldId("url")}
                  label="Link to the original posting (optional)"
                  error={errors["url"]}
                  hint="Only the link is saved. Nothing is downloaded from it."
                >
                  {(props) => <input {...props} name="url" type="url" inputMode="url" autoComplete="off" />}
                </Field>

                {preview ? (
                  <section aria-labelledby={`${uid}-preview`} className="rounded-md border border-neutral-400 bg-neutral-50 p-4">
                    <h3 id={`${uid}-preview`} className="font-bold">
                      What we detected
                    </h3>
                    <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
                      <div className="flex gap-2">
                        <dt className="font-semibold">Role:</dt>
                        <dd>{preview.roleCategory ? ROLE_LABELS[preview.roleCategory] : "Not detected. Choose a role type above."}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="font-semibold">Level:</dt>
                        <dd>{SENIORITY_LABELS[preview.seniority]}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="font-semibold">Work mode:</dt>
                        <dd>{WORK_MODE_LABELS[preview.workMode]}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="font-semibold">Employment:</dt>
                        <dd>{EMPLOYMENT_TYPE_LABELS[preview.employmentType]}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="font-semibold">Sector:</dt>
                        <dd>{SECTOR_LABELS[preview.sector]}</dd>
                      </div>
                    </dl>
                    <p aria-live="polite" className="mt-3 text-sm font-semibold">
                      {preview.skills.length === 0
                        ? "No known skills found yet."
                        : `${preview.skills.length} skill${preview.skills.length === 1 ? "" : "s"} detected`}
                    </p>
                    {preview.skills.length > 0 ? (
                      <ul aria-label="Detected skills" className="mt-2 flex flex-wrap gap-2">
                        {preview.skills.map((skill) => (
                          <li key={skill} className={chipClass}>
                            {skill}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </section>
                ) : null}
              </>
            )}
          </div>

          <div className="sticky bottom-0 flex flex-wrap justify-end gap-3 border-t border-neutral-300 bg-white px-5 py-4">
            <button type="button" onClick={closeDialog} className={secondaryButtonClass}>
              Cancel
            </button>
            <button type="submit" disabled={pending} className={primaryButtonClass}>
              {pending ? "Adding…" : "Add job"}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
