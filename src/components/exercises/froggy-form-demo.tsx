"use client";

import { Component, createContext, useContext, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { Play, Maximize2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { hasFroggyFormDemo, type FroggyFormDemo } from "@/lib/froggy-form-demo";
import { FROGGY_FORMS, type FroggyFormConfig } from "@/lib/froggy-form-config";
import { FroggyThumbnail } from "./froggy-thumbnail";
import type { FroggyPlayerSnapshot } from "./froggy-form-player";

const Player = dynamic(() => import("./froggy-form-player"), {
  ssr: false,
  loading: () => <p role="status" className="p-3">Loading form viewer…</p>,
});

type DemoContextValue = {
  config: FroggyFormConfig;
  opened: boolean;
  expanded: boolean;
  toggle: () => void;
  close: () => void;
  expand: () => void;
  registerTrigger: (element: HTMLButtonElement | null) => void;
  player: ReactNode;
};
const DemoContext = createContext<DemoContextValue | null>(null);
type DemoProps = {
  demo?: FroggyFormDemo | null;
  exerciseId: string;
  presentation?: "inline" | "dialog";
  children: ReactNode;
  initiallyOpen?: boolean;
};

export function FroggyFormDemoProvider(props: DemoProps) {
  if (!hasFroggyFormDemo(props.demo, props.exerciseId)) return <>{props.children}</>;
  return <DemoProvider key={`${props.exerciseId}:${props.demo.key}`} {...props} />;
}

function DemoProvider({ demo, children, presentation = "inline", initiallyOpen = false }: DemoProps) {
  const config = FROGGY_FORMS[demo!.key];
  const [opened, setOpened] = useState(initiallyOpen);
  const [expanded, setExpanded] = useState(false);
  const [snapshot, setSnapshot] = useState<FroggyPlayerSnapshot | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  function toggle() {
    if (expanded) { setExpanded(false); setOpened(false); return; }
    if (opened) { setOpened(false); return; }
    setSnapshot(current => current ? { ...current, userPaused: false } : null);
    if (presentation === "dialog") setExpanded(true);
    else setOpened(true);
  }
  const player = <ViewerBoundary config={config}><Player demoKey={demo!.key} initialSnapshot={snapshot} onSnapshot={setSnapshot} /></ViewerBoundary>;
  return <DemoContext.Provider value={{ config, opened, expanded, toggle, close: () => { setOpened(false); trigger.current?.focus(); }, expand: () => setExpanded(true), registerTrigger: element => { trigger.current = element; }, player }}>
    <Dialog open={expanded} onOpenChange={setExpanded}>
      {children}
      <DialogContent ref={popup} tabIndex={-1} initialFocus={popup} finalFocus={trigger}
        className="max-h-[90dvh] overflow-hidden sm:max-w-lg">
        <div className="max-h-[calc(90dvh-2rem)] space-y-3 overflow-y-auto">
          <DialogTitle className="pr-8">{config.title} · Form</DialogTitle>
          <DialogDescription className="sr-only">Tap the animation to pause or resume. DO/AVOID messages cycle; form callouts stay visible.</DialogDescription>
          {expanded && <div className="mx-auto w-full max-w-[max(300px,calc(90dvh-220px))]">{player}</div>}
        </div>
      </DialogContent>
    </Dialog>
  </DemoContext.Provider>;
}

export function FroggyFormDemoTrigger({ children }: { children?: ReactNode }) {
  const demo = useContext(DemoContext);
  if (!demo) return <>{children}</>;
  return <button ref={element => demo.registerTrigger(element)} type="button" onClick={demo.toggle}
    aria-label={`View ${demo.config.title} form`} aria-expanded={demo.opened || demo.expanded}
    title={demo.opened || demo.expanded ? "Hide form" : "View form"} className="relative flex size-16 shrink-0 items-center justify-center rounded-xl bg-primary/5 ring-1 ring-primary/15 hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
    <span className="relative block size-full overflow-hidden rounded-xl">
      <FroggyThumbnail config={demo.config} paused={demo.opened || demo.expanded} />
    </span>
    <span className="absolute -bottom-1 -right-1 rounded-full bg-primary p-1 text-primary-foreground"><Play className="size-3 fill-current" aria-hidden="true" /></span>
  </button>;
}

export function FroggyFormDemoPanel() {
  const demo = useContext(DemoContext);
  if (!demo || !demo.opened || demo.expanded) return null;
  return <div className="col-span-full min-w-0 w-full max-w-[460px]" data-testid="froggy-inline-preview">
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs font-medium text-muted-foreground">Exercise form</span>
      <div className="flex gap-1">
        <Button type="button" variant="ghost" size="icon-sm" onClick={demo.expand} aria-label="Expand form preview"><Maximize2 className="size-4" /></Button>
        <Button type="button" variant="ghost" size="icon-sm" onClick={demo.close} aria-label="Close form preview"><X className="size-4" /></Button>
      </div>
    </div>
    {demo.player}
  </div>;
}

export function FroggyFormDemoEntry(props: Omit<DemoProps, "children">) {
  return <FroggyFormDemoProvider {...props}><FroggyFormDemoTrigger /><FroggyFormDemoPanel /></FroggyFormDemoProvider>;
}

/** A failed lazy chunk or renderer must not unmount the surrounding workout. */
class ViewerBoundary extends Component<{ children: ReactNode; config: FroggyFormConfig }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="space-y-2 p-3 text-sm" role="status">
      <p>The video viewer could not load. Your workout is still available.</p>
      <ul className="list-disc pl-5">{this.props.config.cues.map(c => <li key={c.text}><strong>{c.kind}:</strong> {c.text}</li>)}</ul>
      <a className="underline" href={this.props.config.reference} target="_blank" rel="noreferrer">Read the form reference</a>
    </div>;
  }
}
