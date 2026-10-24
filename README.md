# TakeLab — Motion Takes

**한 이미지와 장면 설명으로 여러 카메라 조건의 영상을 생성하고, 같은 시점에서 비교해 사용할 테이크를 고르는 로컬 앱입니다.**

[36초 실제 데모](https://github.com/ivy343/takelab-comfyui/releases/download/v0.2.0/motion-takes-demo.mp4) · [데모·한국어/일본어 자막](https://github.com/ivy343/takelab-comfyui/releases/tag/v0.2.0)

v0.2는 Wan 2.1 Fun Camera 1.3B를 실제로 실행합니다. v0.1의 디지털 팬/줌 렌더러는 사용하지 않습니다. 카메라 조건이 확산 모델에 들어가며 원본 밖 영역·가려짐·시점 변화를 모델이 생성합니다. 모든 결과가 의도대로 나오는 것은 아니므로 결과 비교와 선택을 작업의 일부로 둡니다.

## 줄이는 작업

- 이미지·장면 설명을 한 번 입력하고 카메라 조건을 최대 3개 고릅니다.
- 시드·프롬프트·크기·길이를 고정한 채 카메라 조건만 바꿉니다. GPU 작업은 순차 실행합니다.
- 완성 영상을 함께 재생하거나 같은 시간으로 이동해 비교합니다.
- 선택한 테이크의 MP4, 실제 실행 API 그래프, 생성 설정을 저장합니다.
- 실패한 테이크만 다시 실행하고 기존 결과·실패 기록은 보존합니다. 전송 응답이 불명확하면 자동 재접수하지 않습니다.

## 준비

Node.js 22 이상, Wan 카메라 관련 코어 노드가 있는 ComfyUI, 아래 모델 4종이 필요합니다. 앱에는 npm 설치가 필요하지 않습니다. 새 custom node·유료 API·파트너 노드를 요구하지 않습니다.

| ComfyUI 모델 폴더 | 파일 |
|---|---|
| `models/diffusion_models` | `wan2.1_fun_camera_v1.1_1.3B_bf16.safetensors` |
| `models/text_encoders` | `umt5_xxl_fp8_e4m3fn_scaled.safetensors` |
| `models/clip_vision` | `clip_vision_h.safetensors` |
| `models/vae` | `wan_2.1_vae.safetensors` |

[공식 Comfy 모델 파일](https://huggingface.co/Comfy-Org/Wan-2.1/tree/main/split_files)에서 받거나, Python 3.11 이상의 표준 라이브러리만 사용하는 다운로드 도구를 실행합니다. 총 약 11.5GB이며 파일 크기와 SHA256을 검사합니다. 기존 파일이 다르면 덮어쓰지 않고 중단합니다.

```powershell
python download-models.py C:/your/ComfyUI/models
```

기존 ComfyUI·PyTorch 환경을 무조건 업그레이드하지 마세요. 앱의 연결 검사가 필요한 노드와 정확한 파일 이름을 확인합니다. 검증 환경은 Windows / ComfyUI 0.39.0 / Python 3.12.6 / Torch 2.14.1+cu130 / RTX 4060 Ti 16GB입니다. 그 밖의 버전·플랫폼은 전체 실행 미검증입니다. 16GB라는 사양만으로 여유 메모리나 실행 성공을 보장하지 않습니다.

## 실행

ComfyUI를 먼저 시작한 뒤 이 폴더에서:

```powershell
$env:COMFY_URL='http://127.0.0.1:8188'
npm start
```

macOS/Linux 셸에서는 `COMFY_URL=http://127.0.0.1:8188 npm start`입니다. 앱은 `http://127.0.0.1:4318`에 열립니다. `PORT`로 앱 포트를 바꿀 수 있습니다. 로컬 작업용이며 공개 서버 배포용 인증 기능은 포함하지 않습니다.

1. 사용할 권리가 있는 PNG/JPEG/WebP 이미지를 선택합니다.
2. 장면과 피사체 동작을 설명하고 카메라 조건을 고릅니다. 모델 특성상 영어 프롬프트를 먼저 권장하나 한국어 입력도 전달합니다.
3. 생성 버튼을 누릅니다. 이미 ComfyUI 큐에 다른 작업이 있으면 대기합니다. 다른 앱이 동시에 큐에 넣는 것까지 잠그지는 않습니다.
4. 완성된 영상은 **함께 재생** 또는 타임라인으로 비교합니다. 선택 후 **MP4 저장**을 누릅니다.

기본값은 512×336, 49프레임, 16fps(3.0625초), 20스텝, 고정 시드입니다. 카메라 강도가 높으면 구조·형태가 더 크게 변할 수 있습니다. 고정/전진/후퇴/좌우/상하 조건을 지원하며 임의 궤적이나 orbit을 제공한다고 주장하지 않습니다.

## 실제 경로와 재현 범위

`LoadImage → CLIPVision / WanCameraEmbedding → WanCameraImageToVideo → KSampler → VAEDecodeTiled → CreateVideo → SaveVideo`.

`engine.mjs`가 검증된 설정으로 API 그래프를 만듭니다. 프롬프트·시드가 같아도 GPU·Torch·Comfy 버전 차이로 픽셀 단위 동일성을 보장하지 않습니다. JSON 워크플로는 Comfy API 형식이며 일반 시각 노드 배치 파일과 다릅니다. `POST /prompt`의 `prompt` 필드에 사용할 수 있습니다.

브라우저는 업로드 이미지를 긴 변 최대 2048px의 PNG 사본으로 변환합니다. 투명 영역은 흰색으로 합성하고 원본 파일은 변경하지 않습니다. `inputSHA256`은 그 업로드 PNG 파일의 해시입니다. 입력 사본과 작업 기록은 `data/`, 출력 영상은 ComfyUI의 `output/motion-takes/`에 저장됩니다. `data/`, 모델, 인증값을 Git에 넣지 마세요.

앱을 재시작하면 기록을 읽고 기존 prompt ID로 실행 상태를 다시 확인합니다. 접수 불명은 중복 실행 방지를 위해 다음 접수를 막습니다. 이때 ComfyUI의 큐와 기록을 확인하고 불명 작업의 실제 존재 여부를 먼저 확인해야 합니다. 대기 취소는 아직 제출하지 않은 테이크에만 적용하며 실행 중인 다른 Comfy 작업을 중단하지 않습니다.

## 검증

`npm test`는 외부 모델 없이 모의 Comfy 서버를 사용합니다. 카메라 조건 전달·입력 제한·순차 실행·동시 접수·재시작·접수 불명·400 거부·출력 경로 제한을 검사합니다.

실제 집 PC에서 512×336/49프레임/16fps의 카메라 조건부 생성과 H.264 출력 성공을 확인했습니다. 단일 사전 검사에서는 약 81초였으며 이는 해당 입력·설정의 관측값입니다. 생성 결과는 원본과 다른 문틀·벽 등 새로운 구조를 포함할 수 있습니다. 건축 실측·정확한 3D 재구성 도구가 아닙니다.

## 라이선스·출처

앱 코드: MIT (`LICENSE`). 모델 가중치는 포함하지 않습니다. [원저자 Wan2.1 Fun Camera 모델 카드](https://huggingface.co/alibaba-pai/Wan2.1-Fun-V1.1-1.3B-Control-Camera)와 [Comfy repack](https://huggingface.co/Comfy-Org/Wan-2.1)의 Apache-2.0 표시 및 각 파일 이용 조건을 확인하세요. MIT 앱 라이선스가 입력 이미지·타 모델·출력의 권리를 대신하지 않습니다.

그래프 설계 근거는 [Comfy 공식 Wan Camera 예제](https://comfyanonymous.github.io/ComfyUI_examples/wan/)입니다. X·Reddit·Civitai 조사는 카메라 제어 실패, 반복 설정, 결과 비교의 수고를 파악하는 데 사용했으며 타인의 workflow JSON·코드를 그대로 포함하지 않았습니다. 조사와 선택 근거는 `RESEARCH.md`에 정리했습니다.

ComfyUI Open Source Higgsfield 출품 업데이트. v0.1은 디지털 줌 시험 이력이며 현재 앱 설명은 이 v0.2를 기준으로 합니다.
