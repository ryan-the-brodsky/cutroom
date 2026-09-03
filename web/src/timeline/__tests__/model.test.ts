/**
 * `stableClipKey` — the preview's defense against the compiler's per-compile
 * random `id`. The whole-film compile is cached by a fingerprint over the
 * whole project (`cutroom.timeline.compile`), so ANY edit anywhere mints a
 * fresh random `id` for EVERY clip, not just the one that changed. Keying
 * the preview's video/audio elements on `id` would remount all of them on
 * every unrelated edit; this key is what lets an untouched clip keep its
 * DOM element (and its playback position) across a recompile.
 */
import { describe, expect, it } from "vitest";
import { stableClipKey, type Clip } from "../model";

const clip = (over: Partial<Clip> & Pick<Clip, "id" | "track_id" | "kind">): Clip => ({
  start: 0, duration: 24, ...over,
} as Clip);

describe("stableClipKey", () => {
  it("keys a picture clip by its shot, ignoring the churning id", () => {
    const before = clip({ id: "c_aaa111", track_id: "v1", kind: "image",
                          cutroom: { shot: "B06-S2" } });
    const after = clip({ id: "c_zzz999", track_id: "v1", kind: "image",
                         cutroom: { shot: "B06-S2" } });
    expect(stableClipKey(before)).toBe(stableClipKey(after));
  });

  it("gives two different shots two different keys", () => {
    const a = clip({ id: "1", track_id: "v1", kind: "video", cutroom: { shot: "B01-S1" } });
    const b = clip({ id: "2", track_id: "v1", kind: "video", cutroom: { shot: "B01-S2" } });
    expect(stableClipKey(a)).not.toBe(stableClipKey(b));
  });

  it("keys a cue by its own stored id, before the shot or the role", () => {
    const before = clip({ id: "c_aaa", track_id: "sx", kind: "audio",
                          cutroom: { role: "sfx", shot: "B04-S2", cue: "cue_abc123" } });
    const after = clip({ id: "c_zzz", track_id: "sx", kind: "audio",
                         cutroom: { role: "sfx", shot: "B04-S2", cue: "cue_abc123" } });
    expect(stableClipKey(before)).toBe(stableClipKey(after));
    expect(stableClipKey(before)).toBe("cue:cue_abc123");
  });

  it("keys a VO line by its shot and line number, so two lines on one shot differ", () => {
    const line0 = clip({ id: "1", track_id: "a1", kind: "audio",
                         cutroom: { role: "vo", shot: "B01-S1", line: 0 } });
    const line1 = clip({ id: "2", track_id: "a1", kind: "audio",
                         cutroom: { role: "vo", shot: "B01-S1", line: 1 } });
    expect(stableClipKey(line0)).not.toBe(stableClipKey(line1));
  });

  it("does not confuse a shot's VO with a shot-anchored SFX cue on the same shot", () => {
    const vo = clip({ id: "1", track_id: "a1", kind: "audio",
                      cutroom: { role: "vo", shot: "B04-S2", line: 0 } });
    const sfx = clip({ id: "2", track_id: "sx", kind: "audio",
                       cutroom: { role: "sfx", shot: "B04-S2" } });
    expect(stableClipKey(vo)).not.toBe(stableClipKey(sfx));
  });

  it("survives a source, in-point or duration change on the same shot — the caller's job to react to those, not the key's", () => {
    const before = clip({ id: "1", track_id: "v1", kind: "video", start: 0, duration: 48,
                          source: "renders/fx/old.mp4", source_start: 0,
                          cutroom: { shot: "B03-S1" } });
    const after = clip({ id: "2", track_id: "v1", kind: "video", start: 12, duration: 96,
                         source: "renders/fx/new-seedance.mp4", source_start: 10,
                         cutroom: { shot: "B03-S1" } });
    expect(stableClipKey(before)).toBe(stableClipKey(after));
  });

  it("falls back to id when a clip carries no lineage at all", () => {
    const a = clip({ id: "a", track_id: "v1", kind: "video" });
    const b = clip({ id: "b", track_id: "v1", kind: "video" });
    expect(stableClipKey(a)).toBe("a");
    expect(stableClipKey(b)).toBe("b");
  });
});
