# 미디어와 외부 구성요소

앱 소스는 MIT입니다. 모델 가중치와 사용자의 업로드 이미지는 소스 라이선스에 포함하지 않습니다.

릴리스의 데모는 출품자가 보유한 기존 제작 프로젝트의 방 렌더와 해당 입력으로 실제 생성한 Wan 영상, 실제 앱 캡처를 사용합니다. 사용자 지시에 따라 출품·시연에 사용하며 원본 Blender 파일·제3자 참고 사진·모델 가중치를 재배포하지 않습니다. 데모 미디어를 앱의 MIT 라이선스로 재허가하지 않습니다. 앱은 자신의 권리 있는 이미지로 실행할 수 있습니다.

- ComfyUI: GPL-3.0의 별도 로컬 서버. [저장소](https://github.com/Comfy-Org/ComfyUI)
- Wan2.1 Fun Camera: [원저자 모델 카드](https://huggingface.co/alibaba-pai/Wan2.1-Fun-V1.1-1.3B-Control-Camera), [Comfy repack](https://huggingface.co/Comfy-Org/Wan-2.1). Apache-2.0 표시를 확인했으며 가중치는 별도 다운로드합니다.
- 영상 저장: ComfyUI 코어 CreateVideo/SaveVideo와 해당 환경의 인코더를 사용합니다. 별도 실행 파일은 앱에 묶지 않습니다.

영상 모델은 새 구조를 생성하고 원본의 가구·색·형태를 바꿀 수 있습니다. 정확한 3D 공간 복원이나 건축 치수를 보장하지 않습니다. v0.1의 2D 크롭·줌 코드는 Git 이력에만 남으며 v0.2 생성 경로에 사용하지 않습니다.
