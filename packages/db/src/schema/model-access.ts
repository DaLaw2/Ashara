import { pgTable, uuid, text, integer, smallint, doublePrecision, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamptz } from "./columns.js";

// Model Access: providers, models and their prices.

// ---------------------------------------------------------------------------
// provider_configs
// ---------------------------------------------------------------------------

// Provider API keys live in the secret store as provider/<name>/api_key, never
// here (ADR-075 C2); migration 013 drops the plaintext api_key column.
export const providerConfigs = pgTable("provider_configs", {
  id: uuid().primaryKey().default(sql`gen_random_uuid()`),
  name: text().notNull().unique(),
  providerType: text("provider_type").notNull(),
  baseUrl: text("base_url"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// model_configs
// ---------------------------------------------------------------------------

export const modelConfigs = pgTable("model_configs", {
  id: uuid().primaryKey().default(sql`gen_random_uuid()`),
  modelId: text("model_id").notNull().unique(),
  providerName: text("provider_name")
    .notNull()
    .references(() => providerConfigs.name),
  apiModelId: text("api_model_id"),
  capability: text().notNull(),
  // No defaults (migration 054): a forgotten price would read as a free model, a forgotten window as a measured one.
  inputCostPer1m: doublePrecision("input_cost_per_1m").notNull(),
  outputCostPer1m: doublePrecision("output_cost_per_1m").notNull(),
  maxContextTokens: integer("max_context_tokens").notNull(),
  cacheReadCostPer1m: doublePrecision("cache_read_cost_per_1m"),
  cacheWriteCostPer1m: doublePrecision("cache_write_cost_per_1m"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// model_price_windows (migration 021): time-of-day rates replacing a model's base rates
// ---------------------------------------------------------------------------

export const modelPriceWindows = pgTable("model_price_windows", {
  id: uuid().primaryKey().default(sql`gen_random_uuid()`),
  modelId: text("model_id")
    .notNull()
    .references(() => modelConfigs.modelId, { onDelete: "cascade", onUpdate: "cascade" }),
  isoWeekday: smallint("iso_weekday").notNull(),
  utcStartMinute: smallint("utc_start_minute").notNull(),
  utcEndMinute: smallint("utc_end_minute").notNull(),
  inputCostPer1m: doublePrecision("input_cost_per_1m").notNull(),
  outputCostPer1m: doublePrecision("output_cost_per_1m").notNull(),
  cacheReadCostPer1m: doublePrecision("cache_read_cost_per_1m"),
  cacheWriteCostPer1m: doublePrecision("cache_write_cost_per_1m"),
}, (t) => ({
  modelWeekdayStartUnique: unique("model_price_windows_model_id_iso_weekday_utc_start_minute_key")
    .on(t.modelId, t.isoWeekday, t.utcStartMinute),
}));

// ---------------------------------------------------------------------------
// model_price_tiers (migration 047): prompt-length rates replacing a model's base rates
// ---------------------------------------------------------------------------

export const modelPriceTiers = pgTable("model_price_tiers", {
  id: uuid().primaryKey().default(sql`gen_random_uuid()`),
  modelId: text("model_id")
    .notNull()
    .references(() => modelConfigs.modelId, { onDelete: "cascade", onUpdate: "cascade" }),
  minInputTokens: integer("min_input_tokens").notNull(),
  inputCostPer1m: doublePrecision("input_cost_per_1m").notNull(),
  outputCostPer1m: doublePrecision("output_cost_per_1m").notNull(),
  cacheReadCostPer1m: doublePrecision("cache_read_cost_per_1m"),
  cacheWriteCostPer1m: doublePrecision("cache_write_cost_per_1m"),
}, (t) => ({
  modelThresholdUnique: unique("model_price_tiers_model_id_min_input_tokens_key").on(t.modelId, t.minInputTokens),
}));
