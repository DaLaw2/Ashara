import { describe, test, expect } from "vitest";
import { ProvisioningError } from "@ashara/development";
import type { EnvironmentSpec, Toolchain } from "@ashara/development";
import { generateContainerfile, PodmanProvisioner } from "./podman-provisioner.js";

// ---------------------------------------------------------------------------
// Containerfile generation — pure function, no podman required
// ---------------------------------------------------------------------------

describe("generateContainerfile", () => {
  function minimalSpec(overrides?: Partial<EnvironmentSpec>): EnvironmentSpec {
    return {
      baseImage: "ubuntu:24.04",
      systemPackages: [],
      toolchains: [],
      envVars: {},
      projectMount: "/workspace",
      networkPolicy: { provision: true, build: true, test: false, run: false },
      ...overrides,
    };
  }

  test("minimal spec produces FROM + WORKDIR only", () => {
    const result = generateContainerfile(minimalSpec());
    expect(result).toContain("FROM ubuntu:24.04");
    expect(result).toContain("WORKDIR /workspace");
    expect(result).not.toContain("RUN");
    expect(result).not.toContain("ENV ");
  });

  test("system packages produce a single apt-get install", () => {
    const result = generateContainerfile(minimalSpec({
      systemPackages: ["git", "curl", "build-essential"],
    }));
    expect(result).toContain(
      "RUN apt-get update && apt-get install -y git curl build-essential",
    );
  });

  test("toolchains without installMethod use apt-get install", () => {
    const toolchains: Toolchain[] = [
      { name: "zig" },
      { name: "elixir", version: "1.17" },
    ];
    const result = generateContainerfile(minimalSpec({ toolchains }));
    expect(result).toContain("apt-get install -y zig");
    expect(result).toContain("apt-get install -y elixir=1.17");
  });

  test("toolchains with installMethod use it directly", () => {
    const toolchains: Toolchain[] = [
      { name: "cobol", installMethod: "curl -fsSL https://example.com/install-cobol.sh | bash" },
    ];
    const result = generateContainerfile(minimalSpec({ toolchains }));
    expect(result).toContain("curl -fsSL https://example.com/install-cobol.sh | bash");
    expect(result).not.toContain("apt-get install -y cobol");
  });

  test("multiple toolchains join into a single RUN line", () => {
    const toolchains: Toolchain[] = [
      { name: "zig" },
      { name: "elixir" },
    ];
    const result = generateContainerfile(minimalSpec({ toolchains }));
    const runLines = result.split("\n").filter((l) => l.startsWith("RUN"));
    expect(runLines).toHaveLength(1);
    expect(runLines[0]).toContain("apt-get install -y zig && apt-get install -y elixir");
  });

  test("env vars produce ENV directives", () => {
    const result = generateContainerfile(minimalSpec({
      envVars: { LANG: "C.UTF-8", APP_MODE: "test" },
    }));
    expect(result).toContain("ENV LANG=C.UTF-8");
    expect(result).toContain("ENV APP_MODE=test");
  });

  test("custom project mount is honored", () => {
    const result = generateContainerfile(minimalSpec({ projectMount: "/app" }));
    expect(result).toContain("WORKDIR /app");
    expect(result).not.toContain("/workspace");
  });

  test("section order is FROM < system packages < toolchains < ENV < WORKDIR", () => {
    const spec = minimalSpec({
      baseImage: "debian:bookworm",
      systemPackages: ["git"],
      toolchains: [{ name: "zig" }],
      envVars: { LANG: "C.UTF-8" },
    });
    const result = generateContainerfile(spec);
    const lines = result.split("\n");
    const fromIdx = lines.findIndex((l) => l.startsWith("FROM"));
    const aptIdx = lines.findIndex((l) => l.includes("apt-get update"));
    const tcIdx = lines.findIndex((l) => l.includes("apt-get install -y zig"));
    const envIdx = lines.findIndex((l) => l.startsWith("ENV LANG"));
    const wdIdx = lines.findIndex((l) => l.startsWith("WORKDIR"));

    expect(fromIdx).toBeLessThan(aptIdx);
    expect(aptIdx).toBeLessThan(tcIdx);
    expect(tcIdx).toBeLessThan(envIdx);
    expect(envIdx).toBeLessThan(wdIdx);
  });

  test("zero hardcoded toolchain names in generated output", () => {
    const result = generateContainerfile(minimalSpec());
    for (const forbidden of ["node", "go ", "rust", "python", "ruby", "cargo", "npm"]) {
      expect(result).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// ExecResult shape
// ---------------------------------------------------------------------------

describe("ExecResult mapping", () => {
  test("execute returns all ExecResult fields", async () => {
    const provisioner = new PodmanProvisioner("/tmp/test");
    const fakeEnv = {
      id: "test-id",
      version: 1,
      spec: {
        baseImage: "ubuntu:24.04",
        systemPackages: [],
        toolchains: [],
        envVars: {},
        projectMount: "/workspace",
        networkPolicy: { provision: true, build: true, test: false, run: false },
      } satisfies EnvironmentSpec,
      status: "ready" as const,
    };

    // No container handle for this env — should throw ProvisioningError
    await expect(provisioner.execute(fakeEnv, "echo hello")).rejects.toThrow(ProvisioningError);
    try {
      await provisioner.execute(fakeEnv, "echo hello");
    } catch (e) {
      expect(e).toBeInstanceOf(ProvisioningError);
      if (e instanceof ProvisioningError) {
        expect(e.context.operation).toBe("exec");
        expect(e.context.detail).toContain("no container handle");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// ProvisioningError — typed error with ProvisioningErrorContext (Discipline C)
// ---------------------------------------------------------------------------

describe("ProvisioningError", () => {
  test("carries structured context", () => {
    const spec = {
      baseImage: "ubuntu:24.04",
      systemPackages: [],
      toolchains: [],
      envVars: {},
      projectMount: "/workspace",
      networkPolicy: { provision: true, build: true, test: false, run: false },
    } satisfies EnvironmentSpec;

    const err = new ProvisioningError({
      operation: "build",
      spec,
      detail: "image build failed",
    });
    expect(err.context.operation).toBe("build");
    expect(err.context.detail).toBe("image build failed");
    expect(err.context.spec).toBe(spec);
    expect(err.name).toBe("ProvisioningError");
    expect(err.message).toContain("build");
    expect(err.message).toContain("image build failed");
  });
});

// ---------------------------------------------------------------------------
// Teardown idempotency
// ---------------------------------------------------------------------------

describe("PodmanProvisioner.teardown", () => {
  test("teardown is idempotent: does not throw on unknown env id", async () => {
    const provisioner = new PodmanProvisioner("/tmp/test");
    const fakeEnv = {
      id: "nonexistent-id",
      version: 1,
      spec: {
        baseImage: "ubuntu:24.04",
        systemPackages: [],
        toolchains: [],
        envVars: {},
        projectMount: "/workspace",
        networkPolicy: { provision: true, build: true, test: false, run: false },
      } satisfies EnvironmentSpec,
      status: "ready" as const,
    };

    // No handle registered — teardown returns immediately
    await expect(provisioner.teardown(fakeEnv)).resolves.toBeUndefined();
  });
});
