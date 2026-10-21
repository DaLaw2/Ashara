-- Every inbound client message is owed one receipt: an outbound report in reply to it that the
-- Liaison posts the cycle the message is first seen, stating the project's state and what happens to
-- the message. The receipt names the message it answers in receipt_of, whose unique index admits one
-- receipt per message, so a receipt posted before a restart is never posted again.
--
-- A message the Liaison had already consumed when receipts began was acted on and answered by its
-- own reader then: it is owed none (receipt_waived). A message still unconsumed is owed one.

ALTER TABLE public.client_messages
    ADD COLUMN receipt_of uuid,
    ADD COLUMN receipt_waived boolean DEFAULT false NOT NULL,
    ADD CONSTRAINT client_messages_receipt_of_fkey FOREIGN KEY (receipt_of) REFERENCES public.client_messages(id),
    ADD CONSTRAINT client_messages_receipt_replies CHECK (((receipt_of IS NULL) OR (((direction)::text = 'outbound'::text) AND ((kind)::text = 'report'::text) AND (reports_on IS NULL) AND (in_reply_to = receipt_of)))),
    ADD CONSTRAINT client_messages_receipt_waived_inbound CHECK (((NOT receipt_waived) OR ((direction)::text = 'inbound'::text)));

CREATE UNIQUE INDEX client_messages_one_receipt_per_message ON public.client_messages USING btree (receipt_of);

UPDATE public.client_messages SET receipt_waived = true WHERE direction = 'inbound' AND consumed_at IS NOT NULL;
