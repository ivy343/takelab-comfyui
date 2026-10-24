"""TakeLab V1 ComfyUI custom node. SPDX-License-Identifier: MIT"""
from .node import TakeLabCameraRender

NODE_CLASS_MAPPINGS = {"TakeLabCameraRender": TakeLabCameraRender}
NODE_DISPLAY_NAME_MAPPINGS = {"TakeLabCameraRender": "TakeLab · Render camera take"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
