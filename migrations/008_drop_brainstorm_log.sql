-- Migration 008: Drop brainstorm_log.
--
-- Brainstorm and its BrainstormLogRepository are deleted (t-cut-w4); the
-- repository was the table's only reader and writer.

DROP TABLE IF EXISTS brainstorm_log;
