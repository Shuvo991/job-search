import { describe, expect, it } from "vitest";
import rulesJson from "../../config/ats-rules.json";
import { compileAtsRules, expandVerbForms, getAtsRules, scoreResume, type AtsReport } from "@/lib/ats-scorer";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GOOD_RESUME = `Anna Lindqvist
Stockholm, Sweden | anna.lindqvist@example.com | +46 70 123 45 67
linkedin.com/in/annalindqvist | github.com/annalindqvist

SUMMARY
Senior software engineer with eight years of experience building web platforms in TypeScript, React and Node.js for products used by more than two million people.

EXPERIENCE
Senior Software Engineer, Northwind Systems, Stockholm
Jan 2021 - Present
- Led a team of 6 engineers that rebuilt the checkout in React and TypeScript, increasing conversion by 18%
- Designed PostgreSQL schemas and SQL queries that cut report time from 40 seconds to 3 seconds
- Deployed 25 services to AWS with Docker and Kubernetes, reducing infrastructure cost by 30%
- Mentored 4 junior developers and introduced code review guidelines adopted by 3 teams
- Automated releases with GitHub Actions, shortening the release cycle from 2 weeks to 2 days
- Partnered with product managers to prioritize a roadmap of 12 initiatives across 3 quarters

Software Engineer, Contoso AB, Gothenburg
Jun 2017 - Dec 2020
- Built a REST API in Node.js that served 1.2 million requests per day with 99.9% availability
- Improved test coverage from 35% to 85% with Jest and Cypress, preventing regressions before release
- Migrated a monolith to microservices, decreasing deployment failures by 60%
- Collaborated with designers in Scrum teams using Jira to ship 40 features in two years
- Optimized front-end bundles, improving page load time by 45% on mobile connections
- Documented 30 internal services so new engineers became productive within a week

Junior Developer, Fabrikam, Malmo
Aug 2015 - May 2017
- Developed internal tools in JavaScript that saved the support team 15 hours every week
- Resolved 200 customer tickets, reducing the backlog by half in four months
- Implemented automated database backups that cut recovery time to under 10 minutes
- Trained 8 new colleagues on the release process and the incident checklist

EDUCATION
MSc Computer Science, KTH Royal Institute of Technology, 2013 - 2015
BSc Computer Engineering, Chalmers University of Technology, 2010 - 2013

SKILLS
TypeScript, JavaScript, React, Node.js, PostgreSQL, SQL, Docker, Kubernetes, AWS, Git, Jira, Scrum, Agile, Jest, Cypress

PROJECTS
Open-source CLI: Created a command line tool in TypeScript that earned 1,500 GitHub stars
Home lab: Built a Kubernetes cluster on three mini servers to test deployment strategies`;

const JOB_SKILLS = ["React", "TypeScript", "Node.js", "PostgreSQL", "Docker", "Kubernetes", "Terraform", "GraphQL"];

/** A string with exactly `count` words. */
const words = (count: number): string => Array.from({ length: count }, () => "word").join(" ");

function ids(report: AtsReport): string[] {
  return report.formattingWarnings.map((warning) => warning.id);
}

function warningIdsFor(text: string, pageCount?: number): string[] {
  return ids(scoreResume({ resumeText: text, jobSkills: [], pageCount }));
}

// ---------------------------------------------------------------------------
// Rules file
// ---------------------------------------------------------------------------

describe("config/ats-rules.json", () => {
  it("compiles, and its weights add up to 100", () => {
    const compiled = getAtsRules();
    expect(compiled.version).toBe(rulesJson.version);
    const total = Object.values(compiled.rules.weights).reduce((sum, weight) => sum + weight, 0);
    expect(total).toBe(100);
  });

  it("contains every category of heuristic", () => {
    const { rules } = getAtsRules();
    expect(rules.language.buzzwords.length).toBeGreaterThan(30);
    expect(rules.actionVerbs.verbs.length).toBeGreaterThan(100);
    expect(rules.sections.definitions.filter((d) => d.required).map((d) => d.id)).toEqual([
      "experience",
      "education",
      "skills",
    ]);
    expect(rules.length.ideal.min).toBeLessThan(rules.length.ideal.max);
    expect(rules.formatting.flags.length).toBeGreaterThanOrEqual(10);
  });

  it("has unique flag ids and compiles every flag pattern", () => {
    const { flags } = getAtsRules();
    const seen = new Set<string>();
    for (const { rule, regex } of flags) {
      expect(seen.has(rule.id), `duplicate flag id ${rule.id}`).toBe(false);
      seen.add(rule.id);
      expect(regex.flags).toContain("g");
    }
  });

  function broken(change: (copy: typeof rulesJson) => void): unknown {
    const copy = structuredClone(rulesJson);
    change(copy);
    return copy;
  }

  it("rejects a bad edit with a clear message", () => {
    expect(() => compileAtsRules({})).toThrow("ats rules");
    expect(() =>
      compileAtsRules(
        broken((copy) => {
          copy.weights.keywords = 0;
          copy.weights.sections = 0;
          copy.weights.formatting = 0;
          copy.weights.actionVerbs = 0;
          copy.weights.language = 0;
          copy.weights.length = 0;
        }),
      ),
    ).toThrow("weights");
    expect(() =>
      compileAtsRules(
        broken((copy) => {
          const flag = copy.formatting.flags[0];
          if (flag) flag.pattern = "(";
        }),
      ),
    ).toThrow("invalid pattern");
    expect(() =>
      compileAtsRules(
        broken((copy) => {
          copy.sections.definitions[1]?.aliases.push("experience");
        }),
      ),
    ).toThrow("belongs to both");
    expect(() =>
      compileAtsRules(
        broken((copy) => {
          copy.length.ideal.min = 100;
        }),
      ),
    ).toThrow("ideal.min");
  });
});

describe("expandVerbForms", () => {
  it("adds base, third-person and -ing forms of regular verbs", () => {
    expect(expandVerbForms("managed")).toEqual(expect.arrayContaining(["managed", "manage", "manages", "managing"]));
    expect(expandVerbForms("developed")).toEqual(expect.arrayContaining(["develop", "develops", "developing"]));
    expect(expandVerbForms("planned")).toEqual(expect.arrayContaining(["plan", "plans", "planning"]));
    expect(expandVerbForms("shipped")).toEqual(expect.arrayContaining(["ship", "shipping"]));
    expect(expandVerbForms("simplified")).toEqual(expect.arrayContaining(["simplify", "simplifies", "simplifying"]));
  });
});

// ---------------------------------------------------------------------------
// Whole-report behaviour
// ---------------------------------------------------------------------------

describe("scoreResume: a strong resume", () => {
  const report = scoreResume({ resumeText: GOOD_RESUME, jobSkills: JOB_SKILLS, pageCount: 2 });

  it("scores high and gets a good grade", () => {
    expect(report.overallScore).toBeGreaterThanOrEqual(80);
    expect(["excellent", "good"]).toContain(report.grade);
    expect(report.rulesVersion).toBe(rulesJson.version);
  });

  it("lists exactly the job skills that are missing", () => {
    expect(report.keywords.total).toBe(8);
    expect(report.keywords.matched).toEqual(["React", "TypeScript", "Node.js", "PostgreSQL", "Docker", "Kubernetes"]);
    expect(report.keywords.missing).toEqual(["Terraform", "GraphQL"]);
    expect(report.keywords.matchRate).toBe(0.75);
  });

  it("finds all sections and few formatting problems", () => {
    expect(report.sections.missingRequired).toEqual([]);
    expect(report.sections.found).toEqual(expect.arrayContaining(["Experience", "Education", "Skills", "Summary", "Projects"]));
    expect(report.formattingWarnings.filter((w) => w.severity !== "low")).toEqual([]);
  });

  it("measures action verb density from the bullets", () => {
    expect(report.actionVerbs.candidateLines).toBeGreaterThanOrEqual(15);
    expect(report.actionVerbs.density).toBeGreaterThanOrEqual(0.9);
    expect(report.actionVerbs.verbsUsed).toEqual(expect.arrayContaining(["led", "built", "designed"]));
    expect(report.actionVerbs.quantifiedShare).toBeGreaterThan(0.8);
  });

  it("explains every point: component points add up to the overall score", () => {
    const sum = report.components.reduce((total, component) => total + component.points, 0);
    expect(Math.abs(sum - report.overallScore)).toBeLessThanOrEqual(1);
    expect(report.components.reduce((total, component) => total + component.maxPoints, 0)).toBeCloseTo(100, 0);
    for (const component of report.components) {
      expect(component.summary.length).toBeGreaterThan(0);
      expect(component.ratio).toBeGreaterThanOrEqual(0);
      expect(component.ratio).toBeLessThanOrEqual(1);
    }
  });

  it("is deterministic", () => {
    const again = scoreResume({ resumeText: GOOD_RESUME, jobSkills: JOB_SKILLS, pageCount: 2 });
    expect(again).toEqual(report);
  });

  it("scores lower when the job asks for skills the resume lacks", () => {
    const harder = scoreResume({
      resumeText: GOOD_RESUME,
      jobSkills: ["Terraform", "GraphQL", "Rust", "Kafka", "Go", "Swift"],
      pageCount: 2,
    });
    expect(harder.keywords.matched).toEqual([]);
    expect(harder.overallScore).toBeLessThan(report.overallScore);
  });

  it("returns an integer between 0 and 100 and a JSON-safe report", () => {
    expect(Number.isInteger(report.overallScore)).toBe(true);
    expect(JSON.parse(JSON.stringify(report))).toEqual(JSON.parse(JSON.stringify(report)));
    expect(report.recommendations.length).toBeLessThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("scoreResume: empty and unreadable input", () => {
  it("gives 0 for an empty resume (for example a blank PDF)", () => {
    const report = scoreResume({ resumeText: "", jobSkills: ["React", "SQL"] });
    expect(report.overallScore).toBe(0);
    expect(report.grade).toBe("poor");
    expect(ids(report)).toEqual(["no-extractable-text"]);
    expect(report.keywords.matched).toEqual([]);
    expect(report.keywords.missing).toEqual(["React", "SQL"]);
    expect(report.length.status).toBe("empty");
    expect(report.components.every((component) => component.points === 0)).toBe(true);
    expect(report.recommendations[0]).toContain("text-based PDF");
  });

  it("treats whitespace and control characters like an empty resume", () => {
    const report = scoreResume({ resumeText: " \n\t\u0000\u200B \r\n\f ", jobSkills: ["React"] });
    expect(report.overallScore).toBe(0);
    expect(ids(report)).toEqual(["no-extractable-text"]);
  });

  it("still scores a job that lists no skills, without a keyword component", () => {
    const report = scoreResume({ resumeText: GOOD_RESUME, jobSkills: [] });
    const keywords = report.components.find((component) => component.id === "keywords");
    expect(keywords?.applicable).toBe(false);
    expect(keywords?.maxPoints).toBe(0);
    expect(report.components.reduce((total, component) => total + component.maxPoints, 0)).toBeCloseTo(100, 0);
    expect(report.overallScore).toBeGreaterThan(80);
    expect(report.keywords).toEqual({ total: 0, matched: [], missing: [], matchRate: 0 });
  });

  it("does not execute or choke on markup and hostile-looking skill names", () => {
    const report = scoreResume({
      resumeText: "<script>alert(1)</script>\nExperience\n- Built <img src=x onerror=alert(1)> widgets",
      jobSkills: ["__proto__", "constructor", "toString", "(", "[a-z", "  "],
    });
    expect(report.overallScore).toBeGreaterThanOrEqual(0);
    expect(report.keywords.total).toBe(5);
    expect(report.keywords.matched).toEqual([]);
  });

  it("stays fast on pathological input", () => {
    const started = Date.now();
    for (const resumeText of ["a".repeat(150_000), "+1 ".repeat(50_000), "a@".repeat(60_000), `${" ".repeat(100_000)}x`]) {
      scoreResume({ resumeText, jobSkills: ["React", "Zorbulator"] });
    }
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("scoreResume: missing sections", () => {
  it("reports missing required and recommended sections", () => {
    const report = scoreResume({
      resumeText: "Jane Doe\njane@example.com\n\nSummary\nI write software for a living and enjoy it a lot.",
      jobSkills: [],
    });
    expect(report.sections.found).toEqual(["Summary"]);
    expect(report.sections.missingRequired).toEqual(["Experience", "Education", "Skills"]);
    expect(report.sections.missingRecommended).toEqual(["Projects", "Certifications"]);
    const sections = report.components.find((component) => component.id === "sections");
    expect(sections?.ratio).toBeLessThan(0.4);
    expect(report.recommendations.join(" ")).toContain("Experience, Education, Skills");
  });

  it("recognises common heading styles", () => {
    const report = scoreResume({
      resumeText: "WORK EXPERIENCE\nSomething\nEducation & Training\nSomething\nTechnical Skills: Python, SQL\nCertificates\nx",
      jobSkills: [],
    });
    expect(report.sections.found).toEqual(["Experience", "Education", "Skills", "Certifications"]);
  });

  it("does not mistake a sentence for a heading", () => {
    const report = scoreResume({
      resumeText: "I have 5 years of experience with Java and a degree in education policy and teaching methods",
      jobSkills: [],
    });
    expect(report.sections.found).toEqual([]);
  });
});

describe("scoreResume: keyword matching", () => {
  const matched = (resumeText: string, jobSkills: string[]) => scoreResume({ resumeText, jobSkills }).keywords;

  it("matches aliases to the job's canonical skill name", () => {
    expect(matched("Built UIs with ReactJS and ran k8s clusters on Postgres", ["React", "Kubernetes", "PostgreSQL"]).matched).toEqual([
      "React",
      "Kubernetes",
      "PostgreSQL",
    ]);
  });

  it("is case-insensitive and de-duplicates the job's skills", () => {
    const keywords = matched("typescript and DOCKER", ["TypeScript", "typescript", "Docker", "docker"]);
    expect(keywords.total).toBe(2);
    expect(keywords.matched).toEqual(["TypeScript", "Docker"]);
  });

  it("keeps the job's order for missing skills", () => {
    expect(matched("nothing relevant here", ["Rust", "React", "Apache Kafka"]).missing).toEqual(["Rust", "React", "Apache Kafka"]);
  });

  it("does not match ordinary words for ambiguous skills such as Go", () => {
    expect(matched("Go to market strategy for new products", ["Go"]).missing).toEqual(["Go"]);
    expect(matched("Languages: Python, Go, SQL", ["Go"]).matched).toEqual(["Go"]);
  });

  it("matches skills the dictionary does not know by their literal name", () => {
    expect(matched("Experience with Zorbulator and other tools", ["Zorbulator"]).matched).toEqual(["Zorbulator"]);
    expect(matched("Experience with Zorbulatorix", ["Zorbulator"]).missing).toEqual(["Zorbulator"]);
  });

  it("does not match a skill inside a longer word", () => {
    expect(matched("Reactive programming with Javascripting", ["React"]).missing).toEqual(["React"]);
  });
});

describe("scoreResume: action verbs", () => {
  const verbs = (resumeText: string) => scoreResume({ resumeText, jobSkills: [] }).actionVerbs;

  it("reaches full density when every bullet starts with an action verb", () => {
    const result = verbs("- Led a team of five engineers\n- Built a pipeline for data ingestion\n- Reduced costs across the whole stack");
    expect(result.candidateLines).toBe(3);
    expect(result.density).toBe(1);
    expect(result.linesWithoutVerb).toEqual([]);
  });

  it("accepts present-tense and -ing forms", () => {
    const result = verbs("- Manage five engineers every day\n* Leading the platform migration project\n\u2022 Develops internal tooling for analysts");
    expect(result.density).toBe(1);
  });

  it("flags bullets that start with weak wording and lists examples", () => {
    const result = verbs(
      "- Responsible for the database layer of the product\n- Worked on several internal projects with the team\n- Led a team of five engineers\n- The team shipped weekly releases",
    );
    expect(result.candidateLines).toBe(4);
    expect(result.withActionVerb).toBe(1);
    expect(result.density).toBe(0.25);
    expect(result.linesWithoutVerb).toHaveLength(3);
    expect(result.linesWithoutVerb[0]).toContain("Responsible for");
  });

  it("falls back to long plain lines when there are no bullet glyphs (DOCX text)", () => {
    const result = verbs(
      "Anna Lindqvist\nExperience\nLed a team of five engineers across three countries\nBuilt a data pipeline that processed ten million events daily\nReduced hosting costs by thirty percent through careful tuning",
    );
    expect(result.candidateLines).toBe(3);
    expect(result.density).toBe(1);
  });

  it("is 0 with no bullets at all and scores that component 0", () => {
    const report = scoreResume({ resumeText: "Experience\nJane\nDeveloper", jobSkills: [] });
    expect(report.actionVerbs.candidateLines).toBe(0);
    expect(report.actionVerbs.density).toBe(0);
    expect(report.components.find((c) => c.id === "actionVerbs")?.points).toBe(0);
  });
});

describe("scoreResume: language", () => {
  it("finds buzzwords and weak phrases, in any hyphenation, and counts repeats", () => {
    const { language } = scoreResume({
      resumeText:
        "I am a Results-Driven team player and a results driven self-starter.\nResponsible for the API. Responsible for deployments. Worked on tests.",
      jobSkills: [],
    });
    const buzz = Object.fromEntries(language.buzzwords.map((item) => [item.phrase, item.count]));
    expect(buzz["results-driven"]).toBe(2);
    expect(buzz["team player"]).toBe(1);
    expect(buzz["self-starter"]).toBe(1);
    const weak = Object.fromEntries(language.weakPhrases.map((item) => [item.phrase, item.count]));
    expect(weak["responsible for"]).toBe(2);
    expect(weak["worked on"]).toBe(1);
  });

  it("does not flag technical uses of the words", () => {
    const { language } = scoreResume({
      resumeText: "Used dynamic programming and dynamic pricing models; replaced a ninjago widget; synergy-free",
      jobSkills: [],
    });
    expect(language.buzzwords.map((item) => item.phrase)).toEqual(["synergy"]);
  });

  it("lowers the language score as issues pile up", () => {
    const clean = scoreResume({ resumeText: GOOD_RESUME, jobSkills: [] });
    const dirty = scoreResume({
      resumeText: `${GOOD_RESUME}\nPassionate, hard-working team player and go-getter. Proven track record. Responsible for many things.`,
      jobSkills: [],
    });
    const ratio = (report: AtsReport) => report.components.find((c) => c.id === "language")?.ratio ?? -1;
    expect(ratio(clean)).toBe(1);
    expect(ratio(dirty)).toBeLessThan(0.3);
  });
});

describe("scoreResume: formatting red flags", () => {
  const baseline = `Jane Doe\njane@example.com +46 70 123 45 67\ngithub.com/jane\nExperience\n- Built things 2020 - 2022`;

  it("raises nothing for a clean contact block", () => {
    expect(warningIdsFor(baseline)).toEqual([]);
  });

  it("requires an email address", () => {
    expect(warningIdsFor("Jane Doe\n+46 70 123 45 67\ngithub.com/jane\n2020 2021")).toContain("missing-email");
    expect(warningIdsFor(baseline)).not.toContain("missing-email");
  });

  it("recognises common phone formats but not date ranges", () => {
    for (const phone of ["+46 70 123 45 67", "070-123 45 67", "(555) 123-4567", "555-123-4567", "+1 (555) 123-4567"]) {
      expect(warningIdsFor(`jane@example.com ${phone} 2020 2021 github.com/j`), phone).not.toContain("missing-phone");
    }
    expect(warningIdsFor("jane@example.com Experience 2019 - 2021, 2021-2023 github.com/j")).toContain("missing-phone");
  });

  it("flags emoji, symbol bullets and garbled characters", () => {
    expect(warningIdsFor(`${baseline}\n\u{1F4DE} call me`)).toContain("emoji");
    expect(warningIdsFor(`${baseline}\n\u27A2 Led a team`)).toContain("special-bullets");
    expect(warningIdsFor(`${baseline}\n\uF0B7 Led a team`)).toContain("special-bullets");
    const garbled = scoreResume({ resumeText: `${baseline}\nBj\uFFFDrn`, jobSkills: [] });
    expect(garbled.formattingWarnings[0]?.id).toBe("garbled-characters");
    expect(garbled.formattingWarnings[0]?.severity).toBe("high");
    expect(garbled.formattingWarnings[0]?.evidence).toEqual(["\uFFFD"]);
  });

  it("requires dates", () => {
    expect(warningIdsFor("jane@example.com +46 70 123 45 67 github.com/j\nExperience\n- Built things")).toContain("few-dates");
  });

  it("flags many wide gaps as a possible multi-column layout, but not a couple", () => {
    const columns = Array.from({ length: 9 }, (_, i) => `Skill ${i}          Level ${i}`).join("\n");
    expect(warningIdsFor(`${baseline}\n${columns}`)).toContain("column-gaps");
    expect(warningIdsFor(`${baseline}\nSkill A          Level A\nSkill B          Level B`)).not.toContain("column-gaps");
  });

  it("flags personal details and heavy first-person writing", () => {
    expect(warningIdsFor(`${baseline}\nMarital status: single\nDate of birth: 1990`)).toContain("personal-details");
    expect(warningIdsFor(`${baseline}\nI did my work and I led my team; I think my results made me proud`)).toContain("first-person");
  });

  it("flags too many pages from the page count", () => {
    expect(warningIdsFor(baseline, 3)).toContain("too-many-pages");
    expect(warningIdsFor(baseline, 2)).not.toContain("too-many-pages");
    expect(warningIdsFor(baseline)).not.toContain("too-many-pages");
  });

  it("sorts warnings by severity and attaches evidence", () => {
    const report = scoreResume({ resumeText: "\u{1F4DE} hello\n\u27A2 world", jobSkills: [] });
    const severities = report.formattingWarnings.map((warning) => warning.severity);
    expect(severities).toEqual([...severities].sort((a, b) => ["high", "medium", "low"].indexOf(a) - ["high", "medium", "low"].indexOf(b)));
    expect(report.formattingWarnings.find((w) => w.id === "emoji")?.evidence).toEqual(["\u{1F4DE}"]);
  });

  it("lowers the formatting score per raised flag", () => {
    const ratio = (text: string) =>
      scoreResume({ resumeText: text, jobSkills: [] }).components.find((c) => c.id === "formatting")?.ratio ?? -1;
    expect(ratio(baseline)).toBe(1);
    expect(ratio(`${baseline}\n\u{1F4DE}`)).toBeLessThan(1);
    expect(ratio(`${baseline}\n\u{1F4DE}\n\u27A2 x\nBj\uFFFDrn`)).toBeLessThan(ratio(`${baseline}\n\u{1F4DE}`));
  });
});

describe("scoreResume: length", () => {
  const status = (count: number) => scoreResume({ resumeText: words(count), jobSkills: [] }).length;

  it("classifies the word count", () => {
    expect(status(30).status).toBe("too_short");
    expect(status(300).status).toBe("short");
    expect(status(500).status).toBe("ideal");
    expect(status(900).status).toBe("long");
    expect(status(1500).status).toBe("too_long");
    expect(status(500).wordCount).toBe(500);
    expect(status(500).idealRange).toEqual({ min: 400, max: 800 });
  });

  it("scores the ideal range best", () => {
    const ratio = (count: number) =>
      scoreResume({ resumeText: words(count), jobSkills: [] }).components.find((c) => c.id === "length")?.ratio ?? -1;
    expect(ratio(500)).toBe(1);
    expect(ratio(300)).toBeLessThan(1);
    expect(ratio(30)).toBeLessThan(ratio(300));
    expect(ratio(1500)).toBeLessThan(ratio(900));
  });
});
