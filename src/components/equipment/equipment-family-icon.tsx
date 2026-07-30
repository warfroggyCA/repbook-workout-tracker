import type { SVGProps } from "react";
import type { EquipmentFamilyKey } from "@/lib/equipment-families";
import { cn } from "@/lib/utils";

function EquipmentGlyph({
  children,
  className,
  ...props
}: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("size-[24px]", className)}
      {...props}
    >
      {children}
    </svg>
  );
}

function FamilyGlyph({ familyKey }: { familyKey: EquipmentFamilyKey }) {
  switch (familyKey) {
    case "bars_and_plates":
      return (
        <EquipmentGlyph>
          <path d="M3 12h18M4.5 8.5v7M7 10v4M17 10v4M19.5 8.5v7" />
          <path d="M9 19h6M10 17v4M14 17v4" />
        </EquipmentGlyph>
      );
    case "handheld_weights":
      return (
        <EquipmentGlyph>
          <path d="M3 9v6M5.5 7.5v9M18.5 7.5v9M21 9v6M5.5 12h13" />
          <path d="M10 18h4l1 3H9l1-3ZM10.5 18v-2a1.5 1.5 0 0 1 3 0v2" />
        </EquipmentGlyph>
      );
    case "stations_and_supports":
      return (
        <EquipmentGlyph>
          <path d="M4 3v18M20 3v18M4 5h16M7 8h10" />
          <path d="M6 16h12M8 13v6M16 13v6M4 21h4M16 21h4" />
        </EquipmentGlyph>
      );
    case "cables_and_machines":
      return (
        <EquipmentGlyph>
          <path d="M5 21V3h14v18M5 7h14M8 18h8" />
          <circle cx="12" cy="10" r="1.5" />
          <path d="M12 11.5V15M9 15h6M9 14v3M15 14v3" />
        </EquipmentGlyph>
      );
    case "bands_and_suspension":
      return (
        <EquipmentGlyph>
          <path d="M6 3h12M8 3v6l-3 8M16 3v6l3 8" />
          <path d="M3.5 16.5 6.5 18l-2 3M20.5 16.5 17.5 18l2 3" />
          <path d="M9 7c2 3 4 3 6 0" />
        </EquipmentGlyph>
      );
    case "conditioning_machines":
      return (
        <EquipmentGlyph>
          <path d="M7 20h10M9 20l2-9h5l2 9M11 11l-2-5h6l1 5" />
          <path d="M8 6h8M10 15h7M5 20h2M17 20h2" />
        </EquipmentGlyph>
      );
    case "conditioning_tools":
      return (
        <EquipmentGlyph>
          <path d="M3 18c3-8 6-8 9 0s6 8 9 0" />
          <path d="M5 16V8h8v8M5 11h8M13 13h4l2 3M17 16h3" />
        </EquipmentGlyph>
      );
    case "mobility_and_recovery":
      return (
        <EquipmentGlyph>
          <circle cx="7" cy="9" r="4" />
          <path d="M12 16h7a2 2 0 0 1 0 4h-7a2 2 0 0 1 0-4Z" />
          <path d="M14 16v4M18 16v4" />
        </EquipmentGlyph>
      );
    case "specialty_and_attachments":
      return (
        <EquipmentGlyph>
          <path d="M4 10h16v10H4zM8 10V7h8v3M3 14h18" />
          <path d="M9 14v2M15 14v2M10 5h4" />
        </EquipmentGlyph>
      );
    case "no_equipment":
      return (
        <EquipmentGlyph>
          <circle cx="12" cy="4" r="1.7" />
          <path d="M12 5.7v7M12 8 7 11M12 8l5 3M12 12.7l-4 7M12 12.7l4 7" />
          <path d="M5 21h14" />
        </EquipmentGlyph>
      );
    case "uncategorized":
      return (
        <EquipmentGlyph>
          <path d="M5 8.5 12 4l7 4.5v8L12 21l-7-4.5zM5 8.5l7 4.5 7-4.5M12 13v8" />
          <path d="M10 7h4" />
        </EquipmentGlyph>
      );
  }
}

export function EquipmentFamilyIcon({
  familyKey,
  className,
}: {
  familyKey: EquipmentFamilyKey;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-equipment-icon={familyKey}
      className={cn(
        "flex size-[40px] shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary",
        className
      )}
    >
      <FamilyGlyph familyKey={familyKey} />
    </span>
  );
}
