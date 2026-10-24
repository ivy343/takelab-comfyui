# 조사에서 제품으로

확인: 2026-10-24~25. 커뮤니티 게시물의 성능 주장은 자체 재현 결과와 구분한다. 타인의 워크플로·코드를 그대로 배포하지 않는다.

| 근거 | 확인한 문제와 선택 |
|---|---|
| [X Character Card Studio](https://x.com/wildmindai/status/2113817754843091014) | 참조 이미지에서 여러 결과를 묶어 제공하는 작업 단위가 중요. 기능 하나보다 결과 세트와 선택 과정을 연결 |
| [Reddit: 카메라가 움직이지 않음](https://www.reddit.com/r/comfyui/comments/1kpiral/) | 프롬프트 문장만으로 움직임이 안 나오는 문제. 카메라 임베딩을 모델에 직접 연결 |
| [Reddit: Wan Fun Camera 제어](https://www.reddit.com/r/StableDiffusion/comments/1mxubil/) | 실제 지원 범위에 맞춘 조건을 제공. 구현하지 않은 orbit을 UI에 넣지 않음 |
| [Reddit: 일관된 캐릭터와 포즈](https://www.reddit.com/r/comfyui/comments/1m5hc43/2_days_ago_i_asked_for_a_consistent_character/) | 잘못된 인코더·설치 오류가 사용을 막음. 정확한 모델 이름·노드 사전 검사 |
| [Civitai: Consistent character poses](https://civitai.com/models/1796490) | 참조와 제어 입력을 결합하는 유용한 별도 방향. 첫 구현에 영상·포즈·학습을 모두 섞지 않음 |
| [Civitai: WAN2.2 StartEndFrames](https://civitai.com/models/1835564) | 시작/끝 이미지 연결도 유용하나 의존성 범위가 큼. 기본 코어 노드 경로부터 실행 검증 |
| [CreatorOS Studio](https://github.com/thePloggy/CreatorOS-Studio) | 이미 폭넓은 기능의 앱이 있음. 기능 수 경쟁보다 동일 조건 비교·실패 테이크 재시도에 집중 |
| [Comfy 공식 Wan Camera 예제](https://comfyanonymous.github.io/ComfyUI_examples/wan/) | 카메라 조건 → 실제 확산 생성 경로의 기술 근거 |
| [Wan2.1 Fun Camera 원저자 모델](https://huggingface.co/alibaba-pai/Wan2.1-Fun-V1.1-1.3B-Control-Camera) | Apache-2.0 표시와 파일 출처 확인. 작은 로컬 검증 모델로 선택했으며 최신·최고 품질이라고 주장하지 않음 |

사용자 작업은 이미지 선택 → 장면 설명 한 번 → 카메라 조건 선택 → 순차 생성 → 동기 비교 → 결과 선택이다. 노드 그래프 반복 편집, 같은 설정 재입력, 파일명으로 조건 추적, 여러 플레이어의 시간 맞추기를 줄인다.

실제 샘플에서는 512×336/49프레임의 후퇴·좌측 이동 영상을 생성했고 새 문틀/벽과 가려짐 변화가 나타났다. 동시에 원본 밖 구조를 추정하고 가구 형태가 달라지는 한계도 확인했다. 일반화된 품질·속도·인물 동일성 보장은 아니다.
