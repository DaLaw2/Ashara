-- Migration 071: a suite review's second review that failed is recorded as a failure, never as a
-- disagreement or as no other family being asked (ADR-084 decision 2).
--
-- suite_review_judgements.basis gains one value:
--   second-review-failed  the second review was asked and returned no verdict (no model it could go
--                         to answered, its answers never validated, or its verdict was unfit): the
--                         finding acts on nothing and an undecided item it names is reported
--                         unverified because the review failed.
-- second_failure holds why, as the error read when the review failed; it is set exactly on that
-- basis, which records no second model, since none answered.
-- first_finding's conflict of a contradiction now names its sides (first, second); rows already
-- written hold them as a pair, and the repository reads both.

ALTER TABLE suite_review_judgements
  ADD COLUMN second_failure TEXT CHECK (second_failure IS NULL OR length(second_failure) > 0),
  DROP CONSTRAINT suite_review_judgements_basis_known,
  DROP CONSTRAINT suite_review_judgements_second_asked,
  ADD CONSTRAINT suite_review_judgements_basis_known CHECK (
    basis IN ('two-reviews', 'other-family-agreed', 'other-family-disagreed', 'no-other-family', 'second-review-failed', 'frozen', 'reopened-once')
  ),
  ADD CONSTRAINT suite_review_judgements_second_asked CHECK (
    (second_model IS NULL) = (second_review IS NULL)
    AND (basis IN ('frozen', 'reopened-once', 'second-review-failed') OR second_model IS NOT NULL)
    AND (basis <> 'second-review-failed' OR second_model IS NULL)
    AND (second_model IS NOT NULL OR jsonb_array_length(second_findings) = 0)
  ),
  ADD CONSTRAINT suite_review_judgements_failure_of_failed CHECK ((basis = 'second-review-failed') = (second_failure IS NOT NULL));
