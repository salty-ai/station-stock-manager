ALTER TABLE "widget_settings" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "widget_settings" CASCADE;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_unique" UNIQUE("email");