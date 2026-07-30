import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  barbellConfigs,
  equipmentDefinitions,
  equipmentItems,
  plateInventory,
} from "@/db/schema";
import { getCurrentUser } from "@/lib/user";
import { EquipmentInventory } from "@/components/equipment/equipment-inventory";
import { FontSizeControl } from "@/components/settings/font-size-control";
import { RestAlertPreferenceControl } from "@/components/settings/rest-alert-preference-control";
import { TestDataControls } from "@/components/history/test-data-controls";
import { getWorkoutTestDataCount } from "@/services/workout-test-data";
import { getSampleHistoryArchivePreview } from "@/services/archive";
import { normalizeFontSize } from "@/lib/font-size";
import { TimezoneControl } from "@/components/settings/timezone-control";
import { AIHistoryControls } from "@/components/settings/ai-history-controls";
import { getAIHistoryArchivePreview } from "@/services/ai-privacy";
import { groupEquipmentInventory } from "@/lib/equipment-families";
import { SignOutControl } from "@/components/settings/sign-out-control";
import { isSettingsManagementEnabled } from "@/lib/settings-management-feature";
import { EquipmentSaveNotice } from "@/components/settings/equipment-save-notice";
import { Button } from "@/components/ui/button";
import { Pencil, ClipboardList } from "lucide-react";

export default async function SettingsPage(props: PageProps<"/settings">) {
  const searchParams = await props.searchParams;
  const savedParam = searchParams["equipment-saved"];
  const equipmentSaved =
    savedParam === "updated" || savedParam === "unchanged" ? savedParam : null;
  const managementEnabled = isSettingsManagementEnabled();
  const user = await getCurrentUser();
  const db = await getDb();
  const [
    equipment,
    plates,
    bars,
    testSessionCount,
    samplePreview,
    aiHistoryPreview,
  ] = await Promise.all([
    db
      .select({
        id: equipmentItems.id,
        type: equipmentItems.type,
        label: equipmentItems.label,
        quantity: equipmentItems.quantity,
        attrs: equipmentItems.attrs,
        definitionLabel: equipmentDefinitions.label,
        definitionDescription: equipmentDefinitions.description,
      })
      .from(equipmentItems)
      .leftJoin(
        equipmentDefinitions,
        eq(equipmentItems.definitionId, equipmentDefinitions.id)
      )
      .where(
        and(
          eq(equipmentItems.userId, user.id),
          eq(equipmentItems.available, true)
        )
      ),
    db.query.plateInventory.findMany({
      where: eq(plateInventory.userId, user.id),
    }),
    db.query.barbellConfigs.findMany({
      where: eq(barbellConfigs.userId, user.id),
    }),
    getWorkoutTestDataCount(db, user.id),
    getSampleHistoryArchivePreview(db, user.id),
    getAIHistoryArchivePreview(db, user.id),
  ]);
  const equipmentGroups = groupEquipmentInventory({
    items: equipment,
    plates,
    bars,
    profileUnit: user.profile.unit,
  });

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-4 p-4 sm:p-6 lg:p-8">
      <header className="mb-1">
        <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Preferences and safeguards
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
          Settings
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Control how your record is shown, protected, and managed.
        </p>
      </header>

      <section className="rounded-xl border bg-card p-4 shadow-[var(--shadow-soft)]">
        <h2 className="mb-1 text-sm font-medium">App size</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Scale text, controls, spacing, and navigation together. This setting is
          saved to your profile and follows you across sessions and devices.
        </p>
        <FontSizeControl
          profileSize={normalizeFontSize(user.profile.fontSize)}
        />
      </section>

      <section className="rounded-xl border bg-card p-4 shadow-[var(--shadow-soft)]">
        <h2 className="mb-1 text-sm font-medium">Rest timer alert</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Choose how this browser/device should request a cue when rest ends.
          The visible ready state is always the reliable signal.
        </p>
        <RestAlertPreferenceControl />
      </section>

      <section className="rounded-xl border bg-card p-4 shadow-[var(--shadow-soft)]">
        <h2 className="mb-1 text-sm font-medium">Profile</h2>
        <p className="text-sm text-muted-foreground">{user.email}</p>
        <p className="text-sm text-muted-foreground">
          {user.profile.experience} · {user.profile.weeklyFrequency}×/week ·{" "}
          {user.profile.sessionLengthMin} min · {user.profile.unit}
        </p>
        <TimezoneControl current={user.profile.timezone} />
        {managementEnabled && (
          <div className="mt-3">
            <Button
              variant="outline"
              size="sm"
              className="min-h-11"
              render={<Link href="/settings/setup" />}
              nativeButton={false}
            >
              <ClipboardList className="size-4" /> Review setup
            </Button>
            <p className="mt-1 text-xs text-muted-foreground">
              Walk through your saved profile, equipment, constraints, coaching
              preferences, and Program using your current information.
            </p>
          </div>
        )}
      </section>

      <section className="rounded-xl border bg-card p-4 shadow-[var(--shadow-soft)]">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <h2
            id="settings-equipment-heading"
            tabIndex={-1}
            className="text-sm font-medium outline-none"
          >
            Equipment
          </h2>
          {managementEnabled && (
            <Button
              variant="outline"
              size="sm"
              className="min-h-11"
              render={<Link href="/settings/equipment" />}
              nativeButton={false}
            >
              <Pencil className="size-4" /> Manage equipment
            </Button>
          )}
        </div>
        {equipmentSaved && <EquipmentSaveNotice result={equipmentSaved} />}
        <p className="mb-3 mt-2 text-xs leading-5 text-muted-foreground">
          Browse your saved inventory by family. Expand a family to see every
          distinct item, its quantity, and recorded details. Bodyweight training
          is always available and does not need an inventory record.
        </p>
        <EquipmentInventory groups={equipmentGroups} />
      </section>

      <section className="rounded-xl border bg-card p-4 shadow-[var(--shadow-soft)]">
        <h2 className="text-sm font-medium">Data management</h2>
        <div className="mt-3 divide-y rounded-lg border">
          <div className="flex flex-wrap items-center justify-between gap-3 p-3">
            <span className="text-sm">AI and Coach history</span>
            <AIHistoryControls preview={aiHistoryPreview} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 p-3">
            <span className="text-sm">Test data</span>
            <TestDataControls
              testSessionCount={testSessionCount}
              samplePreview={samplePreview.workouts > 0 ? samplePreview : null}
            />
          </div>
          {[
            ["Export and backup", "/export"],
            ["Archive and restore", "/archive"],
            ["Recovery and snapshots", "/recovery"],
            ["Audit history", "/settings/audit"],
          ].map(([label, href]) => (
            <Link
              key={href}
              href={href}
              className="flex min-h-12 items-center justify-between gap-3 p-3 text-sm hover:bg-muted/40"
            >
              {label}<span aria-hidden="true">→</span>
            </Link>
          ))}
        </div>
      </section>

      <SignOutControl ownerId={user.id} />
    </main>
  );
}
