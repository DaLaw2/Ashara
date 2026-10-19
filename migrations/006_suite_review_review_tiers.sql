-- Every suite review judgement and claim records the grade of each review it rests on, as called:
-- first_tier, the first review's; second_tier, the second review's where one answered (second_model
-- set), else none. judge_tier is the weaker of them, so a reader names which review was not above
-- the check work instead of only that one was not.
-- A row written before these columns holds neither and reads as one whose reviews' grades are not
-- on record; every row written now holds them (the *_review_tiers_recorded checks, NOT VALID so they
-- bind new rows only).

ALTER TABLE public.suite_review_judgements
    ADD COLUMN first_tier text,
    ADD COLUMN second_tier text;

ALTER TABLE public.suite_review_judgements
    ADD CONSTRAINT suite_review_judgements_first_tier_known CHECK ((first_tier = ANY (ARRAY['Light'::text, 'Medium'::text, 'Strong'::text, 'Frontier'::text]))),
    ADD CONSTRAINT suite_review_judgements_second_tier_known CHECK ((second_tier = ANY (ARRAY['Light'::text, 'Medium'::text, 'Strong'::text, 'Frontier'::text]))),
    ADD CONSTRAINT suite_review_judgements_judge_tier_weaker CHECK ((first_tier IS NULL OR array_position(ARRAY['Light'::text, 'Medium'::text, 'Strong'::text, 'Frontier'::text], judge_tier) = LEAST(array_position(ARRAY['Light'::text, 'Medium'::text, 'Strong'::text, 'Frontier'::text], first_tier), array_position(ARRAY['Light'::text, 'Medium'::text, 'Strong'::text, 'Frontier'::text], COALESCE(second_tier, first_tier)))));

ALTER TABLE public.suite_review_judgements
    ADD CONSTRAINT suite_review_judgements_review_tiers_recorded CHECK ((first_tier IS NOT NULL AND ((second_tier IS NULL) = (second_model IS NULL)))) NOT VALID;

ALTER TABLE public.suite_review_claims
    ADD COLUMN first_tier text,
    ADD COLUMN second_tier text;

ALTER TABLE public.suite_review_claims
    ADD CONSTRAINT suite_review_claims_first_tier_known CHECK ((first_tier = ANY (ARRAY['Light'::text, 'Medium'::text, 'Strong'::text, 'Frontier'::text]))),
    ADD CONSTRAINT suite_review_claims_second_tier_known CHECK ((second_tier = ANY (ARRAY['Light'::text, 'Medium'::text, 'Strong'::text, 'Frontier'::text]))),
    ADD CONSTRAINT suite_review_claims_judge_tier_weaker CHECK ((first_tier IS NULL OR array_position(ARRAY['Light'::text, 'Medium'::text, 'Strong'::text, 'Frontier'::text], judge_tier) = LEAST(array_position(ARRAY['Light'::text, 'Medium'::text, 'Strong'::text, 'Frontier'::text], first_tier), array_position(ARRAY['Light'::text, 'Medium'::text, 'Strong'::text, 'Frontier'::text], COALESCE(second_tier, first_tier)))));

ALTER TABLE public.suite_review_claims
    ADD CONSTRAINT suite_review_claims_review_tiers_recorded CHECK ((first_tier IS NOT NULL AND ((second_tier IS NULL) = (second_model IS NULL)))) NOT VALID;
