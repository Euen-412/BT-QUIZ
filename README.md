# 서바이벌 퀴즈 (Render 무료 버전 · 라운드 무제한)

화면과 기능은 Firebase 버전과 똑같아요. QR 2개, 라운드 편집, 파랑/빨강 같은 선택지, 캐릭터 움직임을 그대로 쓸 수 있어요.
서버가 직접 실시간으로 신호를 보내는 방식이라 **사용량 한도가 없어요.** 100라운드든 200라운드든 괜찮아요.

## 올리기 (브라우저만 있으면 됨, 약 10분)

### 1. GitHub에 파일 올리기
1. https://github.com 가입 (구글 계정 X, 이메일로 가입)
2. 오른쪽 위 **＋ → New repository**
   - Repository name: `btquiz`
   - **Public** 선택 → **Create repository**
3. 생긴 페이지에서 **"uploading an existing file"** 링크 클릭
4. 압축 푼 `quiz-render` 폴더 **안의 내용 전부**를 끌어다 놓기
   - `server.js`, `package.json`, `render.yaml`, `public` 폴더 등이 올라가야 해요.
5. 아래 **Commit changes** 클릭

### 2. Render에 연결
1. https://render.com → **Get Started** → **GitHub로 가입**
2. **＋ New → Web Service** → 방금 만든 `btquiz` 저장소 선택 → **Connect**
3. 설정 확인
   - Name: `btquiz` (주소가 `btquiz.onrender.com`이 돼요. 이미 쓰고 있는 이름이면 다른 이름으로)
   - Region: **Singapore** (한국에서 가장 가까움)
   - Language: Node / Build Command: `npm install` / Start Command: `npm start`
   - Instance Type: **Free**
4. **Deploy Web Service** → 2~3분 뒤 위쪽에 `https://btquiz.onrender.com` 같은 주소가 생기고 **Live**라고 뜨면 끝

### 3. 사용
- 마스터: `https://내주소.onrender.com/host` → **새 게임방 만들기**
- 나머지는 Firebase 버전과 같아요. 참가자 QR, 마스터 QR, 대형화면 열기, 라운드 편집 모두 그대로예요.

## 꼭 알아둘 것

- **15분 동안 아무도 접속하지 않으면 서버가 잠들어요.** 행사 5~10분 전에 PC로 마스터 화면을 열어 두면 깨어나요(처음 1분 정도 로딩). 마스터 화면이나 대형화면이 켜져 있는 동안은 잠들지 않아요.
- 서버가 잠들었다 깨면 참가자 목록은 초기화돼요. 하지만 **마스터가 같은 방을 다시 열면 같은 방 코드와 같은 QR로 자동 복구**되고, 문제도 마스터 기기에 저장된 걸로 다시 채워져요. QR은 미리 뽑아 둬도 돼요.
- 문제를 백업하려면 마스터 화면의 **CSV 내보내기**를 쓰세요.
- 화면을 고친 뒤 다시 올리려면 GitHub 저장소에서 **Add file → Upload files**로 바뀐 파일만 다시 올리면 돼요. Render가 알아서 다시 배포해요.

## 테스트 결과
- 참가자 200명 동시 접속, 3라운드 진행 확인 (참가 처리 0.1초)
- 참가자가 방 상태를 바꾸거나 정답 목록을 읽으려는 시도는 차단돼요
- 시간이 끝난 뒤에는 선택을 바꿀 수 없어요
- 서버를 재시작해도 마스터가 다시 열면 같은 방 코드로 복구돼요
