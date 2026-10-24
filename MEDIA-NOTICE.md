# 예시 미디어와 외부 구성요소

`public/assets/{room,desk,vanity}*.webp`는 출품자가 보유한 기존 제작 프로젝트의 방 렌더에서 만든 예시입니다. 사용자 지시에 따라 이번 앱·데모에 재사용하며, 원본·Blender 모델·제3자 참고 사진·상용 모델·인증정보는 이 저장소에 포함하지 않습니다. 미디어는 앱 소스의 MIT 라이선스로 재허가하지 않습니다. 자신의 제작물에는 자신이 이용할 권리가 있는 이미지를 올려 사용하세요.

앱의 카메라 계산, ComfyUI 노드, 테스트와 서버·화면 코드는 MIT입니다. 예시가 없어도 자신의 이미지로 실행할 수 있습니다.

외부 구성요소는 별도로 설치하며 이 저장소에 바이너리나 가중치를 배포하지 않습니다.

- [ComfyUI](https://github.com/Comfy-Org/ComfyUI): GPL-3.0. 로컬 별도 서버로 사용합니다.
- [FFmpeg](https://ffmpeg.org/legal.html): 설치한 빌드의 라이선스를 따르세요. H.264 출력에는 libx264 지원이 필요합니다.
- [Pillow](https://python-pillow.github.io/): 설치된 ComfyUI 환경의 기존 패키지를 사용합니다.
- [SDXL Base 1.0](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0): 선택형 실험 경로. CreativeML Open RAIL++-M이며 MIT가 아닙니다. 가중치는 포함하지 않습니다. 이번 공개 검증은 카메라 합성이며 모델 룩 생성의 통과를 주장하지 않습니다.

예시 이미지의 2D 크롭·줌 영상은 새 3D 시점이나 생성형 피사체 동작이 아닙니다. 다른 모델을 직접 선택하면 해당 모델의 이용 조건과 결과를 별도로 확인해야 합니다.
