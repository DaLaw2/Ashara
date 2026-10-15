-- Migration 055: drop project_contracts (ADR-080 d3, reshape step R1; the G6 cut of c-platform-role;
-- story s-legacy-review-ddd-shape, task t-ddd-r1-contract-out).
--
-- The ADR-028 project contract held one knowledge graph per project, derived by an extra model call
-- on every plan. Its only reader was the entry-point section of a task's context map. The platform
-- role's environment definition supersedes it (ADR-074 d54-d55), and the code that wrote and read
-- the table is deleted in the same change, so the table and its rows go too.

DROP TABLE IF EXISTS project_contracts;
