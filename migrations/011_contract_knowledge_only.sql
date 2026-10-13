-- Migration 011: ProjectContract body is knowledge-only.
--
-- t-cut-w8 deleted the HTTP project contract: endpoint/module/mount registries,
-- contract derivation, coverage reconciliation, the completion amend and the
-- brief's contract slice. ContractBodySchema is now `{ knowledge }` and stays
-- `.strict()`, so a stored body still carrying the retired keys would fail to
-- parse on read. Strip them; every version row is rewritten, since the
-- repository reads only the latest but a rewrite of history keeps every row
-- parseable.

UPDATE project_contracts
SET contract = contract - 'endpoints' - 'modules' - 'mounts' - 'excludePaths'
WHERE contract ?| ARRAY['endpoints', 'modules', 'mounts', 'excludePaths'];
