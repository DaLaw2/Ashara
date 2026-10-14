set dotenv-load

dev:
    podman compose -f docker/postgres.yml up -d

stop:
    podman compose -f docker/postgres.yml down

db-reset:
    podman compose -f docker/postgres.yml down -v
    podman compose -f docker/postgres.yml up -d

migrate:
    npx tsx scripts/migrate.ts

# Every gate, in order, aborting on the first failure (ADR-048 decision 6).
#
# tsc is invoked by EXPLICIT PATH, never `npx tsc` (ADR-056). Two TypeScripts are
# installed: `typescript` 6.0.3 holds the peer slot every tool expects, and
# `typescript-7` is an npm alias for 7.0.2. Both link a `tsc` bin, so
# `node_modules/.bin/tsc` is whichever npm linked last — `npx tsc` names no
# particular compiler. A gate must be able to say which tool it ran.
check:
    npm run --silent typecheck
    npx tsx scripts/check-boundaries.ts
    npx knip
    npx eslint .

# The executable-claims gate. NOT in `check`, and the reason is not that it is optional:
# it scans CLAUDE.md, docs/*.md and .claude/commands/*.md, and ALL THREE ARE GITIGNORED.
# CI checks out from git, finds zero documents, and fails closed -- correctly, but it means
# CI can never run this gate while the claims live in untracked files. Making it pass on zero
# documents would be the "All 0 checks passed" defect. Run it before every commit; `just save`
# is not a substitute for the decision recorded in story `swamp-cleanup`.
check-docs:
    npx tsx scripts/check-docs.ts

# The gate typechecks with TS 7; typescript-eslint and tsx resolve TS 6. Both report
# zero errors today, but that is a measurement, not a guarantee — a native-port
# reimplementation may diverge from the JS compiler on some input. This runs the OTHER
# compiler so the divergence is checkable on demand instead of merely tolerated.
# Run it before a release or after a large type-level change. ~10s vs the gate's ~1.8s.
typecheck-full:
    npm run --silent typecheck:full

test:
    npx vitest run

# Secret scan. Deliberately NOT part of `just check`: it calls the GitGuardian API,
# and a gate that needs the network is a gate that fails for the wrong reason.
#
# Enforcement is automatic in two other places — the `.git/hooks/pre-commit` hook
# (`ggshield install --mode local`) and the CI workflow, which fails closed when
# GITGUARDIAN_API_KEY is absent. This recipe is for scanning on demand, e.g. before
# a force-push or after a history rewrite.
#
# Known limitation, measured 2026-07-27 rather than assumed: the hook caught a
# short lowercase password in a POSTGRES_PASSWORD field and a `ghp_` token, and did
# NOT catch an invented password of similar shape in that same field. It is a net
# with holes, not a proof of absence.
#
# Second lesson from the same run: writing the offending value into a comment to
# document the incident re-creates the secret. Both this file and the CI workflow
# tripped the scanner that way. Describe the shape, never quote the value.
secrets:
    ggshield secret scan repo .

server:
    npx tsx packages/server/src/index.ts

# The roadmap's M2 exit 6 probes from inside real cells (W9): resource caps, a credential read, an
# outbound host and an environment-file write without the grant, one verdict each; exits non-zero
# unless every probe held. Needs ASHARA_CELL_MEMORY, ASHARA_CELL_CPUS and ASHARA_CELL_PIDS_LIMIT
# (config/env.example). `just probes --image <ref>` probes that environment image instead of the BaseCell.
probes *ARGS:
    npx tsx scripts/probes.ts {{ARGS}}

# One project's run evidence (roadmap M2 exit 7): attempts, cost coverage, cache-hit share. Read-only.
run-report project:
    npx tsx scripts/run-report.ts {{project}}

install:
    npm install

knip:
    npx knip
