"""Isolated v2 probe models; official Comfy repack, byte/hash verified. No installs."""
import hashlib
import json
import pathlib
import sys
import time
import urllib.request
import argparse

parser = argparse.ArgumentParser(description='Download and SHA256-verify the four Wan Camera models (about 11.5 GB). Existing files are preserved.')
parser.add_argument('models_directory', type=pathlib.Path)
ROOT = parser.parse_args().models_directory.resolve()
FILES = [
    ('diffusion_models/wan2.1_fun_camera_v1.1_1.3B_bf16.safetensors', 3232727784, '1a648f6fbb543dd6ac9f2f9af1ca4bc1bbe460482ee4d7984d50565699e97398'),
    ('text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors', 6735906897, 'c3355d30191f1f066b26d93fba017ae9809dce6c627dda5f6a66eaa651204f68'),
    ('clip_vision/clip_vision_h.safetensors', 1264219396, '64a7ef761bfccbadbaa3da77366aac4185a6c58fa5de5f589b42a65bcc21f161'),
    ('vae/wan_2.1_vae.safetensors', 253815318, '2fc39d31359a4b0a64f55876d8ff7fa8d780956ae2cb13463b0223e15148976b'),
]
for rel, size, expected in FILES:
    out = ROOT / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        with out.open('rb') as f:
            actual = hashlib.file_digest(f, 'sha256').hexdigest()
        if out.stat().st_size != size or actual != expected:
            raise RuntimeError('Existing model differs; preserved: ' + rel)
        print(json.dumps({'file':rel,'status':'verified-existing'}), flush=True)
        continue
    part = out.with_suffix('.safetensors.part')
    if part.exists():
        raise RuntimeError('Partial download exists; inspect before retry: ' + str(part))
    url = 'https://huggingface.co/Comfy-Org/Wan-2.1/resolve/main/split_files/' + rel
    digest = hashlib.sha256()
    count = 0
    start = time.monotonic()
    with urllib.request.urlopen(url, timeout=60) as response, part.open('xb') as f:
        while chunk := response.read(4*1024*1024):
            count += len(chunk)
            if count > size:
                raise RuntimeError('Unexpected model size: ' + rel)
            f.write(chunk)
            digest.update(chunk)
    if count != size or digest.hexdigest() != expected:
        raise RuntimeError('Download verification failed: ' + rel)
    part.rename(out)
    print(json.dumps({'file':rel,'status':'verified','bytes':count,'sha256':expected,'seconds':round(time.monotonic()-start,2)}), flush=True)
print('ALL_MODELS_VERIFIED', flush=True)
