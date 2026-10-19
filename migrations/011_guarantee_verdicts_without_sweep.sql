-- A terminal message is told even when no sweep is on record for it (a halt whose terminal sweep
-- could not be recorded, the report of a first planning that stopped before any work): its verdicts
-- name no sweep, and with no sweep nothing is judged, so every such verdict is unjudged for want of a
-- sweep on a commit.

ALTER TABLE public.guarantee_verdicts
    ALTER COLUMN sweep_id DROP NOT NULL,
    ADD CONSTRAINT guarantee_verdicts_no_sweep_unjudged CHECK (((sweep_id IS NOT NULL) OR ((verdict = 'unjudged'::text) AND (reason = 'no-sweep-on-commit'::text))));
