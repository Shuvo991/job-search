import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { TailorWorkspace } from "@/components/tailor/tailor-workspace";
import { linkClass } from "@/components/ui/styles";
import { getJobById } from "@/lib/jobs/repository";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const job = await getJobById((await params).id);
  return { title: job ? `Tailor your CV for ${job.title} at ${job.company}` : "Job not found" };
}

export default async function TailorPage({ params }: Props) {
  const job = await getJobById((await params).id);
  if (!job) notFound();

  return (
    <div className="space-y-6">
      <p>
        <Link href={`/jobs/${job.id}`} className={linkClass}>
          <span aria-hidden="true">← </span>Back to the job
        </Link>
      </p>

      <header className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">Tailor your CV and cover letter</h1>
        <p className="text-lg text-neutral-800">
          <span className="font-semibold">{job.title}</span> at {job.company}
        </p>
        <p className="max-w-3xl text-base text-neutral-800">
          A local AI (Ollama, on this computer) rephrases your real experience for this job. It may not invent employers,
          titles, dates, skills or numbers, and you review every change before exporting a PDF.
        </p>
      </header>

      <TailorWorkspace job={{ id: job.id, title: job.title, company: job.company, skills: job.skills }} />
    </div>
  );
}
