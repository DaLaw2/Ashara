-- A suite review's undecided item speaks of the checks of the one check task it was found on, so it
-- lowers only those checks' evidence on the guarantee, and a later review whose second opinion
-- confirms the item on that check task clears it.
--
-- guarantee_evidence records the lowering on each check ({taskCheckId, outcome, class, lowered})
-- in place of one flag per guarantee. A row recorded with the flag set lowered every check it holds,
-- so each of its checks is recorded lowered, and each row of a flag left unset none: every verdict
-- judged from a row recorded before reads the same after.
--
-- undecided_items gains its clearing: the claim of the later review that cleared it and when, set
-- once on a standing row and never changed again; nothing else of a row ever changes. At most one
-- row per check task and item stands uncleared, so a review that leaves a cleared item undecided
-- again writes a new row.

ALTER TABLE public.guarantee_evidence DISABLE TRIGGER guarantee_evidence_append_only;

UPDATE public.guarantee_evidence e
SET checks = COALESCE(
    (SELECT jsonb_agg(c.check_row || jsonb_build_object('lowered', e.review_lowers) ORDER BY c.at)
     FROM jsonb_array_elements(e.checks) WITH ORDINALITY AS c(check_row, at)),
    '[]'::jsonb);

ALTER TABLE public.guarantee_evidence ENABLE TRIGGER guarantee_evidence_append_only;

ALTER TABLE public.guarantee_evidence DROP COLUMN review_lowers;

ALTER TABLE public.undecided_items
    ADD COLUMN cleared_by_claim_id uuid,
    ADD COLUMN cleared_at timestamp with time zone,
    ADD CONSTRAINT undecided_items_cleared_by_claim_id_fkey FOREIGN KEY (cleared_by_claim_id) REFERENCES public.suite_review_claims(id) ON DELETE CASCADE,
    ADD CONSTRAINT undecided_items_cleared_whole CHECK (((cleared_by_claim_id IS NULL) = (cleared_at IS NULL))),
    ADD CONSTRAINT undecided_items_cleared_by_another CHECK (((cleared_by_claim_id IS NULL) OR (claim_id IS NULL) OR (cleared_by_claim_id <> claim_id))),
    DROP CONSTRAINT undecided_items_one_per_check_task;

CREATE UNIQUE INDEX undecided_items_one_standing_per_check_task ON public.undecided_items USING btree (check_task_id, item_id) WHERE (cleared_by_claim_id IS NULL);

CREATE OR REPLACE FUNCTION public.undecided_items_refuse_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.cleared_by_claim_id IS NULL AND NEW.cleared_by_claim_id IS NOT NULL
     AND (to_jsonb(NEW) - 'cleared_by_claim_id' - 'cleared_at') = (to_jsonb(OLD) - 'cleared_by_claim_id' - 'cleared_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'undecided_items is append-only but for its clearing, set once on a standing row (item % of check task %)', OLD.item_id, OLD.check_task_id;
END;
$$;
