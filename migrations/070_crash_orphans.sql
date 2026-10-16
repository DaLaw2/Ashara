-- Migration 070: the startups in a row that found a task InProgress (ADR-084 decision 1).
--
-- work_items.crash_orphans: how many startups in a row found the task InProgress, a dispatch of
-- it left by a process that died. The startup reconciler counts one in a single UPDATE before it
-- requeues the task, and gives the task up (blocked_reason source crash_loop) instead once the
-- count reaches its bound, so a task whose dispatch kills the server is not re-dispatched at every
-- restart until its share of the work ledger is spent. A dispatch that ends inside the process
-- that started it sets it back to 0. On a column, so the count survives the restart it counts.

ALTER TABLE work_items ADD COLUMN crash_orphans INTEGER NOT NULL DEFAULT 0 CHECK (crash_orphans >= 0);
