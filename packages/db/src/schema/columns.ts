import { timestamp } from "drizzle-orm/pg-core";

export function timestamptz(name?: string) {
  return name
    ? timestamp(name, { withTimezone: true })
    : timestamp({ withTimezone: true });
}
