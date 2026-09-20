CREATE TABLE "campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"status" text NOT NULL,
	"title" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"campaign_id" text,
	"kind" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"summary" text NOT NULL,
	"refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_events" ADD CONSTRAINT "workspace_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaigns_workspace_idx" ON "campaigns" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "workspace_events_workspace_at_idx" ON "workspace_events" USING btree ("workspace_id","at");--> statement-breakpoint
CREATE INDEX "workspace_events_campaign_at_idx" ON "workspace_events" USING btree ("campaign_id","at");