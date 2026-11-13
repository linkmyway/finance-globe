import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Latest snapshot per data block (fx / mag7 / rates / m2 / rents / volatility).
// payload is the block's typed JSON; source + as_of are rendered on the page
// next to every block per the artifact's honesty rules.
export const snapshots = sqliteTable("snapshots", {
  key: text("key").primaryKey(),
  payload: text("payload").notNull(),
  source: text("source").notNull(),
  asOf: text("as_of").notNull(),
  status: text("status", { enum: ["ok", "stale"] })
    .notNull()
    .default("ok"),
  fetchedAt: integer("fetched_at").notNull(),
});

// Bounded daily history for trend sparklines (Mag7 market cap, FX rates).
// Cap 7 rows (series "cap:<CODE>") additionally carry the tracked company
// count and a provenance tag per point: companies drives the
// coverage-change flag on decomposition windows, source distinguishes
// Wayback archive backfill points ("wayback-backfill") from live daily
// refresh points ("live"). Both stay null for non-cap series and for
// cap points written before the backfill landed.
export const historyPoints = sqliteTable("history_points", {
  series: text("series").notNull(),
  date: text("date").notNull(),
  value: real("value").notNull(),
  companies: integer("companies"),
  source: text("source"),
});
