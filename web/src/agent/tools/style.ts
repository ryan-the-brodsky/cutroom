/**
 * The style register (workstream P).
 *
 * A film has one look, and it is a property of the project, not of the prompt
 * an agent happened to write. The server keeps it in `project.settings.style`
 * and puts it on every still and i2i; this tool is how a director or an agent
 * changes it, and how the Film Editor header learns what to say.
 *
 * The point of the tool is that nobody has to write style words into a shot
 * prompt again — so its description says so, and `write_script` says so too.
 */
import type { ActionDef, ToolResult } from "../contract";
import { ANCHORS, err, ok } from "../contract";
import { cut, filmUrl } from "./util";
import { ROUTES } from "../../routes";

const FILM_ROUTE = ROUTES.film;

/** Named looks the server ships. A custom `prefix` overrides any of them. */
export const STYLE_PRESETS = ["anime-cel", "anime-noir", "anime-pastel"] as const;

export interface StyleRegister {
  name?: string; prefix?: string; suffix?: string; avoid?: string;
  refs?: string[];
}

interface StyleArgs {
  project?: string; preset?: string; prefix?: string; avoid?: string;
  refs?: string[];
}

const slug = (raw: unknown): string =>
  String(raw ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 48);

export const setStyle: ActionDef<StyleArgs> = {
  name: "set_style",
  title: "Set the film's look",
  description:
    "Set the style register — the look the server puts on every still and " +
    "restyle in this film, so no shot prompt has to carry style words. Pick a " +
    "named preset (anime-cel, anime-noir, anime-pastel) or write a custom " +
    "prefix sentence of your own. `avoid` is the negative sent with every " +
    "generation, and it also strips those words out of prompts that already " +
    "carry them. Shots generated before the change keep the look they were " +
    "made with; regenerate to bring them over.",
  inputSchema: {
    type: "object",
    properties: {
      preset: { type: "string", enum: [...STYLE_PRESETS],
                description: "A named house look: anime-cel (default), anime-noir for night, anime-pastel for daylight." },
      prefix: { type: "string", description: "Custom look, as one sentence put in front of every prompt: \"Cinematic anime film still, 1970s rotoscope …\"." },
      avoid: { type: "string", description: "Comma-separated negative applied to every still: \"text, lettering, photorealistic, western cartoon\"." },
      refs: { type: "array", items: { type: "string" },
              description: "Style-reference frames the model matches, as paths. Empty array turns reference conditioning off." },
      project: { type: "string", description: "Project id whose look this is. Defaults to the film that is open." },
    },
    additionalProperties: false,
  },
  annotations: { consequentialHint: true },
  where: { route: FILM_ROUTE, anchor: ANCHORS.filmStyle,
           label: "Film Editor → the style chip" },
  keywords: ["style", "look", "register", "house style", "anime", "preset",
             "consistency", "art direction", "negative"],
  howTo:
    "The Film Editor header shows the film's style register next to the cut " +
    "button; it names the look every still is generated in.",
  summarize: (a) =>
    `Set the look — ${cut(a?.preset || a?.prefix || "the style register", 40)}`,
  async execute(args, ctx): Promise<ToolResult> {
    const pid = slug(args?.project) || ctx.project;
    if (!pid) {
      return err("no_project", {
        hint: "Name the project, or open a film first — a look belongs to a film.",
      });
    }
    const preset = String(args?.preset ?? "").trim().toLowerCase();
    const prefix = String(args?.prefix ?? "").trim();
    const avoid = String(args?.avoid ?? "").trim();
    const refs = Array.isArray(args?.refs) ? args.refs.map(String) : undefined;
    if (!preset && !prefix && !avoid && refs === undefined) {
      return err("nothing_to_set", {
        hint: `Pass preset (${STYLE_PRESETS.join(", ")}), or a custom prefix, or avoid.`,
      });
    }
    if (preset && !(STYLE_PRESETS as readonly string[]).includes(preset)) {
      return err("unknown_preset", {
        hint: `No preset "${cut(preset, 30)}". Known: ${STYLE_PRESETS.join(", ")} — or pass prefix for a look of your own.`,
      });
    }

    try {
      await ctx.nav(filmUrl(pid));
      await ctx.page.waitFor("film", undefined, 3000);
    } catch { /* the register is a server fact; the view is a courtesy */ }

    const body: Record<string, unknown> = {
      ...(preset ? { preset } : {}),
      ...(prefix ? { prefix } : {}),
      ...(avoid ? { avoid } : {}),
      ...(refs !== undefined ? { refs } : {}),
    };
    let res: { style?: StyleRegister };
    try {
      res = await ctx.api<typeof res>(`/api/projects/${pid}/style`, body);
    } catch (e) {
      const status = Number((e as { status?: number })?.status) || 0;
      const hint = cut((e as { message?: string })?.message ?? String(e), 200);
      if (status === 403) return err("forbidden", { hint });
      if (status === 404) return err("no_project", { hint });
      return err("style_write_failed", { hint });
    }
    const style = res?.style || {};
    await ctx.trail.step({
      tool: "set_style", anchor: ANCHORS.filmStyle,
      title: `Style — ${cut(style.name || preset || "custom", 30)}`,
    });
    try {
      const page = await ctx.page.waitFor("film", undefined, 1200);
      await page.refresh();
    } catch { /* the director may be elsewhere */ }

    return ok(`the film's look is “${cut(style.name || preset || "custom", 40)}”`, {
      project: pid,
      style: {
        name: style.name || preset || "custom",
        prefix: cut(style.prefix, 200),
        ...(style.suffix ? { suffix: cut(style.suffix, 120) } : {}),
        avoid: cut(style.avoid, 200),
        refs: (style.refs || []).length,
      },
      next: "every still generated from now on carries this look — no style words in shot prompts",
    });
  },
};
