import { describe, expect, test } from "vitest";
import { CommandPolicy, defaultCommandPolicyConfig } from "./command-policy.js";

describe("CommandPolicy with allowedBinaries override", () => {
    test("docker is blocked by default", () => {
        const config = defaultCommandPolicyConfig();
        const policy = new CommandPolicy(config, "/workspace");
        const result = policy.validate("docker build .");
        expect(result.allowed).toBe(false);
    });

    test("docker is allowed when filtered out of blockedBinaries", () => {
        const config = defaultCommandPolicyConfig();
        const allowed = new Set(["docker"]);
        config.blockedBinaries = config.blockedBinaries.filter(b => !allowed.has(b));
        // docker must also be in the allowlist to pass the allowedSet check
        config.allowedCommands["containers"] = ["docker"];

        const policy = new CommandPolicy(config, "/workspace");
        const result = policy.validate("docker build .");
        expect(result.allowed).toBe(true);
    });

    test("other blocked binaries remain blocked after selective unblock", () => {
        const config = defaultCommandPolicyConfig();
        const allowed = new Set(["docker"]);
        config.blockedBinaries = config.blockedBinaries.filter(b => !allowed.has(b));
        config.allowedCommands["containers"] = ["docker"];

        const policy = new CommandPolicy(config, "/workspace");

        // sudo should still be blocked
        const sudoResult = policy.validate("sudo ls");
        expect(sudoResult.allowed).toBe(false);

        // rm should still be blocked
        const rmResult = policy.validate("rm -rf /");
        expect(rmResult.allowed).toBe(false);
    });
});
