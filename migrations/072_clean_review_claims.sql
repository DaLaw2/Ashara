-- Migration 072: a suite review that lets its plan proceed is a claim about the checks, and the items
-- it covers read as verified only when a second review by another model family confirms it
-- (ADR-084 addendum 2 decision 11).
--
-- suite_review_claims (Quality): one row per review whose outcome routed nothing, written with its
-- judgements before the outcome is acted on: the first review's model, the second review whole
-- (its model and what it was, or why it failed), the check tasks the claim covers, and its basis:
--   other-family-clean    a second review by another model family named nothing about the covered
--                         items: they read as verified;
--   other-family-found    it named something about some of them: those are undecided, and nothing
--                         reopens on its findings (the first review did not raise them);
--   no-other-family       the second review came from the first's provider: every covered item is
--                         undecided;
--   second-review-failed  the second review returned no verdict: every covered item is undecided.
--
-- undecided_items: an item is left undecided either by a judgement on a finding (judgement_id) or
-- by a claim that was not confirmed (claim_id), exactly one of them.

CREATE TABLE suite_review_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  review_task_id UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  basis TEXT NOT NULL CHECK (basis IN ('other-family-clean', 'other-family-found', 'no-other-family', 'second-review-failed')),
  covered JSONB NOT NULL CHECK (jsonb_typeof(covered) = 'array' AND jsonb_array_length(covered) >= 1),
  first_model TEXT NOT NULL CHECK (length(first_model) > 0),
  second_model TEXT CHECK (second_model IS NULL OR length(second_model) > 0),
  second_review TEXT CHECK (second_review IS NULL OR second_review IN ('other-model', 're-sample')),
  second_findings JSONB NOT NULL CHECK (jsonb_typeof(second_findings) = 'array'),
  second_failure TEXT CHECK (second_failure IS NULL OR length(second_failure) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT suite_review_claims_second_asked CHECK (
    (second_model IS NULL) = (second_review IS NULL)
    AND (second_model IS NULL) = (basis = 'second-review-failed')
    AND (second_model IS NOT NULL OR jsonb_array_length(second_findings) = 0)
  ),
  CONSTRAINT suite_review_claims_failure_of_failed CHECK ((basis = 'second-review-failed') = (second_failure IS NOT NULL)),
  CONSTRAINT suite_review_claims_other_family CHECK (basis NOT IN ('other-family-clean', 'other-family-found') OR second_review = 'other-model'),
  CONSTRAINT suite_review_claims_found_has_findings CHECK (basis <> 'other-family-found' OR jsonb_array_length(second_findings) >= 1)
);

CREATE INDEX suite_review_claims_review_task ON suite_review_claims (review_task_id, created_at);

CREATE OR REPLACE FUNCTION suite_review_claims_refuse_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'suite_review_claims is append-only (claim % of review task %)', OLD.id, OLD.review_task_id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER suite_review_claims_append_only
  BEFORE UPDATE ON suite_review_claims
  FOR EACH ROW EXECUTE FUNCTION suite_review_claims_refuse_update();

ALTER TABLE undecided_items
  ALTER COLUMN judgement_id DROP NOT NULL,
  ADD COLUMN claim_id UUID REFERENCES suite_review_claims(id) ON DELETE CASCADE,
  ADD CONSTRAINT undecided_items_one_source CHECK ((judgement_id IS NULL) <> (claim_id IS NULL));
