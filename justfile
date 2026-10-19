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

# Every gate, in order, aborting on the first failure.
#
# tsc is invoked by EXPLICIT PATH, never `npx tsc`. Two TypeScripts are
# installed: `typescript` 6.0.3 holds the peer slot every tool expects, and
# `typescript-7` is an npm alias for 7.0.2. Both link a `tsc` bin, so
# `node_modules/.bin/tsc` is whichever npm linked last — `npx tsc` names no
# particular compiler. A gate must be able to say which tool it ran.
check:
    npm run --silent typecheck
    npx tsx scripts/check-boundaries.ts
    npx tsx scripts/check-comments.ts
    npx knip
    npx eslint .

# The executable-claims gate. NOT in `check`, and the reason is not that it is optional:
# it scans CLAUDE.md, .claude/commands/ and docs/ (and checks the investigations' retention),
# and ALL OF THEM ARE GITIGNORED.
# CI checks out from git, finds zero documents, and fails closed -- correctly, but it means
# CI can never run this gate while the claims live in untracked files. Making it pass on zero
# documents would be the "All 0 checks passed" defect. Run it before every commit; `just save`
# is not a substitute.
check-docs:
    npx tsx scripts/check-docs.ts

# The gate typechecks with TS 7; typescript-eslint and tsx resolve TS 6. Agreement between
# them is a measurement, not a guarantee — a native-port
# reimplementation may diverge from the JS compiler on some input. This runs the OTHER
# compiler so the divergence is checkable on demand instead of merely tolerated.
# Run it before a release or after a large type-level change; it is slower than the gate.
typecheck-full:
    npm run --silent typecheck:full

# Pulls every pinned image a test run needs: the BaseCell and packages/integration/test-images.json.
# A test run never pulls; its globalSetup stops it before any test when one is absent and names this.
test-images:
    timeout 1200 npx tsx packages/integration/src/test-images-pull.ts

# Bounded: SIGTERM after 20 minutes, which the cell-leak guard (vitest.config.ts globalSetup)
# answers by removing the run's cells before vitest exits; SIGKILL only if the run is still alive
# 150 s later. That grace outlasts the guard's signal-time removal at its worst, one podman listing
# and one podman rm of 60 s each (cell-leak-guard.ts PODMAN_TIMEOUT_MS): a SIGKILL inside it would
# cut the listing short and leave the cells to the next run's reaper.
#
# timeout runs vitest in a process group of its own, which a terminal's Ctrl+C does not reach, so
# this shell forwards SIGINT, SIGTERM and SIGHUP to that group (to timeout itself if it has not made
# the group yet) and waits for it to end. `timeout --foreground` would let Ctrl+C through, but on
# expiry it signals vitest alone and leaves its forks workers running.
test:
    #!/usr/bin/env bash
    set -u
    timeout -k 150 1200 npx vitest run &
    run=$!
    trap 'kill -INT -- "-$run" 2>/dev/null || kill -INT "$run"' INT
    trap 'kill -TERM -- "-$run" 2>/dev/null || kill -TERM "$run"' TERM HUP
    while :; do
      wait "$run"
      status=$?
      kill -0 "$run" 2>/dev/null || exit "$status"
    done

# Runs only the test files a change against <base> can affect (scripts/affected-tests.ts states the
# selection rules and their blind spots); `just test` stays the full suite the merge lane runs.
# Example: just test-affected origin/master --list
#          just test-affected origin/master -- --maxWorkers=2
# Bounded and signal-forwarding exactly as `test` is, for the same reasons.
test-affected base *ARGS:
    #!/usr/bin/env bash
    set -u
    timeout -k 150 1200 npx tsx scripts/affected-tests.ts {{base}} {{ARGS}} &
    run=$!
    trap 'kill -INT -- "-$run" 2>/dev/null || kill -INT "$run"' INT
    trap 'kill -TERM -- "-$run" 2>/dev/null || kill -TERM "$run"' TERM HUP
    while :; do
      wait "$run"
      status=$?
      kill -0 "$run" 2>/dev/null || exit "$status"
    done

# The lifecycle simulator's soak tier: consecutive seeds, each
# on its own scratch database `ashara_sim_*` on the server of SIM_DATABASE_URL (default
# DATABASE_URL), run by `--jobs J` worker processes at once (default: the host's cores, at most 16;
# at most 20; `--jobs 1` runs them in one process). Output and exit code are the serial run's, each
# seed's lines in seed order. A soak of at least 80 seeds also reruns its project count's second
# determinism seed (6 at one project, 59 at two) in one process and fails on a trace that differs.
# Bounded: at most 500 seeds, 120 cycles and 120 s per seed.
# Example: just simulate --seeds 50 --start 100 --minimize
simulate *ARGS:
    choom -n 1000 -- npx tsx scripts/simulate.ts {{ARGS}}

# Secret scan. Deliberately NOT part of `just check`: it calls the GitGuardian API,
# and a gate that needs the network is a gate that fails for the wrong reason.
#
# Enforcement is automatic in two other places — the `.git/hooks/pre-commit` hook
# (`ggshield install --mode local`) and the CI workflow, which fails closed when
# GITGUARDIAN_API_KEY is absent on a push or a same-repository pull request (a fork's pull
# request gets no secrets, so there it skips with a notice). This recipe is for scanning on demand, e.g. before
# a force-push or after a history rewrite.
#
# Known limitation: the scanner recognises known secret shapes and can miss an
# invented password of ordinary shape. It is a net with holes, not a proof of absence.
#
# Writing a secret's value into a comment to document it re-creates the secret.
# Describe the shape, never quote the value.
secrets:
    ggshield secret scan repo .

server:
    npx tsx packages/server/src/index.ts

# The isolation probes from inside real cells: resource caps, a credential read, an
# outbound host and an environment-file write without the grant, one verdict each; exits non-zero
# unless every probe held. Needs ASHARA_CELL_MEMORY, ASHARA_CELL_CPUS and ASHARA_CELL_PIDS_LIMIT
# (config/env.example). `just probes --image <ref>` probes that environment image instead of the BaseCell.
probes *ARGS:
    npx tsx scripts/probes.ts {{ARGS}}

# One project's run evidence: attempts, cost coverage, cache-hit share, and Ashara's verdict beside the hidden
# suite's. Read-only. `just run-report <id> --hidden <verdict.json> --run <label>` adds the hidden verdict and the
# run's tender pick (pool from --pool or ASHARA_TENDER_POOL).
run-report project *ARGS:
    npx tsx scripts/run-report.ts {{project}} {{ARGS}}

# Picks a real run's tender from the pool (fewest recorded runs, ties drawn by sha256 of run label and commit) and
# appends the pick to the pool's ledger. The pool directory is --pool or ASHARA_TENDER_POOL, never a path in this
# repository. Example:
#   just pool-select --run <label> --commit "$(git rev-parse HEAD)" [--pin <tender id> --reason <text>]
pool-select *ARGS:
    npx tsx scripts/pool-select.ts {{ARGS}}

# A hidden acceptance suite run against a delivered product in its environment image, in one capped cell with no
# network; the suite's directory is an argument, never a path in this repository. scripts/hidden-suite.ts states the
# arguments and how each guarantee is judged. Example:
#   just hidden-suite --suite <dir> --product <dir> --image <ref> --out <verdict.json> --timeout 1200 -- --cmd {product}/<executable>
hidden-suite *ARGS:
    npx tsx scripts/hidden-suite.ts {{ARGS}}

# Makes a git worktree's node_modules usable offline in seconds, from the main checkout's install:
# external packages are linked to it, workspace packages (@ashara/*) to the worktree's own. Refuses,
# naming npm ci, when the main checkout has no node_modules, its package-lock.json differs, or its
# installed tree does not match its own package-lock.json. External packages are the main checkout's
# own directories, so a tool writing inside one writes there. Plain node, not tsx: the worktree has
# no node_modules to load tsx from yet.
# Example: just worktree-setup .claude/worktrees/<name>
worktree-setup dir:
    node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/worktree-setup.ts {{dir}}

install:
    npm install

knip:
    npx knip
