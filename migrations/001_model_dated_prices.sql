-- Scheduled price changes: rates that replace a model's base rates from an instant on, so a call
-- is priced by the rate in force at its time rather than by today's rate after a provider's
-- announced change. A model with no row here bills its model_configs rates at every instant.

CREATE TABLE public.model_dated_prices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    model_id text NOT NULL,
    effective_from timestamp with time zone NOT NULL,
    input_cost_per_1m double precision NOT NULL,
    output_cost_per_1m double precision NOT NULL,
    cache_read_cost_per_1m double precision,
    cache_write_cost_per_1m double precision,
    CONSTRAINT model_dated_prices_pkey PRIMARY KEY (id),
    CONSTRAINT model_dated_prices_model_id_effective_from_key UNIQUE (model_id, effective_from),
    CONSTRAINT model_dated_prices_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.model_configs(model_id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT model_dated_prices_input_cost_per_1m_check CHECK ((input_cost_per_1m > (0)::double precision)),
    CONSTRAINT model_dated_prices_output_cost_per_1m_check CHECK ((output_cost_per_1m > (0)::double precision)),
    CONSTRAINT model_dated_prices_cache_read_cost_per_1m_check CHECK (((cache_read_cost_per_1m IS NULL) OR (cache_read_cost_per_1m >= (0)::double precision))),
    CONSTRAINT model_dated_prices_cache_write_cost_per_1m_check CHECK (((cache_write_cost_per_1m IS NULL) OR (cache_write_cost_per_1m >= (0)::double precision)))
);

-- The provider states each change by calendar day only; the day is read as starting at 00:00 UTC.
-- Neither model bills cache writes, so the cache write rate stays NULL as in its base row.
INSERT INTO public.model_dated_prices (model_id, effective_from, input_cost_per_1m, output_cost_per_1m, cache_read_cost_per_1m, cache_write_cost_per_1m) VALUES
  ('gemini-4-argon', '2026-12-01T00:00:00Z', 4, 20, 0.2, NULL),
  ('gemini-3.8-flash', '2027-01-01T00:00:00Z', 1.5, 7.5, 0.15, NULL);
