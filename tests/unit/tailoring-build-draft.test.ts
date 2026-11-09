import { describe, expect, it } from "vitest";
import { buildCoverLetterDraft, buildCvDraft } from "@/lib/tailoring/build-draft";
import type { CoverLetterLlmOutput, CvLlmOutput } from "@/schemas/tailoring";

const CV = [
  "Jane Doe",
  "jane.doe@example.com",
  "+46 70 123 45 67",
  "https://www.linkedin.com/in/janedoe",
  "",
  "PROFESSIONAL EXPERIENCE",
  "Senior Product Manager",
  "Acme AB, Stockholm",
  "Jan 2021 - Present",
  "• Led a team of 5 engineers to ship a payments feature used by 40% of customers",
  "• Worked with finance and legal on PSD2 compliance across 3 markets",
  "Product Owner",
  "Beta Corp",
  "2018 - 2020",
  "• Managed the backlog in Jira and ran weekly sprint reviews",
  "",
  "EDUCATION",
  "Stockholm University, MSc Computer Science, 2017 - 2019",
  "",
  "SKILLS",
  "Jira, SQL, Roadmapping",
].join("\n");

const GOOD_BULLET = "Worked with finance and legal on PSD2 compliance across 3 markets";

// Line numbers of CV (1-based, blank lines are not counted): 9 and 10 are the Acme bullets, 14 is Beta's.
function llmOutput(): CvLlmOutput {
  return {
    fullName: "Jane Doe",
    location: "Stockholm",
    summary: { lines: [], tailored: "Product manager who led a team of 5 engineers and shipped payments features." },
    experience: [
      {
        company: "Acme AB",
        title: "Senior Product Manager",
        location: "Stockholm",
        startDate: "Jan 2021",
        endDate: "Present",
        bullets: [
          { line: 9, tailored: "Led 5 engineers to deliver payments, lifting conversion by 25%" },
          { line: 10, tailored: "Partnered with finance and legal on PSD2 compliance across 3 markets" },
          { line: 999, tailored: "Built a rocket engine" },
        ],
      },
      {
        company: "Globex Corp",
        title: "CTO",
        location: "",
        startDate: "2015",
        endDate: "2017",
        bullets: [],
      },
      {
        company: "Beta Corp",
        title: "Product Owner",
        location: "",
        startDate: "2016",
        endDate: "2020",
        bullets: [{ line: 14, tailored: "Managed the Jira backlog and ran weekly sprint reviews" }],
      },
    ],
    education: [
      { institution: "Stockholm University", degree: "MSc Computer Science", startDate: "2017", endDate: "2019" },
      { institution: "MIT", degree: "PhD", startDate: "2010", endDate: "2014" },
    ],
    additional: [{ heading: "Interests", lines: [18, 5000] }],
    matchedKeywords: ["Jira", "Kubernetes"],
    gaps: ["Kubernetes"],
    notes: [],
  };
}

const JOB = { title: "Product Lead", description: "Own the SQL reporting roadmap.", skills: ["SQL"], requirements: [] };

describe("buildCvDraft: nothing invented survives", () => {
  const { draft, warnings } = buildCvDraft(llmOutput(), CV, JOB);

  it("reads contact details from the CV text, not from the model", () => {
    expect(draft.contact).toMatchObject({
      fullName: "Jane Doe",
      email: "jane.doe@example.com",
      phone: "+46 70 123 45 67",
      location: "Stockholm",
    });
    expect(draft.contact.links[0]).toContain("linkedin.com/in/janedoe");
  });

  it("builds the skills list from the CV itself and puts the job's skills first", () => {
    expect(draft.skills).toEqual(["SQL", "Jira", "Roadmapping"]);
    expect(buildCvDraft(llmOutput(), CV).draft.skills).toEqual(["Jira", "SQL", "Roadmapping"]);
    expect(draft.matchedKeywords).toEqual(["Jira"]);
  });

  it("drops an employer that is not in the CV", () => {
    expect(draft.experience.map((entry) => entry.company)).toEqual(["Acme AB", "Beta Corp"]);
    expect(warnings.join(" ")).toContain("Globex Corp");
  });

  it("falls back to the original wording when a rewrite invents a number", () => {
    const [first] = draft.experience[0]?.bullets ?? [];
    expect(first?.text).toBe("Led a team of 5 engineers to ship a payments feature used by 40% of customers");
    expect(first?.suggested).toContain("25%");
    expect(first?.flags.join(" ")).toContain("25%");
  });

  it("keeps a clean rewrite and shows the user's own line as the original", () => {
    const second = draft.experience[0]?.bullets[1];
    expect(second?.text).toBe("Partnered with finance and legal on PSD2 compliance across 3 markets");
    expect(second?.original).toBe(GOOD_BULLET);
    expect(second?.flags).toEqual([]);
  });

  it("leaves out a bullet that points at a line that does not exist", () => {
    expect(draft.experience[0]?.bullets).toHaveLength(2);
    expect(warnings.join(" ")).toContain("does not exist");
  });

  it("blanks a date the CV does not give for that job, and says so", () => {
    const beta = draft.experience[1];
    expect(beta?.startDate).toBe("");
    expect(beta?.endDate).toBe("2020");
    expect(beta?.issues.join(" ")).toContain("2016");
  });

  it("drops an institution that is not in the CV", () => {
    expect(draft.education.map((entry) => entry.institution)).toEqual(["Stockholm University"]);
  });

  it("copies other sections from the CV lines it points at and drops bad line numbers", () => {
    expect(draft.additional).toEqual([{ id: "add-0", heading: "Interests", items: ["Jira, SQL, Roadmapping"] }]);
    expect(warnings.join(" ")).toMatch(/did not match/);
  });

  it("holds back AI rewrites flagged by the safety checks and says how many", () => {
    expect(warnings.join(" ")).toMatch(/held back/);
  });
});

describe("buildCvDraft: quality checks on a rewrite", () => {
  const withBullet = (tailored: string, line = 9) => {
    const output = llmOutput();
    output.experience = [
      {
        company: "Acme AB",
        title: "Senior Product Manager",
        location: "",
        startDate: "",
        endDate: "",
        bullets: [{ line, tailored }],
      },
    ];
    return buildCvDraft(output, CV).draft.experience[0]?.bullets[0];
  };

  it("rejects a rewrite that drops the original's numbers", () => {
    const bullet = withBullet("Led engineers to ship a payments feature");
    expect(bullet?.flags.join(" ")).toContain("Dropped a number");
    expect(bullet?.text).toBe("Led a team of 5 engineers to ship a payments feature used by 40% of customers");
  });

  it("accepts a rewrite that keeps every number", () => {
    const bullet = withBullet("Shipped a payments feature used by 40% of customers, leading a team of 5 engineers");
    expect(bullet?.flags).toEqual([]);
    expect(bullet?.text).toContain("40%");
  });

  it("never turns a job header line into a bullet", () => {
    const output = llmOutput();
    output.experience = [
      { company: "Acme AB", title: "Senior Product Manager", location: "", startDate: "", endDate: "", bullets: [{ line: 8, tailored: "x" }] },
    ];
    expect(buildCvDraft(output, CV).draft.experience[0]?.bullets).toEqual([]);
  });
});

describe("buildCvDraft: summary", () => {
  it("uses the CV's own summary section as the original", () => {
    const cv = ["Jane Doe", "PROFESSIONAL SUMMARY", "Product manager with 7 years of payments experience.", "SKILLS", "SQL"].join("\n");
    const output = llmOutput();
    output.experience = [];
    output.summary = { lines: [], tailored: "Product manager with 7 years of payments experience, aimed at this job." };
    const { draft } = buildCvDraft(output, cv);
    expect(draft.summary.original).toBe("Product manager with 7 years of payments experience.");
    expect(draft.summary.flags).toEqual([]);
  });
});

describe("buildCoverLetterDraft", () => {
  const output: CoverLetterLlmOutput = {
    greeting: "Dear Hiring Team,",
    paragraphs: [
      {
        text: "At Acme AB I led a team of 5 engineers and shipped a payments feature used by 40% of customers.",
        evidence: ["Led a team of 5 engineers to ship a payments feature used by 40% of customers"],
      },
      {
        text: "I also cut cloud costs by 60% using Kubernetes at a previous employer.",
        evidence: ["Reduced cloud costs by 60% with Kubernetes"],
      },
      { text: "I would welcome a conversation about Initech.", evidence: [] },
    ],
    closing: "Thank you for your time.",
    requirementsAddressed: ["Payments"],
    gaps: [],
  };
  const { draft, warnings } = buildCoverLetterDraft(output, CV, { title: "Product Lead", company: "Globex" });

  it("keeps supported claims unflagged and snaps evidence to the real CV line", () => {
    expect(draft.paragraphs[0]?.flags).toEqual([]);
    expect(draft.paragraphs[0]?.evidence).toEqual([
      "Led a team of 5 engineers to ship a payments feature used by 40% of customers",
    ]);
  });

  it("flags a paragraph with an invented number, an invented tool and no supporting CV line", () => {
    const flags = draft.paragraphs[1]?.flags.join(" ") ?? "";
    expect(flags).toContain("60%");
    expect(flags).toContain("Kubernetes");
    expect(flags).toContain("No line of your CV");
    expect(warnings.join(" ")).toContain("careful check");
  });

  it("flags an employer name that is neither in the CV nor the job", () => {
    expect(draft.paragraphs[2]?.flags.join(" ")).toContain("Initech");
  });
});

describe("buildCoverLetterDraft: evidence and job names", () => {
  const output: CoverLetterLlmOutput = {
    greeting: "Dear Hiring Team,",
    paragraphs: [
      {
        text: "I applied for the Product Lead role at Globex. At Acme AB I led a team of 5 engineers.",
        // The first evidence line is a job header (proves nothing); the second is a real bullet.
        evidence: ["Jan 2021 - Present", "Led a team of 5 engineers to ship a payments feature used by 40% of customers"],
      },
    ],
    closing: "Thank you.",
    requirementsAddressed: [],
    gaps: [],
  };
  const { draft } = buildCoverLetterDraft(output, CV, { title: "Product Lead", company: "Globex" });

  it("never uses a job header as evidence and never merges neighbouring bullets", () => {
    expect(draft.paragraphs[0]?.evidence).toEqual([
      "Led a team of 5 engineers to ship a payments feature used by 40% of customers",
    ]);
  });

  it("allows words from the job title (it is the employer's own wording)", () => {
    expect(draft.paragraphs[0]?.flags).toEqual([]);
  });
});
