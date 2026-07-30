-- The expand/preview/contract sequence intentionally split the generated
-- schema change across 0043-0045. This no-op checkpoint aligns Drizzle's
-- schema snapshot with that already-applied contract for future generations.
SELECT 1;
