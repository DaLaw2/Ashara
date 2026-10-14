import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { DEFAULT_DATABASE_URL } from "./connection.js";
import { claimTargetCheckouts } from "./target-claim.js";

const databaseUrl = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;

describe("claimTargetCheckouts", () => {
  test("a second process claiming a held target refuses; the release frees it", async () => {
    const target = `/srv/ashara-claim-test/${randomUUID()}`;
    const lost: unknown[] = [];
    const first = await claimTargetCheckouts(databaseUrl, [target, `${target}-other`], (e) => lost.push(e));
    try {
      await expect(claimTargetCheckouts(databaseUrl, [`${target}-free`, target], () => {})).rejects.toMatchObject({
        name: "TargetCheckoutClaimedElsewhere",
        targetPath: target,
      });
      // The refused claimant released what it had taken before the refusal.
      const free = await claimTargetCheckouts(databaseUrl, [`${target}-free`], () => {});
      await free.release();
    } finally {
      await first.release();
    }
    const second = await claimTargetCheckouts(databaseUrl, [target], () => {});
    await second.release();
    expect(lost).toEqual([]);
  });
});
