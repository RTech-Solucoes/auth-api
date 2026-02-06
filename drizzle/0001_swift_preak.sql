ALTER TABLE "tokens" ALTER COLUMN "tenant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "tenant_id" DROP NOT NULL;