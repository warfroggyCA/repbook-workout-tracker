ALTER TYPE "public"."substitution_reason"
  ADD VALUE IF NOT EXISTS 'equipment_unavailable_incompatible'
  AFTER 'equipment_busy';
