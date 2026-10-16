-- Migration 069: a suite review's finding acts only with a witness or another model family's
-- agreement (ADR-084 decision 2); one that does not act is kept whole as advisory, and a cited item
-- it leaves undecided is stored undecided; a plan revision's check set freezes when its first
-- implementation is dispatched (ADR-084 decision 3).
--
-- suite_review_judgements now holds every finding of a review's first pass, of every kind, with
-- why it acted or did not (basis):
--   two-reviews             an outside-vision rejection: routed when the second review rejects the
--                           same check, released when it does not (migration 063's rule);
--   other-family-agreed     a contradiction or undecided item a second review by another model
--                           family (another provider) reached too: routed;
--   other-family-disagreed  one the other family's second review did not reach: advisory;
--   no-other-family         one whose second review came from the first's provider: advisory;
--   frozen                  any finding on a check set already frozen: advisory;
--   reopened-once           an undecided item on a check task the review already reopened once: advisory.
-- check_name is the rejected check of an outside-vision finding and null for the other kinds. A
-- finding on which no second review was asked (frozen, reopened-once) records no second model.
-- Rows written before this migration are outside-vision rejections judged by two reviews.
--
-- undecided_items (Quality): one row per cited item a review found no check deciding where that
-- finding did not act. The item stays undecided: the delivered report names it unverified, never
-- covered (ADR-084 decision 2). Append-only; one row per check task and item.
--
-- check_set_freezes (Quality): one row per review task, written when the first implementation task
-- depending on it is dispatched, with the check set it reviewed as it then stood (each check task,
-- the task its checks decide, the latest revision's checks and what each decides, the items the
-- check task cites). After it, a review of that set reopens nothing. Append-only.

ALTER TABLE suite_review_judgements
  ALTER COLUMN check_name DROP NOT NULL,
  ALTER COLUMN second_model DROP NOT NULL,
  ALTER COLUMN second_review DROP NOT NULL,
  ADD COLUMN basis TEXT NOT NULL DEFAULT 'two-reviews',
  DROP CONSTRAINT suite_review_judgements_outcome_check,
  DROP CONSTRAINT suite_review_judgements_routed_has_second,
  ADD CONSTRAINT suite_review_judgements_outcome_known CHECK (outcome IN ('routed', 'released', 'advisory')),
  ADD CONSTRAINT suite_review_judgements_basis_known CHECK (
    basis IN ('two-reviews', 'other-family-agreed', 'other-family-disagreed', 'no-other-family', 'frozen', 'reopened-once')
  ),
  ADD CONSTRAINT suite_review_judgements_kind_known CHECK (first_finding->>'kind' IN ('contradiction', 'outside-vision', 'undecided-item')),
  ADD CONSTRAINT suite_review_judgements_check_of_rejection CHECK ((first_finding->>'kind' = 'outside-vision') = (check_name IS NOT NULL)),
  ADD CONSTRAINT suite_review_judgements_basis_fits_kind CHECK (
    (basis = 'two-reviews') = (first_finding->>'kind' = 'outside-vision' AND outcome <> 'advisory')
  ),
  ADD CONSTRAINT suite_review_judgements_outcome_fits_basis CHECK (
    (outcome = 'routed') = (basis = 'other-family-agreed' OR (basis = 'two-reviews' AND outcome = 'routed'))
    AND (outcome <> 'released' OR basis = 'two-reviews')
  ),
  ADD CONSTRAINT suite_review_judgements_routed_has_second CHECK (outcome <> 'routed' OR jsonb_array_length(second_findings) >= 1),
  ADD CONSTRAINT suite_review_judgements_second_asked CHECK (
    (second_model IS NULL) = (second_review IS NULL)
    AND (basis IN ('frozen', 'reopened-once') OR second_model IS NOT NULL)
    AND (second_model IS NOT NULL OR jsonb_array_length(second_findings) = 0)
  );

ALTER TABLE suite_review_judgements ALTER COLUMN basis DROP DEFAULT;

CREATE TABLE undecided_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  review_task_id UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  check_task_id UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL CHECK (length(item_id) > 0),
  item_text TEXT NOT NULL CHECK (length(item_text) > 0),
  judgement_id UUID NOT NULL REFERENCES suite_review_judgements(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT undecided_items_one_per_check_task UNIQUE (check_task_id, item_id)
);

CREATE INDEX undecided_items_project ON undecided_items (project_id, created_at);

CREATE OR REPLACE FUNCTION undecided_items_refuse_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'undecided_items is append-only (item % of check task %)', OLD.item_id, OLD.check_task_id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER undecided_items_append_only
  BEFORE UPDATE ON undecided_items
  FOR EACH ROW EXECUTE FUNCTION undecided_items_refuse_update();

CREATE TABLE check_set_freezes (
  review_task_id UUID PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  frozen_by UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  check_set JSONB NOT NULL CHECK (jsonb_typeof(check_set) = 'array'),
  frozen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION check_set_freezes_refuse_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'check_set_freezes is append-only (review task %)', OLD.review_task_id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_set_freezes_append_only
  BEFORE UPDATE ON check_set_freezes
  FOR EACH ROW EXECUTE FUNCTION check_set_freezes_refuse_update();
