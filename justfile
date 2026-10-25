set dotenv-load

dev:
    podman compose -f docker/postgres.yml up -d

stop:
    podman compose -f docker/postgres.yml down

db-reset:
    podman compose -f docker/postgres.yml down -v
    podman compose -f docker/postgres.yml up -d

# The test Postgres every test and the simulator use (resolveTestDatabaseUrl, default 127.0.0.1:5433):
# its data is tmpfs with fsync off, so scratch databases write nothing to disk, and stopping it
# discards them. The shared database above stays where it is.
test-db-up:
    podman compose -f docker/postgres-test.yml up -d

test-db-down:
    podman compose -f docker/postgres-test.yml down

# Fails closed, naming `just test-db-up`, when the test Postgres does not answer; then migrates it,
# since it starts empty.
_test-db-ready:
    timeout 120 npx tsx scripts/test-db-ready.ts

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

# Known advisories against the locked dependency tree, dev toolchain included; any severity fails.
# NOT in `check`: the verdict comes from the registry's advisory database, not from the tree, so
# it can turn red on an unchanged commit the day an advisory is published, and it needs the network.
# Run it before every commit that touches package.json or package-lock.json; CI runs it on every push.
audit:
    npm audit --audit-level=low

# The gate typechecks with TS 7; typescript-eslint and tsx resolve TS 6. Agreement between
# them is a measurement, not a guarantee — a native-port
# reimplementation may diverge from the JS compiler on some input. This runs the OTHER
# compiler so the divergence is checkable on demand instead of merely tolerated.
# Run it before a release or after a large type-level change; it is slower than the gate.
typecheck-full:
    npm run --silent typecheck:full

# Pulls every pinned image a test run needs: the BaseCell and packages/integration/test-images.json.
# A test run never pulls; its globalSetup stops it before any test when one is absent and names this.
# On a host with /data the images go into the test image store (config/podman-test-images.conf),
# which every test run there reads, and podman's default store is left as it is.
test-images:
    timeout 1200 npx tsx packages/integration/src/test-images-pull.ts

# The whole suite, or the files its vitest arguments filter, bounded by a wall time derived from the
# files vitest selects and the workers it runs them on (scripts/test-run.ts states the rule and the
# stop past it); a run cut off by its bound exits 124 naming the bound and every test file it did not finish.
# Example: just test
#          just test -- --maxWorkers=2
#          just test -- scripts/test-run
test *ARGS: _test-db-ready
    #!/usr/bin/env bash
    set -u
    # Every temp file goes under the scratch root (scripts/scratch-root.ts: a tmpfs unless
    # ASHARA_SCRATCH_ROOT names another), or the recipe stops naming why it cannot. The podman
    # store follows vitest.config.mts (useTestPodmanStore), so a direct `npx vitest` gets it too.
    scratch=$(node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/scratch-root.ts) || exit 1
    export TMPDIR="$scratch"
    exec npx tsx scripts/test-run.ts {{ARGS}}

# Runs only the test files a change against <base> can affect (scripts/affected-tests.ts states the
# selection rules and their blind spots); `just test` stays the full suite the merge lane runs.
# Every selected test file runs, however many: no bound trims the selection, and a large one says so.
# Example: just test-affected origin/master --list
#          just test-affected origin/master -- --maxWorkers=2
# Bounded as `test` is, by a wall time derived from the selection and the workers it runs on, so a
# whole-suite selection gets the whole suite's bound. `--list` runs no test, so it needs no test
# database.
test-affected base *ARGS:
    #!/usr/bin/env bash
    set -u
    listing=0
    for arg in {{ARGS}}; do
      [ "$arg" = "--" ] && break
      [ "$arg" = "--list" ] && listing=1
    done
    if [ "$listing" = 0 ]; then just _test-db-ready || exit 1; fi
    # Every temp file goes under the scratch root (scripts/scratch-root.ts: a tmpfs unless
    # ASHARA_SCRATCH_ROOT names another), or the recipe stops naming why it cannot.
    scratch=$(node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/scratch-root.ts) || exit 1
    export TMPDIR="$scratch"
    exec npx tsx scripts/affected-tests.ts {{base}} {{ARGS}}

# The lifecycle simulator's soak tier: consecutive seeds, each
# on its own scratch database `ashara_sim_*` on the server of SIM_DATABASE_URL (default the test
# Postgres, never DATABASE_URL; it fails closed naming `just test-db-up` when that is down), run by
# `--jobs J` worker processes at once (default: the host's cores, at most 16;
# at most 20; `--jobs 1` runs them in one process). Output and exit code are the serial run's, each
# seed's lines in seed order. A soak of at least 80 seeds also reruns its project count's second
# determinism seed (6 at one project, 59 at two) in one process and fails on a trace that differs.
# Bounded: at most 500 seeds, 120 cycles and 120 s per seed.
# Example: just simulate --seeds 50 --start 100 --minimize
simulate *ARGS:
    #!/usr/bin/env bash
    set -u
    # Every temp file goes under the scratch root (scripts/scratch-root.ts: a tmpfs unless
    # ASHARA_SCRATCH_ROOT names another), or the recipe stops naming why it cannot.
    scratch=$(node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/scratch-root.ts) || exit 1
    export TMPDIR="$scratch"
    exec choom -n 1000 -- npx tsx scripts/simulate.ts {{ARGS}}

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
# own directories, so a tool writing inside one writes there. Also links the gitignored records
# (docs/, CLAUDE.md, .claude/commands/; a worktree has none) to the main checkout's, so
# `just check-docs` runs there; the links are shared, so a write under one writes the main
# checkout's records, and an existing record path that is not that link is refused. Plain node, not
# tsx: the worktree has no node_modules to load tsx from yet.
# Example: just worktree-setup .claude/worktrees/<name>
worktree-setup dir:
    node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/worktree-setup.ts {{dir}}

install:
    npm install

knip:
    npx knip
