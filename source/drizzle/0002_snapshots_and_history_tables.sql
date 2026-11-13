DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE snapshots (
  key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  source TEXT NOT NULL,
  as_of TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  fetched_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE history_points (
  series TEXT NOT NULL,
  date TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (series, date)
);
