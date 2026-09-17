CREATE TABLE "verification_snapshots" (
	"ref" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
