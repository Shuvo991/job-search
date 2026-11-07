/**
 * Minimal in-memory stand-in for `prisma.job`, enough to exercise src/lib/jobs/repository.ts and the
 * /api/jobs route without a database. It understands the subset of Prisma query syntax the
 * repository uses: AND / OR, `contains` (case-insensitive like SQLite LIKE), `in`, equality,
 * orderBy with NULL sorting last for DESC, skip/take, select, count, findUnique, create.
 */
type Row = Record<string, unknown>;
type Where = Record<string, unknown> | undefined;

let rows: Row[] = [];
let sequence = 0;

function matches(row: Row, where: Where): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]) => {
    if (key === "AND") return ([] as Where[]).concat(condition as Where).every((part) => matches(row, part));
    if (key === "OR") return ([] as Where[]).concat(condition as Where).some((part) => matches(row, part));
    const value = row[key];
    if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
      const op = condition as Record<string, unknown>;
      if ("contains" in op) {
        return typeof value === "string" && value.toLowerCase().includes(String(op["contains"]).toLowerCase());
      }
      if ("in" in op) return (op["in"] as unknown[]).includes(value);
      if ("equals" in op) return value === op["equals"];
    }
    return value === condition;
  });
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1; // NULL is the smallest value, as in SQLite
  if (b === null || b === undefined) return 1;
  return (a as number | Date) < (b as number | Date) ? -1 : 1;
}

function pick(row: Row, select: Record<string, boolean> | undefined): Row {
  if (!select) return { ...row };
  return Object.fromEntries(Object.entries(select).filter(([, on]) => on).map(([key]) => [key, row[key]]));
}

export const fakePrisma = {
  job: {
    async findMany(args: {
      where?: Where;
      select?: Record<string, boolean>;
      orderBy?: Array<Record<string, "asc" | "desc">>;
      skip?: number;
      take?: number;
    } = {}) {
      let result = rows.filter((row) => matches(row, args.where));
      for (const order of [...(args.orderBy ?? [])].reverse()) {
        const [field, direction] = Object.entries(order)[0] as [string, "asc" | "desc"];
        result = [...result].sort((a, b) => (direction === "desc" ? -1 : 1) * compare(a[field], b[field]));
      }
      const start = args.skip ?? 0;
      result = result.slice(start, args.take === undefined ? undefined : start + args.take);
      return result.map((row) => pick(row, args.select));
    },
    async count(args: { where?: Where } = {}) {
      return rows.filter((row) => matches(row, args.where)).length;
    },
    async findUnique(args: { where: Record<string, unknown>; select?: Record<string, boolean> }) {
      const found = rows.find((row) => Object.entries(args.where).every(([key, value]) => row[key] === value));
      return found ? pick(found, args.select) : null;
    },
    async create(args: { data: Row }) {
      if (rows.some((row) => row["dedupeHash"] === args.data["dedupeHash"])) {
        throw Object.assign(new Error("Unique constraint failed"), { name: "PrismaClientKnownRequestError", code: "P2002" });
      }
      sequence += 1;
      const now = new Date();
      const row: Row = {
        id: `job_${sequence}`,
        isActive: true,
        createdAt: now,
        updatedAt: now,
        fetchedAt: now,
        ...args.data,
      };
      rows.push(row);
      return { ...row };
    },
  },
};

export function resetFakePrisma(): void {
  rows = [];
  sequence = 0;
}

export function fakePrismaRows(): Row[] {
  return rows.map((row) => ({ ...row }));
}
