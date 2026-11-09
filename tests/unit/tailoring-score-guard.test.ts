import { describe, expect, it } from "vitest";
import { scoreResume } from "@/lib/ats-scorer";
import { buildCvDraft } from "@/lib/tailoring/build-draft";
import { cvToPlainText, draftToCvDocument } from "@/lib/tailoring/documents";
import { applyScoreGuard } from "@/lib/tailoring/score-guard";
import type { CvDraft } from "@/lib/tailoring/types";
import type { CvLlmOutput } from "@/schemas/tailoring";

const CV = [
  "Jane Doe",
  "jane.doe@example.com",
  "PROFESSIONAL EXPERIENCE",
  "Senior Product Manager",
  "Acme AB, Stockholm",
  "Jan 2021 - Present",
  "Payments conversion was low, so worked with the design team on stakeholder management and roadmapping, lifting conversion by 25%",
  "Weekly sprint reviews and backlog grooming with engineering",
  "EDUCATION",
  "Stockholm University, MSc Computer Science, 2017 - 2019",
  "SKILLS",
  "Jira, SQL",
].join("\n");

const JOB = {
  title: "Product Lead",
  description: "Own the roadmap.",
  skills: ["Stakeholder management", "Roadmapping", "SQL"],
  requirements: [],
};

function output(first: string, second: string): CvLlmOutput {
  return {
    fullName: "Jane Doe",
    location: "",
    summary: { lines: [], tailored: "" },
    experience: [
      {
        company: "Acme AB",
        title: "Senior Product Manager",
        location: "",
        startDate: "Jan 2021",
        endDate: "Present",
        bullets: [
          { line: 7, tailored: first },
          { line: 8, tailored: second },
        ],
      },
    ],
    education: [],
    additional: [],
    matchedKeywords: [],
    gaps: [],
    notes: [],
  };
}

const scoreOf = (draft: CvDraft) =>
  scoreResume({ resumeText: cvToPlainText(draftToCvDocument(draft)), jobSkills: JOB.skills }).overallScore;

describe("score guard", () => {
  it("keeps a rewrite that keeps the job's keywords and starts with an action verb", () => {
    const { draft } = buildCvDraft(
      output(
        "Led stakeholder management and roadmapping with the design team, lifting payments conversion by 25%",
        "Ran weekly sprint reviews and backlog grooming with engineering",
      ),
      CV,
      JOB,
    );
    const bullets = draft.experience[0]?.bullets ?? [];
    expect(bullets[0]?.text).toContain("Led stakeholder management");
    expect(bullets[0]?.flags).toEqual([]);
  });

  it("does not apply a rewrite that drops a keyword the job asks for", () => {
    const { draft, warnings } = buildCvDraft(
      output(
        "Led work with the design team, lifting payments conversion by 25%",
        "Weekly sprint reviews and backlog grooming with engineering",
      ),
      CV,
      JOB,
    );
    const first = draft.experience[0]?.bullets[0];
    expect(first?.text).toBe(first?.original);
    expect(first?.suggested).toContain("Led work");
    expect(first?.flags.join(" ")).toContain("lower this CV's ATS match");
    expect(warnings.join(" ")).toContain("would have lowered your ATS match");
  });

  it("never ends below the score of the user's own wording", () => {
    const rewritten = buildCvDraft(
      output("Led work with the design team, lifting conversion by 25%", "Ran reviews with engineering"),
      CV,
      JOB,
    ).draft;
    const ownWording: CvDraft = structuredClone(rewritten);
    for (const entry of ownWording.experience) for (const bullet of entry.bullets) bullet.text = bullet.original ?? "";
    ownWording.summary.text = ownWording.summary.original ?? "";
    expect(scoreOf(rewritten)).toBeGreaterThanOrEqual(scoreOf(ownWording));
    expect(applyScoreGuard(structuredClone(rewritten), JOB.skills).final).toBeGreaterThanOrEqual(scoreOf(ownWording));
  });
});
