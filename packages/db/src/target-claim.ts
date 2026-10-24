import pg from "pg";
import { z } from "zod";
import { describeErrorChain } from "@ashara/shared";

/**
 * Another session holds the claim on a target checkout: a second Ashara process drives it. The
 * checkout lock that serialises finalizes is in-process only (development's withTargetCheckout),
 * so two processes on one checkout would abort each other's tentative merges.
 */
export class TargetCheckoutClaimedElsewhere extends Error {
  constructor(
    readonly targetPath: string,
    readonly claimKey: string,
  ) {
    super(
      `the target checkout ${targetPath} is claimed by another Ashara process (advisory lock on hashtextextended('${claimKey}', 0)); ` +
        "one process drives a target, so this one refuses to start",
    );
    this.name = "TargetCheckoutClaimedElsewhere";
  }
}

/** The claims' session ended while the process still ran: no claim is held any longer. */
class TargetCheckoutClaimLost extends Error {
  constructor(
    readonly targetPaths: readonly string[],
    options: { readonly cause: unknown },
  ) {
    super(`the database session holding the claims on ${targetPaths.join(", ")} ended: ${describeErrorChain(options.cause)}`, { cause: options.cause });
    this.name = "TargetCheckoutClaimLost";
  }
}

export interface TargetCheckoutClaims {
  /** Ends the claims' session, which releases every claim. */
  release(): Promise<void>;
}

const ClaimRowSchema = z.object({ claimed: z.boolean() });

function claimKey(targetPath: string): string {
  return `ashara.target_checkout/${targetPath}`;
}

/**
 * Claims each target checkout for this process's lifetime: a session-level advisory lock per
 * canonical path, on one dedicated connection, released when it ends. A path another session
 * holds refuses with TargetCheckoutClaimedElsewhere and releases what was claimed. `onLost` is
 * called once if the session ends before release(): the claims are gone, and the caller stops
 * driving the targets (fail closed) rather than run on unclaimed checkouts.
 */
export async function claimTargetCheckouts(
  databaseUrl: string,
  canonicalTargetPaths: readonly string[],
  onLost: (lost: TargetCheckoutClaimLost) => void,
): Promise<TargetCheckoutClaims> {
  const paths = [...new Set(canonicalTargetPaths)];
  const client = new pg.Client({ connectionString: databaseUrl });
  let released = false;
  let lostReported = false;
  const lose = (cause: unknown): void => {
    if (released || lostReported) return;
    lostReported = true;
    onLost(new TargetCheckoutClaimLost(paths, { cause }));
  };
  client.on("error", (err: Error) => lose(err));
  client.on("end", () => lose("the connection closed"));
  await client.connect();
  try {
    for (const path of paths) {
      const result = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS claimed", [claimKey(path)]);
      const [row] = z.tuple([ClaimRowSchema]).parse(result.rows);
      if (!row.claimed) throw new TargetCheckoutClaimedElsewhere(path, claimKey(path));
    }
  } catch (e) {
    released = true;
    await client.end().catch((endError: unknown) => {
      console.warn(`[target-claim] ending the claims' session after a refused claim failed: ${describeErrorChain(endError)}`);
    });
    throw e;
  }
  return {
    async release() {
      if (released) return;
      released = true;
      await client.end();
    },
  };
}
