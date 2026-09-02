import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_PUBLIC_CONFIG, publicConfig, resetPublicConfig, youtubeEmbed, youtubeId,
} from "../publicConfig";

afterEach(() => { resetPublicConfig(); });

describe("publicConfig", () => {
  it("fetches once and shares the result", async () => {
    const body = { access_form_url: "https://forms.gle/x", video_url: "", film: null };
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal("fetch", f);
    const [a, b] = await Promise.all([publicConfig(), publicConfig()]);
    expect(a).toEqual(body);
    expect(b).toBe(a);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("fills in missing keys so callers never read undefined", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      { ok: true, json: async () => ({ video_url: "https://youtu.be/abcdefghijk" }) }));
    const c = await publicConfig();
    expect(c.access_form_url).toBe("");
    expect(c.film).toBeNull();
  });

  it("degrades to nothing-configured instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await publicConfig()).toEqual(EMPTY_PUBLIC_CONFIG);
    resetPublicConfig();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    expect(await publicConfig()).toEqual(EMPTY_PUBLIC_CONFIG);
  });
});

describe("youtubeEmbed", () => {
  // whatever the share sheet hands the owner has to work
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?t=42", "dQw4w9WgXcQ"],
    ["https://youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["  https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1  ", "dQw4w9WgXcQ"],
  ])("reads the id out of %s", (url, id) => {
    expect(youtubeId(url)).toBe(id);
    expect(youtubeEmbed(url)).toBe(`https://www.youtube-nocookie.com/embed/${id}`);
  });

  // null, so the page shows a plain link instead of an iframe pointed at nothing
  it.each(["", "not a url", "https://vimeo.com/12345", "https://youtube.com/",
           "https://www.youtube.com/watch?v="])("refuses %s", (url) => {
    expect(youtubeEmbed(url)).toBeNull();
  });
});
