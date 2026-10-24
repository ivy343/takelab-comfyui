"""Thin ComfyUI adapter; the camera core stays usable without torch/ComfyUI.

Copyright (c) 2026 TakeLab contributors. SPDX-License-Identifier: MIT
"""
import json

from PIL import Image

from .camera import CameraError, MAX_SOURCE_PIXELS, render_take, validate_prefix, validate_recipe

DEFAULT_RECIPE = {
    "version": 1, "width": 768, "height": 432, "fps": 24, "duration": 3,
    "start": {"x": 0.5, "y": 0.5, "zoom": 1},
    "end": {"x": 0.6, "y": 0.45, "zoom": 1.5}, "easing": "smoothstep",
}


def image_to_pil(image, check_interrupt):
    """Copy one IMAGE to RGB8 one row at a time, matching SaveImage quantization.

    Reject batches rather than silently rendering only their first image. Never
    change the input tensor and never create a whole floating-point frame batch.
    """
    shape = getattr(image, "shape", ())
    if len(shape) != 4 or shape[0] != 1 or shape[3] != 3:
        raise CameraError("TakeLab requires exactly one IMAGE with shape [1, height, width, 3].")
    height, width = int(shape[1]), int(shape[2])
    if height < 1 or width < 1 or width > 65536 or height > 65536 or width * height > MAX_SOURCE_PIXELS:
        raise CameraError(f"Input dimensions are invalid or exceed {MAX_SOURCE_PIXELS} pixels.")
    if not callable(getattr(image, "is_floating_point", None)) or not image.is_floating_point():
        raise CameraError("Comfy IMAGE must contain floating RGB values in the range 0 to 1.")
    # NumPy is a ComfyUI dependency, imported only for the actual tensor adapter.
    import numpy as np

    output = Image.new("RGB", (width, height))
    try:
        for y in range(height):
            check_interrupt()
            # Move before float conversion: all pixel arithmetic is on the CPU.
            row = image[0, y].detach().cpu().float().numpy()
            if not np.isfinite(row).all() or (row < 0).any() or (row > 1).any():
                raise CameraError("Input IMAGE contains non-finite or out-of-range RGB values.")
            pixels = (row * 255.0).astype(np.uint8).tobytes()
            with Image.frombytes("RGB", (width, 1), pixels) as row_image:
                output.paste(row_image, (0, y))
        return output
    except BaseException:
        output.close()
        raise


class TakeLabCameraRender:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "image": ("IMAGE",),
            "recipe": ("STRING", {"default": json.dumps(DEFAULT_RECIPE), "multiline": True}),
            "filename_prefix": ("STRING", {"default": "takelab/take"}),
        }}

    RETURN_TYPES = ()
    FUNCTION = "render"
    CATEGORY = "TakeLab"
    OUTPUT_NODE = True
    DESCRIPTION = "Render a reproducible 2D crop/zoom camera take on CPU. Requires FFmpeg with libx264."

    @classmethod
    def VALIDATE_INPUTS(cls, recipe, filename_prefix):
        try:
            validate_recipe(recipe)
            validate_prefix(filename_prefix)
        except (CameraError, TypeError, ValueError) as exc:
            return str(exc)
        return True

    def render(self, image, recipe, filename_prefix="takelab/take"):
        recipe = validate_recipe(recipe)
        validate_prefix(filename_prefix)
        # No ComfyUI or torch import occurs while importing camera.py/the package.
        import folder_paths
        from comfy.model_management import throw_exception_if_processing_interrupted

        check = throw_exception_if_processing_interrupted
        check()
        with image_to_pil(image, check) as source:
            ui = render_take(source, recipe, folder_paths.get_output_directory(),
                             filename_prefix, check_interrupt=check)
        return {"ui": ui, "result": ()}
