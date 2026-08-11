import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type {
  Provisioner,
  EnvironmentSpec,
  ProvisionedEnv,
  EnvChangeDelta,
  ExecResult,
  ExecOptions,
} from "@ashara/development";
import { ProvisioningError, TeardownError } from "@ashara/development";
import { validateContainerfileSpec } from "./containerfile-validation.js";

// ---------------------------------------------------------------------------
// Containerfile generation
// ---------------------------------------------------------------------------

export function generateContainerfile(spec: EnvironmentSpec): string {
  const lines: string[] = [`FROM ${spec.baseImage}`];

  // System packages: each entry is a full install command from the LLM
  for (const cmd of spec.systemPackages) {
    lines.push(`RUN ${cmd}`);
  }

  // Toolchains: each carries its own installMethod — the provisioner does not
  // know which package manager the base image uses (Target Generality).
  for (const tc of spec.toolchains) {
    if (tc.installMethod) {
      lines.push(`RUN ${tc.installMethod}`);
    }
  }

  for (const [key, value] of Object.entries(spec.envVars)) {
    lines.push(`ENV ${key}=${value}`);
  }

  lines.push(`WORKDIR ${spec.projectMount}`);

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Runtime state for a provisioned container (keyed by env.id)
// ---------------------------------------------------------------------------

interface ContainerHandle {
  readonly containerName: string;
  readonly imageTag: string;
}

// ---------------------------------------------------------------------------
// PodmanProvisioner
// ---------------------------------------------------------------------------

export class PodmanProvisioner implements Provisioner {
  private readonly hostWorkDir: string;
  private readonly handles = new Map<string, ContainerHandle>();

  constructor(hostWorkDir: string) {
    this.hostWorkDir = hostWorkDir;
  }

  async provision(spec: EnvironmentSpec): Promise<ProvisionedEnv> {
    // Validate LLM-derived content before interpolation (Discipline A: fail-closed)
    validateContainerfileSpec(spec);

    const envId = randomUUID().slice(0, 12);
    const containerName = `ashara-env-${envId}`;
    const imageTag = `ashara-provisioned-${envId}`;

    const containerfile = generateContainerfile(spec);
    const buildDir = await mkdtemp(join(tmpdir(), "ashara-build-"));
    try {
      const containerfilePath = join(buildDir, "Containerfile");
      await writeFile(containerfilePath, containerfile);
      await podmanBuild(imageTag, containerfilePath, buildDir, spec);
    } finally {
      await rm(buildDir, { recursive: true, force: true });
    }

    await podmanRun(containerName, imageTag, spec, this.hostWorkDir);
    this.handles.set(envId, { containerName, imageTag });

    return {
      id: envId,
      version: 1,
      spec,
      status: "ready",
    };
  }

  activeContainerName(): string | undefined {
    for (const handle of this.handles.values()) {
      return handle.containerName;
    }
    return undefined;
  }

  async update(env: ProvisionedEnv, delta: EnvChangeDelta): Promise<ProvisionedEnv> {
    const newSpec = applyDelta(env.spec, delta);
    await this.teardown(env);
    const newEnv = await this.provision(newSpec);
    return { ...newEnv, version: env.version + 1 };
  }

  async execute(env: ProvisionedEnv, command: string[], opts?: ExecOptions): Promise<ExecResult> {
    const handle = this.handles.get(env.id);
    if (!handle) {
      throw new ProvisioningError({
        operation: "exec",
        spec: env.spec,
        detail: `no container handle for env ${env.id} — provision() not called or already torn down`,
      });
    }

    const timeout = opts?.timeout ?? 30_000;
    const execArgs = ["exec"];
    if (opts?.cwd) {
      execArgs.push("-w", opts.cwd);
    }
    if (opts?.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        execArgs.push("-e", `${k}=${v}`);
      }
    }
    execArgs.push(handle.containerName, ...command);

    return new Promise<ExecResult>((resolve, reject) => {
      const proc = spawn("podman", execArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let killed = false;
      const timer = setTimeout(() => { killed = true; proc.kill(); }, timeout);
      let stdout = "";
      let stderr = "";
      proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.on("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (err.code === "ENOENT") {
          reject(new ProvisioningError({
            operation: "exec",
            spec: env.spec,
            detail: "podman binary not found on PATH",
          }));
        } else {
          reject(new ProvisioningError({
            operation: "exec",
            spec: env.spec,
            detail: `podman exec error: ${err.message}`,
          }));
        }
      });

      proc.on("close", (exitCode) => {
        clearTimeout(timer);
        resolve({
          exitCode: killed ? null : (exitCode ?? 1),
          stdout,
          stderr,
          timedOut: killed,
        });
      });
    });
  }

  async teardown(env: ProvisionedEnv): Promise<void> {
    const handle = this.handles.get(env.id);
    if (!handle) return;

    try {
      await podmanExecSimple(["stop", "--time", "5", handle.containerName]);
      await podmanExecSimple(["rm", "-f", handle.containerName]);
      await podmanExecSimple(["rmi", "-f", handle.imageTag]);
    } catch (e) {
      throw new TeardownError({
        envId: env.id,
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      this.handles.delete(env.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Delta application
// ---------------------------------------------------------------------------

function applyDelta(spec: EnvironmentSpec, delta: EnvChangeDelta): EnvironmentSpec {
  const req = delta.request;
  switch (req.kind) {
    case "add_toolchain":
      return { ...spec, toolchains: [...spec.toolchains, req.detail] };
    case "add_package":
      return { ...spec, systemPackages: [...spec.systemPackages, req.detail] };
    case "set_env":
      return { ...spec, envVars: { ...spec.envVars, ...req.detail } };
    case "change_network":
      return { ...spec, networkPolicy: { ...spec.networkPolicy, ...req.detail } };
  }
}

// ---------------------------------------------------------------------------
// Podman subprocess helpers
// ---------------------------------------------------------------------------

function podmanBuild(
  tag: string,
  containerfilePath: string,
  contextDir: string,
  spec: EnvironmentSpec,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn("podman", [
      "build",
      "-t", tag,
      "-f", containerfilePath,
      contextDir,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new ProvisioningError({
          operation: "build",
          spec,
          detail: "podman binary not found on PATH",
        }));
      } else {
        reject(new ProvisioningError({
          operation: "build",
          spec,
          detail: `podman build error: ${err.message}`,
        }));
      }
    });

    proc.on("close", (exitCode) => {
      if (exitCode !== 0) {
        reject(new ProvisioningError({
          operation: "build",
          spec,
          detail: stderr.trim().slice(0, 500) || `build failed with exit code ${exitCode}`,
        }));
      } else {
        resolve();
      }
    });
  });
}

function podmanRun(
  containerName: string,
  imageTag: string,
  spec: EnvironmentSpec,
  hostWorkDir: string,
): Promise<void> {
  const resolvedWork = resolve(hostWorkDir);
  // Per-command network control via podman exec is not supported.
  // The container is created with network access for provisioning.
  // Container-level isolation is the boundary; per-phase gating is deferred.
  const args = [
    "run", "-d",
    "--name", containerName,
    "--userns=keep-id",
    "-v", `${resolvedWork}:${spec.projectMount}:z`,
    "-w", spec.projectMount,
    imageTag,
    "sleep", "infinity",
  ];

  return new Promise<void>((resolve, reject) => {
    const proc = spawn("podman", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new ProvisioningError({
          operation: "start",
          spec,
          detail: "podman binary not found on PATH",
        }));
      } else {
        reject(new ProvisioningError({
          operation: "start",
          spec,
          detail: `podman run error: ${err.message}`,
        }));
      }
    });

    proc.on("close", (exitCode) => {
      if (exitCode !== 0) {
        reject(new ProvisioningError({
          operation: "start",
          spec,
          detail: stderr.trim().slice(0, 500) || `container start failed with exit code ${exitCode}`,
        }));
      } else {
        resolve();
      }
    });
  });
}

function podmanExecSimple(args: string[]): Promise<void> {
  return new Promise<void>((resolve) => {
    const proc = spawn("podman", args, { stdio: ["ignore", "pipe", "pipe"] });
    proc.on("error", () => resolve());
    proc.on("close", () => resolve());
  });
}
