CREATE TABLE "exercise_execution_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exercise_id" uuid NOT NULL,
	"required_profile_kind" text,
	"required_equipment_definition_id" uuid,
	"required_attachment_kind" text,
	"required_attachment_definition_id" uuid,
	"requires_known_geometry" boolean DEFAULT false NOT NULL,
	"review_notes" text,
	"reviewed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exercise_execution_requirements_exact_predicate_check" CHECK (
		"required_profile_kind" IS NOT NULL
		OR "required_equipment_definition_id" IS NOT NULL
		OR "required_attachment_kind" IS NOT NULL
		OR "required_attachment_definition_id" IS NOT NULL
		OR "requires_known_geometry"
	),
	CONSTRAINT "exercise_execution_requirements_profile_kind_check" CHECK (
		"required_profile_kind" IS NULL
		OR length(btrim("required_profile_kind")) > 0
	),
	CONSTRAINT "exercise_execution_requirements_attachment_kind_check" CHECK (
		"required_attachment_kind" IS NULL
		OR length(btrim("required_attachment_kind")) > 0
	)
);--> statement-breakpoint
ALTER TABLE "exercise_execution_requirements" ADD CONSTRAINT "exercise_execution_requirements_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exercise_execution_requirements" ADD CONSTRAINT "exercise_execution_requirements_equipment_definition_fk" FOREIGN KEY ("required_equipment_definition_id") REFERENCES "public"."equipment_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exercise_execution_requirements" ADD CONSTRAINT "exercise_execution_requirements_attachment_definition_fk" FOREIGN KEY ("required_attachment_definition_id") REFERENCES "public"."equipment_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exercise_execution_requirements_exercise_uq" ON "exercise_execution_requirements" USING btree ("exercise_id");--> statement-breakpoint
CREATE INDEX "exercise_execution_requirements_equipment_definition_idx" ON "exercise_execution_requirements" USING btree ("required_equipment_definition_id");--> statement-breakpoint
CREATE INDEX "exercise_execution_requirements_attachment_definition_idx" ON "exercise_execution_requirements" USING btree ("required_attachment_definition_id");
