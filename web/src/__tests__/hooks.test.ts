/**
 * `usePoll`'s freshness knobs (workstream: Timeline freshness fix).
 *
 * A page like the Timeline can sit open for hours while another tab (or an
 * agent driving one) changes what it shows — `usePoll(path, 0)` never
 * refetches on its own, so the only way anyone noticed was reloading the
 * page. Three things earn their keep here:
 *   - a plain interval (not exercised in depth — it is a `setTimeout` loop,
 *     already covered by every page that has always used one)
 *   - `refetchOnFocus`: catch up the instant the tab is looked at again
 *   - `invalidatePoll(path)`: a WebMCP tool bumping a path some OTHER
 *     mounted page is showing right now, the moment it changes
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({ api: vi.fn() }));
import { api } from "../api";
import { invalidatePoll, usePoll } from "../hooks";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  apiMock.mockReset();
});

describe("usePoll", () => {
  it("fetches once on mount and again on refresh()", async () => {
    apiMock.mockResolvedValueOnce({ n: 1 }).mockResolvedValueOnce({ n: 2 });
    const { result } = renderHook(() => usePoll<{ n: number }>("/p/one", 0));
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.data).toEqual({ n: 2 }));
    expect(apiMock).toHaveBeenCalledTimes(2);
  });

  it("does not refetch on focus/visibility unless refetchOnFocus is set", async () => {
    apiMock.mockResolvedValue({ n: 1 });
    renderHook(() => usePoll<{ n: number }>("/p/no-focus", 0));
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));

    act(() => { window.dispatchEvent(new Event("focus")); });
    document.dispatchEvent(new Event("visibilitychange"));
    // Nothing async to await — a wrong implementation would still have fired
    // synchronously off the event; give the microtask queue one turn anyway.
    await Promise.resolve();
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it("refetches immediately when the window regains focus, with refetchOnFocus", async () => {
    apiMock.mockResolvedValue({ n: 1 });
    renderHook(() => usePoll<{ n: number }>("/p/focus", 0, { refetchOnFocus: true }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));

    act(() => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
  });

  it("refetches when the tab becomes visible again, with refetchOnFocus", async () => {
    apiMock.mockResolvedValue({ n: 1 });
    renderHook(() => usePoll<{ n: number }>("/p/visible", 0, { refetchOnFocus: true }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));

    const spy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    spy.mockRestore();
  });

  it("ignores a visibilitychange that fired because the tab went hidden", async () => {
    apiMock.mockResolvedValue({ n: 1 });
    renderHook(() => usePoll<{ n: number }>("/p/hidden", 0, { refetchOnFocus: true }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));

    const spy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await Promise.resolve();
    expect(apiMock).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("invalidatePoll", () => {
  it("forces an already-mounted usePoll(path) to refetch right away", async () => {
    apiMock.mockResolvedValueOnce({ n: 1 }).mockResolvedValueOnce({ n: 2 });
    const { result } = renderHook(() => usePoll<{ n: number }>("/p/shared", 0));
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));

    act(() => { invalidatePoll("/p/shared"); });
    await waitFor(() => expect(result.current.data).toEqual({ n: 2 }));
    expect(apiMock).toHaveBeenCalledTimes(2);
  });

  it("leaves an unrelated path's mount alone", async () => {
    apiMock.mockResolvedValue({ n: 1 });
    const { result } = renderHook(() => usePoll<{ n: number }>("/p/other", 0));
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));

    act(() => { invalidatePoll("/p/not-this-one"); });
    await Promise.resolve();
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual({ n: 1 });
  });

  it("clears the cache even with nothing mounted, so the next mount fetches fresh", async () => {
    apiMock.mockResolvedValueOnce({ n: 1 });
    const first = renderHook(() => usePoll<{ n: number }>("/p/remount", 0));
    await waitFor(() => expect(first.result.current.data).toEqual({ n: 1 }));
    first.unmount();

    invalidatePoll("/p/remount");
    apiMock.mockResolvedValueOnce({ n: 2 });
    // Without the invalidate, a fresh mount would paint {n:1} from cache
    // before the network call resolves — assert the CACHE value is gone,
    // not just that the fetch eventually wins.
    const second = renderHook(() => usePoll<{ n: number }>("/p/remount", 0));
    expect(second.result.current.data).toBeNull();
    await waitFor(() => expect(second.result.current.data).toEqual({ n: 2 }));
  });
});
