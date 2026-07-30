/**
 * Injury-constraint flags per movement pattern (plan §4 step 3, §7).
 * `avoid` patterns are excluded from all suggestions; `cautious` patterns are
 * allowed but flagged in the UI and freeze-checked by progression rules.
 */

export type UserConstraint = {
  bodyPart: string;
  affectedPatterns: string[];
  avoid: boolean;
  cautious: boolean;
  painStopThreshold: number;
};

export type PatternFlag = {
  avoid: boolean;
  cautious: boolean;
  bodyParts: string[];
};

export function patternFlags(
  constraints: UserConstraint[]
): Map<string, PatternFlag> {
  const flags = new Map<string, PatternFlag>();
  for (const c of constraints) {
    for (const pattern of c.affectedPatterns) {
      const flag = flags.get(pattern) ?? {
        avoid: false,
        cautious: false,
        bodyParts: [],
      };
      flag.avoid ||= c.avoid;
      flag.cautious ||= c.cautious;
      if (!flag.bodyParts.includes(c.bodyPart)) flag.bodyParts.push(c.bodyPart);
      flags.set(pattern, flag);
    }
  }
  return flags;
}

export function isPatternAllowedForSuggestions(
  pattern: string,
  constraints: UserConstraint[]
): boolean {
  return !(patternFlags(constraints).get(pattern)?.avoid ?? false);
}
