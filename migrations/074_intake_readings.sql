-- Migration 074: a reading of a tender that asks the client nothing is a claim that the tender leaves
-- nothing open worth asking, so it is put to a second reading at the strongest independence the
-- catalog offers, as a clean suite review is (ADR-084 addenda 2 and 3, decisions 11 and 12). One row
-- per project, written with vision v1 in the intake's transaction.
--
-- confirmation:
--   not-needed        the first reading asked the client questions: there is no claim to confirm;
--   confirmed         it asked nothing, and the second reading asked nothing either;
--   questions-raised  it asked nothing, and the second reading asked the questions the client was sent;
--   unconfirmed       it asked nothing, and no second reading answered at any strength: the client
--                     is told the reading is unconfirmed, and work proceeds on it.
-- second_*: the second reading that answered: its strength against the first, named as migration 073
-- names a suite review's (another provider is other-family, the same model same-model, any other
-- model of the provider same-family-other-model), its model, and how many questions it asked. Set
-- exactly for confirmed and questions-raised.
-- passed_over: the strengths no answer was had at, in the order asked, before the one that answered
-- (or all three, when none did): each {strength, outcome, reason}, outcome `unavailable` (the catalog
-- offers no model for it) or `failed` (its model gave no fit answer).

CREATE TABLE intake_readings (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  tender_id UUID NOT NULL REFERENCES client_messages(id) ON DELETE CASCADE,
  first_provider TEXT NOT NULL,
  first_model TEXT NOT NULL,
  first_questions INTEGER NOT NULL,
  confirmation TEXT NOT NULL,
  second_strength TEXT,
  second_provider TEXT,
  second_model TEXT,
  second_questions INTEGER,
  passed_over JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT intake_readings_first_questions CHECK (first_questions >= 0),
  CONSTRAINT intake_readings_confirmation_known
    CHECK (confirmation IN ('not-needed', 'confirmed', 'questions-raised', 'unconfirmed')),
  CONSTRAINT intake_readings_claim CHECK ((confirmation = 'not-needed') = (first_questions > 0)),
  CONSTRAINT intake_readings_second_answered CHECK (
    (confirmation IN ('confirmed', 'questions-raised')) = (second_strength IS NOT NULL)
    AND (second_strength IS NULL) = (second_provider IS NULL)
    AND (second_strength IS NULL) = (second_model IS NULL)
    AND (second_strength IS NULL) = (second_questions IS NULL)
  ),
  CONSTRAINT intake_readings_strength_known
    CHECK (second_strength IS NULL OR second_strength IN ('other-family', 'same-family-other-model', 'same-model')),
  CONSTRAINT intake_readings_strength_fits CHECK (
    second_strength IS NULL OR second_strength = CASE
      WHEN second_provider <> first_provider THEN 'other-family'
      WHEN second_model = first_model THEN 'same-model'
      ELSE 'same-family-other-model'
    END
  ),
  CONSTRAINT intake_readings_second_questions
    CHECK (second_questions IS NULL OR (confirmation = 'questions-raised') = (second_questions > 0)),
  CONSTRAINT intake_readings_passed_over_list CHECK (jsonb_typeof(passed_over) = 'array'),
  CONSTRAINT intake_readings_unconfirmed_asked_every_strength
    CHECK (confirmation <> 'unconfirmed' OR jsonb_array_length(passed_over) = 3)
);
