"use client";

import Link from "next/link";
import {
  useMemo,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { createActivity, updateActivity } from "@/app/actions/activities";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ACTIVITY_INTENSITIES,
  ACTIVITY_TYPES,
  activityUsesSpeed,
  dateTimeLocalInZoneToDate,
  formatActivityPace,
  formatActivitySpeed,
  formatDateTimeLocalInZone,
  parseActivityDurationParts,
  type ActivityInput,
  type ActivityIntensity,
  type ActivityType,
  type DistanceUnit,
  type ElevationUnit,
} from "@/lib/activities";

type ExactActivityInput = Extract<ActivityInput, { durationSeconds: number }>;
export type ActivityFormInitialValues = Omit<
  ExactActivityInput,
  | "durationMinutes"
  | "durationSeconds"
  | "distanceValue"
  | "elevationValue"
  | "averageHeartRateBpm"
  | "energyKcal"
> & {
  durationSeconds: number;
  distanceValue: number | null;
  elevationValue: number | null;
  averageHeartRateBpm: number | null;
  energyKcal: number | null;
};

function nowForDateTimeInput() {
  return formatDateTimeLocalInZone(
    new Date(),
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  );
}

function optionalNumber(value: string) {
  return value.trim() ? Number(value) : null;
}

const selectClassName =
  "h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
const subscribeToHydration = () => () => undefined;
const getClientHydrationSnapshot = () => true;
const getServerHydrationSnapshot = () => false;

export function ActivityForm({
  ...props
}: {
  activityId?: string;
  initialValues?: ActivityFormInitialValues;
  successHref?: string;
  cancelHref?: string;
}) {
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    getClientHydrationSnapshot,
    getServerHydrationSnapshot
  );

  if (!hydrated) {
    return (
      <div className="flex min-h-96 items-center justify-center text-sm text-muted-foreground">
        Preparing activity form…
      </div>
    );
  }

  return <ActivityFormFields {...props} />;
}

function ActivityFormFields({
  activityId,
  initialValues,
  successHref,
  cancelHref = "/history",
}: {
  activityId?: string;
  initialValues?: ActivityFormInitialValues;
  successHref?: string;
  cancelHref?: string;
}) {
  const router = useRouter();
  const [activityType, setActivityType] = useState<ActivityType>(
    initialValues?.activityType ?? "walk"
  );
  const [title, setTitle] = useState(initialValues?.title ?? "");
  const [startedAtLocal, setStartedAtLocal] = useState(() =>
    initialValues
      ? formatDateTimeLocalInZone(
          new Date(initialValues.startedAtISO),
          initialValues.timezone
        )
      : nowForDateTimeInput()
  );
  const [durationMinutes, setDurationMinutes] = useState(() =>
    initialValues
      ? String(Math.floor(initialValues.durationSeconds / 60))
      : "",
  );
  const [durationSecondsPart, setDurationSecondsPart] = useState(() =>
    initialValues
      ? String(initialValues.durationSeconds % 60)
      : "",
  );
  const [distanceValue, setDistanceValue] = useState(
    initialValues?.distanceValue == null
      ? ""
      : String(initialValues.distanceValue)
  );
  const [distanceUnit, setDistanceUnit] = useState<DistanceUnit>(
    initialValues?.distanceUnit ?? "km"
  );
  const [intensity, setIntensity] = useState<ActivityIntensity | "">(
    initialValues?.intensity ?? ""
  );
  const [elevationValue, setElevationValue] = useState(
    initialValues?.elevationValue == null
      ? ""
      : String(initialValues.elevationValue)
  );
  const [elevationUnit, setElevationUnit] = useState<ElevationUnit>(
    initialValues?.elevationUnit ?? "m"
  );
  const [heartRate, setHeartRate] = useState(
    initialValues?.averageHeartRateBpm == null
      ? ""
      : String(initialValues.averageHeartRateBpm)
  );
  const [energy, setEnergy] = useState(
    initialValues?.energyKcal == null
      ? ""
      : String(initialValues.energyKcal)
  );
  const [notes, setNotes] = useState(initialValues?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const pacePreview = useMemo(() => {
    const durationSeconds = parseActivityDurationParts(
      durationMinutes,
      durationSecondsPart,
    );
    const distance = Number(distanceValue);
    if (durationSeconds == null || !(distance > 0)) return null;
    const distanceKm = distanceUnit === "mi" ? distance * 1.609344 : distance;
    const secondsPerKm = durationSeconds / distanceKm;
    return activityUsesSpeed(activityType)
      ? formatActivitySpeed(secondsPerKm)
      : formatActivityPace(secondsPerKm);
  }, [
    activityType,
    distanceUnit,
    distanceValue,
    durationMinutes,
    durationSecondsPart,
  ]);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const timezone =
      initialValues?.timezone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone ??
      "UTC";
    const startedAt = dateTimeLocalInZoneToDate(startedAtLocal, timezone);
    if (!startedAt) {
      setError("Choose a valid activity date and time.");
      return;
    }
    const durationSeconds = parseActivityDurationParts(
      durationMinutes,
      durationSecondsPart,
    );
    if (durationSeconds == null) {
      setError(
        "Enter a duration between 1 second and 7 days. Seconds must be from 0 to 59.",
      );
      return;
    }

    const input: ActivityInput = {
      activityType,
      title: title.trim() || null,
      startedAtISO: startedAt.toISOString(),
      timezone,
      durationSeconds,
      distanceValue: optionalNumber(distanceValue),
      distanceUnit,
      intensity: intensity || null,
      elevationValue: optionalNumber(elevationValue),
      elevationUnit,
      averageHeartRateBpm: optionalNumber(heartRate),
      energyKcal: optionalNumber(energy),
      notes: notes.trim() || null,
    };

    startTransition(async () => {
      const result = activityId
        ? await updateActivity(activityId, input)
        : await createActivity(input);
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      router.push(successHref ?? `/activity/${result.id}`);
      router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="activity-type">Activity type</Label>
          <select
            id="activity-type"
            className={selectClassName}
            value={activityType}
            onChange={(event) => setActivityType(event.target.value as ActivityType)}
          >
            {ACTIVITY_TYPES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="activity-title">Title (optional)</Label>
          <Input
            id="activity-title"
            value={title}
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Power walk, waterfront route…"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="activity-started">Date and start time</Label>
          <Input
            id="activity-started"
            type="datetime-local"
            required
            value={startedAtLocal}
            onChange={(event) => setStartedAtLocal(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Saved with your device timezone.
          </p>
        </div>
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="text-sm font-medium">Duration</legend>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="activity-duration-minutes">Minutes</Label>
              <Input
                id="activity-duration-minutes"
                type="text"
                inputMode="numeric"
                maxLength={5}
                pattern="[0-9]*"
                required
                aria-describedby="activity-duration-help"
                value={durationMinutes}
                onChange={(event) => setDurationMinutes(event.target.value)}
                placeholder="42"
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="activity-duration-seconds">Seconds</Label>
              <Input
                id="activity-duration-seconds"
                type="text"
                inputMode="numeric"
                maxLength={2}
                pattern="[0-9]*"
                aria-describedby="activity-duration-help"
                value={durationSecondsPart}
                onChange={(event) => setDurationSecondsPart(event.target.value)}
                placeholder="30"
              />
            </div>
          </div>
          <p id="activity-duration-help" className="text-xs text-muted-foreground">
            Enter minutes and seconds separately. Leave seconds blank for whole minutes.
          </p>
        </fieldset>
        <div className="flex flex-col gap-2">
          <Label htmlFor="activity-distance">Distance (optional)</Label>
          <div className="flex gap-2">
            <Input
              id="activity-distance"
              type="number"
              inputMode="decimal"
              min={0.01}
              max={10_000}
              step="any"
              value={distanceValue}
              onChange={(event) => setDistanceValue(event.target.value)}
              placeholder="3.5"
            />
            <select
              aria-label="Distance unit"
              className={`${selectClassName} w-24`}
              value={distanceUnit}
              onChange={(event) => setDistanceUnit(event.target.value as DistanceUnit)}
            >
              <option value="km">km</option>
              <option value="mi">mi</option>
            </select>
          </div>
          {pacePreview && (
            <p className="text-xs font-medium text-primary">
              Average {activityUsesSpeed(activityType) ? "speed" : "pace"}: {pacePreview}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="activity-intensity">Intensity (optional)</Label>
          <select
            id="activity-intensity"
            className={selectClassName}
            value={intensity}
            onChange={(event) =>
              setIntensity(event.target.value as ActivityIntensity | "")
            }
          >
            <option value="">Not recorded</option>
            {ACTIVITY_INTENSITIES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="activity-elevation">Elevation gain (optional)</Label>
          <div className="flex gap-2">
            <Input
              id="activity-elevation"
              type="number"
              inputMode="decimal"
              min={0}
              max={100_000}
              step="any"
              value={elevationValue}
              onChange={(event) => setElevationValue(event.target.value)}
              placeholder="120"
            />
            <select
              aria-label="Elevation unit"
              className={`${selectClassName} w-24`}
              value={elevationUnit}
              onChange={(event) => setElevationUnit(event.target.value as ElevationUnit)}
            >
              <option value="m">m</option>
              <option value="ft">ft</option>
            </select>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="activity-heart-rate">Average heart rate (optional)</Label>
          <Input
            id="activity-heart-rate"
            type="number"
            inputMode="numeric"
            min={20}
            max={260}
            step={1}
            value={heartRate}
            onChange={(event) => setHeartRate(event.target.value)}
            placeholder="116 bpm"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="activity-energy">Energy (optional)</Label>
          <div className="relative">
            <Input
              id="activity-energy"
              type="number"
              inputMode="decimal"
              min={0.1}
              max={100_000}
              step="any"
              className="pr-12"
              value={energy}
              onChange={(event) => setEnergy(event.target.value)}
              placeholder="280"
            />
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
              kcal
            </span>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="activity-notes">Notes (optional)</Label>
        <Textarea
          id="activity-notes"
          value={notes}
          maxLength={4_000}
          onChange={(event) => setNotes(event.target.value)}
          rows={4}
          placeholder="Route, weather, effort, how you felt…"
        />
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          render={<Link href={cancelHref} />}
          nativeButton={false}
          type="button"
          variant="outline"
        >
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending
            ? "Saving…"
            : activityId
              ? "Save changes"
              : "Record activity"}
        </Button>
      </div>
    </form>
  );
}
