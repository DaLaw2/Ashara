-- A suite review judges a check that requires what a cited guarantee lists as refuting it, or the
-- opposite of a cited assumption, as a finding of its own kind: 'breaks-contract'.

ALTER TABLE public.suite_review_judgements
    DROP CONSTRAINT suite_review_judgements_kind_known,
    ADD CONSTRAINT suite_review_judgements_kind_known CHECK (((first_finding ->> 'kind'::text) = ANY (ARRAY['contradiction'::text, 'outside-vision'::text, 'undecided-item'::text, 'breaks-contract'::text])));
