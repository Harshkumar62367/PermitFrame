CREATE TABLE "campaign_assets" (
	"job_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"receipt_id" text,
	"storage_provider" text DEFAULT 'cloudinary' NOT NULL,
	"storage_public_id" text,
	"storage_version" integer,
	"storage_url" text,
	"storage_resource_type" text,
	"storage_format" text,
	"storage_bytes" integer,
	"storage_width" integer,
	"storage_height" integer,
	"storage_duration" real,
	"storage_status" text DEFAULT 'pending' NOT NULL,
	"storage_error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"persisted_at" timestamp with time zone,
	"provider_url" text,
	"provider_job_id" text,
	"provider_model" text,
	"provider_cost" text,
	"prompt_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_assets" ADD CONSTRAINT "campaign_assets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_assets_workspace_campaign_idx" ON "campaign_assets" USING btree ("workspace_id","campaign_id");--> statement-breakpoint
CREATE INDEX "campaign_assets_status_idx" ON "campaign_assets" USING btree ("storage_status");