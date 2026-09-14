CREATE TABLE IF NOT EXISTS "application_state" (
  "id" text PRIMARY KEY NOT NULL,
  "data" jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
