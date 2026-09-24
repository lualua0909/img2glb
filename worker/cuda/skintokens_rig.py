"""Rig one model with SkinTokens/TokenRig (skeleton + skin weights) and keep its textures and scale.

The same pipeline as SkinTokens' `demo.py --use_transfer` CLI, without its gradio import (the worker runs no demo UI).
Run with SkinTokens' venv python and cwd = the SkinTokens checkout:

    python skintokens_rig.py --input model.glb --output rigged.glb
"""

import argparse
import os
import subprocess
import sys
import tempfile
import time

os.environ["XFORMERS_IGNORE_FLASH_VERSION_CHECK"] = "1"
sys.path.insert(0, os.getcwd())

import requests  # noqa: E402
from torch import Tensor  # noqa: E402

from src.data.dataset import DatasetConfig, RigDatasetModule  # noqa: E402
from src.data.transform import Transform  # noqa: E402
from src.server.spec import BPY_SERVER, bytes_to_object, get_model, object_to_bytes  # noqa: E402
from src.tokenizer.parse import get_tokenizer  # noqa: E402

CKPT = "experiments/articulation_xl_quantization_256_token_4/grpo_1400.ckpt"  # GRPO-refined, the recommended one


def start_bpy_server() -> subprocess.Popen:
    """Blender (bpy) runs in its own process: SkinTokens talks to it over HTTP for import/export."""
    proc = subprocess.Popen([sys.executable, "bpy_server.py"])  # same process group: the worker kills both on timeout
    t0 = time.time()
    while True:
        try:
            requests.get(f"{BPY_SERVER}/ping", timeout=1)
            return proc
        except requests.RequestException:
            if proc.poll() is not None or time.time() - t0 > 60:
                raise RuntimeError("bpy_server failed to start")
            time.sleep(0.5)


def post_bpy(endpoint: str, payload):
    with tempfile.NamedTemporaryFile(prefix=f"skintokens_{endpoint}_", suffix=".pt", delete=False) as f:
        f.write(object_to_bytes(payload))
        path = f.name
    try:
        r = requests.post(f"{BPY_SERVER}/{endpoint}", data=object_to_bytes({"payload_path": path}))
        r.raise_for_status()
        result = bytes_to_object(r.content)
        if isinstance(result, dict) and result.get("error") is not None:
            raise RuntimeError(result.get("traceback") or result["error"])
        return result
    finally:
        os.remove(path)


def rig(src: str, dst: str):
    model = get_model(CKPT)
    tokenizer = get_tokenizer(**model.tokenizer_config)
    transform = Transform.parse(**model.transform_config["predict_transform"])
    config = DatasetConfig.parse(
        shuffle=False,
        batch_size=1,
        num_workers=1,
        pin_memory=True,
        persistent_workers=False,
        datapath={"data_name": None, "loader": "bpy_server", "filepaths": {"articulation": [src]}},
    ).split_by_cls()
    module = RigDatasetModule(
        predict_dataset_config=config, predict_transform=transform, tokenizer=tokenizer, process_fn=model._process_fn
    )
    batch = next(iter(module.predict_dataloader()["articulation"]))
    batch = {k: v.to("cuda") if isinstance(v, Tensor) else v for k, v in batch.items()}
    batch.pop("skeleton_tokens", None)  # predict the skeleton too
    batch.pop("skeleton_mask", None)
    # SkinTokens' defaults (demo.py): beam search with light sampling.
    batch["generate_kwargs"] = dict(
        max_length=2048,
        top_k=5,
        top_p=0.95,
        temperature=1.0,
        repetition_penalty=2.0,
        num_return_sequences=1,
        num_beams=10,
        do_sample=True,
    )
    asset = model.predict_step(batch, skeleton_tokens=None, make_asset=True)["results"][0].asset
    res = post_bpy("transfer", dict(source_asset=asset, target_path=asset.path, export_path=dst, group_per_vertex=4))
    if res != "ok":
        raise RuntimeError(f"export failed: {res}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    server = start_bpy_server()
    try:
        rig(os.path.abspath(args.input), os.path.abspath(args.output))
    finally:
        server.terminate()


if __name__ == "__main__":
    main()
