CREATE TABLE "databricks_discovery_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by_user_id" text NOT NULL,
	"workspace_host" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_material" jsonb NOT NULL,
	"credential_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "databricks_discovery_sessions" ADD CONSTRAINT "databricks_discovery_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "databricks_discovery_sessions_company_user_idx" ON "databricks_discovery_sessions" USING btree ("company_id","created_by_user_id");--> statement-breakpoint
CREATE INDEX "databricks_discovery_sessions_expires_idx" ON "databricks_discovery_sessions" USING btree ("expires_at");