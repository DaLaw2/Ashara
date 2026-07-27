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

# The gate typechecks with TS 7; typescript-eslint and tsx resolve TS 6. Both report
# zero errors today, but that is a measurement, not a guarantee — a native-port
# reimplementation may diverge from the JS compiler on some input. This runs the OTHER
# compiler so the divergence is checkable on demand instead of merely tolerated.
# Run it before a release or after a large type-level change. ~10s vs the gate's ~1.8s.
typecheck-full:
    npm run --silent typecheck:full

test:
    npx vitest run

server:
    npx tsx packages/server/src/index.ts

install:
    npm install

clean:
    rm -rf node_modules

knip:
    npx knip

build-sandbox:
    bash docker/build-sandbox.sh
