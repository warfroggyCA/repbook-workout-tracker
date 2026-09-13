"use client";

import { useEffect, useRef, useState } from "react";
import { CircleCheck, CircleX } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FroggyDemoKey } from "@/lib/froggy-form-demo";
import { FROGGY_FORMS, type FroggyMode } from "@/lib/froggy-form-config";
import curlFrames from "@/lib/froggy-incline-curl-anchors.json";
import styles from "./froggy-form-player.module.css";
import { froggyPlaybackWrapped } from "@/lib/froggy-playback";

import pressFrames from "@/lib/froggy-incline-press-anchors.json";
import latFrames from "@/lib/froggy-lat-pulldown-anchors.json";
import squatFrames from "@/lib/froggy-goblet-squat-anchors.json";
import rdlFrames from "@/lib/froggy-romanian-deadlift-anchors.json";
import benchFrames from "@/lib/froggy-barbell-bench-anchors.json";
import backSquatFrames from "@/lib/froggy-back-squat-anchors.json";
import ohpFrames from "@/lib/froggy-overhead-press-anchors.json";
import rowFrames from "@/lib/froggy-barbell-row-anchors.json";
import splitFrames from "@/lib/froggy-bulgarian-split-squat-anchors.json";
import ezFrames from "@/lib/froggy-ez-bar-curl-anchors.json";
import batch117legcurl from "@/lib/froggy-standing-cable-leg-curl-anchors.json";
import batch117pushdown from "@/lib/froggy-rope-pushdown-anchors.json";
import batch117chestrow from "@/lib/froggy-chest-supported-row-anchors.json";
import batch117reversefly from "@/lib/froggy-chest-supported-reverse-fly-anchors.json";
import batch133calfraise from "@/lib/froggy-single-leg-dumbbell-calf-raise-anchors.json";
import batch133deadbug from "@/lib/froggy-dead-bug-anchors.json";
import batch133zottman from "@/lib/froggy-zottman-curl-anchors.json";
import batch133suitcase from "@/lib/froggy-kettlebell-suitcase-carry-anchors.json";
import batch138lateralraise from "@/lib/froggy-standing-dumbbell-lateral-raise-anchors.json";
import batch138dbbench from "@/lib/froggy-flat-dumbbell-bench-press-anchors.json";
const TRACKS: Record<FroggyDemoKey, number[][][]> = {
  "standing-cable-leg-curl-v117": batch117legcurl,
  "rope-pushdown-v117": batch117pushdown,
  "chest-supported-row-v117": batch117chestrow,
  "chest-supported-reverse-fly-v117": batch117reversefly,
  "single-leg-dumbbell-calf-raise-v133": batch133calfraise,
  "dead-bug-v133": batch133deadbug,
  "zottman-curl-v133": batch133zottman,
  "kettlebell-suitcase-carry-v133": batch133suitcase,
  "standing-dumbbell-lateral-raise-v138": batch138lateralraise,
  "flat-dumbbell-bench-press-v138": batch138dbbench,
  "incline-dumbbell-curl-v102": curlFrames.map(f => [f.upper_arm, f.forearm]),
  "incline-press-v107": pressFrames, "lat-pulldown-v107": latFrames,
  "goblet-squat-v107": squatFrames, "romanian-deadlift-v107": rdlFrames,
  "barbell-bench-v108": benchFrames,
  "back-squat-v108": backSquatFrames,
  "overhead-press-v108": ohpFrames,
  "barbell-row-v108": rowFrames,
  "bulgarian-split-squat-v109": splitFrames, "ez-bar-curl-v109": ezFrames,
};
type Mode = FroggyMode;
export type FroggyPlayerSnapshot = { time: number; cue: number; userPaused: boolean; mode: Mode; speed: number };

export default function FroggyFormPlayer({ demoKey, initialSnapshot, onSnapshot }: { demoKey: FroggyDemoKey; initialSnapshot: FroggyPlayerSnapshot | null; onSnapshot: (value: FroggyPlayerSnapshot) => void }) {
  const config = FROGGY_FORMS[demoKey];
  const frames = TRACKS[demoKey];
  const [initial] = useState<FroggyPlayerSnapshot>(() => initialSnapshot ?? {
    time: 0, cue: 0, userPaused: false, speed: 1,
    mode: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "steady" : config.modes[0],
  });
  const [mode, setMode] = useState(initial.mode);
  const [speed, setSpeed] = useState(initial.speed);
  const [cue, setCue] = useState(initial.cue);
  const [userPaused, setUserPaused] = useState(initial.userPaused);
  const pauseIntent = useRef(initial.userPaused);
  const resetPlaybackSample = useRef(true);
  const syncPlayback = useRef<() => void>(() => {});
  const [hint, setHint] = useState(() => {
    try { return !sessionStorage.getItem("froggy-tap-hint"); } catch { return true; }
  });
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(initial.time);
  const [status, setStatus] = useState("Loading video…");
  const [failed, setFailed] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const callouts = useRef<(SVGGElement | null)[]>([]);
  const settings = useRef(initial);
  const lastTime = useRef(initial.time);
  const resumeTime = useRef(initial.time);

  useEffect(() => {
    try { sessionStorage.setItem("froggy-tap-hint", "seen"); } catch { /* Optional hint only. */ }
    const timer = setTimeout(() => setHint(false), 4000);
    return () => clearTimeout(timer);
  }, []);

  // Presentation-frame tracking does not re-render the workout or its inputs.
  useEffect(() => {
    const v = video.current!;
    function paint(time: number) {
      const frame = ((time * 24) % frames.length + frames.length) % frames.length;
      const i = Math.floor(frame), weight = frame - i;
      config.callouts.forEach((label, index) => {
        const a = frames[i][index], b = frames[(i + 1) % frames.length][index];
        // Match the contained video's letterboxing, then its bottom-right framing.
        const rawX = (a[0] + (b[0] - a[0]) * weight) * 1080 + (label.offsetX ?? 0);
        const rawY = (1080 - config.videoHeight) / 2 + (1 - a[1] - (b[1] - a[1]) * weight) * config.videoHeight;
        const x = 1080 + (rawX - 1080) * config.scale;
        const y = 1080 + (rawY - 1080) * config.scale + (config.offsetY ?? 0) * 1080;
        const start = label.x + (label.edge === "right" ? 282 : 0);
        const bend = start + (label.edge === "right" ? 28 : -28);
        const path = `M${start} ${label.y + 55}H${bend}L${x + (label.edge === "left" ? 9 : -9)} ${y}`;
        const group = callouts.current[index];
        group?.querySelectorAll("path").forEach(line => line.setAttribute("d", path));
        const dot = group?.querySelector("circle");
        dot?.setAttribute("cx", String(x)); dot?.setAttribute("cy", String(y));
      });
    }
    let callback = 0, raf = 0;
    const trackPlayback = (time: number) => {
      if (resetPlaybackSample.current) {
        if (v.seeking) { paint(time); return; }
        resetPlaybackSample.current = false;
      } else if (!v.paused && froggyPlaybackWrapped(lastTime.current, time, v.duration)) {
        setCue(c => (c + 1) % config.cues.length);
      }
      lastTime.current = time;
      paint(time);
    };
    const frameCallback: VideoFrameRequestCallback = (_, meta) => {
      trackPlayback(meta.mediaTime); callback = v.requestVideoFrameCallback(frameCallback);
    };
    const fallback = () => { trackPlayback(v.currentTime); raf = requestAnimationFrame(fallback); };
    if (typeof v.requestVideoFrameCallback === "function") callback = v.requestVideoFrameCallback(frameCallback);
    else raf = requestAnimationFrame(fallback);
    const seek = () => paint(v.currentTime);
    let visible = false, disposed = false;
    const sync = () => {
      if (disposed) return;
      if (!visible || document.hidden || pauseIntent.current) { v.pause(); return; }
      if (v.readyState >= HTMLMediaElement.HAVE_METADATA && v.paused) void v.play().then(() => {
        if (disposed || !visible || document.hidden || pauseIntent.current) v.pause();
      }).catch(() => { if (!disposed && visible && !pauseIntent.current) setStatus("Tap to play"); });
    };
    syncPlayback.current = sync;
    const hide = sync;
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); });
    if (stage.current) observer.observe(stage.current);
    document.addEventListener("visibilitychange", hide); v.addEventListener("seeked", seek);
    paint(v.currentTime);
    return () => {
      onSnapshot({ ...settings.current, time: Number.isFinite(v.duration) ? v.currentTime : resumeTime.current });
      disposed = true; syncPlayback.current = () => {};
      v.pause(); observer.disconnect(); document.removeEventListener("visibilitychange", hide);
      v.removeEventListener("seeked", seek);
      if (callback) v.cancelVideoFrameCallback(callback); if (raf) cancelAnimationFrame(raf);
    };
  }, [onSnapshot, config, frames]);

  useEffect(() => {
    settings.current = { time: position, cue, userPaused, mode, speed };
    // Save before an inline/dialog remount; cleanup runs too late for the next render.
    onSnapshot(settings.current);
    // Keep both pointers aligned after a paused seek or player remount.
    video.current?.dispatchEvent(new Event("seeked"));
  }, [cue, userPaused, mode, speed, position, onSnapshot]);

  function loadMode(next: Mode) {
    const v = video.current!;
    resumeTime.current = v.currentTime;
    resetPlaybackSample.current = true;
    v.pause(); setFailed(false); setStatus("Loading video…"); setMode(next);
  }
  function playPause() {
    const v = video.current!;
    pauseIntent.current = !v.paused;
    settings.current.userPaused = pauseIntent.current;
    setUserPaused(pauseIntent.current);
    setHint(false);
    syncPlayback.current();
  }
  const current = config.cues[cue];
  return (
    <div className="mt-3 space-y-3" data-testid="froggy-player">
      <p className="text-xs text-muted-foreground">{config.setup}</p>
      <div ref={stage} className={styles.stage} style={config.offsetY ? { backgroundImage: `url("${config.media}/poster.png")`, backgroundSize: "100% 100%" } : undefined}>
        <video ref={video} className={styles.video} style={{ transform: `translateY(${(config.offsetY ?? 0) * 100}%) scale(${config.scale})`, transformOrigin: "bottom right" }} src={`${config.media}/${mode}.mp4`}
          poster={`${config.media}/poster.png`} muted playsInline loop preload="metadata"
          aria-label={`${config.title} demonstration`}
          onLoadedMetadata={() => {
            const v = video.current!;
            v.currentTime = Math.min(resumeTime.current, Math.max(0, v.duration - .01));
            lastTime.current = v.currentTime; resetPlaybackSample.current = true; v.playbackRate = speed;
            setFailed(false); setStatus("Paused");
            // Metadata-only preload may stop before canplay in WebKit. Start
            // loading playback here instead of waiting for that later event.
            syncPlayback.current();
          }}
          onCanPlay={() => syncPlayback.current()}
          onPlay={() => { setPlaying(true); setStatus("Playing"); }}
          onPause={() => { setPlaying(false); setStatus(current => failed ? current : "Paused"); }}
          onWaiting={() => setStatus("Buffering…")}
          onPlaying={() => setStatus("Playing")}
          onError={() => { setFailed(true); setPlaying(false); setStatus("Video unavailable. You can still read the form tips below."); }}
          onTimeUpdate={() => {
            const v = video.current!;
            setPosition(v.currentTime);
          }} />
        <>
          <div key={cue} data-form-banner={cue} className={`${styles.cue} ${config.floatingCue ? styles.floatingCue : ""} ${current.kind === "AVOID" ? styles.avoid : ""}`}>
            <span className={styles.tag}>
              {current.kind === "DO" ? <CircleCheck aria-hidden="true" /> : <CircleX aria-hidden="true" />}{current.kind}
            </span><span className={styles.cueText}>{current.text}</span>
          </div>
          <svg className={styles.pointer} viewBox="0 0 1080 1080" role="img" aria-label={`Form tips: ${config.callouts.map(c => c.text.join(" ")).join("; ")}`}>
            {config.callouts.map((label, index) => <g key={label.id} ref={element => { callouts.current[index] = element; }} data-form-callout={label.id}>
              <path fill="none" stroke="#14221f" strokeWidth="3.5" strokeOpacity=".85" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
              <path fill="none" stroke="#fff" strokeWidth="1.75" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
              <circle r="8" fill="#14221f" fillOpacity=".8" stroke="#fff" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
              <rect x={label.x} y={label.y} width="282" height="110" rx="14" fill="#14221f" fillOpacity=".78" />
              <text x={label.x + 16} y={label.y + 43} fill="#fff" fontFamily="system-ui" fontSize="39" fontWeight="600">
                <tspan x={label.x + 16}>{label.text[0]}</tspan>
                <tspan x={label.x + 16} dy="43">{label.text[1]}</tspan>
              </text>
            </g>)}
          </svg>
        </>
        <button type="button" className={styles.tapTarget} onClick={playPause} disabled={failed}
          aria-label={playing ? "Pause form animation" : "Resume form animation"} />
        {(!playing || hint) && !failed && <span className={styles.playbackState}>
          {playing ? "Tap to pause" : status}
        </span>}
      </div>
      <div className="flex flex-wrap gap-2">
        {failed && <Button type="button" onClick={() => { setFailed(false); setStatus("Loading video…"); video.current?.load(); }}>Retry video</Button>}
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer py-2 font-medium">Playback options</summary>
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
        {config.modes.length > 1 && <label>Highlights <select aria-label="Muscle highlights" className="min-h-11 rounded-md border bg-background p-2" value={mode} onChange={e => loadMode(e.target.value as Mode)}>
          {config.modes.map(m => <option key={m} value={m}>{m === "pulse" ? "Pulse" : m === "steady" ? "Steady" : "None"}</option>)}
        </select></label>}
        <label>Speed <select aria-label="Playback speed" className="min-h-11 rounded-md border bg-background p-2" value={speed} onChange={e => { const s = Number(e.target.value); setSpeed(s); video.current!.playbackRate = s; }}>
          <option value={1}>Normal</option><option value={.5}>Half</option><option value={.25}>Quarter</option>
        </select></label>
      </div>
      <label className="flex items-center gap-3 text-xs">Position
        <input aria-label="Demonstration position" type="range" min={0} max={6} step={.04} value={position} className="min-h-11 min-w-0 flex-1" disabled={failed}
          onChange={e => { const t = Number(e.target.value); resetPlaybackSample.current = true; resumeTime.current = t; lastTime.current = t; video.current!.currentTime = t; setPosition(t); }} />
        <span>{position.toFixed(1)} / 6s</span>
      </label>
      </details>
      <p role="status" className={failed ? "text-xs text-muted-foreground" : "sr-only"}>{failed || status.includes("…") || status.startsWith("Playback") ? status : playing ? "Playing" : "Paused"} · Tip {cue + 1} of {config.cues.length}</p>
      <p className="text-xs">{config.muscles}</p>
      <details className="text-sm" open={failed || undefined}>
        <summary className="cursor-pointer py-2 font-medium">All tips and reference</summary>
        <ul className="list-disc space-y-1 pl-5">{config.cues.map(c => <li key={c.text}><strong>{c.kind}:</strong> {c.text}</li>)}</ul>
        <p className="mt-2"><a className="underline" href={config.reference} target="_blank" rel="noreferrer">{config.referenceLabel}</a></p>
        <p className="mt-2 text-xs text-muted-foreground">Highlights are schematic; the pulse is decorative, not measured muscle activation.</p>
        <p className="mt-2 text-xs text-muted-foreground">Adapted from Snow Rig © Blender Foundation · <a className="underline" href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>.</p>
      </details>
    </div>
  );
}
