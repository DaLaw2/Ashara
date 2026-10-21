import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { declaredTables, findTableUses, parseTableOwnershipRules } from "./table-ownership.js";

const REPO = join(import.meta.dirname, "..");
const SCHEMA = join(REPO, "packages", "db", "src", "schema");
const rules = parseTableOwnershipRules(readFileSync(join(REPO, "boundary-rules.toml"), "utf-8"), "boundary-rules.toml");
const identifiers = new Map(
  readdirSync(SCHEMA)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .flatMap((name) => declaredTables(readFileSync(join(SCHEMA, name), "utf-8"), name))
    .map((table) => [table.identifier, table.name] as const),
);

describe("findTableUses", () => {
  test("reports a drizzle write, a raw write and a raw read, a substituted table read as its name", () => {
    const source = [
      'import { sql } from "drizzle-orm";',
      "await tx.update(projectBlocks).set({ endedAt: null });",
      "await tx.insert(clientMessages).values(row);",
      "await db.execute(sql`UPDATE acceptance_sweeps s SET details = 'x' WHERE s.id = ${id}`);",
      "await db.execute(sql`SELECT count(*) FROM llm_calls c JOIN ${workGrants} g ON g.project_id = c.project_id`);",
      "const seen = new Set<string>(); seen.delete(projectId);",
      'const hint = `UPDATE model_configs SET input_cost_per_1m = 1`;',
    ].join("\n");
    expect(findTableUses(source, "probe.ts", identifiers).map((use) => [use.line, use.kind, use.table])).toEqual([
      [2, "write", "project_blocks"],
      [3, "write", "client_messages"],
      [4, "write", "acceptance_sweeps"],
      [5, "raw-read", "llm_calls"],
      [5, "raw-read", "work_grants"],
    ]);
  });

  test("reads no drizzle builder read: the import boundary keeps a table object inside its owner", () => {
    const source = [
      'import { alias } from "drizzle-orm/pg-core";',
      "await db.select({ id: acceptanceSweeps.id }).from(acceptanceSweeps).where(eq(acceptanceSweeps.blockId, id));",
      "await db.select().from(checkDisputes).innerJoin(workItems, eq(workItems.id, checkDisputes.taskId));",
      'const w = alias(workItems, "w");',
    ].join("\n");
    expect(findTableUses(source, "probe.ts", identifiers)).toEqual([]);
  });

  test("reports a raw FOR UPDATE lock as a read of the locked table", () => {
    const source = "await tx.execute(sql`SELECT id FROM work_items WHERE id = ${taskId} FOR UPDATE`);";
    expect(findTableUses(source, "probe.ts", identifiers).map((use) => [use.kind, use.table])).toEqual([["raw-read", "work_items"]]);
  });

  test("the told record kept on another context's row, as Engagement and Delivery wrote it, is a write of that row", () => {
    const blockReport = "await tx.update(projectBlocks).set(on === \"blocked\" ? { reportId } : { resumedReportId: reportId }).where(eq(projectBlocks.id, episodeId));";
    const deliveredReport = "await tx.update(acceptanceSweeps).set({ reportId: message.id }).where(eq(acceptanceSweeps.id, sweepId));";
    const planReport = "const [inserted] = await tx.insert(clientMessages).values({ projectId, direction: \"outbound\", kind: \"report\", body }).returning();";
    const owners = [blockReport, deliveredReport, planReport].map((line) => findTableUses(line, "probe.ts", identifiers).map((use) => rules.owners.get(use.table)));
    expect(owners).toEqual([["delivery"], ["quality"], ["engagement"]]);
  });
});

describe("parseTableOwnershipRules", () => {
  test("every table the schema declares has an owner", () => {
    expect([...identifiers.values()].filter((table) => !rules.owners.has(table))).toEqual([]);
  });

  test("the rules hold no exemption: every foreign read the map admits is an allowed edge with its reason", () => {
    expect(rules.edges.map((edge) => edge.id)).toEqual(["finance-model-catalog"]);
    for (const edge of rules.edges) expect(edge.reason.length).toBeGreaterThan(0);
  });

  test("refuses a missing section, a table stated twice, an edge to an unlisted table, an exemption and an unknown key", () => {
    expect(() => parseTableOwnershipRules("[shared]\nallow = []\n", "r.toml")).toThrow(/section is missing/);
    expect(() => parseTableOwnershipRules('[tables]\nprojects = "shared"\nprojects = "db"\n', "r.toml")).toThrow(/stated twice/);
    expect(() =>
      parseTableOwnershipRules('[tables]\nprojects = "shared"\nedge.a = { file = "f.ts", tables = ["llm_calls"], reason = "r" }\n', "r.toml"),
    ).toThrow(/does not list/);
    expect(() =>
      parseTableOwnershipRules('[tables]\nllm_calls = "finance"\nexempt.a = { file = "f.ts", tables = ["llm_calls"], reason = "r" }\n', "r.toml"),
    ).toThrow(/has no exemption/);
    expect(() => parseTableOwnershipRules('[tables]\nprojects = "shared"\nallow = []\n', "r.toml")).toThrow(/unrecognised key/);
  });
});
