# Athlete coaching product requirements

Status: canonical athlete-facing product requirements.

These requirements apply to coaching, Program evaluation, workout completion,
progression, exercise selection, History/Review interpretation, and athlete-facing
intelligence. They are subordinate to the source-of-truth, historical-evidence,
privacy, and approval-gating contracts in `AGENTS.md` and `docs/ARCHITECTURE.md`.
They are not optional UX suggestions: an implementation that touches these areas
must satisfy them or explicitly document a bounded deferral.

## 1. Product objective

Repbook should help a serious returning lifter build muscle, improve visible
physique, train consistently, and manage recovery without becoming nagging,
generic, or over-prescriptive.

The athlete may deliberately prioritize visual development of specific muscle
groups while still wanting a balanced whole-body Program. The product must
preserve those priorities rather than flattening every Program into generic
strength or wellness advice.

The Coach should optimize for repeatable productive training over time, not for
short workouts, maximal fatigue, maximal soreness, or arbitrary exercise count.

## 2. Workout duration is context, not a score

A longer workout is not automatically a bad workout.

- Compare actual duration with the Program day's frozen planned duration when
  that evidence exists; never use one global duration target for every routine.
- Deliberately longer rest periods may be appropriate for high-quality compound
  work, heavier sets, joint comfort, equipment transitions, or maintaining
  performance across working sets.
- Do not reduce adherence, quality, or completion merely because a session ran
  longer than expected.
- Duration becomes coaching-relevant when repeated over-time evidence connects it
  with missed training, deteriorating performance, poor recovery, pain, or the
  athlete explicitly wanting shorter sessions.
- The UI may say a workout ran long. It must not silently translate that fact
  into a coaching failure.
- Never infer fatigue, low motivation, or a time-limit cause from elapsed time.

## 3. Rest-period interpretation

Rest duration should serve performance and recovery, not a universal stopwatch.

- Compound and technically demanding work may require longer rest than isolation
  work.
- If the athlete is intentionally taking longer rest and performance remains
  stable or improves, the Coach should not penalize the workout solely for rest
  duration.
- Shorter rest may be suggested only when it is compatible with the exercise,
  goal, performance evidence, and athlete preference.
- Timer UX must make the planned rest visible but allow an intentional extension
  without implying non-compliance.
- Rest recommendations must remain exercise- and context-specific rather than
  enforcing a single global target.

## 4. Completion and interruption semantics

Workout outcome must keep completion, remaining work, cause, and technical
interruption separate.

At minimum, athlete-facing semantics must distinguish:

- completed normally;
- completed with intentional cuts;
- completed with optional work omitted;
- completed with required work remaining;
- interrupted by a technical/app problem;
- interrupted by an external event;
- ended because of pain/discomfort;
- ended because of fatigue;
- ended because of an external time constraint;
- abandoned before meaningful work;
- abandoned after meaningful work;
- historical/legacy outcome unknown.

A technical/app interruption is not an adherence failure.

When a timer, save, crash, reload, sleep/wake, network, or other app issue
interrupts a workout:

- preserve every durable completed set and exact performed evidence;
- preserve unknowns instead of inventing a motive or training cause;
- do not infer lack of commitment, fatigue, or poor adherence;
- do not automatically down-regulate the future Program;
- surface product reliability separately from athlete performance;
- allow the athlete to identify the session as technically interrupted when the
  system cannot determine that fact itself.

## 5. Workout-priority tiers

Repbook should support an explicit priority model so the athlete and Coach know
what to protect when time, fatigue, pain, or interruption forces a shorter
session.

Use three conceptual tiers:

- **Tier 1 — primary work:** highest-value work for the Program day's objective;
- **Tier 2 — important accessories:** meaningful secondary work;
- **Tier 3 — optional bonus work:** finishers, extra sets, carries, or other work
  that can be omitted without invalidating an otherwise productive session.

Requirements:

- Priority must be explicit Program meaning or a versioned reviewed projection;
  never infer it solely from display name or exercise order.
- Tier 1 completion should carry more coaching weight than optional volume.
- If Tier 1 is completed and lower-priority work is intentionally omitted, the
  product should be able to describe the session as productive rather than
  simply incomplete.
- Historical sessions must retain the priority semantics frozen at workout
  start; later Program edits must not reinterpret them.

## 6. Balanced Program plus physique priorities

The athlete may want a well-rounded Program while emphasizing particular visual
outcomes such as chest, shoulders, arms, and forearms/grip.

Repbook must support both ideas simultaneously.

- Preserve whole-body balance and recovery constraints.
- Allow owner-selected muscle-group priorities to influence future Program
  proposals and Coach interpretation.
- Distinguish direct target-muscle work from indirect contribution.
- Do not count every press as equivalent chest/shoulder/triceps stimulus or every
  pull as equivalent biceps/forearm stimulus.
- Prefer repeatable high-value weekly volume over random extra exercises and junk
  volume.
- Review priority muscles across the training week, not just within one session.
- Do not let a priority-muscle goal silently remove necessary pulling, lower-body,
  posterior-chain, scapular, or other balancing work.
- Program changes remain proposals until explicitly accepted by the athlete.

## 7. Chest development requirements

When chest is an athlete-selected priority, Program evaluation should consider:

- sufficient weekly direct pressing volume;
- both horizontal and incline/upper-chest-biased exposure when compatible with
  equipment and joint tolerance;
- stable progression on exact exercise variants;
- fatigue overlap with anterior delts and triceps;
- whether extra volume is actually recoverable rather than simply addable.

The Coach should favour repeatable pressing quality and progressive overload over
maximal set count.

## 8. Shoulder development requirements

When shoulders are a priority, do not treat pressing alone as complete shoulder
training.

Program evaluation should distinguish at least:

- anterior-delt contribution from pressing;
- direct lateral-delt work;
- direct or meaningful rear-delt/scapular work;
- overhead pressing when appropriate for the athlete and Program.

The Coach should be able to identify underexposed lateral/rear-delt work even
when total pressing volume is high.

## 9. Arm and forearm development requirements

When arms/forearms are priorities, the Program should evaluate direct and
indirect exposure separately.

- Biceps: direct elbow-flexion work plus pulling contribution.
- Triceps: direct elbow-extension work plus pressing contribution.
- Forearms/grip: direct forearm work plus grip demand from rows, hinges, carries,
  and similar work.
- Do not count indirect contribution as a one-for-one replacement for direct
  priority work.
- Avoid adding redundant isolation volume solely to increase exercise count.

## 10. Zottman Curl is a first-class exact exercise variant

The exercise system must support **Zottman Curl** as an exact exercise variant.
It must not be silently normalized to Hammer Curl, Standard Curl, Reverse Curl,
or a generic curl family for progression purposes.

If the Program contains Zottman Curl:

- preserve it as the authored exercise;
- keep its progression history separate from other curl variants;
- allow substitution only through the normal explicit substitution/Program
  change pathways;
- broad reporting may classify it under a curl/forearm family, but load records,
  targets, comparisons, and progression remain exact-variant specific.

Coach execution guidance may describe the movement as a supinated concentric,
rotation near the top, and controlled pronated eccentric. Guidance should favour
controlled moderate loading and clean repetitions rather than repeated maximal
loading.

## 11. Exercise-prescription quality

A Program recommendation should be evaluated on more than whether every major
movement family appears once.

For each exercise, preserve or support explicit intent such as:

- primary strength/hypertrophy work;
- secondary hypertrophy/accessory work;
- direct priority-muscle work;
- balance/prehab-supportive work;
- optional finisher/conditioning work.

The Coach must not silently substitute exercises because two names look similar.
Equipment compatibility, exact variant identity, historical progression,
athlete preference, and joint comfort matter.

## 12. Progression and effort

Progression should maximize repeatable productive work, not repeated grinders.

- Increase load or difficulty only when relevant evidence supports it.
- Main compound work should usually remain submaximal enough to preserve
  technique and repeated performance.
- High effort, technique deterioration, pain, or unstable repetitions are
  reasons to hold or reduce progression rather than force it.
- Isolation work may approach failure more closely when joint comfort and form
  remain good, but repeated maximal effort is not the default.
- A missed load increase is not a failure when repetitions, technique, range of
  motion, or total quality work improve.
- Unknown or incomparable evidence must remain unknown rather than being used to
  manufacture a progression signal.

## 13. Recovery-aware coaching without age stereotypes

Repbook should support recovery-aware coaching for adult and older lifters
without using age alone as a reason to reduce ambition.

- Do not assume an older athlete cannot build substantial muscle or visual
  definition.
- Use actual evidence: performance trend, session frequency, pain, fatigue,
  technique, sleep/readiness inputs when available, and recovery between
  sessions.
- Protect joints and connective tissue through exercise choice, progression
  quality, sensible effort, and recoverable volume rather than generic
  age-based restrictions.
- Avoid sudden volume or load jumps simply because motivation is high.

## 14. Coach communication style

Athlete-facing intelligence should be concise, evidence-backed, and actionable.

Good examples of behaviour:

- identify one useful next action rather than flooding the screen;
- explain whether the signal came from Program intent, performed evidence, or a
  deterministic rule;
- acknowledge when a longer workout was still productive;
- distinguish technical interruption from training failure;
- say when evidence is insufficient;
- protect athlete-selected priorities while still flagging clear balance or
  recovery issues.

Avoid:

- generic praise;
- arbitrary warnings based on duration alone;
- nagging about optional work;
- treating every incomplete session as poor adherence;
- inventing causes for missing work;
- automatic Program mutation;
- substituting broad movement-family similarity for exact exercise intent.

## 15. Required athlete controls

The product should expose durable owner controls for the semantics the Coach
cannot safely infer. Exact UI is implementation-dependent, but the product must
be able to represent:

- selected physique/muscle-group priorities;
- whether a Program item is primary, important accessory, or optional;
- why a workout with remaining work ended;
- whether an interruption was technical/app-related;
- an intentional exercise substitution versus a future Program edit;
- explicit acceptance/rejection of consequential Program recommendations.

Missing controls must remain missing/unknown; do not replace them with guessed
facts.

## 16. Acceptance criteria

A coaching/product change is not complete unless the relevant tests prove these
behaviours:

1. A long workout with stable productive performance is not automatically scored
   or described as poor execution.
2. Intentional longer rest can be represented without producing an adherence
   penalty.
3. A technical/app interruption does not become fatigue, user-choice, or poor
   adherence by inference.
4. Completed sets survive an interrupted/ended-early workflow exactly.
5. Tier 1, Tier 2, and Tier 3 semantics can influence workout interpretation
   without rewriting historical Program meaning.
6. A productive session with optional work omitted can be distinguished from one
   that missed primary work.
7. Athlete-selected physique priorities can coexist with whole-body balance.
8. Chest, shoulder, arm, and forearm exposure can be evaluated distinctly enough
   that pressing/pulling alone does not falsely imply complete direct work.
9. Zottman Curl remains an exact exercise identity and is not silently replaced
   or progression-merged with Hammer Curl or another curl variant.
10. Any consequential future Program change remains approval-gated.
11. Unknown evidence remains unknown.
12. Current workout, History, Review, and Coach use compatible semantics for the
   same interruption, priority, and exercise-identity facts.
