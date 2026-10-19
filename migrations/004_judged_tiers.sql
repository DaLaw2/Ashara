-- The catalog grades each model per thinking mode, and the intake's second reading records the tier
-- it judged and the grade of the judge.
--
-- model_configs.capability is a model's grade called with thinking on; capability_thinking_off is
-- its grade called with thinking off. A model with no thinking switch is called the same way in
-- both modes and graded the same. deepseek-flash is Strong only when it reasons: called without
-- reasoning the catalog record grades it Light.
--
-- intake_readings.judged_tier is the catalog grade of the model that gave the first reading, as it
-- was called; judge_tier is the grade of the model that gave the second reading, as it was called,
-- never below judged_tier. A row written before these columns recorded neither, so the
-- constraints hold every row written from now on (NOT VALID) and leave those rows as they are.

ALTER TABLE model_configs ADD COLUMN capability_thinking_off text;
UPDATE model_configs SET capability_thinking_off = capability;
UPDATE model_configs SET capability_thinking_off = 'Light' WHERE model_id = 'deepseek-flash';
ALTER TABLE model_configs ALTER COLUMN capability_thinking_off SET NOT NULL;
ALTER TABLE model_configs
  ADD CONSTRAINT model_configs_capability_thinking_off_check
    CHECK (capability_thinking_off = ANY (ARRAY['Frontier'::text, 'Strong'::text, 'Medium'::text, 'Light'::text]));

ALTER TABLE intake_readings ADD COLUMN judged_tier text;
ALTER TABLE intake_readings ADD COLUMN judge_tier text;
ALTER TABLE intake_readings
  ADD CONSTRAINT intake_readings_judged_tier_known
    CHECK (judged_tier IS NOT NULL AND judged_tier = ANY (ARRAY['Frontier'::text, 'Strong'::text, 'Medium'::text, 'Light'::text])) NOT VALID;
ALTER TABLE intake_readings
  ADD CONSTRAINT intake_readings_judge_tier_known
    CHECK (judge_tier IS NULL OR judge_tier = ANY (ARRAY['Frontier'::text, 'Strong'::text, 'Medium'::text, 'Light'::text]));
ALTER TABLE intake_readings
  ADD CONSTRAINT intake_readings_judge_tier_answered
    CHECK ((judge_tier IS NULL) = (second_strength IS NULL)) NOT VALID;
ALTER TABLE intake_readings
  ADD CONSTRAINT intake_readings_judge_not_below
    CHECK (
      judge_tier IS NULL
      OR array_position(ARRAY['Light'::text, 'Medium'::text, 'Strong'::text, 'Frontier'::text], judge_tier)
         >= array_position(ARRAY['Light'::text, 'Medium'::text, 'Strong'::text, 'Frontier'::text], judged_tier)
    ) NOT VALID;
