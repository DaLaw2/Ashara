set dotenv-load

dev:
    podman compose -f docker/postgres.yml up -d

stop:
    podman compose -f docker/postgres.yml down

db-reset:
    podman compose -f docker/postgres.yml down -v
    podman compose -f docker/postgres.yml up -d

migrate:
    podman exec docker_postgres_1 psql -U ashara -d ashara -f /dev/stdin < migrations/001_initial.sql

# Every gate, in order, aborting on the first failure (ADR-048 decision 6).
check:
    npx tsc --noEmit
    npx tsx scripts/check-boundaries.ts
    npx knip
    npx eslint .

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
