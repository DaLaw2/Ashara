-- Migration 029: provider_type, not the row name, selects the SDK adapter
-- (story s-isolated-worker-m1, task t-gateway-turn-api).
--
-- The gateway picked its adapter by provider_configs.name ('deepseek' got
-- @ai-sdk/deepseek, 'local' could lack a key). It now reads provider_type, so a
-- row of any name reaches the right adapter. 002 seeded both 'deepseek' and
-- 'local' as 'openai-compatible', which under type dispatch would move DeepSeek
-- off its own adapter and require a key for the local endpoint. This re-types
-- those two seeded rows only where they still carry 002's value; a row an
-- operator re-typed is left alone. A NOTICE reports the count.
--
-- The known types are the gateway's PROVIDER_TYPES; a row with any other
-- provider_type makes the gateway refuse to start (InvalidGatewayCatalog).

DO $$
DECLARE
  retyped INTEGER;
BEGIN
  UPDATE provider_configs
     SET provider_type = name, updated_at = NOW()
   WHERE name IN ('deepseek', 'local')
     AND provider_type = 'openai-compatible';
  GET DIAGNOSTICS retyped = ROW_COUNT;
  RAISE NOTICE 'provider_configs re-typed by name (deepseek, local): % row(s)', retyped;
END
$$;
