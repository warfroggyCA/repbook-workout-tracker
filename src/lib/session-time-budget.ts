import { z } from "zod";

export const SESSION_TIME_BUDGET_MIN = 5;
export const SESSION_TIME_BUDGET_MAX = 600;

export const sessionTimeBudgetSchema = z
  .number()
  .int()
  .min(SESSION_TIME_BUDGET_MIN)
  .max(SESSION_TIME_BUDGET_MAX)
  .optional();
