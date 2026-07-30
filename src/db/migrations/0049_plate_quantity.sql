ALTER TABLE "plate_inventory" RENAME COLUMN "count_per_side" TO "quantity";--> statement-breakpoint
UPDATE "plate_inventory" SET "quantity" = "quantity" * 2;
