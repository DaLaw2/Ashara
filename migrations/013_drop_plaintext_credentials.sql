-- Migration 013: drop the plaintext credential paths (ADR-075 C3, C4).
--
-- Provider API keys and the server API token now live only in the encrypted
-- secret store (migration 012). Fail closed: if any plaintext credential is
-- still here, dropping it would destroy the only copy, so the migration refuses
-- and names the command that moves it into the store first. On a fresh
-- database there is nothing to move and it passes.

DO $$
DECLARE
  plaintext_keys INTEGER;
  token_rows INTEGER;
BEGIN
  SELECT count(*) INTO plaintext_keys FROM provider_configs
    WHERE api_key IS NOT NULL AND api_key <> '';
  SELECT count(*) INTO token_rows FROM system_settings WHERE key = 'api_token';
  IF plaintext_keys > 0 OR token_rows > 0 THEN
    RAISE EXCEPTION
      'Plaintext credentials remain: % provider_configs.api_key value(s), % system_settings ''api_token'' row(s). Run `npx tsx scripts/secret.ts import-legacy` to move them into the secret store, then re-run migrations.',
      plaintext_keys, token_rows;
  END IF;
END
$$;

ALTER TABLE provider_configs DROP COLUMN api_key;
