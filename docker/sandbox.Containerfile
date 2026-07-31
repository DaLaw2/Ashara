# Agent sandbox: the environment task-agents execute in.
# Carries the toolchains proven on this host (Node 22, Go 1.26, Rust 1.95)
# so moving agent execution into a container does not regress capability.
#
# Declarative per-project provisioning (roadmap P0 #6) replaces this
# with contract-driven images; until then this is the static baseline.

# --- Pin: node:22.22.1-bookworm-slim, pulled 2026-07-27 ---
FROM docker.io/library/node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS base

# Build-essential + git: the minimum a project build needs.
# procps: node child_process.spawn needs /proc.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      git \
      curl \
      ca-certificates \
      procps \
 && rm -rf /var/lib/apt/lists/*

# --- Go 1.26.5 (matches host) ---
ARG GO_VERSION=1.26.5
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" \
      -o /tmp/go.tar.gz \
 && tar -C /usr/local -xzf /tmp/go.tar.gz \
 && rm /tmp/go.tar.gz
ENV PATH="/usr/local/go/bin:${PATH}"

# --- Rust 1.95.0 (matches host) ---
# Install to a shared location so any uid can use it.
ENV RUSTUP_HOME="/usr/local/rustup" \
    CARGO_HOME="/usr/local/cargo"
RUN curl -fsSL https://sh.rustup.rs \
      | sh -s -- -y --default-toolchain 1.95.0 --profile minimal --no-modify-path \
 && chmod -R a+rX /usr/local/rustup /usr/local/cargo
ENV PATH="/usr/local/cargo/bin:${PATH}"

# Writable directories the agent process needs at runtime.
# npm/npx cache, tsx transform cache.
# These survive as anonymous volumes or are overridden by the spawn task.
# Go and Cargo caches are redirected under /workspace at runtime (see
# containerizedRunCommand in packages/development/src/check-runner.ts) since
# /workspace is the only mount shared between the prepare and check
# containers — anything outside it is destroyed when a container exits.
RUN mkdir -p /tmp/npm-cache /tmp/tsx-cache \
 && chmod 1777 /tmp/npm-cache /tmp/tsx-cache
ENV npm_config_cache="/tmp/npm-cache" \
    TSX_CACHE="/tmp/tsx-cache"

# No USER directive — rootless podman maps the caller's uid via
# --userns=keep-id, so the container process already runs as that uid.
# A hardcoded USER would fight the mapping.

WORKDIR /workspace
