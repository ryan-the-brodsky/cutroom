import { forwardRef } from "react";
import { HeadlessPlayer, type PlayerRef } from "../runtime/player";
import { Sequence } from "../runtime/player/composition";
import { type Timeline, clipsOnTrack, orderedTracks } from "../timeline/model";
import { PreviewImage, PreviewText, PreviewVideo } from "./PreviewClip";

/** A live, scrubbable preview of the timeline — the lifted FreeCut player
 * (clock + layout) compositing our URL-served media. Picture only, by design:
 * the audio tracks are played by `preview/timelineAudio.ts`, which follows this
 * player's clock rather than being composited frame by frame. */
export const PreviewStage = forwardRef<PlayerRef, {
  pid: string;
  tl: Timeline;
  onFrameChange?: (f: number) => void;
  /** CSS pixel size of the preview monitor; the 1920×1080 composition is
   * scaled to fit this box (letterboxed) via the player's layoutSize. */
  box?: { width: number; height: number };
  style?: React.CSSProperties;
}>(function PreviewStage({ pid, tl, onFrameChange, box, style }, ref) {
  const total = Math.max(1, tl.total_frames);
  const size = box ?? { width: 480, height: Math.round(480 * tl.height / tl.width) };
  return (
    <HeadlessPlayer
      ref={ref}
      durationInFrames={total}
      fps={tl.fps}
      width={tl.width}
      height={tl.height}
      layoutSize={size}
      onFrameChange={onFrameChange}
      style={{ width: size.width, height: size.height, background: "#000",
               overflow: "hidden", position: "relative", ...style }}
    >
      {orderedTracks(tl)
        .filter((t) => t.kind === "video")
        .flatMap((track) =>
          clipsOnTrack(tl, track.id).map((clip) => (
            <Sequence key={clip.id} from={clip.start}
                      durationInFrames={clip.duration}>
              {clip.kind === "video"
                ? <PreviewVideo pid={pid} clip={clip} fps={tl.fps} />
                : clip.kind === "image"
                  ? <PreviewImage pid={pid} clip={clip} />
                  : clip.kind === "text"
                    ? <PreviewText clip={clip} />
                    : null}
            </Sequence>
          )))}
    </HeadlessPlayer>
  );
});
