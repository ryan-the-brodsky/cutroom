"""Figure separation: mask utils, clean-plate fallback, the gen.separate
job, and the /segment preview — SAM/LaMa are monkeypatched (model-free)."""
import numpy as np
import pytest
from PIL import Image

from conftest import make_image


def _fake_mask(w=768, h=448):
    """A soft blob standing in for a segmented figure."""
    m = np.zeros((h, w), np.float32)
    m[100:300, 200:400] = 1.0
    return m


# ------------------------------------------------------------- mask algebra

def test_mask_utils():
    from cutroom.engine import matte
    m = _fake_mask()
    assert matte.bbox(m) == (200, 100, 400, 300)
    assert matte.bbox(m, pad=10) == (190, 90, 410, 310)
    grown = matte.dilate(m, 8)
    assert grown.sum() > m.sum()
    soft = matte.feather(m, 4)
    assert ((soft > 0) & (soft < 1)).any()
    img = Image.new("RGB", (768, 448), (200, 30, 30))
    rgba = matte.cutout_rgba(img, m)
    assert rgba.mode == "RGBA"
    a = np.asarray(rgba.split()[-1])
    assert a[200, 300] == 255 and a[10, 10] == 0


def test_normalize_prompts():
    from cutroom.engine import matte
    out = matte.normalize_prompts([
        {"x": 10.6, "y": 20.2, "label": 1},
        {"type": "rectangle", "data": [1, 2, 3, 4]},
    ])
    assert out[0] == {"type": "point", "data": [11, 20], "label": 1}
    assert out[1]["type"] == "rectangle"


def test_classical_fill_replaces_hole_only():
    from cutroom.engine import inpaint
    img = Image.new("RGB", (200, 100), (10, 200, 10))
    px = img.load()
    for x in range(80, 120):
        for y in range(30, 70):
            px[x, y] = (250, 0, 0)          # the "figure"
    mask = np.zeros((100, 200), np.float32)
    mask[30:70, 80:120] = 1.0
    out = inpaint.classical_fill(img, mask)
    arr = np.asarray(out)
    assert arr[50, 100][1] > 150            # hole now green-ish
    assert tuple(arr[5, 5]) == (10, 200, 10)  # untouched outside


# ------------------------------------------------- the job + the preview API

@pytest.fixture()
def patched_models(monkeypatch):
    from cutroom.engine import cels, inpaint, matte
    monkeypatch.setattr(matte, "sam_mask",
                        lambda img, prompts: _fake_mask(*img.size[::-1]
                                                        and img.size))
    monkeypatch.setattr(matte, "refined_mask",
                        lambda img, prompts, pad=24: _fake_mask())
    monkeypatch.setattr(matte, "anime_mask", lambda img: _fake_mask())
    monkeypatch.setattr(
        inpaint, "clean_plate",
        lambda img, m, dilate_px=12, feather_px=4, log=None:
        (img.convert("RGB"), "classical"))
    # per-frame isnet-anime at composite time is minutes of CPU — the layer
    # falls back to its window matte when mattes are unavailable
    monkeypatch.setattr(cels, "try_figure_mattes", lambda frames: None)


def test_segment_preview(client, patched_models):
    client.post("/api/projects", json={"id": "p1"})
    from cutroom.storage import get_storage
    store = get_storage().project("p1")
    make_image(store.resolve("renders/stills/A.png"))
    r = client.post("/api/projects/p1/segment",
                    json={"image": "renders/stills/A.png",
                          "prompts": [{"type": "point", "data": [250, 150],
                                       "label": 1}]})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["mask"].startswith("data:image/png;base64,")
    assert d["bbox"] == [184, 84, 416, 316]        # blob bbox + default pad
    assert d["coverage"] > 0.1
    r = client.post("/api/projects/p1/segment",
                    json={"image": "renders/stills/missing.png"})
    assert r.status_code == 400


def test_separate_job_stages_comp(client, patched_models):
    client.post("/api/projects", json={"id": "p1"})
    client.post("/api/projects/p1/shots",
                json={"sid": "S1", "seconds": 6.0})
    from cutroom.storage import get_storage
    store = get_storage().project("p1")
    make_image(store.resolve("renders/stills/S1_plate.png"))

    r = client.post("/api/projects/p1/separate",
                    json={"shot": "S1",
                          "plate": "renders/stills/S1_plate.png",
                          "prompts": [{"type": "point", "data": [250, 150],
                                       "label": 1}]})
    assert r.status_code == 200, r.text
    job = r.json()["job"]
    import time
    for _ in range(80):
        d = client.get(f"/api/jobs/{job}").json()
        if d["status"] in ("done", "failed"):
            break
        time.sleep(0.25)
    assert d["status"] == "done", d.get("error")
    res = d["result"]
    assert store.exists(res["mask"]) and store.exists(res["cutout"])
    assert store.exists(res["clean_plate"])
    assert res["method"] == "classical"

    comps = client.get("/api/projects/p1/comps?shot=S1").json()
    assert len(comps) == 1
    c = comps[0]
    assert c["background"] == res["clean_plate"]
    assert c["duration"] == 6.0
    L = c["layers"][0]
    assert L["matte"] == "figure"
    assert L["source_plate"] == "renders/stills/S1_plate.png"
    assert L["mask"] == res["mask"]
    assert L["clip"] is None
    # region covers the blob (pad applied)
    l, t, rr, b = L["region"]
    assert l <= 200 and t <= 100 and rr >= 400 and b >= 300

    # clean plate lands in the stills gallery as a curatable take
    shot = client.get("/api/projects/p1/shots/S1").json()
    assert res["clean_plate"] in shot["stills"]


def test_layer_reroll_uses_source_plate(client, patched_models):
    """A separated layer's cel must crop the ORIGINAL plate, not the clean
    background it sits over."""
    client.post("/api/projects", json={"id": "p1"})
    client.post("/api/projects/p1/shots", json={"sid": "S1", "seconds": 4})
    client.post("/api/backends", json={"id": "mock", "type": "mock",
                                       "enabled": True})
    from cutroom.storage import get_storage
    store = get_storage().project("p1")
    make_image(store.resolve("renders/stills/orig.png"))
    # a clean plate that is a solid, distinguishable color
    clean = store.resolve("renders/plates/clean.png")
    clean.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (768, 448), (1, 2, 3)).save(clean)

    client.post("/api/projects/p1/comps",
                json={"cid": "c1", "shot": "S1",
                      "background": "renders/plates/clean.png",
                      "layers": [{"id": "fig1", "region": [200, 100, 392, 292],
                                  "matte": "figure",
                                  "source_plate": "renders/stills/orig.png",
                                  "prompt": "the figure breathes",
                                  "media": {"loop": "hold"}, "opacity": 1.0,
                                  "z": 1, "clip": None}]})
    r = client.post("/api/projects/p1/comps/c1/layers/fig1/reroll",
                    json={"backend": "mock"})
    assert r.status_code == 200, r.text
    job = r.json()["job"]
    import time
    for _ in range(120):
        d = client.get(f"/api/jobs/{job}").json()
        if d["status"] in ("done", "failed"):
            break
        time.sleep(0.25)
    assert d["status"] == "done", d.get("error")
    takes = client.get("/api/projects/p1/takes?shot=S1&kind=crop").json()
    assert takes and takes[0]["sources"] == ["renders/stills/orig.png"]
