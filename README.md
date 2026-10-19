# Ashara

**Describe the software you want. Ashara's team of AI agents builds it, tests it, and tells you honestly how it
went.**

You act as the client. Ashara acts as a contractor. You send it a description of the product you want, answer a few
questions, and receive progress reports and a delivered report at the end. You never manage the agents yourself.

> **Pre-alpha.** It works end to end on small and medium projects, but expect rough edges. See
> [Limitations](#limitations).

## What it has built

Two recent projects, delivered from the same version of Ashara with no change in between:

| Request | Stack Ashara chose | Result | Time | Model cost |
|---|---|---|---|---|
| A key-value store with a write-ahead log, crash recovery and concurrent access | Rust | Delivered, all checks passing | 12 min | $1.22 |
| A team task-board web app with boards, tasks and an HTML page | Python + SQLite | Delivered, all checks passing | 45 min | $1.48 |

Both products survived a hard kill and restart with their data intact, and rejected bad input with clear errors.

## How a project goes

1. **You send a request** through the web client, in your own words. You don't need to name a language or framework.
2. **Ashara asks a few questions** (at most five) about what it can't safely assume. It doesn't wait for your answers
   before it starts. Where you haven't answered yet, it states its assumption, and adjusts when your answer arrives.
3. **It forms a team for your project.** The team includes someone who sets up the build environment for the stack it
   chose, developers, and separate authors of the tests.
4. **It builds in small, checked steps.** A piece of work is accepted only after it passes tests written by someone
   other than its developer.
5. **It reports to you** when something blocks it and when the product is delivered. Each report says what was built,
   what was checked, what was assumed, and what it cost.
6. **You decide when to stop.** Ashara never refuses your request and never quits on its own. It stops only when you
   tell it to, or when it reaches the spending limit you set.

## What you can rely on

- **Tests by someone else.** No agent grades its own work.
- **Honest reports.** If something failed or was skipped, the report says so in plain words.
- **A hard spending limit.** Every model call is recorded with its cost, and the limit you set is enforced before
  each call.
- **Isolation.** Agents run every command in a sealed container with no network and no access to your keys. These
  guarantees are tested by probes that try to break them.
- **Any stack.** Ashara has no built-in list of languages. The environment for each project is written as part of
  the project.

## Design principles

**A contractor, not a tool.** You are the client and Ashara is the firm you hired. It does not stop working because
you haven't replied. It may push back and tell you what a decision costs, but it does not refuse you. Within the firm,
work is divided the way a good real-world firm divides it: someone takes the client's requests, someone plans, someone
builds, and someone else checks.

**Nobody grades their own work.** Every check that decides whether work is accepted is written and run by someone
other than the developer who did the work. Independent verification is the core of the system, not a final step
added at the end.

**Honesty over a good-looking result.** A report states what was built, what was checked, what was assumed and what
it cost. A failure is reported as a failure. A step that could not be verified is never counted as passed.

**When in doubt, stop.** Every check fails safe. Missing information is treated as unknown, never as fine. An
unreachable service blocks the work rather than letting it through. A step that cannot be verified does not count as
passed.

**Code where possible, models where necessary.** Scheduling, dependencies, merging, spending limits and the project
lifecycle are ordinary deterministic code. Language models do only what needs judgment: talking with you, planning,
writing code and writing tests.

**Safety is structural.** Agents cannot reach the network, the host or your keys. This is not because they are
asked not to: the container they work in has none of those.

**No favourite stack.** Ashara contains no list of languages or frameworks. Each project's build environment is
written by the team as part of the project, so a PHP, Rust or embedded project needs no change to Ashara.

**Predictable cost.** Every model call is priced and recorded. The spending limit is checked before each call, not
after the money is gone.

## Getting started

You need:

- Node.js 24 with npm (the version CI runs; `.nvmrc` names it).
- [just](https://github.com/casey/just).
- podman, plus a compose provider for `podman compose` (podman-compose or docker-compose), which `just dev` uses
  to start the database. The full test suite, real containers included, passes on podman 4.9.3 and podman 5.8.2.
- An API key for Anthropic (Claude) and/or DeepSeek.

```bash
just install                  # install dependencies
just dev                      # start the database (in a container)
just migrate                  # set up the database

# Every `just` recipe reads a .env file at the repository root. The example sets the resource caps
# of the containers agents work in, which Ashara requires; adjust them to your machine.
cp config/env.example .env

npx tsx scripts/secret-key-init.ts        # create the key that encrypts stored secrets

# Store your model provider key. You'll be prompted to paste it; it is never shown or logged.
read -rs K && printf '%s' "$K" | npx tsx scripts/secret.ts put provider/anthropic/api_key

# Store the token the server's API requires: any long random string, such as `openssl rand -base64 24`.
read -rs T && printf '%s' "$T" | npx tsx scripts/secret.ts put server/api_token

# Create your client login. Type an access code of your choice, at least 20 characters, at the prompt.
read -rs C && printf '%s' "$C" | npx tsx scripts/client.ts add "Your Name"

# Start Ashara with a spending limit, in US dollars, and a folder to keep projects in.
ASHARA_BUDGET_LIMIT_USD=5 WORKDIR_BASE=~/ashara-work just server
```

Open http://localhost:3000, sign in with your access code, and send your request. `http://localhost:3000/health`
answers `ok` once the server is up.

**Useful settings:**

| Variable | Purpose |
|---|---|
| `ASHARA_BUDGET_LIMIT_USD` | Required. The most Ashara may spend on model calls. |
| `ASHARA_CELL_MEMORY` | Required. The memory cap of each container an agent works in, such as `4g`. |
| `ASHARA_CELL_CPUS` | Required. The CPU cap of each such container, such as `4`. |
| `ASHARA_CELL_PIDS_LIMIT` | Required. The most processes one such container may hold, such as `1024`. |
| `ASHARA_PROJECT_BUDGET_LIMIT_USD` | Optional. A smaller limit for each project. |
| `ASHARA_TASK_WORK_BUDGET_REQUESTS` | Optional. The most model requests one task may make (default 60); past it the task is given up. |
| `ASHARA_PROJECT_WORK_BUDGET_REQUESTS` | Optional. The most model requests one project may make (default 600); past it the project pauses until you grant more with `npx tsx scripts/project.ts grant`. |
| `ASHARA_WORK_RESERVE_PERCENT` | Optional. The share of each project's request budget, a whole percent from 0 to 99 (default 25), that only verification and acceptance may draw; planning, check authoring, review and implementation pause the project when only this share is left. |
| `ASHARA_PORT` | The web client's port (default 3000). A value that is not a port stops Ashara from starting. |
| `WORKDIR_BASE` | Required. Where projects are kept. Ashara will not start without it. |
| `DATABASE_URL` | Optional. The database to use (default `postgresql://ashara@localhost:5432/ashara`, the one `just dev` starts). |
| `TEST_DATABASE_URL` | Optional, for contributors. The database tests use (default `postgresql://ashara@localhost:5433/ashara`, the test Postgres `just test-db-up` starts). Tests never read `DATABASE_URL`, and a URL naming the shared database is refused. |
| `SIM_DATABASE_URL` | Optional, for contributors. The server `just simulate` creates its scratch databases on (default the one `TEST_DATABASE_URL` resolves to); a URL naming the shared database is refused. |
| `ASHARA_SECRET_KEY_FILE` | Optional. Where the key that encrypts stored secrets is kept (default `~/.config/ashara/secret.key`). |

Any of these can go in `.env` instead of on the command line; `config/env.example` explains the container
caps. Each project is a git repository under `WORKDIR_BASE/projects/`; the delivered product is on its `main` branch.
Model choices are in `config/models.toml`.

## Limitations

- **Projects are planned as a single stage.** Ashara does not yet grow a project in phases, so larger products need
  several requests.
- **It does not yet act on a change of direction mid-project.** A change request you send while it is working is
  saved but not yet applied. Send it as a new request instead.
- **One machine.** Ashara runs on a single computer with a local database.
- **Cost.** A small to medium request has cost $1-2 with Claude doing most of the work.

## Coming next

- Growing a project over several stages without you stepping in.
- Absorbing a change of direction mid-project, with a report of what it affects and costs.
- Lower cost per piece of work, so larger projects stay affordable.

## Contributing

A change is ready when both gates pass. Judge each by its exit code, not by a count of what it ran.

```bash
just check      # type check, package boundaries, unused code, lint; stops at the first failure
just test       # test suite
just simulate   # deterministic lifecycle simulator: crashes, races and misbehaving models, no model cost
```

Tests and the simulator never touch the database `just dev` starts. They run on a separate test Postgres,
started with `just test-db-up` and stopped with `just test-db-down`; it keeps its data in memory, so stopping
it discards every test database. `just test` migrates it before the run, as does a direct `npx vitest`, and
either stops naming `just test-db-up` when it is not running. `TEST_DATABASE_URL` points tests at another
database instead, never the shared one. `just test` also needs podman: the container tests run real
containers and are never skipped. `just simulate` needs the test Postgres too.

### Packages

Each package under `packages/` is one bounded context or one piece of shared infrastructure. Which package may
import which is declared in `boundary-rules.toml` and enforced by `just check`.

| Package | Purpose |
|---|---|
| `shared` | The shared kernel: identifiers and the vocabulary every other package uses. Imports nothing. |
| `db` | Generic persistence: the database connection, migrations, the event store and each context's schema. |
| `model-access` | Model providers, the model catalog and structured output from models. |
| `finance` | Prices and records every model call and enforces the spending limits before each one. |
| `security` | The encrypted secret store and the master key that protects it. |
| `execution-infra` | Sealed containers ("cells") on podman, where every agent command runs. |
| `knowledge` | Findings and failed approaches, kept so later work can learn from them. |
| `workplace` | An agent's attempt at a piece of work: its model turns and the tools it uses inside a cell. |
| `engagement` | The client relationship: intake, questions and assumptions, and the reports sent to the client. |
| `organization` | The project team: its roster, roles and what each role may do. |
| `quality` | Independent checks: tests and gates, merging and its verification, suite review and acceptance. |
| `delivery` | The board: planning, breaking work down, assigning it and driving the project to delivery. |
| `server` | The composition root and the web client, the only interface a client uses. |
| `integration` | Cross-package integration tests and the lifecycle simulator; nothing imports it. |
