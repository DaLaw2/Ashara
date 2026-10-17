-- Migration 079: every claim that leaves an item undecided is tied to it (task t-run-report-wiring-guard).
--
-- undecided_items holds one row per check task and item (migration 069), and its claim_id names only
-- the claim that kept the row first: a later claim covering the same check task that leaves the same
-- item undecided wrote nothing, so it read back as leaving nothing unverified.
--
-- undecided_item_claims (Quality): one row per claim and item it leaves undecided, every claim
-- included, the first among them. The readers list a claim's items through it, never through
-- undecided_items.claim_id. undecided_items.claim_id keeps naming the claim that kept the row first
-- (undecided_items_one_source is unchanged), and the deferred foreign key below holds it to a row
-- here, so no row tied to a claim lacks its link. Append-only.

CREATE TABLE undecided_item_claims (
  claim_id UUID NOT NULL REFERENCES suite_review_claims(id) ON DELETE CASCADE,
  check_task_id UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL CHECK (length(item_id) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (claim_id, check_task_id, item_id)
);

CREATE INDEX undecided_item_claims_item ON undecided_item_claims (check_task_id, item_id);

CREATE OR REPLACE FUNCTION undecided_item_claims_refuse_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'undecided_item_claims is append-only (item % of check task %, claim %)', OLD.item_id, OLD.check_task_id, OLD.claim_id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER undecided_item_claims_append_only
  BEFORE UPDATE ON undecided_item_claims
  FOR EACH ROW EXECUTE FUNCTION undecided_item_claims_refuse_update();

INSERT INTO undecided_item_claims (claim_id, check_task_id, item_id, created_at)
SELECT claim_id, check_task_id, item_id, created_at FROM undecided_items WHERE claim_id IS NOT NULL;

ALTER TABLE undecided_items
  ADD CONSTRAINT undecided_items_claim_linked FOREIGN KEY (claim_id, check_task_id, item_id)
    REFERENCES undecided_item_claims (claim_id, check_task_id, item_id)
    DEFERRABLE INITIALLY DEFERRED;
