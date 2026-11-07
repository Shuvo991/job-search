import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalizeSkillName,
  createSkillExtractor,
  extractSkillNames,
  extractSkills,
  getSkillExtractor,
  parseSkillDictionary,
} from "@/lib/skills-extractor";

const dictionaryPath = path.join(process.cwd(), "config", "skills-dictionary.json");
const rawDictionary: unknown = JSON.parse(readFileSync(dictionaryPath, "utf8"));

function names(text: string): string[] {
  return extractSkillNames(text);
}

describe("skills dictionary integrity", () => {
  const { definitions } = parseSkillDictionary(rawDictionary);

  it("parses and has a useful number of skills in both kinds", () => {
    expect(definitions.length).toBeGreaterThan(300);
    expect(definitions.filter((d) => d.kind === "technical").length).toBeGreaterThan(250);
    expect(definitions.filter((d) => d.kind === "soft").length).toBeGreaterThanOrEqual(25);
  });

  it("has unique canonical names", () => {
    const seen = new Set<string>();
    for (const definition of definitions) {
      const key = definition.name.toLowerCase();
      expect(seen.has(key), `duplicate skill name: ${definition.name}`).toBe(false);
      seen.add(key);
    }
  });

  it("never maps the same term to two different skills", () => {
    const owner = new Map<string, string>();
    for (const definition of definitions) {
      const terms = [
        ...(definition.nameMatch === "none" ? [] : [definition.name]),
        ...definition.aliases,
        ...definition.exact,
        ...definition.contextual,
      ];
      for (const term of terms) {
        const key = term.toLowerCase().replace(/[\s-]+/g, " ");
        const existing = owner.get(key);
        expect(
          existing === undefined || existing === definition.name,
          `term "${term}" belongs to both "${existing}" and "${definition.name}"`,
        ).toBe(true);
        owner.set(key, definition.name);
      }
    }
  });

  it("rejects a malformed dictionary with a clear message", () => {
    expect(() => parseSkillDictionary({})).toThrow("version");
    expect(() =>
      parseSkillDictionary({ version: "1", categories: {}, skills: [{ name: "X", category: "nope" }] }),
    ).toThrow("unknown category");
    expect(() =>
      parseSkillDictionary({
        version: "1",
        categories: { c: { kind: "technical", label: "C" } },
        skills: [{ name: "X", category: "c", aliases: [""] }],
      }),
    ).toThrow("non-empty");
  });
});

describe("extractSkills: basics", () => {
  it("finds skills case-insensitively and reports canonical names", () => {
    expect(names("We use typescript, PYTHON and Docker.")).toEqual(
      expect.arrayContaining(["TypeScript", "Python", "Docker"]),
    );
  });

  it("returns an empty list for empty or skill-free text", () => {
    expect(names("")).toEqual([]);
    expect(names("   \n  ")).toEqual([]);
    expect(names("We are a friendly company with free coffee.")).toEqual([]);
  });

  it("maps aliases to the canonical name", () => {
    expect(names("ReactJS, NodeJS, Postgres and k8s")).toEqual(
      expect.arrayContaining(["React", "Node.js", "PostgreSQL", "Kubernetes"]),
    );
    expect(names("Experience with Amazon Web Services and Google Cloud Platform")).toEqual(
      expect.arrayContaining(["AWS", "GCP"]),
    );
  });

  it("matches symbol-heavy skills", () => {
    expect(names("C#, C++, .NET and ASP.NET Core")).toEqual(expect.arrayContaining(["C#", "C++", ".NET"]));
    expect(names("CI/CD pipelines, PL/SQL and A/B testing")).toEqual(
      expect.arrayContaining(["CI/CD", "SQL", "A/B Testing"]),
    );
    expect(names("Node.js and Next.js")).toEqual(expect.arrayContaining(["Node.js", "Next.js"]));
  });

  it("treats hyphens, spaces and slash spacing as equivalent", () => {
    expect(names("problem-solving and problem solving")).toEqual(["Problem Solving"]);
    expect(names("CI / CD")).toEqual(["CI/CD"]);
    expect(names("go-to-market strategy")).toEqual(["Go-to-Market"]);
    expect(names("test driven development")).toEqual(["TDD"]);
  });

  it("allows plurals", () => {
    expect(names("Strong KPIs and several microservices")).toEqual(expect.arrayContaining(["KPIs", "Microservices"]));
    expect(names("Kafkas and Dockers")).toEqual(expect.arrayContaining(["Apache Kafka", "Docker"]));
  });

  it("does not match inside longer words", () => {
    expect(names("javascripting, pythonic, reactive, reacting, gitignore, digital")).toEqual([]);
    expect(names("Java is not JavaScript")).toEqual(expect.arrayContaining(["Java", "JavaScript"]));
    expect(names("JavaScript only")).toEqual(["JavaScript"]);
  });

  it("is not fooled by markdown, bullets or punctuation", () => {
    expect(names("- **Python**\n- (SQL)\n• `Docker`; \"Terraform\"")).toEqual(
      expect.arrayContaining(["Python", "SQL", "Docker", "Terraform"]),
    );
  });
});

describe("extractSkills: ambiguity rules", () => {
  it("matches case-sensitive terms only in their proper case", () => {
    expect(names("Knowledge of REST and JSON")).toContain("REST APIs");
    expect(names("the rest of the team will rest")).not.toContain("REST APIs");
    expect(names("You will excel at planning")).not.toContain("Excel");
    expect(names("Advanced Excel skills")).toContain("Excel");
    expect(names("swift delivery of results")).not.toContain("Swift");
    expect(names("iOS (Swift) developer")).toContain("Swift");
    expect(names("a spark of creativity")).not.toContain("Apache Spark");
    expect(names("Kafka and Spark")).toContain("Apache Spark");
    expect(names("team unity and trust")).not.toContain("Unity");
    expect(names("Unity and Unreal Engine")).toEqual(expect.arrayContaining(["Unity", "Unreal Engine"]));
  });

  it("matches Go / R / C only inside a skill list", () => {
    expect(names("Experience with Go, Rust and Python")).toEqual(expect.arrayContaining(["Go", "Rust", "Python"]));
    expect(names("Proficient in Python and R")).toContain("R");
    expect(names("Languages: Python, R, SQL")).toContain("R");
    expect(names("Skills in C/C++")).toEqual(expect.arrayContaining(["C", "C++"]));
    expect(names("Golang developer")).toContain("Go");
  });

  it("does not match Go / R / C in ordinary prose", () => {
    expect(names("Go to market planning and Go-to-market strategy")).not.toContain("Go");
    expect(names("You will go beyond expectations")).not.toContain("Go");
    expect(names("Our R&D department")).not.toContain("R");
    expect(names("Plan A, plan B and plan C are ready")).not.toContain("C");
    expect(names("Vitamin C and a go-getter attitude")).not.toContain("C");
  });

  it("matches Spring only as a list item or as Spring Boot", () => {
    expect(names("Java, Spring, Hibernate")).toContain("Spring Boot");
    expect(names("Spring Boot microservices")).toContain("Spring Boot");
    expect(names("Starting in spring 2027")).not.toContain("Spring Boot");
  });

  it("does not treat common English words as skills", () => {
    const text =
      "Join our team and express yourself. We value notion of ownership, linear thinking, a rails-free life, flask of coffee.";
    expect(names(text)).not.toEqual(expect.arrayContaining(["Notion", "Ruby on Rails", "Flask", "Express.js"]));
  });
});

describe("extractSkills: overlaps, counts and ordering", () => {
  it("prefers the longest match", () => {
    const found = names("React Native and React");
    expect(found).toEqual(expect.arrayContaining(["React Native", "React"]));
    expect(names("React Native only")).toEqual(["React Native"]);
    expect(names("Unreal Engine 5 and Unreal")).toEqual(["Unreal Engine"]);
  });

  it("counts every mention and sorts most-mentioned first", () => {
    const skills = extractSkills("Python. We love Python. SQL and Python again; SQL too. Docker.");
    expect(skills.map((s) => [s.name, s.count])).toEqual([
      ["Python", 3],
      ["SQL", 2],
      ["Docker", 1],
    ]);
  });

  it("records the first offset and distinct surface forms", () => {
    const [react] = extractSkills("We use ReactJS and React.js and React.");
    expect(react?.name).toBe("React");
    expect(react?.count).toBe(3);
    expect(react?.matchedAs).toEqual(["ReactJS", "React.js", "React"]);
    expect(react?.firstIndex).toBe(7);
  });

  it("breaks count ties by first appearance", () => {
    expect(names("Docker then Terraform then Python")).toEqual(["Docker", "Terraform", "Python"]);
  });

  it("filters by kind and applies a limit", () => {
    const text = "Excellent communication and leadership, plus Python, SQL and Docker.";
    const technical = extractSkills(text, { kinds: ["technical"] }).map((s) => s.name);
    const soft = extractSkills(text, { kinds: ["soft"] }).map((s) => s.name);
    expect(technical).toEqual(["Python", "SQL", "Docker"]);
    expect(soft).toEqual(["Communication", "Leadership"]);
    expect(extractSkills(text, { limit: 2 })).toHaveLength(2);
    expect(extractSkills(text, { limit: 0 })).toHaveLength(0);
  });
});

describe("extractSkills: soft skills and domain skills", () => {
  it("finds soft skills from typical phrasing", () => {
    const text =
      "You are a self-starter with excellent written and verbal communication, strong problem-solving, " +
      "attention to detail, and the ability to mentor juniors and collaborate across cross-functional teams.";
    expect(names(text)).toEqual(
      expect.arrayContaining([
        "Self-Motivation",
        "Communication",
        "Problem Solving",
        "Attention to Detail",
        "Mentoring",
        "Collaboration",
        "Cross-Functional Collaboration",
      ]),
    );
  });

  it("finds product, project, analysis and game skills", () => {
    expect(names("Own the product roadmap, write PRDs and run A/B tests with Mixpanel")).toEqual(
      expect.arrayContaining(["Product Roadmap", "PRD", "A/B Testing", "Mixpanel"]),
    );
    expect(names("PMP certified, Scrum, Kanban, Jira, risk management and budgeting")).toEqual(
      expect.arrayContaining(["PMP", "Scrum", "Kanban", "Jira", "Risk Management", "Budget Management"]),
    );
    expect(names("Requirements gathering, BPMN, UAT, Power BI and Excel")).toEqual(
      expect.arrayContaining(["Requirements Gathering", "BPMN", "User Acceptance Testing", "Power BI", "Excel"]),
    );
    expect(names("Unity (C#), HLSL shaders, netcode and live ops")).toEqual(
      expect.arrayContaining(["Unity", "C#", "Shader Programming", "Multiplayer Networking", "Live Operations"]),
    );
  });
});

describe("extractSkills: determinism, robustness and performance", () => {
  const sample = "Senior engineer: TypeScript, React, Node.js, PostgreSQL, AWS, Docker. Strong communication.";

  it("returns identical results for identical input", () => {
    expect(extractSkills(sample)).toEqual(extractSkills(sample));
    expect(extractSkills(sample)).toEqual(createSkillExtractor(rawDictionary).extract(sample));
  });

  it("normalises curly quotes, non-breaking spaces and zero-width characters", () => {
    expect(names("Node​.js and Type​Script")).toEqual(expect.arrayContaining(["Node.js", "TypeScript"]));
  });

  it("handles huge and hostile input quickly", () => {
    const hostile = "a-".repeat(60_000) + " ".repeat(10_000) + "((((((((((" .repeat(2_000);
    const big = (sample + "\n").repeat(1_500);
    const started = performance.now();
    extractSkills(hostile);
    const skills = extractSkills(big);
    const elapsed = performance.now() - started;
    expect(skills.find((s) => s.name === "TypeScript")?.count).toBe(1_500);
    expect(elapsed).toBeLessThan(2_000);
  });

  it("ignores input beyond the size cap instead of failing", () => {
    const text = "x ".repeat(150_000) + "Python";
    expect(names(text)).toEqual([]);
  });
});

describe("canonicalizeSkillName", () => {
  it("maps user-typed skills to canonical names", () => {
    expect(canonicalizeSkillName("reactjs")).toBe("React");
    expect(canonicalizeSkillName("  Postgres ")).toBe("PostgreSQL");
    expect(canonicalizeSkillName("golang")).toBe("Go");
    expect(canonicalizeSkillName("go")).toBe("Go");
    expect(canonicalizeSkillName("rest")).toBe("REST APIs");
    expect(canonicalizeSkillName("k8s")).toBe("Kubernetes");
    expect(canonicalizeSkillName("kpis")).toBe("KPIs");
  });

  it("keeps unknown skills as typed (trimmed)", () => {
    expect(canonicalizeSkillName("  Quantum Basket Weaving ")).toBe("Quantum Basket Weaving");
  });

  it("exposes the dictionary version", () => {
    expect(getSkillExtractor().version).toMatch(/^\d{4}\.\d+\.\d+$/);
  });
});

describe("realistic job description", () => {
  const jd = `
    Senior Full-Stack Engineer (Remote, EU)

    About you
    - 5+ years building web apps with TypeScript, React and Next.js; Node.js/Express on the backend
    - You know PostgreSQL well and have used Redis and Docker in production
    - Experience with AWS (Lambda, S3) and Terraform; CI/CD using GitHub Actions
    - Comfortable writing unit tests (Jest) and doing code review
    - Strong communication, ownership and a curious mindset

    Nice to have: GraphQL, Kubernetes, Python. Go beyond the brief and help us go to market faster.
    We are not looking for a Rust expert; the rest of the stack is JavaScript.
  `;

  it("extracts the expected set and nothing spurious", () => {
    const found = names(jd);
    expect(found).toEqual(
      expect.arrayContaining([
        "TypeScript",
        "React",
        "Next.js",
        "Node.js",
        "PostgreSQL",
        "Redis",
        "Docker",
        "AWS",
        "Terraform",
        "CI/CD",
        "GitHub Actions",
        "Jest",
        "Code Review",
        "Communication",
        "Ownership",
        "Learning Agility",
        "GraphQL",
        "Kubernetes",
        "Python",
        "JavaScript",
        "Rust",
      ]),
    );
    expect(found).not.toContain("Go");
    expect(found).not.toContain("REST APIs");
  });
});
