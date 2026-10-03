# Apple Silicon Mac

1. 릴리스 ZIP을 압축 해제하고 `Daemonlet for Codex.app`을 응용 프로그램 폴더로 옮깁니다.
2. 같은 Mac 사용자 계정에서 Codex Desktop과 앱을 실행합니다. Codex Desktop 연결에는 Hook 설치가 필요하지 않습니다.
3. Codex CLI의 Hook 연결을 사용할 때만 **Settings → Codex 연결 → 연결 준비**를 누릅니다. 설치 또는 수리 미리보기를 확인한 뒤 **변경을 확인했으며 적용**을 누릅니다.
4. CLI에서는 `/hooks`로 Hook 실행을 허용하고 앱의 추가 안내를 따릅니다.

Hook 연결을 사용하는 경우 앱 경로를 변경하면 Hook 수리가 필요할 수 있으므로 설치 위치를 먼저 정하세요. 이미 다른 앱의 Hook을 사용 중이면 충돌 안내를 확인하고 임의로 기존 항목을 삭제하지 마세요.

Developer ID 서명·Apple 공증 여부는 해당 릴리스 설명을 확인합니다. 직접 빌드한 앱에는 자동 적용되지 않습니다. 이전 이름의 앱에 받은 공증도 새 바이너리에 승계되지 않습니다.

기본 캐릭터는 지피쨩 하나입니다. 추가 `.petchar`는 설정에서 가져옵니다. 데이터는 `~/Library/Application Support/Daemonlet for Codex`에 저장하며 기존 2D Live/Test 데이터는 가져오지 않습니다.
기본 앱 사용에는 별도 Python, ComfyUI, 모델 또는 NVIDIA GPU가 필요하지 않습니다. 선택 기능인 캐릭터 음성·로컬 챗은 해당 실행 환경과 외부 모델을 별도로 준비합니다. 음성 모델은 앱에 포함되지 않으며 사용자가 다운로드를 선택해야 합니다.
