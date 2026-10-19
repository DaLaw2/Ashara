-- Every suite review judgement and claim records how its judges stood to the check work they judged:
-- judge_tier, the grade of the weaker judge the row rests on (the first review, and the second where
-- it answered); judged_tier, the check work's tier; tier_relation, "above" when that judge is graded
-- above the work, "equal" when only at it. A judge below the work is never recorded.
-- A row written before these columns holds none of the three and reads as unrecorded; every row
-- written now holds all three (the *_tiers_recorded checks, NOT VALID so they bind new rows only).

ALTER TABLE public.suite_review_judgements
    ADD COLUMN judge_tier text,
    ADD COLUMN judged_tier text,
    ADD COLUMN tier_relation text;

ALTER TABLE public.suite_review_judgements
    ADD CONSTRAINT suite_review_judgements_judge_tier_known CHECK ((judge_tier = ANY (ARRAY['Light'::text, 'Medium'::text, 'Strong'::text, 'Frontier'::text]))),
    ADD CONSTRAINT suite_review_judgements_judged_tier_known CHECK ((judged_tier = ANY (ARRAY['Light'::text, 'Medium'::text, 'Strong'::text, 'Frontier'::text]))),
    ADD CONSTRAINT suite_review_judgements_tier_relation_known CHECK ((tier_relation = ANY (ARRAY['above'::text, 'equal'::text]))),
    ADD CONSTRAINT suite_review_judgements_tier_relation_fits CHECK (((array_position(ARRAY['Light'::text, 'Medium'::text, 'Strong'::text, 'Frontier'::text], judge_tier) >= array_position(ARRAY['Light'::text, 'Medium'::text, 'Strong'::text, 'Frontier'::text], judged_tier)) AND ((tier_relation = 'equal'::text) = (judge_tier = judged_tier))));

ALTER TABLE public.suite_review_judgements
    ADD CONSTRAINT suite_review_judgements_tiers_recorded CHECK ((num_nulls(judge_tier, judged_tier, tier_relation) = 0)) NOT VALID;

ALTER TABLE public.suite_review_claims
    ADD COLUMN judge_tier text,
    ADD COLUMN judged_tier text,
    ADD COLUMN tier_relation text;

ALTER TABLE public.suite_review_claims
    ADD CONSTRAINT suite_review_claims_judge_tier_known CHECK ((judge_tier = ANY (ARRAY['Light'::text, 'Medium'::text, 'Strong'::text, 'Frontier'::text]))),
    ADD CONSTRAINT suite_review_claims_judged_tier_known CHECK ((judged_tier = ANY (ARRAY['Light'::text, 'Medium'::text, 'Strong'::text, 'Frontier'::text]))),
    ADD CONSTRAINT suite_review_claims_tier_relation_known CHECK ((tier_relation = ANY (ARRAY['above'::text, 'equal'::text]))),
    ADD CONSTRAINT suite_review_claims_tier_relation_fits CHECK (((array_position(ARRAY['Light'::text, 'Medium'::text, 'Strong'::text, 'Frontier'::text], judge_tier) >= array_position(ARRAY['Light'::text, 'Medium'::text, 'Strong'::text, 'Frontier'::text], judged_tier)) AND ((tier_relation = 'equal'::text) = (judge_tier = judged_tier))));

ALTER TABLE public.suite_review_claims
    ADD CONSTRAINT suite_review_claims_tiers_recorded CHECK ((num_nulls(judge_tier, judged_tier, tier_relation) = 0)) NOT VALID;
