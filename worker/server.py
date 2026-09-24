"""
GPU inference worker for Forma3D, wrapping Tencent Hunyuan3D-2 (https://github.com/Tencent-Hunyuan/Hunyuan3D-2)
or, with ENGINE=2.1, Hunyuan3D-2.1 (https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1, PBR textures).

Modified from the upstream `api_server.py` (NOTICE per Hunyuan3D license §3(b)): adds bearer-token auth,
a single-GPU FIFO job queue, image-URL input, text-to-3D via HunyuanDiT, a bounded job store with TTL
cleanup, a job status API consumed by the Next.js app (web/src/lib/providers/hunyuan.ts), an admin API
(model downloads, model selection with hot reload) used by the web admin CMS (/app/admin/models), and
refinement jobs: the reference image is edited with an instruction (InstructPix2Pix, Vietnamese prompts are
translated to English first), then the model is rebuilt from it, or only re-textured when mesh_url is given.

API (all routes except /healthz require `Authorization: Bearer $WORKER_TOKEN`):
  POST   /v1/preprocess         raw image bytes -> image/png (denoised, background removed, centered)
  POST   /v1/jobs               {image_url | prompt, texture, num_inference_steps, guidance_scale,
                                 octree_resolution, face_count, texture_size, flat_shading, seed,
                                 edit_prompt, edit_image_guidance, mesh_url}   (edit_*/mesh_url: refinement)
  GET    /v1/jobs/{id}          -> {id, status: queued|running|completed|failed, stage, queue_position, error, has_concept_image}
  GET    /v1/jobs/{id}/model    -> model/gltf-binary
  GET    /v1/jobs/{id}/concept  -> image/png (text mode: concept image, refinement: edited image)
  GET    /v1/admin/status       -> device, GPU memory, disk, queue, loaded config, load state
  GET    /v1/admin/models       -> model catalog with local download state
  POST   /v1/admin/models/download {repo_id, subfolder}  (background download into the HF cache)
  DELETE /v1/admin/models?repo_id=&subfolder=            (remove from the HF cache)
  GET    /v1/admin/config       PUT /v1/admin/config {...}  (select models; reloads them between jobs)
  GET    /healthz

Both engines can run side by side (one process each, e.g. :8081 and :8082) on one machine: they share
DATA_ROOT/engine.lock, so only one of them keeps its models in memory. A worker with work asks for the lock
(DATA_ROOT/engine.want); the holder unloads and hands it over once its own queue is empty.

Storage: everything lives under DATA_ROOT (default ../data next to this repo's web/ and worker/ folders):
  models/          Hugging Face cache (HF_HOME) + rembg weights (edit models download here on first refinement)
  worker-jobs[-2.1]/        per-job outputs, purged after JOB_TTL_SECONDS
  worker-config[-2.1].json  model selection saved from the admin CMS
"""
import os

# Must run before huggingface_hub / hy3dgen / rembg are imported: they read these at import time.
DATA_ROOT = os.path.abspath(
    os.environ.get("DATA_ROOT", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data"))
)
os.environ.setdefault("HF_HOME", os.path.join(DATA_ROOT, "models"))
os.environ.setdefault("U2NET_HOME", os.path.join(DATA_ROOT, "models", "u2net"))
ENGINE = os.environ.get("ENGINE", "2.0")
if ENGINE not in ("2.0", "2.1"):
    raise SystemExit("ENGINE must be 2.0 or 2.1")
SUFFIX = "" if ENGINE == "2.0" else "-" + ENGINE
if ENGINE == "2.1":
    import sys

    # Hunyuan3D-2.1 is not a package: its shape and paint code are imported from the repo checkout.
    HY21_REPO = os.path.abspath(os.environ.get("HY21_REPO", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "Hunyuan3D-2.1")))
    sys.path[:0] = [HY21_REPO, os.path.join(HY21_REPO, "hy3dshape"), os.path.join(HY21_REPO, "hy3dpaint")]
    from torchvision_fix import apply_fix  # basicsr (Real-ESRGAN) imports a module newer torchvision removed

    apply_fix()

import fcntl  # noqa: E402
import gc  # noqa: E402
import hmac  # noqa: E402
import ipaddress  # noqa: E402
import json  # noqa: E402
import logging  # noqa: E402
import queue  # noqa: E402
import shutil  # noqa: E402
import socket  # noqa: E402
import signal  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import traceback  # noqa: E402
import uuid  # noqa: E402
from dataclasses import asdict, dataclass, field  # noqa: E402
from io import BytesIO  # noqa: E402
from typing import Literal, Optional  # noqa: E402
from urllib.parse import urlparse  # noqa: E402

import numpy as np  # noqa: E402
import psutil  # noqa: E402
import requests  # noqa: E402
import torch  # noqa: E402
import trimesh  # noqa: E402
import uvicorn  # noqa: E402
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request  # noqa: E402
from fastapi.responses import FileResponse, Response  # noqa: E402
from starlette.concurrency import run_in_threadpool  # noqa: E402
from huggingface_hub import HfApi, hf_hub_download  # noqa: E402
from huggingface_hub.constants import HF_HUB_CACHE  # noqa: E402
from PIL import Image  # noqa: E402
from pydantic import BaseModel, Field, model_validator  # noqa: E402

if ENGINE == "2.0":
    from hy3dgen.shapegen import DegenerateFaceRemover, FaceReducer, FloaterRemover, Hunyuan3DDiTFlowMatchingPipeline  # noqa: E402
else:
    from hy3dshape.pipelines import Hunyuan3DDiTFlowMatchingPipeline  # noqa: E402
    from hy3dshape.postprocessors import DegenerateFaceRemover, FaceReducer, FloaterRemover  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("worker")

# ---------------- config ----------------
TOKEN = os.environ.get("WORKER_TOKEN", "")
if len(TOKEN) < 24:
    raise SystemExit("WORKER_TOKEN must be set (>= 24 chars)")
# CUDA when the host has it, else Apple MPS, else CPU; DEVICE overrides.
DEVICE = os.environ.get("DEVICE") or (
    "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
)
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(DATA_ROOT, "worker-jobs" + SUFFIX))
CONFIG_PATH = os.path.join(DATA_ROOT, f"worker-config{SUFFIX}.json")
ENGINE_LOCK = os.path.join(DATA_ROOT, "engine.lock")
ENGINE_WANT = os.path.join(DATA_ROOT, "engine.want")
# Load models at startup (default engine) or only when the first job arrives.
LOAD_ON_START = os.environ.get("LOAD_ON_START", "1") == "1"
# Upstream defaults differ per engine (Hunyuan3D-2 api_server: 5.0, Hunyuan3D-2.1 gradio_app: 7.5).
DEFAULT_GUIDANCE = 5.0 if ENGINE == "2.0" else 7.5
# Hunyuan3D-2.1 PBR paint: views (6-9) and view resolution (512 or 768). Upstream's maximum by default.
PAINT_VIEWS = int(os.environ.get("PAINT_VIEWS", "9"))
PAINT_RESOLUTION = int(os.environ.get("PAINT_RESOLUTION", "768"))
REALESRGAN_CKPT = os.environ.get("REALESRGAN_CKPT", os.path.join(DATA_ROOT, "models", "realesrgan", "RealESRGAN_x4plus.pth"))
MAX_QUEUE = int(os.environ.get("MAX_QUEUE", "50"))
JOB_TTL_SECONDS = int(os.environ.get("JOB_TTL_SECONDS", str(3 * 3600)))
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_MESH_BYTES = 200 * 1024 * 1024
# Refinement models, loaded on first use (not part of the admin model config).
EDIT_MODEL = os.environ.get("EDIT_MODEL", "timbrooks/instruct-pix2pix")
TRANSLATE_MODEL = os.environ.get("TRANSLATE_MODEL", "Helsinki-NLP/opus-mt-vi-en")
# Background removal (rembg session name). BiRefNet-general (MIT): best of the commercially usable models in rembg.
REMBG_MODEL = os.environ.get("REMBG_MODEL", "birefnet-general")
# Auto-rigging (skeleton + skin weights) with SkinTokens/TokenRig, UniRig's successor (MIT). CUDA only: it needs
# flash-attn, so it is offered only on CUDA hosts that ran cuda/setup-skintokens.sh (own Python 3.11 venv).
SKINTOKENS_REPO = os.path.abspath(
    os.environ.get("SKINTOKENS_REPO", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "SkinTokens"))
)
SKINTOKENS_PYTHON = os.environ.get("SKINTOKENS_PYTHON", os.path.join(SKINTOKENS_REPO, ".venv", "bin", "python"))
SKINTOKENS_CKPTS = (
    "experiments/articulation_xl_quantization_256_token_4/grpo_1400.ckpt",
    "experiments/skin_vae_2_10_32768/last.ckpt",
)
SKINTOKENS_VRAM = 14 * 1024**3  # inference needs ~14 GB
AUTORIG_TIMEOUT = int(os.environ.get("AUTORIG_TIMEOUT", "1800"))
# HunyuanDiT full (non-distilled) model needs ~50 steps; upstream's wrapper hardcodes 25 for the distilled one.
T2I_STEPS = int(os.environ.get("T2I_STEPS", "50"))
# Only fetch input images from these hosts (localhost for the local web app). Empty = any public host.
ALLOWED_IMAGE_HOSTS = {h.strip() for h in os.environ.get("ALLOWED_IMAGE_HOSTS", "").split(",") if h.strip()}

# Model selection: env gives the defaults, the admin CMS overrides them (saved to CONFIG_PATH).
HY_REPO = "tencent/Hunyuan3D-2" if ENGINE == "2.0" else "tencent/Hunyuan3D-2.1"
ENV_MODEL_CONFIG = {
    "shape_model": os.environ.get("SHAPE_MODEL", HY_REPO),
    "shape_subfolder": os.environ.get("SHAPE_SUBFOLDER", "hunyuan3d-dit-v2-0" if ENGINE == "2.0" else "hunyuan3d-dit-v2-1"),
    "enable_tex": os.environ.get("ENABLE_TEX", "1") == "1",
    "tex_model": os.environ.get("TEX_MODEL", HY_REPO),
    "tex_subfolder": os.environ.get("TEX_SUBFOLDER", "hunyuan3d-paint-v2-0" if ENGINE == "2.0" else "hunyuan3d-paintpbr-v2-1"),
    "enable_t2i": os.environ.get("ENABLE_T2I", "1") == "1",
    "t2i_model": os.environ.get("T2I_MODEL", "Tencent-Hunyuan/HunyuanDiT-v1.2-Diffusers"),
    "low_vram": os.environ.get("LOW_VRAM", "0") == "1",
}

os.makedirs(DATA_DIR, exist_ok=True)

# Known single-image models. `requires` = other entries the pipeline also loads.
T2I_ITEM = {"kind": "t2i", "repo_id": "Tencent-Hunyuan/HunyuanDiT-v1.2-Diffusers", "subfolder": "",
            "label": "HunyuanDiT v1.2 (1.5B)", "note": "Full model, text-to-image stage for text-to-3D.", "requires": []}
CATALOG_21 = [
    {"kind": "shape", "repo_id": "tencent/Hunyuan3D-2.1", "subfolder": "hunyuan3d-dit-v2-1",
     "label": "Hunyuan3D-DiT v2.1 (3.3B)", "note": "Full model, 50 steps.",
     "requires": [["tencent/Hunyuan3D-2.1", "hunyuan3d-vae-v2-1"]]},
    {"kind": "shape", "repo_id": "tencent/Hunyuan3D-2.1", "subfolder": "hunyuan3d-vae-v2-1",
     "label": "ShapeVAE v2.1", "note": "Decoder for the v2.1 shape model.", "requires": []},
    {"kind": "texture", "repo_id": "tencent/Hunyuan3D-2.1", "subfolder": "hunyuan3d-paintpbr-v2-1",
     "label": "Hunyuan3D-Paint PBR v2.1", "note": "PBR textures (albedo + metallic/roughness); uses DINOv2-giant and Real-ESRGAN.",
     "requires": [["facebook/dinov2-giant", ""]]},
    {"kind": "texture", "repo_id": "facebook/dinov2-giant", "subfolder": "",
     "label": "DINOv2 giant (1.1B)", "note": "Image features for Paint PBR v2.1.", "requires": []},
    T2I_ITEM,
]
CATALOG = [
    {"kind": "shape", "repo_id": "tencent/Hunyuan3D-2", "subfolder": "hunyuan3d-dit-v2-0",
     "label": "Hunyuan3D-DiT v2.0 (1.1B)", "note": "Full model, best with 30-50 steps.",
     "requires": []},
    {"kind": "texture", "repo_id": "tencent/Hunyuan3D-2", "subfolder": "hunyuan3d-paint-v2-0",
     "label": "Hunyuan3D-Paint v2.0 (1.3B)", "note": "Full texture model.",
     "requires": [["tencent/Hunyuan3D-2", "hunyuan3d-delight-v2-0"]]},
    {"kind": "texture", "repo_id": "tencent/Hunyuan3D-2", "subfolder": "hunyuan3d-delight-v2-0",
     "label": "Hunyuan3D-Delight v2.0 (1.3B)", "note": "Removes lighting from the input; needed by Paint.",
     "requires": []},
    T2I_ITEM,
]
if ENGINE == "2.1":
    CATALOG = CATALOG_21

def load_model_config() -> dict:
    try:
        with open(CONFIG_PATH) as f:
            saved = json.load(f)
        return {**ENV_MODEL_CONFIG, **{k: v for k, v in saved.items() if k in ENV_MODEL_CONFIG}}
    except FileNotFoundError:
        return dict(ENV_MODEL_CONFIG)


def save_model_config(cfg: dict):
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp, CONFIG_PATH)


def required_models(cfg: dict) -> set[tuple[str, str]]:
    """(repo_id, subfolder) pairs a config loads; used to block deleting in-use weights."""
    used = {(cfg["shape_model"], cfg["shape_subfolder"])}
    if cfg["enable_tex"]:
        used.add((cfg["tex_model"], cfg["tex_subfolder"]))
        if ENGINE == "2.0":
            used.add((cfg["tex_model"], "hunyuan3d-delight-v2-0"))
    if cfg["enable_t2i"]:
        used.add((cfg["t2i_model"], ""))
    for item in CATALOG:
        if (item["repo_id"], item["subfolder"]) in used:
            used |= {tuple(r) for r in item["requires"]}
    return used


# ---------------- models ----------------
class Models:
    def __init__(self, cfg: dict):
        log.info("loading shape model %s/%s", cfg["shape_model"], cfg["shape_subfolder"])
        self.rembg = remove_background
        if ENGINE == "2.0":
            self.shape = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
                cfg["shape_model"], subfolder=cfg["shape_subfolder"], use_safetensors=True, device=DEVICE
            )
        else:  # 2.1 ships fp16 .ckpt weights only
            self.shape = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
                cfg["shape_model"], subfolder=cfg["shape_subfolder"], device=DEVICE
            )
        # FlashVDM swaps in the turbo VAE with approximate decoding; full models keep their own VAE.
        if "turbo" in cfg["shape_subfolder"]:
            self.shape.enable_flashvdm(mc_algo="mc")
        self.tex = None
        if cfg["enable_tex"] and ENGINE == "2.1":
            log.info("loading texture model %s/%s", cfg["tex_model"], cfg["tex_subfolder"])
            self.tex = PaintPBR(cfg)
        elif cfg["enable_tex"]:
            from hy3dgen.texgen import Hunyuan3DPaintPipeline

            log.info("loading texture model %s/%s", cfg["tex_model"], cfg["tex_subfolder"])
            # Upstream hardcodes CUDA here; `device` comes from the macOS patch (see mac/README.md).
            device_kw = {} if DEVICE.startswith("cuda") else {"device": DEVICE}
            self.tex = Hunyuan3DPaintPipeline.from_pretrained(cfg["tex_model"], subfolder=cfg["tex_subfolder"], **device_kw)
            if cfg["low_vram"]:
                self.tex.enable_model_cpu_offload()
        self.t2i = None
        if cfg["enable_t2i"]:
            log.info("loading text-to-image model %s", cfg["t2i_model"])
            self.t2i = TextToImage(cfg["t2i_model"])
        self.floater, self.degenerate, self.reducer = FloaterRemover(), DegenerateFaceRemover(), FaceReducer()


class TextToImage:
    """HunyuanDiT concept image for text-to-3D, as upstream's hy3dgen.text2image (Hunyuan3D-2.1 has no copy)."""

    POS = ",白色背景,3D风格,最佳质量"
    NEG = (
        "文本,特写,裁剪,出框,最差质量,低质量,JPEG伪影,PGLY,重复,病态,残缺,多余的手指,变异的手,画得不好的手,画得不好的脸,变异,畸形,"
        "模糊,脱水,糟糕的解剖学,糟糕的比例,多余的肢体,克隆的脸,毁容,恶心的比例,畸形的肢体,缺失的手臂,缺失的腿,额外的手臂,额外的腿,"
        "融合的手指,手指太多,长脖子"
    )

    def __init__(self, model: str):
        from diffusers import AutoPipelineForText2Image

        self.pipe = AutoPipelineForText2Image.from_pretrained(
            model, torch_dtype=torch.float16, enable_pag=True, pag_applied_layers=["blocks.(16|17|18|19)"]
        ).to(DEVICE)

    def __call__(self, prompt: str, seed: int = 0) -> Image.Image:
        g = torch.Generator(device=self.pipe.device).manual_seed(int(seed))
        return self.pipe(
            prompt=prompt[:60] + self.POS, negative_prompt=self.NEG, num_inference_steps=T2I_STEPS,
            pag_scale=1.3, width=1024, height=1024, generator=g, return_dict=False,
        )[0][0]


class PaintPBR:
    """Hunyuan3D-2.1 PBR texturing. Upstream exports GLB through Blender (bpy); here the baked OBJ + albedo /
    metallic / roughness maps are packed into a glTF PBR material with trimesh instead."""

    def __init__(self, cfg: dict):
        from huggingface_hub import snapshot_download
        from textureGenPipeline import Hunyuan3DPaintConfig, Hunyuan3DPaintPipeline

        # diffusers imports the UNet code from the weights snapshot, not from the repo: overwrite it with the
        # repo's patched copy (hardcoded CUDA devices removed, see mac/hunyuan3d-2.1-mps.patch).
        snap = snapshot_download(cfg["tex_model"], allow_patterns=[f"{cfg['tex_subfolder']}/*"])
        for name in ("attn_processor.py", "model.py", "modules.py"):
            src = os.path.join(HY21_REPO, "hy3dpaint", "hunyuanpaintpbr", "unet", name)
            dst = os.path.join(snap, cfg["tex_subfolder"], "unet", name)
            with open(src, "rb") as a, open(dst, "rb") as b:
                same = a.read() == b.read()
            if not same:
                os.remove(dst)  # a symlink into the HF blob store: replace the link, keep the blob
                shutil.copyfile(src, dst)

        conf = Hunyuan3DPaintConfig(PAINT_VIEWS, PAINT_RESOLUTION, device=DEVICE)
        conf.multiview_pretrained_path = cfg["tex_model"]
        conf.realesrgan_ckpt_path = REALESRGAN_CKPT
        conf.multiview_cfg_path = os.path.join(HY21_REPO, "hy3dpaint", "cfgs", "hunyuan-paint-pbr.yaml")
        conf.custom_pipeline = os.path.join(HY21_REPO, "hy3dpaint", "hunyuanpaintpbr")
        self.pipe = Hunyuan3DPaintPipeline(conf)

    def __call__(self, mesh: trimesh.Trimesh, image: Image.Image) -> trimesh.Trimesh:
        with tempfile.TemporaryDirectory() as d:
            mesh.export(os.path.join(d, "white.obj"))
            obj = os.path.join(d, "textured.obj")
            self.pipe(mesh_path=os.path.join(d, "white.obj"), image_path=image, output_mesh_path=obj, use_remesh=False, save_glb=False)
            out = trimesh.load(obj, force="mesh", process=False)
            albedo = Image.open(os.path.join(d, "textured.jpg")).convert("RGB")
            metallic = Image.open(os.path.join(d, "textured_metallic.jpg")).convert("L")
            roughness = Image.open(os.path.join(d, "textured_roughness.jpg")).convert("L")
            # glTF packs roughness in G and metallic in B.
            mr = Image.merge("RGB", (Image.new("L", metallic.size, 0), roughness, metallic))
            material = trimesh.visual.material.PBRMaterial(
                baseColorTexture=albedo, metallicRoughnessTexture=mr, metallicFactor=1.0, roughnessFactor=1.0
            )
            out.visual = trimesh.visual.TextureVisuals(uv=out.visual.uv, material=material)
            return out


class Editor:
    """Instruction-based image editing for refinement jobs. Non-English (e.g. Vietnamese) instructions are
    translated to English first, since InstructPix2Pix only understands English."""

    SIZE = 512  # InstructPix2Pix is trained at 512px

    def __init__(self):
        from diffusers import EulerAncestralDiscreteScheduler, StableDiffusionInstructPix2PixPipeline
        from transformers import MarianMTModel, MarianTokenizer

        log.info("loading edit model %s and translator %s", EDIT_MODEL, TRANSLATE_MODEL)
        self.tokenizer = MarianTokenizer.from_pretrained(TRANSLATE_MODEL)
        self.translator = MarianMTModel.from_pretrained(TRANSLATE_MODEL).eval()  # small: stays on CPU
        cuda_or_mps = DEVICE.startswith("cuda") or DEVICE == "mps"
        self.pipe = StableDiffusionInstructPix2PixPipeline.from_pretrained(
            EDIT_MODEL,
            dtype=torch.float16 if cuda_or_mps else torch.float32,
            variant="fp16" if cuda_or_mps else None,
            use_safetensors=True,
            safety_checker=None,
            requires_safety_checker=False,
        )
        self.pipe.scheduler = EulerAncestralDiscreteScheduler.from_config(self.pipe.scheduler.config)
        self.pipe.to(DEVICE)
        self.pipe.set_progress_bar_config(disable=True)

    def to_english(self, text: str) -> str:
        if text.isascii():
            return text
        batch = self.tokenizer([text], return_tensors="pt")
        out = self.translator.generate(**batch, max_new_tokens=128)
        english = self.tokenizer.decode(out[0], skip_special_tokens=True)
        log.info("translated edit prompt %r -> %r", text, english)
        return english

    def __call__(self, image: Image.Image, instruction: str, seed: int, image_guidance: float) -> Image.Image:
        # Flatten onto white (transparent pixels would turn black) and pad to a square.
        rgba = image.convert("RGBA")
        side = max(rgba.size)
        canvas = Image.new("RGBA", (side, side), (255, 255, 255, 255))
        canvas.alpha_composite(rgba, ((side - rgba.width) // 2, (side - rgba.height) // 2))
        source = canvas.convert("RGB").resize((self.SIZE, self.SIZE), Image.LANCZOS)
        return self.pipe(
            self.to_english(instruction),
            image=source,
            num_inference_steps=20,
            image_guidance_scale=image_guidance,
            guidance_scale=7.5,
            generator=torch.Generator("cpu").manual_seed(seed),
        ).images[0]


class Runtime:
    """Loaded pipelines. `gpu_lock` is held while a job runs or while models (re)load."""

    def __init__(self):
        self.config = load_model_config()
        self.models: Optional[Models] = None
        self.loading = False
        self.load_error: Optional[str] = None
        self.gpu_lock = threading.Lock()
        self._editor: Optional[Editor] = None
        self._lock_fd: Optional[int] = None  # held while this engine's models are in memory
        self.waiting = False  # blocked on the other engine freeing memory

    def acquire_memory(self):
        """Take DATA_ROOT/engine.lock (called with gpu_lock held). Blocks until the other engine unloads."""
        if self._lock_fd is not None:
            return
        with open(ENGINE_WANT, "w") as f:
            f.write(ENGINE)
        fd = os.open(ENGINE_LOCK, os.O_CREAT | os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log.info("waiting for the other engine to free memory")
            self.waiting = True
            fcntl.flock(fd, fcntl.LOCK_EX)
            self.waiting = False
        self._lock_fd = fd

    def unload(self):
        """Free the models and release the engine lock (called with gpu_lock held)."""
        self.models = None
        self._editor = None
        gc.collect()
        empty_cache()
        if self._lock_fd is not None:
            fcntl.flock(self._lock_fd, fcntl.LOCK_UN)
            os.close(self._lock_fd)
            self._lock_fd = None
        log.info("models unloaded")

    def editor(self) -> Editor:
        """Loaded on the first refinement job (called with gpu_lock held); downloads weights the first time."""
        if self._editor is None:
            self._editor = Editor()
        return self._editor

    def load(self, cfg: dict):
        with self.gpu_lock:
            self.load_locked(cfg)

    def load_locked(self, cfg: dict):
        """(Re)load models; caller holds gpu_lock."""
        self.acquire_memory()
        self.loading = True
        previous = self.models is not None and self.config
        self.models = None
        gc.collect()
        empty_cache()
        try:
            self.models = Models(cfg)
            self.config, self.load_error = cfg, None
            save_model_config(cfg)
            log.info("models loaded")
        except Exception as e:  # noqa: BLE001
            self.load_error = f"Loading {cfg['shape_model']}/{cfg['shape_subfolder']} failed: {str(e)[:400]}"
            log.error("%s\n%s", self.load_error, traceback.format_exc())
            if previous:
                try:
                    self.models = Models(previous)
                    self.load_error += " (previous models restored)"
                except Exception as e2:  # noqa: BLE001
                    self.load_error += f" (restoring previous models failed: {str(e2)[:200]})"
        finally:
            self.loading = False
            empty_cache()


def empty_cache():
    if DEVICE.startswith("cuda") and torch.cuda.is_available():
        torch.cuda.empty_cache()
    elif DEVICE == "mps":
        torch.mps.empty_cache()


rt = Runtime()


# ---------------- model downloads ----------------
@dataclass
class Download:
    repo_id: str
    subfolder: str
    status: str = "running"  # running | completed | failed
    total_bytes: int = 0
    done_bytes: int = 0  # finished files
    current_file: Optional[str] = None
    error: Optional[str] = None
    started: float = field(default_factory=time.time)

    def view(self):
        # Bytes of the file in flight: huggingface_hub writes it as blobs/<hash>.incomplete.
        partial = 0
        if self.status == "running":
            blobs = os.path.join(repo_cache_dir(self.repo_id), "blobs")
            try:
                partial = sum(e.stat().st_size for e in os.scandir(blobs) if e.name.endswith(".incomplete"))
            except FileNotFoundError:
                pass
        return {**asdict(self), "downloaded_bytes": min(self.done_bytes + partial, self.total_bytes or 1 << 62)}


downloads: dict[str, Download] = {}
downloads_lock = threading.Lock()


def repo_cache_dir(repo_id: str) -> str:
    return os.path.join(HF_HUB_CACHE, "models--" + repo_id.replace("/", "--"))


def local_files(repo_id: str, subfolder: str) -> list[str]:
    """Snapshot files (symlinks into blobs/) under a subfolder, across cached revisions."""
    root = os.path.join(repo_cache_dir(repo_id), "snapshots")
    out = []
    if not os.path.isdir(root):
        return out
    for rev in os.listdir(root):
        base = os.path.join(root, rev, subfolder) if subfolder else os.path.join(root, rev)
        for dirpath, _, names in os.walk(base):
            out += [os.path.join(dirpath, n) for n in names]
    return out


def local_size(repo_id: str, subfolder: str) -> int:
    blobs = {os.path.realpath(p) for p in local_files(repo_id, subfolder)}
    return sum(os.path.getsize(b) for b in blobs if os.path.exists(b))


def run_download(d: Download):
    try:
        info = HfApi().model_info(d.repo_id, files_metadata=True)
        files = [s for s in info.siblings if not d.subfolder or s.rfilename.startswith(d.subfolder + "/")]
        if not files:
            raise ValueError(f"no files under '{d.subfolder}' in {d.repo_id}")
        d.total_bytes = sum(s.size or 0 for s in files)
        for s in files:
            d.current_file = s.rfilename
            hf_hub_download(d.repo_id, s.rfilename)  # no-op when already cached
            d.done_bytes += s.size or 0
        d.status, d.current_file = "completed", None
        log.info("downloaded %s/%s (%.1f GB)", d.repo_id, d.subfolder, d.total_bytes / 1e9)
    except Exception as e:  # noqa: BLE001
        d.status, d.error = "failed", str(e)[:500]
        log.error("download %s/%s failed: %s", d.repo_id, d.subfolder, e)


# ---------------- jobs ----------------
class JobIn(BaseModel):
    image_url: Optional[str] = None
    prompt: Optional[str] = Field(default=None, max_length=300)
    texture: bool = False
    num_inference_steps: int = Field(default=30, ge=1, le=100)
    guidance_scale: Optional[float] = Field(default=None, ge=1, le=20)  # None = engine default
    octree_resolution: int = Field(default=256, ge=64, le=512)
    face_count: int = Field(default=40000, ge=1000, le=500000)
    # Cap on baked texture maps in px (downscaled after painting); None = engine native size.
    texture_size: Optional[Literal[512, 1024, 2048, 4096]] = None
    # Faceted low poly look: every face gets its own vertices, so normals are per face.
    flat_shading: bool = False
    seed: int = Field(default=1234, ge=0, le=2**31 - 1)
    # Refinement: edit the input image with this instruction before generating.
    edit_prompt: Optional[str] = Field(default=None, max_length=300)
    # InstructPix2Pix image guidance: higher keeps more of the original image.
    edit_image_guidance: float = Field(default=2.0, ge=1.0, le=5.0)
    # Refinement that keeps this mesh (GLB) and only repaints its texture from the (edited) image.
    mesh_url: Optional[str] = None
    # Auto-rig this finished model (GLB) with SkinTokens instead of generating one (CUDA hosts only).
    rig_url: Optional[str] = None

    @model_validator(mode="after")
    def one_input(self):
        if self.rig_url:
            if self.image_url or self.prompt or self.edit_prompt or self.mesh_url:
                raise ValueError("rig_url cannot be combined with other inputs")
            return self
        if bool(self.image_url) == bool(self.prompt):
            raise ValueError("provide exactly one of image_url or prompt")
        if (self.edit_prompt or self.mesh_url) and not self.image_url:
            raise ValueError("edit_prompt and mesh_url need image_url")
        if self.mesh_url and not self.texture:
            raise ValueError("mesh_url needs texture")
        return self


@dataclass
class Job:
    id: str
    params: JobIn
    status: str = "queued"
    stage: Optional[str] = None
    error: Optional[str] = None
    created: float = field(default_factory=time.time)
    has_concept_image: bool = False
    # Seconds per stage (wait, load, concept, edit, shape, texture, total) and peak memory in GB.
    timings: dict = field(default_factory=dict)
    # Progress estimate: the stages this job runs and their expected seconds, fixed when it starts.
    expected: dict = field(default_factory=dict)
    stage_started: float = 0.0

    @property
    def dir(self):
        return os.path.join(DATA_DIR, self.id)

    def enter(self, stage: Optional[str]):
        """Moves to the next stage; the time the finished one took refines the estimate for later jobs."""
        now = time.time()
        if self.stage in self.expected:
            key = stage_key(self.params, self.stage)
            stage_secs[key] = 0.5 * self.expected[self.stage] + 0.5 * (now - self.stage_started)
        self.stage, self.stage_started = stage, now

    @property
    def progress(self) -> int:
        """Estimated percent done: finished stages plus elapsed time in the current one. 100 only once completed."""
        if self.status == "completed":
            return 100
        if self.stage not in self.expected:  # queued, waiting for memory or loading models
            return 0
        stages = list(self.expected)
        done = sum(self.expected[s] for s in stages[: stages.index(self.stage)])
        current = min(time.time() - self.stage_started, 0.95 * self.expected[self.stage])
        return int(99 * (done + current) / sum(self.expected.values()))


# Seconds per stage on this host for the progress bar, seeded with M4 measurements (30 steps, octree 256) and
# updated as stages finish. Shape time depends on steps and octree resolution, so it is tracked per setting.
stage_secs: dict[str, float] = {
    "Creating concept image": 60,
    "Preparing image": 2,
    "Editing image": 60,
    "Loading model": 5,
    "Generating shape": 400 if ENGINE == "2.0" else 580,
    "Cleaning mesh": 15,
    "Painting texture": 270 if ENGINE == "2.0" else 500,
    "Rigging": 120,
}


def stage_key(p: JobIn, stage: str) -> str:
    return f"{stage} {p.num_inference_steps}/{p.octree_resolution}" if stage == "Generating shape" else stage


def expected_stages(p: JobIn) -> dict[str, float]:
    """The stages `run` / `run_autorig` go through for these params, in order, with their expected seconds."""
    if p.rig_url:
        stages = ["Loading model", "Rigging"]
    else:
        stages = [
            "Creating concept image" if p.prompt else "Preparing image",
            *(["Editing image"] if p.edit_prompt else []),
            *(["Loading model"] if p.mesh_url else ["Generating shape", "Cleaning mesh"]),
            *(["Painting texture"] if p.texture else []),
        ]
    # A shape setting not seen yet: scale the base estimate (steps linear, octree decoding roughly by area).
    scale = p.num_inference_steps / 30 * (p.octree_resolution / 256) ** 2
    return {
        s: stage_secs.get(stage_key(p, s)) or stage_secs[s] * (scale if s == "Generating shape" else 1)
        for s in stages
    }


jobs: dict[str, Job] = {}
jobs_lock = threading.Lock()
work: "queue.Queue[str]" = queue.Queue(maxsize=MAX_QUEUE)


def fetch_bytes(url: str, max_bytes: int) -> bytes:
    u = urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise ValueError("invalid url")
    if ALLOWED_IMAGE_HOSTS and u.hostname not in ALLOWED_IMAGE_HOSTS:
        raise ValueError("host not allowed")
    # SSRF guard: refuse private / loopback targets.
    for info in socket.getaddrinfo(u.hostname, None):
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            if not ALLOWED_IMAGE_HOSTS:
                raise ValueError("host resolves to a private address")
    with requests.get(url, stream=True, timeout=30) as r:
        r.raise_for_status()
        buf = BytesIO()
        for chunk in r.iter_content(64 * 1024):
            buf.write(chunk)
            if buf.tell() > max_bytes:
                raise ValueError("file too large")
    return buf.getvalue()


def fetch_image(url: str) -> Image.Image:
    img = Image.open(BytesIO(fetch_bytes(url, MAX_IMAGE_BYTES)))
    img.load()
    return img


def fetch_mesh(url: str) -> trimesh.Trimesh:
    """A previous result as a plain mesh: textures, UV seams and vertex colors dropped, vertices welded."""
    loaded = trimesh.load(BytesIO(fetch_bytes(url, MAX_MESH_BYTES)), file_type="glb", force="mesh")
    return trimesh.Trimesh(vertices=loaded.vertices, faces=loaded.faces)  # process=True merges seam vertices


class Stopwatch:
    """Per-stage wall time into job.timings, plus peak process memory (RSS) and MPS/CUDA allocations."""

    def __init__(self, job: Job):
        self.job, self.proc, self.stop = job, psutil.Process(), threading.Event()
        self.peak_rss = self.peak_gpu = 0
        threading.Thread(target=self._sample, daemon=True).start()

    def _sample(self):
        while not self.stop.is_set():
            self.peak_rss = max(self.peak_rss, self.proc.memory_info().rss)
            if DEVICE == "mps":
                self.peak_gpu = max(self.peak_gpu, torch.mps.driver_allocated_memory())
            elif DEVICE.startswith("cuda"):
                self.peak_gpu = max(self.peak_gpu, torch.cuda.max_memory_allocated())
            self.stop.wait(0.5)

    def lap(self, key: str, t0: float):
        self.job.timings[key] = round(time.time() - t0, 1)

    def done(self):
        self.stop.set()
        self.job.timings["peak_rss_gb"] = round(self.peak_rss / 1e9, 1)
        self.job.timings["peak_gpu_gb"] = round(self.peak_gpu / 1e9, 1)


@torch.inference_mode()
def run(models: Models, job: Job, sw: Stopwatch):
    p = job.params
    os.makedirs(job.dir, exist_ok=True)

    if p.prompt:
        if models.t2i is None:
            raise RuntimeError("text-to-3D disabled on this worker")
        job.enter("Creating concept image")
        t = time.time()
        image = models.t2i(p.prompt, seed=p.seed)
        sw.lap("concept", t)
        image.save(os.path.join(job.dir, "concept.png"))
        job.has_concept_image = True
    else:
        job.enter("Preparing image")
        image = fetch_image(p.image_url)

    if p.edit_prompt:
        job.enter("Editing image")
        t = time.time()
        image = rt.editor()(image, p.edit_prompt, p.seed, p.edit_image_guidance)
        sw.lap("edit", t)

    if image.mode != "RGBA":  # keep user-supplied alpha, otherwise remove background (as upstream)
        image = models.rembg(image.convert("RGB"))
    if p.edit_prompt:  # the edited, cut-out image becomes the reference for this version (and later refinements)
        image.save(os.path.join(job.dir, "concept.png"))
        job.has_concept_image = True

    if p.mesh_url:
        job.enter("Loading model")
        mesh = fetch_mesh(p.mesh_url)
    else:
        job.enter("Generating shape")
        t = time.time()
        mesh = models.shape(
            image=image,
            num_inference_steps=p.num_inference_steps,
            guidance_scale=p.guidance_scale or DEFAULT_GUIDANCE,
            generator=torch.Generator(DEVICE).manual_seed(p.seed),
            octree_resolution=p.octree_resolution,
            num_chunks=200000,
            mc_algo="mc",
        )[0]

        job.enter("Cleaning mesh")
        mesh = models.floater(mesh)
        mesh = models.degenerate(mesh)
        mesh = models.reducer(mesh, max_facenum=p.face_count)
        fix_upside_down(mesh, image)
        sw.lap("shape", t)

    if p.texture:
        if models.tex is None:
            raise RuntimeError("texture generation disabled on this worker")
        job.enter("Painting texture")
        t = time.time()
        mesh = models.tex(mesh, image)
        sw.lap("texture", t)
        if p.texture_size:
            cap_textures(mesh, p.texture_size)

    if p.flat_shading:
        mesh.unmerge_vertices()
    mesh.export(os.path.join(job.dir, "model.glb"), include_normals=p.flat_shading or None)


def autorig_available() -> bool:
    return (
        DEVICE.startswith("cuda")
        and torch.cuda.is_available()
        and os.path.isfile(SKINTOKENS_PYTHON)
        and all(os.path.isfile(os.path.join(SKINTOKENS_REPO, c)) for c in SKINTOKENS_CKPTS)
    )


def run_autorig(job: Job, sw: Stopwatch):
    """Skeleton + skin weights for a finished model with SkinTokens (cuda/skintokens_rig.py), run in its own venv
    (called with gpu_lock held). The result keeps the model's own textures and scale."""
    os.makedirs(job.dir, exist_ok=True)
    src, out = os.path.join(job.dir, "input.glb"), os.path.join(job.dir, "model.glb")
    job.enter("Loading model")
    with open(src, "wb") as f:
        f.write(fetch_bytes(job.params.rig_url, MAX_MESH_BYTES))
    free, _ = torch.cuda.mem_get_info()
    if free < SKINTOKENS_VRAM and rt.models is not None:
        log.info("rig job %s: %.1f GB VRAM free, unloading the generation models", job.id, free / 1e9)
        rt.unload()
    job.enter("Rigging")
    t = time.time()
    proc = subprocess.Popen(
        [SKINTOKENS_PYTHON, os.path.join(os.path.dirname(os.path.abspath(__file__)), "cuda", "skintokens_rig.py"),
         "--input", src, "--output", out],
        cwd=SKINTOKENS_REPO,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,  # own process group, with its Blender server
    )
    try:
        output, _ = proc.communicate(timeout=AUTORIG_TIMEOUT)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait()
        raise RuntimeError(f"auto-rig timed out after {AUTORIG_TIMEOUT}s")
    sw.lap("rig", t)
    if proc.returncode != 0 or not os.path.isfile(out):
        tail = (output or "")[-2000:]
        log.error("SkinTokens failed (exit %s):\n%s", proc.returncode, tail)
        raise RuntimeError(f"auto-rig failed: {tail.strip().splitlines()[-1] if tail.strip() else 'no output'}")


def _square_mask(mask: np.ndarray, n: int = 64) -> np.ndarray:
    """Crop a boolean mask to its bounding box, pad it square (centered) and resize to n x n."""
    ys, xs = np.nonzero(mask)
    mask = mask[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
    h, w = mask.shape
    side = max(h, w)
    out = np.zeros((side, side), np.uint8)
    out[(side - h) // 2 : (side - h) // 2 + h, (side - w) // 2 : (side - w) // 2 + w] = mask * 255
    return np.asarray(Image.fromarray(out).resize((n, n), Image.BILINEAR)) > 127


def fix_upside_down(mesh: trimesh.Trimesh, image: Image.Image, margin: float = 0.05):
    """The shape model does not always generate in its canonical pose (front = +Z, up = +Y): depending on the
    seed, some results come out turned 180° (upside down). The front view (the mesh projected on XY) should
    match the reference image's silhouette, so compare it upright and upside down (rotated 180° about X or Z)
    and rotate the mesh, in place, when an upside-down pose matches clearly better."""
    if image.mode != "RGBA":
        return
    alpha = np.asarray(image.getchannel("A")) > 127
    if not alpha.any() or alpha.all():  # no silhouette to compare with
        return
    target = _square_mask(alpha)

    from PIL import ImageDraw

    r = 256
    xy = mesh.vertices[:, :2] - mesh.vertices[:, :2].min(0)
    xy = xy / xy.max() * (r - 1)
    xy[:, 1] = r - 1 - xy[:, 1]  # image rows grow downwards
    canvas = Image.new("1", (r, r), 0)
    draw = ImageDraw.Draw(canvas)
    for tri in xy[mesh.faces]:
        draw.polygon([tuple(v) for v in tri], fill=1)
    front = _square_mask(np.asarray(canvas))

    def iou(a: np.ndarray) -> float:
        return (a & target).sum() / (a | target).sum()

    upright = iou(front)
    # 180° about X maps (x, y) -> (x, -y): the silhouette flips vertically; about Z, it also flips horizontally.
    flipped = {(1, 0, 0): iou(front[::-1]), (0, 0, 1): iou(front[::-1, ::-1])}
    axis, best = max(flipped.items(), key=lambda kv: kv[1])
    log.info("front silhouette IoU: upright %.3f, 180° about X %.3f, about Z %.3f", upright, *flipped.values())
    if best > upright + margin:
        log.info("mesh generated upside down: rotating 180° about %s", "XYZ"[axis.index(1)])
        mesh.apply_transform(trimesh.transformations.rotation_matrix(np.pi, axis))


def cap_textures(mesh: trimesh.Trimesh, size: int):
    """Downscale baked maps (2.0: color image, 2.1: PBR maps) so their longest side is at most `size` px."""
    m = mesh.visual.material
    for attr in ("image", "baseColorTexture", "metallicRoughnessTexture", "normalTexture", "occlusionTexture", "emissiveTexture"):
        img = getattr(m, attr, None)
        if isinstance(img, Image.Image) and max(img.size) > size:
            k = size / max(img.size)
            setattr(m, attr, img.resize((round(img.width * k), round(img.height * k)), Image.LANCZOS))


def gpu_loop():
    if LOAD_ON_START:
        rt.load(rt.config)
    while True:
        job_id = work.get()
        job = jobs.get(job_id)
        if not job:
            continue
        with rt.gpu_lock:  # waits while models reload
            job.status = "running"
            job.expected = expected_stages(job.params)
            t0 = time.time()
            job.timings["wait"] = round(t0 - job.created, 1)
            sw = Stopwatch(job)
            try:
                if job.params.rig_url:
                    run_autorig(job, sw)
                    job.status = "completed"
                    job.enter(None)
                    log.info("rig job %s completed in %.1fs", job.id, time.time() - t0)
                    continue
                if rt.models is None:
                    job.enter("Waiting for memory (other engine)")
                    t = time.time()
                    rt.acquire_memory()
                    job.enter("Loading models")
                    sw.lap("wait_memory", t)
                    t = time.time()
                    rt.load_locked(rt.config)
                    sw.lap("load", t)
                if rt.models is None:
                    raise RuntimeError(f"models not loaded: {rt.load_error or 'unknown error'}")
                run(rt.models, job, sw)
                job.status = "completed"
                job.enter(None)
                log.info("job %s completed in %.1fs", job.id, time.time() - t0)
            except Exception as e:  # noqa: BLE001
                job.status, job.error = "failed", str(e)[:500]
                log.error("job %s failed: %s\n%s", job.id, e, traceback.format_exc())
            finally:
                sw.lap("total", t0)
                sw.done()
                empty_cache()


def yield_memory():
    """Hand the engine lock to the other engine when it asks (engine.want) and this one has nothing to do."""
    while True:
        time.sleep(2)
        if rt._lock_fd is None or not work.empty():
            continue
        try:
            with open(ENGINE_WANT) as f:
                wanted = f.read().strip()
        except FileNotFoundError:
            continue
        if wanted and wanted != ENGINE and rt.gpu_lock.acquire(blocking=False):
            try:
                if work.empty():
                    log.info("engine %s asked for memory: unloading", wanted)
                    rt.unload()
            finally:
                rt.gpu_lock.release()


def janitor():
    while True:
        time.sleep(300)
        cutoff = time.time() - JOB_TTL_SECONDS
        with jobs_lock:
            stale = [j for j in jobs.values() if j.created < cutoff and j.status in ("completed", "failed")]
            for j in stale:
                jobs.pop(j.id, None)
                shutil.rmtree(j.dir, ignore_errors=True)


# ---------------- http ----------------
app = FastAPI(title="Hunyuan3D worker", docs_url=None, redoc_url=None)


def auth(authorization: str = Header(default="")):
    if not hmac.compare_digest(authorization.encode(), f"Bearer {TOKEN}".encode()):
        raise HTTPException(401, "unauthorized")


def get_job(job_id: str) -> Job:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    return job


@app.get("/healthz")
def healthz():
    # ready = can take jobs; models load on demand when they are not in memory.
    return {"ok": True, "ready": rt.load_error is None or rt.models is not None, "loaded": rt.models is not None,
            "engine": ENGINE, "queued": work.qsize(), "device": DEVICE, "autorig": autorig_available()}


_rembg_session = None
_rembg_lock = threading.Lock()


def remove_background(image: Image.Image) -> Image.Image:
    global _rembg_session
    from rembg import new_session, remove

    with _rembg_lock:
        if _rembg_session is None:
            _rembg_session = new_session(REMBG_MODEL)
    return remove(image, session=_rembg_session, bgcolor=[255, 255, 255, 0])


def preprocess_image(data: bytes) -> bytes:
    """Upload preprocessing, previewed by the user before generating: denoise, remove the background
    (the upload's own alpha is kept when it has one), crop to the object and center it on a square
    transparent canvas. Returns PNG bytes; jobs then use its alpha as-is (no second background pass)."""
    import cv2
    import numpy as np
    from PIL import ImageOps

    img = ImageOps.exif_transpose(Image.open(BytesIO(data)))
    img.thumbnail((1024, 1024))
    rgba = img.convert("RGBA")
    rgb = cv2.fastNlMeansDenoisingColored(np.ascontiguousarray(np.asarray(rgba.convert("RGB"))), None, 5, 5, 7, 21)
    out = Image.fromarray(rgb)
    alpha = rgba.getchannel("A")
    if alpha.getextrema()[0] < 255:
        out.putalpha(alpha)
    else:
        out = remove_background(out).convert("RGBA")
    bbox = out.getchannel("A").point(lambda a: 255 if a > 16 else 0).getbbox()
    if bbox is None:
        raise ValueError("no object found in the image")
    obj = out.crop(bbox)
    side = int(max(obj.size) / 0.85)  # ~7.5% margin on each side
    canvas = Image.new("RGBA", (side, side))
    canvas.paste(obj, ((side - obj.width) // 2, (side - obj.height) // 2))
    canvas.thumbnail((1024, 1024))
    buf = BytesIO()
    canvas.save(buf, "PNG", optimize=True)
    return buf.getvalue()


@app.post("/v1/preprocess", dependencies=[Depends(auth)])
async def preprocess(request: Request):
    data = await request.body()
    if not data:
        raise HTTPException(400, "image required")
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "file too large")
    try:
        png = await run_in_threadpool(preprocess_image, data)
    except (ValueError, OSError) as e:  # unreadable image, or nothing left after background removal
        raise HTTPException(422, str(e)[:200])
    return Response(png, media_type="image/png")


@app.post("/v1/jobs", dependencies=[Depends(auth)], status_code=201)
def create_job(body: JobIn):
    if body.rig_url and not autorig_available():
        raise HTTPException(501, "auto-rig needs a CUDA host with SkinTokens set up (cuda/setup-skintokens.sh)")
    job = Job(id=uuid.uuid4().hex, params=body)
    with jobs_lock:
        jobs[job.id] = job
    try:
        work.put_nowait(job.id)
    except queue.Full:
        jobs.pop(job.id, None)
        raise HTTPException(503, "queue full")
    return status(job.id)


@app.get("/v1/jobs/{job_id}", dependencies=[Depends(auth)])
def status(job_id: str):
    job = get_job(job_id)
    position = 0
    if job.status == "queued":
        with work.mutex:
            q = list(work.queue)
        position = q.index(job.id) if job.id in q else 0
    return {
        "id": job.id,
        "status": job.status,
        "stage": job.stage,
        "progress": job.progress,
        "queue_position": position,
        "error": job.error,
        "has_concept_image": job.has_concept_image,
        "engine": ENGINE,
        "timings": job.timings,
    }


@app.get("/v1/jobs/{job_id}/model", dependencies=[Depends(auth)])
def model(job_id: str):
    job = get_job(job_id)
    if job.status != "completed":
        raise HTTPException(409, "not ready")
    return FileResponse(os.path.join(job.dir, "model.glb"), media_type="model/gltf-binary")


@app.get("/v1/jobs/{job_id}/concept", dependencies=[Depends(auth)])
def concept(job_id: str):
    job = get_job(job_id)
    path = os.path.join(job.dir, "concept.png")
    if not os.path.exists(path):
        raise HTTPException(404, "no concept image")
    return FileResponse(path, media_type="image/png")


# ---------------- admin ----------------
# Path components may not start with "." so ".." can't escape the cache dir.
REPO_ID = r"^[\w-][\w.-]*/[\w-][\w.-]*$"
SUBFOLDER = r"^([\w-][\w.-]*)?$"


class ModelRef(BaseModel):
    repo_id: str = Field(pattern=REPO_ID, max_length=100)
    subfolder: str = Field(default="", pattern=SUBFOLDER, max_length=100)


class ModelConfigIn(BaseModel):
    shape_model: str = Field(pattern=REPO_ID, max_length=100)
    shape_subfolder: str = Field(pattern=SUBFOLDER, min_length=1, max_length=100)
    enable_tex: bool
    tex_model: str = Field(pattern=REPO_ID, max_length=100)
    tex_subfolder: str = Field(pattern=SUBFOLDER, min_length=1, max_length=100)
    enable_t2i: bool
    t2i_model: str = Field(pattern=REPO_ID, max_length=100)
    low_vram: bool


def dl_key(repo_id: str, subfolder: str) -> str:
    return f"{repo_id}:{subfolder}"


def pipeline_view(cfg: dict) -> list[dict]:
    """Every model the worker runs, per stage. state: active (in memory), standby (loads with the next job),
    lazy (loaded on first refinement), off (disabled)."""
    loaded = "active" if rt.models is not None else "standby"
    tex = loaded if cfg["enable_tex"] else "off"
    shape = f"{cfg['shape_model']}/{cfg['shape_subfolder']}"
    if ENGINE == "2.0":
        stages = [
            {"stage": "shape", "model": shape, "state": loaded},
            {"stage": "vae", "model": f"{shape} (built-in)", "state": loaded},
            {"stage": "texture", "model": f"{cfg['tex_model']}/{cfg['tex_subfolder']}", "state": tex},
            {"stage": "delight", "model": f"{cfg['tex_model']}/hunyuan3d-delight-v2-0", "state": tex},
        ]
    else:
        stages = [
            {"stage": "shape", "model": shape, "state": loaded},
            {"stage": "vae", "model": f"{cfg['shape_model']}/hunyuan3d-vae-v2-1", "state": loaded},
            {"stage": "texture", "model": f"{cfg['tex_model']}/{cfg['tex_subfolder']} ({PAINT_VIEWS} views @ {PAINT_RESOLUTION}px)", "state": tex},
            {"stage": "dino", "model": "facebook/dinov2-giant", "state": tex},
            {"stage": "upscale", "model": "Real-ESRGAN x4plus", "state": tex},
        ]
    return stages + [
        {"stage": "t2i", "model": cfg["t2i_model"], "state": loaded if cfg["enable_t2i"] else "off"},
        {"stage": "rembg", "model": f"rembg {REMBG_MODEL}", "state": "active"},
        {"stage": "edit", "model": EDIT_MODEL, "state": "active" if rt._editor is not None else "lazy"},
        {"stage": "translate", "model": TRANSLATE_MODEL, "state": "active" if rt._editor is not None else "lazy"},
    ]


@app.get("/v1/admin/status", dependencies=[Depends(auth)])
def admin_status():
    gpu = None
    if DEVICE.startswith("cuda") and torch.cuda.is_available():
        free, total = torch.cuda.mem_get_info()
        gpu = {"name": torch.cuda.get_device_name(0), "free_bytes": free, "total_bytes": total}
    disk = shutil.disk_usage(DATA_ROOT)
    with jobs_lock:
        counts = {s: sum(1 for j in jobs.values() if j.status == s) for s in ("queued", "running", "completed", "failed")}
    return {
        "engine": ENGINE,
        "device": DEVICE,
        "waiting_for_memory": rt.waiting,
        "gpu": gpu,
        "disk": {"path": DATA_ROOT, "free_bytes": disk.free, "total_bytes": disk.total},
        "ready": rt.models is not None,
        "loading": rt.loading,
        "load_error": rt.load_error,
        "config": rt.config,
        "pipeline": pipeline_view(rt.config),
        "jobs": counts,
    }


@app.get("/v1/admin/models", dependencies=[Depends(auth)])
def admin_models():
    in_use = required_models(rt.config)
    with downloads_lock:
        dls = {k: d.view() for k, d in downloads.items()}
    catalog = [
        {
            **item,
            "local_bytes": local_size(item["repo_id"], item["subfolder"]),
            "in_use": (item["repo_id"], item["subfolder"]) in in_use,
            "download": dls.get(dl_key(item["repo_id"], item["subfolder"])),
        }
        for item in CATALOG
    ]
    known = {dl_key(i["repo_id"], i["subfolder"]) for i in CATALOG}
    return {"catalog": catalog, "other_downloads": [d for k, d in dls.items() if k not in known]}


def start_download(repo_id: str, subfolder: str) -> Download:
    key = dl_key(repo_id, subfolder)
    with downloads_lock:
        current = downloads.get(key)
        if current and current.status == "running":
            return current
        d = downloads[key] = Download(repo_id=repo_id, subfolder=subfolder)
    threading.Thread(target=run_download, args=(d,), daemon=True).start()
    return d


@app.post("/v1/admin/models/download", dependencies=[Depends(auth)], status_code=202)
def admin_download(body: ModelRef):
    d = start_download(body.repo_id, body.subfolder)
    # Also fetch what the pipeline loads alongside it (e.g. the turbo VAE, the delight model).
    for item in CATALOG:
        if (item["repo_id"], item["subfolder"]) == (body.repo_id, body.subfolder):
            for repo_id, subfolder in item["requires"]:
                if not local_files(repo_id, subfolder):
                    start_download(repo_id, subfolder)
    return d.view()


@app.delete("/v1/admin/models", dependencies=[Depends(auth)])
def admin_delete_model(
    repo_id: str = Query(pattern=REPO_ID, max_length=100), subfolder: str = Query(default="", pattern=SUBFOLDER)
):
    ref = ModelRef(repo_id=repo_id, subfolder=subfolder)
    if (ref.repo_id, ref.subfolder) in required_models(rt.config):
        raise HTTPException(409, "model is in use by the current config")
    with downloads_lock:
        d = downloads.get(dl_key(ref.repo_id, ref.subfolder))
        if d and d.status == "running":
            raise HTTPException(409, "download in progress")
        downloads.pop(dl_key(ref.repo_id, ref.subfolder), None)
    targets = local_files(ref.repo_id, ref.subfolder)
    if not targets:
        raise HTTPException(404, "not downloaded")
    # Blobs are content-addressed and may be shared with other subfolders: keep those still referenced.
    target_set = set(targets)
    keep = {os.path.realpath(p) for p in local_files(ref.repo_id, "") if p not in target_set}
    freed = 0
    for p in targets:
        blob = os.path.realpath(p)
        os.remove(p)
        if blob != p and blob not in keep and os.path.exists(blob):
            freed += os.path.getsize(blob)
            os.remove(blob)
    return {"deleted_files": len(targets), "freed_bytes": freed}


@app.get("/v1/admin/config", dependencies=[Depends(auth)])
def admin_config():
    return {"config": rt.config, "defaults": ENV_MODEL_CONFIG}


@app.put("/v1/admin/config", dependencies=[Depends(auth)], status_code=202)
def admin_set_config(body: ModelConfigIn):
    if rt.loading:
        raise HTTPException(409, "models are already reloading")
    rt.loading = True  # reported immediately; the reload itself waits for the running job
    threading.Thread(target=rt.load, args=(body.model_dump(),), daemon=True).start()
    return admin_status()


if __name__ == "__main__":
    # Serve the admin API right away; models load in the GPU thread (first start downloads weights).
    threading.Thread(target=gpu_loop, daemon=True).start()
    threading.Thread(target=janitor, daemon=True).start()
    threading.Thread(target=yield_memory, daemon=True).start()
    uvicorn.run(app, host=os.environ.get("HOST", "0.0.0.0"), port=int(os.environ.get("PORT", "8081")), workers=1)
