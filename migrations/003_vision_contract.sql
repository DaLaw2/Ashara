-- A vision version records its contract: the product's public interface, the guarantees a delivery
-- is judged against, and the exclusions the tender leaves out. contract_form says which records a
-- version is written in; a version written before guarantees were is 'scope-lines' and keeps its
-- scope_boundaries, which readers read as legacy guarantees. A 'guarantees' version never holds an
-- empty interface or guarantee list, and never holds scope lines; a 'scope-lines' version holds no
-- contract records, so a reader of one form never drops the other's.

ALTER TABLE public.vision_documents
    ADD COLUMN contract_form text DEFAULT 'scope-lines' NOT NULL,
    ADD COLUMN "interface" jsonb DEFAULT '[]'::jsonb NOT NULL,
    ADD COLUMN guarantees jsonb DEFAULT '[]'::jsonb NOT NULL,
    ADD COLUMN exclusions jsonb DEFAULT '[]'::jsonb NOT NULL,
    ADD CONSTRAINT vision_documents_contract_form_check CHECK ((contract_form = ANY (ARRAY['scope-lines'::text, 'guarantees'::text]))),
    ADD CONSTRAINT vision_documents_contract_lists_check CHECK (
        jsonb_typeof("interface") = 'array'::text
        AND jsonb_typeof(guarantees) = 'array'::text
        AND jsonb_typeof(exclusions) = 'array'::text
    ),
    ADD CONSTRAINT vision_documents_contract_form_records CHECK (
        CASE contract_form
            WHEN 'guarantees' THEN jsonb_array_length(guarantees) > 0
                AND jsonb_array_length("interface") > 0
                AND scope_boundaries = '[]'::jsonb
            ELSE guarantees = '[]'::jsonb
                AND "interface" = '[]'::jsonb
                AND exclusions = '[]'::jsonb
        END
    );
