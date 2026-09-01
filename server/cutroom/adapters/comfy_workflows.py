"""ComfyUI graph builders — the two canonical lanes, fully parameterized.

Defaults reproduce the game7 production recipes exactly (bible/anima-lane.md,
bible/ltx-lane.md); every model filename, sampler, and knob is overridable per
backend (Backend.options["still"|"motion"]) and per request, so the same
builder drives any checkpoints a ComfyUI host actually has.
"""
from __future__ import annotations

ANIMA_STILL_DEFAULTS = {
    "unet": "anima-base-v1.0.safetensors",
    "clip": "qwen_3_06b_base.safetensors",
    "clip_type": "stable_diffusion",     # NOT qwen_image — verified lane finding
    "vae": "qwen_image_vae.safetensors",
    "sampler": "er_sde",
    "scheduler": "simple",
    "steps": 20,
    "cfg": 4.0,
    "positive_prefix": "masterpiece, best quality, score_7, safe, anime screencap, ",
    "negative": ("worst quality, low quality, score_1, score_2, score_3, blurry, "
                 "jpeg artifacts, sepia, watermark, signature, text, "
                 "photorealistic, realistic, 3d"),
    "timeout": 1200,
}

LTX_MOTION_DEFAULTS = {
    "checkpoint": "ltxv-2b-0.9.8-distilled.safetensors",
    "clip": "t5xxl_fp16.safetensors",
    "clip_type": "ltxv",
    "sampler": "euler",
    "steps": 8,
    "cfg": 1.0,
    "fps": 24.0,
    "max_shift": 2.05,
    "base_shift": 0.95,
    "terminal": 0.1,
    "crf": 18.0,
    "negative": ("worst quality, low quality, deformed, distorted, warping, "
                 "morphing, jitter, strobing, sudden movement, camera shake, "
                 "jpeg artifacts, blurry, extra limbs, duplicated people, "
                 "melting faces, duplicate, photorealistic, realistic, 3d"),
    "free_after": True,      # evict weights when done (small-box discipline)
    "timeout": 1800,
}


def anima_graph(o: dict, prompt: str, negative: str, width: int, height: int,
                seed: int, prefix: str, denoise: float = 1.0,
                source_image: str | None = None) -> dict:
    """t2i (EmptyLatent) or i2i (LoadImage→VAEEncode) on the Anima-style stack."""
    positive = (o.get("positive_prefix") or "") + prompt
    neg = negative or o["negative"]
    g = {
        "44": {"class_type": "UNETLoader",
               "inputs": {"unet_name": o["unet"], "weight_dtype": "default"}},
        "45": {"class_type": "CLIPLoader",
               "inputs": {"clip_name": o["clip"], "type": o["clip_type"],
                          "device": "default"}},
        "15": {"class_type": "VAELoader", "inputs": {"vae_name": o["vae"]}},
        "11": {"class_type": "CLIPTextEncode",
               "inputs": {"clip": ["45", 0], "text": positive}},
        "12": {"class_type": "CLIPTextEncode",
               "inputs": {"clip": ["45", 0], "text": neg}},
        "8": {"class_type": "VAEDecode",
              "inputs": {"samples": ["19", 0], "vae": ["15", 0]}},
        "9": {"class_type": "SaveImage",
              "inputs": {"filename_prefix": prefix, "images": ["8", 0]}},
    }
    if source_image:
        g["30"] = {"class_type": "LoadImage", "inputs": {"image": source_image}}
        g["31"] = {"class_type": "VAEEncode",
                   "inputs": {"pixels": ["30", 0], "vae": ["15", 0]}}
        latent = ["31", 0]
    else:
        g["28"] = {"class_type": "EmptyLatentImage",
                   "inputs": {"width": width, "height": height, "batch_size": 1}}
        latent = ["28", 0]
        denoise = 1.0
    g["19"] = {"class_type": "KSampler",
               "inputs": {"model": ["44", 0], "positive": ["11", 0],
                          "negative": ["12", 0], "latent_image": latent,
                          "seed": seed, "steps": int(o["steps"]),
                          "cfg": float(o["cfg"]),
                          "sampler_name": o["sampler"],
                          "scheduler": o["scheduler"], "denoise": denoise}}
    return {"prompt": g}


def ltx_graph(o: dict, image_name: str, prompt: str, negative: str,
              width: int, height: int, frames: int, seed: int,
              prefix: str) -> dict:
    """LTX-class i2v. Constraints: W/H % 32 == 0, frames == 8k+1."""
    neg = negative or o["negative"]
    return {"prompt": {
        "1": {"class_type": "CheckpointLoaderSimple",
              "inputs": {"ckpt_name": o["checkpoint"]}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": o["clip"], "type": o["clip_type"],
                         "device": "default"}},
        "3": {"class_type": "LoadImage", "inputs": {"image": image_name}},
        "4": {"class_type": "CLIPTextEncode",
              "inputs": {"clip": ["2", 0], "text": prompt}},
        "5": {"class_type": "CLIPTextEncode",
              "inputs": {"clip": ["2", 0], "text": neg}},
        "6": {"class_type": "LTXVImgToVideo",
              "inputs": {"positive": ["4", 0], "negative": ["5", 0],
                         "vae": ["1", 2], "image": ["3", 0],
                         "width": width, "height": height, "length": frames,
                         "batch_size": 1, "strength": 1.0}},
        "7": {"class_type": "LTXVConditioning",
              "inputs": {"positive": ["6", 0], "negative": ["6", 1],
                         "frame_rate": float(o["fps"])}},
        "8": {"class_type": "ModelSamplingLTXV",
              "inputs": {"model": ["1", 0], "max_shift": o["max_shift"],
                         "base_shift": o["base_shift"], "latent": ["6", 2]}},
        "9": {"class_type": "LTXVScheduler",
              "inputs": {"steps": int(o["steps"]), "max_shift": o["max_shift"],
                         "base_shift": o["base_shift"], "stretch": True,
                         "terminal": o["terminal"], "latent": ["6", 2]}},
        "10": {"class_type": "KSamplerSelect",
               "inputs": {"sampler_name": o["sampler"]}},
        "11": {"class_type": "SamplerCustom",
               "inputs": {"model": ["8", 0], "add_noise": True,
                          "noise_seed": seed, "cfg": float(o["cfg"]),
                          "positive": ["7", 0], "negative": ["7", 1],
                          "sampler": ["10", 0], "sigmas": ["9", 0],
                          "latent_image": ["6", 2]}},
        "12": {"class_type": "VAEDecode",
               "inputs": {"samples": ["11", 0], "vae": ["1", 2]}},
        "13": {"class_type": "SaveWEBM",
               "inputs": {"images": ["12", 0], "filename_prefix": prefix,
                          "codec": "vp9", "fps": float(o["fps"]),
                          "crf": float(o["crf"])}},
    }}


OUTPUT_NODES = ("9", "13")   # SaveImage / SaveWEBM
