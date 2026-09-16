type PlaybackPosition = {
  currentTime: number;
  duration: number;
  ended: boolean;
  paused: boolean;
  seeking: boolean;
};

/** Some media backends stop nanoseconds short of duration without emitting ended. */
export function froggyClipCompleted(video: PlaybackPosition): boolean {
  if (video.seeking || !Number.isFinite(video.duration) || video.duration <= 0 || !Number.isFinite(video.currentTime)) return false;
  return video.ended || (
    !video.paused &&
    Math.abs(video.duration - video.currentTime) <= 0.000001
  );
}
