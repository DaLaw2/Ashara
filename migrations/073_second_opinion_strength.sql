-- Migration 073: a suite review's second opinion is independent at one of three strengths, and every
-- judgement and claim records which (ADR-084 addendum 3 decision 12).
--
-- second_strength, on suite_review_judgements and suite_review_claims, replaces second_review:
--   other-family             a model of another provider answered;
--   same-family-other-model  another model of the first review's provider answered, asked to look for
--                            what the checks cannot observe;
--   same-model               the first review's model answered again from that angle, in a deployment
--                            that offers no other model.
-- It is set exactly when second_model is, and agrees with the two models: another provider is
-- other-family, the same model is same-model, any other model of the provider same-family-other-model.
-- Rows already written take it from their two models the same way.
--
-- passed_over: the strengths the second review got no answer at, in the order asked, before the one
-- that answered (or every one, when it failed): each {strength, outcome, reason}, outcome
-- `unavailable` (the catalog offers no model for it) or `failed` (its model gave no fit answer).
-- Rows already written passed over nothing on record.
--
-- basis: a second opinion that answered acts at any strength as another family's did, so
--   other-family-agreed     becomes second-opinion-agreed,
--   other-family-disagreed  becomes second-opinion-disagreed,
--   other-family-clean      becomes second-opinion-clean,
--   other-family-found      becomes second-opinion-found;
-- rows already written are renamed. no-other-family is no longer written: rows that hold it keep it,
-- as a same-provider answer that confirmed nothing, and it never names an other-family second review.

ALTER TABLE suite_review_judgements
  ADD COLUMN second_strength TEXT,
  ADD COLUMN passed_over JSONB NOT NULL DEFAULT '[]'::jsonb,
  DROP CONSTRAINT suite_review_judgements_basis_known,
  DROP CONSTRAINT suite_review_judgements_outcome_fits_basis,
  DROP CONSTRAINT suite_review_judgements_second_asked,
  DROP CONSTRAINT suite_review_judgements_resample_same_model;

ALTER TABLE suite_review_claims
  ADD COLUMN second_strength TEXT,
  ADD COLUMN passed_over JSONB NOT NULL DEFAULT '[]'::jsonb,
  DROP CONSTRAINT suite_review_claims_basis_check,
  DROP CONSTRAINT suite_review_claims_second_asked,
  DROP CONSTRAINT suite_review_claims_other_family,
  DROP CONSTRAINT suite_review_claims_found_has_findings;

ALTER TABLE suite_review_judgements DISABLE TRIGGER suite_review_judgements_append_only;
ALTER TABLE suite_review_claims DISABLE TRIGGER suite_review_claims_append_only;

UPDATE suite_review_judgements SET
  second_strength = CASE
    WHEN second_model IS NULL THEN NULL
    WHEN split_part(first_model, '/', 1) <> split_part(second_model, '/', 1) THEN 'other-family'
    WHEN first_model = second_model THEN 'same-model'
    ELSE 'same-family-other-model'
  END,
  basis = CASE basis
    WHEN 'other-family-agreed' THEN 'second-opinion-agreed'
    WHEN 'other-family-disagreed' THEN 'second-opinion-disagreed'
    ELSE basis
  END;

UPDATE suite_review_claims SET
  second_strength = CASE
    WHEN second_model IS NULL THEN NULL
    WHEN split_part(first_model, '/', 1) <> split_part(second_model, '/', 1) THEN 'other-family'
    WHEN first_model = second_model THEN 'same-model'
    ELSE 'same-family-other-model'
  END,
  basis = CASE basis
    WHEN 'other-family-clean' THEN 'second-opinion-clean'
    WHEN 'other-family-found' THEN 'second-opinion-found'
    ELSE basis
  END;

ALTER TABLE suite_review_judgements ENABLE TRIGGER suite_review_judgements_append_only;
ALTER TABLE suite_review_claims ENABLE TRIGGER suite_review_claims_append_only;

ALTER TABLE suite_review_judgements
  DROP COLUMN second_review,
  ALTER COLUMN passed_over DROP DEFAULT,
  ADD CONSTRAINT suite_review_judgements_basis_known CHECK (
    basis IN ('two-reviews', 'second-opinion-agreed', 'second-opinion-disagreed', 'no-other-family', 'second-review-failed', 'frozen', 'reopened-once')
  ),
  ADD CONSTRAINT suite_review_judgements_outcome_fits_basis CHECK (
    (outcome = 'routed') = (basis = 'second-opinion-agreed' OR (basis = 'two-reviews' AND outcome = 'routed'))
    AND (outcome <> 'released' OR basis = 'two-reviews')
  ),
  ADD CONSTRAINT suite_review_judgements_second_asked CHECK (
    (second_model IS NULL) = (second_strength IS NULL)
    AND (basis IN ('frozen', 'reopened-once', 'second-review-failed') OR second_model IS NOT NULL)
    AND (basis <> 'second-review-failed' OR second_model IS NULL)
    AND (second_model IS NOT NULL OR jsonb_array_length(second_findings) = 0)
  ),
  ADD CONSTRAINT suite_review_judgements_strength_known CHECK (
    second_strength IS NULL OR second_strength IN ('other-family', 'same-family-other-model', 'same-model')
  ),
  ADD CONSTRAINT suite_review_judgements_strength_fits_models CHECK (
    second_strength IS NULL
    OR ((second_strength = 'same-model') = (first_model = second_model)
      AND (second_strength = 'other-family') = (split_part(first_model, '/', 1) <> split_part(second_model, '/', 1)))
  ),
  ADD CONSTRAINT suite_review_judgements_no_other_family_same_provider CHECK (basis <> 'no-other-family' OR second_strength <> 'other-family'),
  ADD CONSTRAINT suite_review_judgements_passed_over_list CHECK (jsonb_typeof(passed_over) = 'array');

ALTER TABLE suite_review_claims
  DROP COLUMN second_review,
  ALTER COLUMN passed_over DROP DEFAULT,
  ADD CONSTRAINT suite_review_claims_basis_known CHECK (
    basis IN ('second-opinion-clean', 'second-opinion-found', 'no-other-family', 'second-review-failed')
  ),
  ADD CONSTRAINT suite_review_claims_second_asked CHECK (
    (second_model IS NULL) = (second_strength IS NULL)
    AND (second_model IS NULL) = (basis = 'second-review-failed')
    AND (second_model IS NOT NULL OR jsonb_array_length(second_findings) = 0)
  ),
  ADD CONSTRAINT suite_review_claims_strength_known CHECK (
    second_strength IS NULL OR second_strength IN ('other-family', 'same-family-other-model', 'same-model')
  ),
  ADD CONSTRAINT suite_review_claims_strength_fits_models CHECK (
    second_strength IS NULL
    OR ((second_strength = 'same-model') = (first_model = second_model)
      AND (second_strength = 'other-family') = (split_part(first_model, '/', 1) <> split_part(second_model, '/', 1)))
  ),
  ADD CONSTRAINT suite_review_claims_no_other_family_same_provider CHECK (basis <> 'no-other-family' OR second_strength <> 'other-family'),
  ADD CONSTRAINT suite_review_claims_found_has_findings CHECK (basis <> 'second-opinion-found' OR jsonb_array_length(second_findings) >= 1),
  ADD CONSTRAINT suite_review_claims_passed_over_list CHECK (jsonb_typeof(passed_over) = 'array');
