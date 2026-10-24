"""TakeLab's CPU camera and streaming encoder. No torch/ComfyUI imports.

Copyright (c) 2026 TakeLab contributors. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import threading
import time
from typing import Callable
import uuid

from PIL import Image
from PIL.PngImagePlugin import PngInfo

RENDERER_VERSION = "1.0.0"
MAX_SOURCE_PIXELS = 16_777_216
MAX_RECIPE_BYTES = 8192
DEFAULT_TIMEOUT_SECONDS = 300


class CameraError(ValueError):
    """Invalid input or an unsuccessful render; no published output is returned."""


def _number(value, name, low, high, *, integer=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise CameraError(f"{name} must be a finite number.")
    if not low <= value <= high or not math.isfinite(value):
        raise CameraError(f"{name} must be between {low} and {high}.")
    if integer and value != int(value):
        raise CameraError(f"{name} must be an integer.")
    return int(value) if integer else float(value)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise CameraError(f"Duplicate recipe field: {key}")
        result[key] = value
    return result


def validate_recipe(value):
    """Return a new canonical v1 recipe without mutating the caller's object."""
    if isinstance(value, str):
        if len(value.encode("utf-8")) > MAX_RECIPE_BYTES:
            raise CameraError("Recipe exceeds 8192 UTF-8 bytes.")
        try:
            value = json.loads(value, object_pairs_hook=_unique_object)
        except (json.JSONDecodeError, RecursionError) as exc:
            raise CameraError("Recipe must be a valid JSON object.") from exc
    keys = {"version", "width", "height", "fps", "duration", "start", "end", "easing"}
    if not isinstance(value, dict) or set(value) != keys:
        raise CameraError("Recipe must contain exactly the v1 camera fields.")
    version = _number(value["version"], "version", 1, 1, integer=True)
    result = {"version": version}
    for axis in ("width", "height"):
        result[axis] = _number(value[axis], axis, 128, 1280, integer=True)
        if result[axis] % 2:
            raise CameraError(f"{axis} must be even for yuv420p video.")
    result["fps"] = _number(value["fps"], "fps", 1, 30, integer=True)
    result["duration"] = _number(value["duration"], "duration", 0.5, 8)
    for name in ("start", "end"):
        pose = value[name]
        if not isinstance(pose, dict) or set(pose) != {"x", "y", "zoom"}:
            raise CameraError(f"{name} must contain exactly x, y, zoom.")
        result[name] = {
            "x": _number(pose["x"], f"{name}.x", 0, 1),
            "y": _number(pose["y"], f"{name}.y", 0, 1),
            "zoom": _number(pose["zoom"], f"{name}.zoom", 1, 3),
        }
    if value["easing"] not in ("linear", "smoothstep"):
        raise CameraError("easing must be linear or smoothstep.")
    result["easing"] = value["easing"]
    return result


def frame_count(recipe):
    """Positive JS Math.round semantics, including .5 ties (not Python bankers' rounding)."""
    recipe = validate_recipe(recipe)
    count = math.floor(recipe["duration"] * recipe["fps"] + 0.5)
    if not 1 <= count <= 240:
        raise CameraError("Recipe must produce between 1 and 240 frames.")
    return count


def frame_time(index, count):
    """Both endpoints included; a single-frame take uses the start pose."""
    count = _number(count, "frame count", 1, 240, integer=True)
    index = _number(index, "frame index", 0, count - 1, integer=True)
    return index / (count - 1) if count > 1 else 0.0


def _source_size(width, height):
    width = _number(width, "source width", 1, 65536, integer=True)
    height = _number(height, "source height", 1, 65536, integer=True)
    if width * height > MAX_SOURCE_PIXELS:
        raise CameraError(f"Input image exceeds {MAX_SOURCE_PIXELS} pixels.")
    return width, height


def compute_crop(source_width, source_height, recipe, t):
    """Floating PIL box (left, top, right, bottom); same math as JS preview.

    Cover-crop to the output aspect, divide its dimensions by zoom, interpolate
    the normalized center and zoom, then clamp the resulting center to input.
    """
    sw, sh = _source_size(source_width, source_height)
    recipe = validate_recipe(recipe)
    t = _number(t, "t", 0, 1)
    ease = t if recipe["easing"] == "linear" else t * t * (3 - 2 * t)
    first, last = recipe["start"], recipe["end"]
    x = first["x"] + (last["x"] - first["x"]) * ease
    y = first["y"] + (last["y"] - first["y"]) * ease
    zoom = first["zoom"] + (last["zoom"] - first["zoom"]) * ease
    aspect = recipe["width"] / recipe["height"]
    if sw / sh > aspect:
        base_width, base_height = sh * aspect, float(sh)
    else:
        base_width, base_height = float(sw), sw / aspect
    crop_width, crop_height = base_width / zoom, base_height / zoom
    # Clamp the left/top rather than rounded centers to retain subpixel motion.
    left = max(0.0, min(sw - crop_width, x * sw - crop_width / 2))
    top = max(0.0, min(sh - crop_height, y * sh - crop_height / 2))
    return (left, top, min(float(sw), left + crop_width),
            min(float(sh), top + crop_height))


def render_frame(source, recipe, t):
    """Resample only this frame. Source pixels and the recipe are not modified."""
    if not isinstance(source, Image.Image) or source.mode != "RGB":
        raise CameraError("Source must be a PIL RGB image.")
    recipe = validate_recipe(recipe)
    box = compute_crop(*source.size, recipe, t)
    # PIL's floating box combines crop+resize without an input-sized crop copy.
    return source.resize((recipe["width"], recipe["height"]),
                         resample=Image.Resampling.LANCZOS, box=box)


def source_pixel_sha256(source):
    """Hash row-major RGB8 pixels, no PNG encoding/EXIF/header in the digest."""
    if not isinstance(source, Image.Image) or source.mode != "RGB":
        raise CameraError("Source must be a PIL RGB image.")
    _source_size(*source.size)
    digest = hashlib.sha256()
    for y in range(source.height):
        with source.crop((0, y, source.width, y + 1)) as row:
            digest.update(row.tobytes())
    return digest.hexdigest()


def validate_prefix(prefix):
    """Portable relative output prefix, never an absolute path or template."""
    if not isinstance(prefix, str) or not 1 <= len(prefix) <= 160:
        raise CameraError("filename_prefix must contain 1 to 160 characters.")
    parts = prefix.split("/")
    for part in parts:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", part):
            raise CameraError("filename_prefix uses slash-separated letters, digits, _ or - only.")
        if re.fullmatch(r"(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])", part):
            raise CameraError("filename_prefix contains a reserved device name.")
    return parts


def _inside(path, root):
    try:
        path.resolve().relative_to(root)
    except ValueError as exc:
        raise CameraError("Output path escapes the ComfyUI output directory.") from exc


def _output_parent(output_dir, prefix):
    parts = validate_prefix(prefix)
    root = Path(output_dir).resolve(strict=True)
    if not root.is_dir():
        raise CameraError("ComfyUI output directory must already exist.")
    parent = root
    for part in parts[:-1]:
        parent = parent / part
        _inside(parent, root)
        if parent.exists() or parent.is_symlink():
            info = parent.lstat()
            if parent.is_symlink() or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                raise CameraError("Output prefix cannot traverse a symlink or junction.")
        else:
            parent.mkdir()
        if not parent.is_dir():
            raise CameraError("Output prefix parent is not a directory.")
    _inside(parent, root)
    return root, parent, parts[-1]


def find_ffmpeg(executable=None):
    # Only the administrator's process environment supplies this override.
    candidate = executable or os.environ.get("TAKELAB_FFMPEG") or "ffmpeg"
    found = shutil.which(os.fspath(candidate))
    if not found:
        raise CameraError("FFmpeg not found. Install FFmpeg with libx264, add its bin directory to PATH, "
                          "or set TAKELAB_FFMPEG to the executable; restart ComfyUI afterwards.")
    return found


def _stderr_tail(path):
    try:
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            handle.seek(max(0, handle.tell() - 4096))
            return handle.read(4096).decode("utf-8", "replace").strip()
    except OSError:
        return ""


def _stop_process(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)


def _encode(source, recipe, stage, ffmpeg, check_interrupt, timeout_seconds):
    total = frame_count(recipe)
    sample_indices = [0, (total - 1) // 2, total - 1]
    samples = ["start.png", "middle.png", "end.png"]
    pixel_hash = source_pixel_sha256(source)
    metadata = {
        "version": 1, "renderer": "TakeLabCameraRender", "renderer_version": RENDERER_VERSION,
        "recipe": recipe, "source_pixel_sha256": pixel_hash,
        "source": {"width": source.width, "height": source.height, "mode": "RGB",
                   "hash_encoding": "row-major RGB8 pixels, no header"},
        "frame_count": total, "actual_duration": total / recipe["fps"],
        "sample_frame_indices": sample_indices,
        "interpolation": "Pillow LANCZOS floating crop box", "pillow_version": Image.__version__,
        "output": {"codec": "h264", "pixel_format": "yuv420p", "audio": False},
    }
    video = stage / "take.mp4"
    stderr_path = stage / "ffmpeg.log"
    args = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
            "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size",
            f'{recipe["width"]}x{recipe["height"]}', "-framerate", str(recipe["fps"]),
            "-i", "pipe:0", "-an", "-c:v", "libx264", "-threads", "1",
            "-filter_threads", "1", "-preset", "veryfast", "-crf", "18",
            "-pix_fmt", "yuv420p", "-frames:v", str(total), "-movflags", "+faststart",
            "-f", "mp4", str(video)]
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    errors = []
    stop = threading.Event()
    with stderr_path.open("wb") as stderr:
        try:
            process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                       stderr=stderr, shell=False, creationflags=creationflags)
        except OSError as exc:
            raise CameraError(f"Could not start FFmpeg: {exc}") from exc

        def write_frames():
            try:
                for index in range(total):
                    if stop.is_set():
                        return
                    with render_frame(source, recipe, frame_time(index, total)) as frame:
                        for sample_index, name in zip(sample_indices, samples):
                            if index == sample_index:
                                png_info = PngInfo()
                                png_info.add_text("takelab", json.dumps(
                                    {**metadata, "frame_index": index}, ensure_ascii=False, allow_nan=False))
                                frame.save(stage / name, format="PNG", pnginfo=png_info)
                        process.stdin.write(frame.tobytes())
            except BaseException as exc:
                errors.append(exc)
            finally:
                try:
                    process.stdin.close()
                except OSError:
                    pass

        writer = threading.Thread(target=write_frames, name="TakeLab-FFmpeg-writer", daemon=True)
        writer.start()
        started = time.monotonic()
        try:
            # The main thread remains interruptible even if FFmpeg blocks stdin.
            while writer.is_alive() or process.poll() is None:
                check_interrupt()
                if time.monotonic() - started > timeout_seconds:
                    raise CameraError(f"FFmpeg render exceeded {timeout_seconds:g} seconds.")
                writer.join(0.05)
                if not writer.is_alive() and process.poll() is None:
                    time.sleep(0.05)
            check_interrupt()
            if process.returncode != 0 or errors:
                detail = _stderr_tail(stderr_path)
                if not detail and errors:
                    detail = str(errors[0])
                raise CameraError(f"FFmpeg encoding failed (exit {process.returncode}): {detail}")
        finally:
            stop.set()
            _stop_process(process)
            writer.join(timeout=5)
            if writer.is_alive():
                raise CameraError("FFmpeg writer did not stop; temporary render was not published.")
    if not video.is_file() or video.stat().st_size == 0:
        raise CameraError("FFmpeg produced no video file.")
    metadata["files"] = {"video": video.name, "images": samples, "recipe": "recipe.json"}
    (stage / "recipe.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2,
                                                allow_nan=False) + "\n", encoding="utf-8")
    stderr_path.unlink(missing_ok=True)
    return metadata


def render_take(source, recipe, output_dir, filename_prefix="takelab/take", *,
                ffmpeg=None, check_interrupt: Callable[[], None] | None = None,
                timeout_seconds=DEFAULT_TIMEOUT_SECONDS):
    """Stream one CPU frame at a time; atomically publish this take only on success.

    Returns the Comfy V1 UI descriptor object, not frame tensors. An interruption
    (including Comfy's BaseException) removes only this call's staging directory.
    """
    recipe = validate_recipe(recipe)
    if not isinstance(source, Image.Image) or source.mode != "RGB":
        raise CameraError("Source must be a PIL RGB image.")
    _source_size(*source.size)
    timeout_seconds = _number(timeout_seconds, "timeout_seconds", 0.01, 3600)
    check_interrupt = check_interrupt or (lambda: None)
    check_interrupt()
    executable = find_ffmpeg(ffmpeg)
    root, parent, stem = _output_parent(output_dir, filename_prefix)
    unique = f"{stem}_{uuid.uuid4().hex}"
    target = parent / unique
    stage = Path(tempfile.mkdtemp(prefix=f".{unique}_pending_", dir=parent))
    try:
        _encode(source, recipe, stage, executable, check_interrupt, timeout_seconds)
        check_interrupt()
        _inside(parent, root)
        if target.exists():
            raise CameraError("Unique output already exists; existing results will not be overwritten.")
        stage.rename(target)
        subfolder = target.relative_to(root).as_posix()

        def descriptor(filename, **extra):
            return {"filename": filename, "subfolder": subfolder, "type": "output", **extra}

        return {"videos": [descriptor("take.mp4", format="video/mp4")],
                "images": [descriptor(name) for name in ("start.png", "middle.png", "end.png")],
                "takelab_recipe": [descriptor("recipe.json")]}
    finally:
        # Only this call's private pending directory; never a prior success.
        if stage.exists():
            shutil.rmtree(stage)
