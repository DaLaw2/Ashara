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

check:
    npx tsc --noEmit

test:
    npx vitest run

lint:
    npx tsc --noEmit

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
