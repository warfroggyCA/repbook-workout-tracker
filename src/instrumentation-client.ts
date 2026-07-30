import { z } from "zod";

// The production CSP intentionally forbids eval. Configure Zod before any
// browser application module initializes a schema so its CSP-safe parser is
// used consistently across every route.
z.config({ jitless: true });
