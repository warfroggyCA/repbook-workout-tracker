import type { ComponentType, SVGProps } from "react";
import { Bike, Images, Play } from "lucide-react";
import type { ExerciseMediaPreview } from "@/lib/exercise-discovery";
import {
  iconKeyForExerciseFamily,
  type ExerciseFamilyIconKey,
} from "@/lib/exercise-family-icon";
import { cn } from "@/lib/utils";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

function ExerciseGlyph({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  );
}

function BenchPressIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ExerciseGlyph {...props}>
      <path d="M3 18h18M5 18v3M19 18v3" />
      <circle cx="7" cy="13" r="1.5" />
      <path d="M8.5 14.5H16l2 3H7" />
      <path d="M4 6h16M5.5 4v4M18.5 4v4" />
      <path d="m10 14 1-6M15 14l-2-6" />
    </ExerciseGlyph>
  );
}

function SquatIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ExerciseGlyph {...props}>
      <circle cx="12" cy="3.5" r="1.5" />
      <path d="M4 7h16M6 5.5v3M18 5.5v3" />
      <path d="M12 5.5v5l-4 4 1 5.5M12 10.5l4 4-1 5.5" />
      <path d="m8 14.5 4 1.5 4-1.5" />
    </ExerciseGlyph>
  );
}

function HingeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ExerciseGlyph {...props}>
      <circle cx="16.5" cy="4.5" r="1.5" />
      <path d="m15 6-5 5 3 3M10 11l-2 5M13 14l4 5M9 12l-1 7M13 9l4 8" />
      <path d="M3 19h18M4.5 17v4M19.5 17v4" />
    </ExerciseGlyph>
  );
}

function HorizontalPressIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ExerciseGlyph {...props}>
      <circle cx="7" cy="4.5" r="1.5" />
      <path d="M7 6v7M7 8.5l4 2.5 3-1M14 6v8M16.5 6v8" />
      <path d="M7 13l-3 6M7 13l4 6M13 8h4.5M13 12h4.5" />
    </ExerciseGlyph>
  );
}

function PushUpIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ExerciseGlyph {...props}>
      <circle cx="18" cy="8.5" r="1.5" />
      <path d="m16.5 9.5-6 2-5-2.5M10.5 11.5l3 4.5M16.5 10l2.5 6" />
      <path d="M3 16h18M5.5 9 3 16M13.5 16h2M18.5 16H21" />
    </ExerciseGlyph>
  );
}

function FlyIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ExerciseGlyph {...props}>
      <circle cx="12" cy="4" r="1.5" />
      <path d="M12 5.5v8M12 8.5H4M12 8.5h8M12 13.5l-4 6M12 13.5l4 6" />
      <path d="M2.5 6.5v4M4 7.5v2M20 7.5v2M21.5 6.5v4" />
    </ExerciseGlyph>
  );
}

function LungeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ExerciseGlyph {...props}>
      <circle cx="10" cy="4" r="1.5" />
      <path d="M10 5.5v6M10 8l-3 3M10 8l4 2M10 11.5l5 3.5 4 4M10 11.5l-4 4-2 4" />
      <path d="M15 15h4M3 20h5M17 20h4" />
    </ExerciseGlyph>
  );
}

function StepIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ExerciseGlyph {...props}>
      <circle cx="9" cy="4" r="1.5" />
      <path d="M9 5.5v7M9 8l-3 3M9 8l3 2M9 12.5l4 2.5h4M9 12.5l-3 7" />
      <path d="M12 20v-5h8v5M4 20h5" />
    </ExerciseGlyph>
  );
}

function BridgeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ExerciseGlyph {...props}>
      <circle cx="5" cy="15" r="1.5" />
      <path d="M6.5 14.5 11 11l5 2 3 5M11 11l-2 7M16 13l-1 5" />
      <path d="M2.5 18h19M18.5 18h3" />
    </ExerciseGlyph>
  );
}

function RowIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ExerciseGlyph {...props}>
      <circle cx="6" cy="7" r="1.5" />
      <path d="M7 8.5 9 14l5 3M9 11l4 2 3-2M8.5 14 5 18M14 17h4" />
      <path d="M16 8v6M18 8v6M16 10.5l-3 2.5M3 19h8" />
    </ExerciseGlyph>
  );
}

function VerticalPullIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ExerciseGlyph {...props}>
      <path d="M3 3h18M5 2v3M19 2v3" />
      <circle cx="12" cy="9" r="1.5" />
      <path d="M12 10.5v6M12 12l-5-6M12 12l5-6M12 16.5l-3 4M12 16.5l3 4" />
    </ExerciseGlyph>
  );
}

function CurlIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ExerciseGlyph {...props}>
      <circle cx="10" cy="4" r="1.5" />
      <path d="M10 5.5v8M10 8l-4 3 2 3M10 8l4 3 2-3M10 13.5l-3 6M10 13.5l3 6" />
      <path d="M5.5 13.5h5M4.5 12v3M11.5 12v3" />
    </ExerciseGlyph>
  );
}

function TricepsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ExerciseGlyph {...props}>
      <circle cx="10" cy="5" r="1.5" />
      <path d="M10 6.5v7M10 8l4-3 2 3-3 3M10 13.5l-3 6M10 13.5l3 6" />
      <path d="M15 2.5v5M17 2.5v5M14 3.5h4" />
    </ExerciseGlyph>
  );
}

function RaiseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ExerciseGlyph {...props}>
      <circle cx="12" cy="4.5" r="1.5" />
      <path d="M12 6v8M12 9 5 7M12 9l7-2M12 14l-4 6M12 14l4 6" />
      <path d="M2.5 5.5v3M4 5v4M20 5v4M21.5 5.5v3" />
    </ExerciseGlyph>
  );
}

function LegsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ExerciseGlyph {...props}>
      <circle cx="8" cy="5" r="1.5" />
      <path d="M8 6.5v7h6l4 3M8 10H5v7M14 13.5l2-4M18 16.5v3" />
      <path d="M4 17h6M4 19h6M16 19.5h4" />
    </ExerciseGlyph>
  );
}

function CoreIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ExerciseGlyph {...props}>
      <circle cx="18" cy="8" r="1.5" />
      <path d="m16.5 9-6 2-5-2M10.5 11l3 5M5.5 9 3 16M13.5 16h3M3 16h2" />
      <path d="M3 19h18" />
    </ExerciseGlyph>
  );
}

function RotationIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ExerciseGlyph {...props}>
      <circle cx="9" cy="4" r="1.5" />
      <path d="M9 5.5v8M9 8l5 2.5 4-1M9 10l5 3 4-1M9 13.5l-4 6M9 13.5l4 6" />
      <circle cx="19.5" cy="10.5" r="1.5" />
      <path d="M4 8c1.5-1.5 3-2 5-2" />
    </ExerciseGlyph>
  );
}

function CarryIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ExerciseGlyph {...props}>
      <circle cx="12" cy="4" r="1.5" />
      <path d="M12 5.5v8M12 8 7 11M12 8l5 3M12 13.5l-4 6M12 13.5l4 6" />
      <path d="M4.5 12v5M7 12v5M17 12v5M19.5 12v5M4 17h3.5M16.5 17H20" />
    </ExerciseGlyph>
  );
}

function OlympicLiftIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ExerciseGlyph {...props}>
      <path d="M3 4h18M4.5 2v4M19.5 2v4" />
      <circle cx="12" cy="8" r="1.5" />
      <path d="M12 9.5v6M12 11 6 5M12 11l6-6M12 15.5l-4 5M12 15.5l4 5" />
    </ExerciseGlyph>
  );
}

function JumpIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ExerciseGlyph {...props}>
      <circle cx="12" cy="5" r="1.5" />
      <path d="M12 6.5v7M12 9 6 5M12 9l6-4M12 13.5l-5 4M12 13.5l5 4" />
      <path d="m4 4-1-1M20 4l1-1M5 20h3M16 20h3" />
    </ExerciseGlyph>
  );
}

function RunIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ExerciseGlyph {...props}>
      <circle cx="14" cy="4" r="1.5" />
      <path d="m13 6-3 5 4 2 3 6M10 11 6 9M14 13l-5 6M13 7l4 3 3-1" />
      <path d="M3 20h7M16 20h5" />
    </ExerciseGlyph>
  );
}

function SwimIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ExerciseGlyph {...props}>
      <circle cx="15" cy="7" r="1.5" />
      <path d="m13.5 8-5 3-4-1M9 10.5l4-5 5-2" />
      <path d="M2 15c2-2 4-2 6 0s4 2 6 0 4-2 8 0M2 19c2-2 4-2 6 0s4 2 6 0 4-2 8 0" />
    </ExerciseGlyph>
  );
}

function ConditioningIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ExerciseGlyph {...props}>
      <circle cx="12" cy="5" r="1.5" />
      <path d="M12 6.5v7M12 9 8 11M12 9l4 2M12 13.5l-3 6M12 13.5l3 6" />
      <path d="M8 7C3 8 3 18 8 20M16 7c5 1 5 11 0 13" />
    </ExerciseGlyph>
  );
}

function MobilityIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ExerciseGlyph {...props}>
      <circle cx="10" cy="5" r="1.5" />
      <path d="M10 6.5v7M10 9 6 5M10 9l5-5M10 13.5l-4 6M10 13.5l5 4" />
      <path d="M15 4h4v4M16 18c2-1 3-3 3-5" />
    </ExerciseGlyph>
  );
}

function StretchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ExerciseGlyph {...props}>
      <circle cx="8" cy="5" r="1.5" />
      <path d="m9 6 4 5 5 2M13 11l-4 3-5 5M13 11l3 8M9 8 6-3" />
      <path d="M2.5 20h7M14 20h6" />
    </ExerciseGlyph>
  );
}

function NeutralMovementIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ExerciseGlyph {...props}>
      <circle cx="12" cy="4" r="1.5" />
      <path d="M12 5.5v8M12 8 7 11M12 8l5 3M12 13.5l-4 6M12 13.5l4 6" />
    </ExerciseGlyph>
  );
}

const ICONS: Record<ExerciseFamilyIconKey, IconComponent> = {
  bench_press: BenchPressIcon,
  horizontal_press: HorizontalPressIcon,
  push: PushUpIcon,
  fly: FlyIcon,
  squat: SquatIcon,
  lunge: LungeIcon,
  step: StepIcon,
  hinge: HingeIcon,
  bridge: BridgeIcon,
  row: RowIcon,
  vertical_pull: VerticalPullIcon,
  curl: CurlIcon,
  triceps: TricepsIcon,
  raise: RaiseIcon,
  legs: LegsIcon,
  core: CoreIcon,
  rotation: RotationIcon,
  carry: CarryIcon,
  olympic_lift: OlympicLiftIcon,
  jump: JumpIcon,
  locomotion: RunIcon,
  cycling: Bike,
  swimming: SwimIcon,
  conditioning: ConditioningIcon,
  mobility: MobilityIcon,
  stretch: StretchIcon,
  default: NeutralMovementIcon,
};

export function ExerciseFamilyIcon({
  family,
  exerciseName,
  movementPattern,
  media,
  className,
  iconClassName,
}: {
  family?: string | null;
  exerciseName: string;
  movementPattern: string;
  media?: ExerciseMediaPreview | null;
  className?: string;
  iconClassName?: string;
}) {
  const iconKey = iconKeyForExerciseFamily({
    family,
    exerciseName,
    movementPattern,
  });
  const Icon = ICONS[iconKey];
  const hasVideo = Boolean(media?.video || media?.kind === "video");
  const hasImages = Boolean(media?.images?.length || media?.kind === "image");
  const MediaIcon = hasVideo ? Play : hasImages ? Images : null;

  return (
    <span
      data-exercise-icon={iconKey}
      className={cn(
        "relative flex size-10 shrink-0 items-center justify-center rounded-xl border bg-primary/8 text-primary",
        className
      )}
    >
      <Icon className={cn("size-5", iconClassName)} aria-hidden="true" />
      {MediaIcon && (
        <span className="absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-full border border-background bg-primary text-primary-foreground shadow-sm">
          <MediaIcon className="size-2.5" aria-hidden="true" />
          <span className="sr-only">
            {hasVideo ? "Video demonstration available" : "Image demonstration available"}
          </span>
        </span>
      )}
    </span>
  );
}
