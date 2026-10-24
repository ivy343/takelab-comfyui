"""Small CPU-only tests. Run with Python 3.11 + Pillow; no ComfyUI/torch needed.

FFmpeg/ffprobe integration tests skip explicitly when the executables are absent.
SPDX-License-Identifier: MIT
"""
import copy
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "custom_nodes"))
from takelab import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from takelab import camera
from takelab.node import TakeLabCameraRender, image_to_pil


def recipe(**changes):
    value = {"version": 1, "width": 128, "height": 128, "fps": 10, "duration": 0.5,
             "start": {"x": 0.2, "y": 0.5, "zoom": 1},
             "end": {"x": 0.8, "y": 0.5, "zoom": 2}, "easing": "linear"}
    value.update(changes)
    return value


def fixture():
    # Tiny RGB coordinate field; no purchased/private media or model inference.
    image = Image.new("RGB", (256, 128))
    image.putdata([(x, y * 2, (x + y) % 256) for y in range(128) for x in range(256)])
    return image


class GeometryTests(unittest.TestCase):
    def assertBox(self, actual, expected):
        for a, b in zip(actual, expected):
            self.assertAlmostEqual(a, b, places=8)

    def test_start_middle_end_cover_zoom_and_clamp(self):
        r = recipe()
        self.assertBox(camera.compute_crop(400, 200, r, 0), (0, 0, 200, 200))
        self.assertBox(camera.compute_crop(400, 200, r, 0.5),
                       (400 / 3, 100 / 3, 800 / 3, 500 / 3))
        self.assertBox(camera.compute_crop(400, 200, r, 1), (270, 50, 370, 150))

    def test_smoothstep_interpolates_before_clamping(self):
        r = recipe(easing="smoothstep", start={"x": 0.5, "y": 0.5, "zoom": 1},
                   end={"x": 0.5, "y": 0.5, "zoom": 3})
        box = camera.compute_crop(400, 200, r, 0.25)
        width = 200 / 1.3125  # smoothstep(.25) = .15625
        self.assertBox(box, (200 - width / 2, 100 - width / 2,
                             200 + width / 2, 100 + width / 2))

    def test_extreme_ratios_and_edge_centers_stay_inside(self):
        for dimensions in ((1, 4096), (4096, 1), (3, 2), (2, 3), (256, 128)):
            for output in ((1280, 128), (128, 1280), (128, 128)):
                for center in (0, 1):
                    r = recipe(width=output[0], height=output[1],
                               start={"x": center, "y": center, "zoom": 3})
                    for t in (0, 0.5, 1):
                        l, top, right, bottom = camera.compute_crop(*dimensions, r, t)
                        self.assertTrue(0 <= l < right <= dimensions[0])
                        self.assertTrue(0 <= top < bottom <= dimensions[1])
                        self.assertAlmostEqual((right - l) / (bottom - top), output[0] / output[1], places=6)

    def test_deterministic_frames_preserve_source_and_recipe(self):
        with fixture() as source:
            r = recipe()
            before, original_recipe = source.tobytes(), copy.deepcopy(r)
            for t in (0, 0.5, 1):
                with camera.render_frame(source, r, t) as a, camera.render_frame(source, r, t) as b:
                    self.assertEqual(a.tobytes(), b.tobytes())
                    self.assertEqual(a.size, (128, 128))
            self.assertEqual(source.tobytes(), before)
            self.assertEqual(r, original_recipe)
            self.assertEqual(camera.source_pixel_sha256(source), hashlib.sha256(before).hexdigest())

    def test_identity_frame_is_pixel_exact(self):
        with fixture() as source:
            r = recipe(width=256, start={"x": 0.5, "y": 0.5, "zoom": 1},
                       end={"x": 0.5, "y": 0.5, "zoom": 1})
            with camera.render_frame(source, r, 0.5) as frame:
                self.assertEqual(frame.tobytes(), source.tobytes())

    def test_fractional_crop_really_changes_pixels(self):
        with fixture() as source:
            with camera.render_frame(source, recipe(), 0) as a, camera.render_frame(source, recipe(), 1) as b:
                self.assertNotEqual(a.tobytes(), b.tobytes())
                self.assertLess(a.getpixel((64, 64))[0], b.getpixel((64, 64))[0])

    def test_js_half_up_and_single_frame_time(self):
        self.assertEqual(camera.frame_count(recipe(fps=5)), 3)  # 2.5 -> 3, unlike round(2.5)
        self.assertEqual(camera.frame_count(recipe(fps=1)), 1)
        self.assertEqual(camera.frame_count(recipe(fps=30, duration=8)), 240)
        self.assertEqual(camera.frame_time(0, 1), 0)
        self.assertEqual([camera.frame_time(i, 5) for i in (0, 2, 4)], [0, 0.5, 1])
        for index, count in ((1, 1), (0, 0), (-1, 5), (2.5, 5), (0, 241)):
            with self.assertRaises(camera.CameraError):
                camera.frame_time(index, count)


class ValidationTests(unittest.TestCase):
    def test_valid_recipe_is_canonical_and_not_aliased(self):
        original = recipe()
        actual = camera.validate_recipe(json.dumps(original))
        self.assertEqual(actual, original)
        actual["start"]["x"] = 1
        self.assertEqual(original["start"]["x"], 0.2)

    def test_rejects_invalid_fields(self):
        cases = [{"width": 129}, {"height": 127}, {"width": 1282}, {"width": True},
                 {"fps": 0}, {"fps": 30.1}, {"duration": 0.49}, {"duration": 8.1},
                 {"duration": math.nan}, {"duration": math.inf}, {"easing": "bezier"},
                 {"version": 2}, {"version": True}, {"secret": "unknown field"}]
        for changes in cases:
            with self.subTest(changes=changes), self.assertRaises(camera.CameraError):
                camera.validate_recipe(recipe(**changes))
        for key, invalid in (("x", -0.1), ("y", 1.1), ("zoom", 0.99), ("zoom", 3.01), ("x", True)):
            value = recipe()
            value["start"][key] = invalid
            with self.subTest(key=key, invalid=invalid), self.assertRaises(camera.CameraError):
                camera.validate_recipe(value)

    def test_bad_json_duplicate_keys_and_size(self):
        for value in ("null", "[]", "{", '{"version":1,"version":1}', " " * 8193,
                      recipe(start=None), recipe(end={"x": 0.5, "y": 0.5})):
            with self.subTest(value=str(value)[:50]), self.assertRaises(camera.CameraError):
                camera.validate_recipe(value)

    def test_invalid_time_source_mode_and_size(self):
        for t in (-0.01, 1.01, float("nan"), True):
            with self.assertRaises(camera.CameraError):
                camera.compute_crop(128, 128, recipe(), t)
        for size in ((0, 128), (128, -1), (65536, 65536)):
            with self.assertRaises(camera.CameraError):
                camera.compute_crop(*size, recipe(), 0)
        with Image.new("RGBA", (1, 1)) as rgba, self.assertRaises(camera.CameraError):
            camera.render_frame(rgba, recipe(), 0)

    def test_prefix_escape_device_and_template_rejected(self):
        for prefix in ("../escape", "/absolute", "C:/escape", "x\\y", "a/../b", "a//b",
                       "CON", "folder/LPT1", "foo:bar", "a/", "a%date%", "", "a" * 65):
            with self.subTest(prefix=prefix), self.assertRaises(camera.CameraError):
                camera.validate_prefix(prefix)
        self.assertEqual(camera.validate_prefix("takelab/take_01-test"), ["takelab", "take_01-test"])

    def test_no_torch_or_comfy_import_and_v1_contract(self):
        self.assertNotIn("torch", sys.modules)
        self.assertNotIn("comfy", sys.modules)
        self.assertNotIn("folder_paths", sys.modules)
        node = NODE_CLASS_MAPPINGS["TakeLabCameraRender"]
        self.assertIs(node, TakeLabCameraRender)
        self.assertEqual(NODE_DISPLAY_NAME_MAPPINGS["TakeLabCameraRender"], "TakeLab · Render camera take")
        self.assertEqual(set(node.INPUT_TYPES()["required"]), {"image", "recipe", "filename_prefix"})
        self.assertEqual(node.RETURN_TYPES, ())
        self.assertEqual(node.FUNCTION, "render")
        self.assertTrue(node.OUTPUT_NODE)
        self.assertIs(node.VALIDATE_INPUTS(json.dumps(recipe()), "takelab/take"), True)
        self.assertIsInstance(node.VALIDATE_INPUTS("{}", "takelab/take"), str)

    def test_adapter_rejects_batch_without_loading_numpy(self):
        for shape in ((2, 128, 128, 3), (1, 128, 128, 4), (128, 128, 3), (1, 0, 1, 3)):
            class FakeTensor:
                pass
            value = FakeTensor()
            value.shape = shape
            with self.assertRaises(camera.CameraError):
                image_to_pil(value, lambda: None)

    def test_missing_ffmpeg_is_explicit_and_creates_nothing(self):
        with tempfile.TemporaryDirectory() as output, fixture() as source:
            with self.assertRaisesRegex(camera.CameraError, "FFmpeg not found"):
                camera.render_take(source, recipe(), output, ffmpeg="takelab-missing-ffmpeg-9e4b")
            self.assertEqual(list(Path(output).iterdir()), [])


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg + ffprobe not available")
class EncoderTests(unittest.TestCase):
    def test_one_frame_produces_three_identical_samples(self):
        with tempfile.TemporaryDirectory() as output, fixture() as source:
            ui = camera.render_take(source, recipe(fps=1), output)
            folder = Path(output) / ui["videos"][0]["subfolder"]
            data = json.loads((folder / "recipe.json").read_text(encoding="utf-8"))
            self.assertEqual(data["frame_count"], 1)
            self.assertEqual(data["actual_duration"], 1)
            self.assertEqual(data["recipe"]["duration"], 0.5)
            self.assertEqual(data["sample_frame_indices"], [0, 0, 0])
            with camera.render_frame(source, recipe(fps=1), 0) as expected:
                for item in ui["images"]:
                    with Image.open(folder / item["filename"]) as frame:
                        self.assertEqual(frame.tobytes(), expected.tobytes())

    def test_real_encode_decode_metadata_and_unique_outputs(self):
        with tempfile.TemporaryDirectory() as output, fixture() as source:
            before = source.tobytes()
            ui = camera.render_take(source, recipe(), output)
            self.assertEqual(set(ui), {"videos", "images", "takelab_recipe"})
            self.assertEqual(len(ui["images"]), 3)
            video = Path(output) / ui["videos"][0]["subfolder"] / ui["videos"][0]["filename"]
            self.assertEqual(ui["videos"][0]["format"], "video/mp4")
            data = json.loads((video.parent / "recipe.json").read_text(encoding="utf-8"))
            self.assertEqual(data["source_pixel_sha256"], hashlib.sha256(before).hexdigest())
            self.assertEqual(data["frame_count"], 5)
            self.assertEqual(data["sample_frame_indices"], [0, 2, 4])
            self.assertEqual(data["actual_duration"], 0.5)
            for descriptor, t in zip(ui["images"], (0, 0.5, 1)):
                with Image.open(video.parent / descriptor["filename"]) as sample, camera.render_frame(source, recipe(), t) as expected:
                    self.assertEqual(sample.tobytes(), expected.tobytes())
                    self.assertEqual(json.loads(sample.info["takelab"])["source_pixel_sha256"], data["source_pixel_sha256"])
            probe = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-show_streams",
                                    "-of", "json", str(video)], check=True, capture_output=True, timeout=15)
            streams = json.loads(probe.stdout)["streams"]
            self.assertEqual(len(streams), 1)
            self.assertEqual(streams[0]["codec_name"], "h264")
            self.assertEqual(streams[0]["pix_fmt"], "yuv420p")
            self.assertEqual(streams[0]["width"], 128)
            self.assertEqual(streams[0]["height"], 128)
            self.assertEqual(streams[0]["r_frame_rate"], "10/1")
            self.assertEqual(int(streams[0]["nb_read_frames"]), 5)
            self.assertAlmostEqual(float(streams[0]["duration"]), 0.5)
            decoded = subprocess.run(["ffmpeg", "-v", "error", "-threads", "1", "-i", str(video),
                                      "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
                                     check=True, capture_output=True, timeout=15)
            self.assertEqual(len(decoded.stdout), 5 * 128 * 128 * 3)
            for position, t in ((0, 0), (2, 0.5), (4, 1)):
                actual = decoded.stdout[position * 49152:(position + 1) * 49152]
                with camera.render_frame(source, recipe(), t) as expected:
                    mae = sum(abs(a - b) for a, b in zip(actual, expected.tobytes())) / len(actual)
                    self.assertLess(mae, 6, "Decoded frame should match its camera sample within H.264 loss")
            digest = hashlib.sha256(video.read_bytes()).hexdigest()
            another = camera.render_take(source, recipe(), output)
            self.assertNotEqual(ui["videos"][0]["subfolder"], another["videos"][0]["subfolder"])
            self.assertEqual(hashlib.sha256(video.read_bytes()).hexdigest(), digest)
            self.assertEqual(source.tobytes(), before)
            self.assertFalse(list(Path(output).rglob("*pending*")))

    def test_encoder_failure_preserves_prior_file_and_cleans_pending(self):
        with tempfile.TemporaryDirectory() as output, fixture() as source:
            prior = Path(output) / "prior.mp4"
            prior.write_bytes(b"existing output must survive")
            # Python is executable but deliberately not an FFmpeg encoder.
            with self.assertRaisesRegex(camera.CameraError, "FFmpeg encoding failed"):
                camera.render_take(source, recipe(), output, ffmpeg=sys.executable)
            self.assertEqual(prior.read_bytes(), b"existing output must survive")
            self.assertFalse(list(Path(output).rglob("*.png")))
            self.assertFalse(list(Path(output).rglob("*pending*")))

    def test_baseexception_interrupt_stops_process_and_cleans_pending(self):
        class Interrupt(BaseException):
            pass
        calls, processes = [], []
        original_popen = subprocess.Popen

        def capture(*args, **kwargs):
            process = original_popen(*args, **kwargs)
            processes.append(process)
            return process

        def check():
            calls.append(1)
            if len(calls) >= 2:
                raise Interrupt("Comfy-like cancellation")

        with tempfile.TemporaryDirectory() as output, fixture() as source:
            with patch.object(camera.subprocess, "Popen", side_effect=capture):
                with self.assertRaises(Interrupt):
                    camera.render_take(source, recipe(), output, check_interrupt=check)
            self.assertTrue(processes)
            self.assertTrue(all(p.poll() is not None for p in processes))
            self.assertFalse(list(Path(output).rglob("*pending*")))
            self.assertFalse(list(Path(output).rglob("*.mp4")))

    def test_timeout_terminates_encoder(self):
        original = camera.render_frame

        def slow_frame(*args):
            time.sleep(0.15)
            return original(*args)

        with tempfile.TemporaryDirectory() as output, fixture() as source:
            with patch.object(camera, "render_frame", side_effect=slow_frame):
                with self.assertRaisesRegex(camera.CameraError, "exceeded"):
                    camera.render_take(source, recipe(), output, timeout_seconds=0.03)
            self.assertFalse(list(Path(output).rglob("*pending*")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
