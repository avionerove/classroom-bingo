# ☁️ 인터넷에 올리기 (영구 주소 · 설치 불필요 · 패들렛 방식)

한 번만 올려두면 **PC·태블릿 어디서나 주소 하나로** 접속합니다. 아무 기기에도 설치할 게 없고,
주소가 고정되며, 학교 WiFi의 '기기 격리' 문제도 사라집니다.

추천: **Render**(무료, 영구 주소). 아래 순서대로 하면 명령어 없이 됩니다.

---

## 방법 A. Render (추천)

### 1단계 — 코드를 GitHub에 올리기 (명령어 없이, 웹에서)
1. https://github.com 에서 무료 가입 → 로그인.
2. 오른쪽 위 **`+` → New repository**.
   - Repository name: `classroom-bingo` (아무 이름이나)
   - **Public** 선택 → **Create repository**.
3. 다음 화면에서 **"uploading an existing file"** 링크 클릭.
4. 이 폴더(`bingo`)의 파일들을 **드래그&드롭**으로 올립니다. 꼭 포함할 것:
   - `server.py`, `requirements.txt`, `Procfile`, `render.yaml`, `README.md`
   - **`public` 폴더 통째로** (안에 index.html, teacher.html, style.css, student.js, teacher.js, celebrate.js)
   - ※ `.claude` 폴더는 올리지 않아도 됩니다.
5. 아래 **Commit changes** 클릭.

### 2단계 — Render에서 배포
1. https://render.com 가입 → **GitHub 계정으로 로그인**하면 편합니다.
2. 대시보드에서 **New + → Blueprint**.
3. 방금 만든 `classroom-bingo` 저장소 선택 → **Apply / Create**.
   - (Blueprint가 안 뜨면: **New + → Web Service** → 저장소 선택 →
      Language(Runtime): **Python 3**, Start Command: **`python server.py`**, Instance Type: **Free** → Create)
4. 2~3분 기다리면 배포 완료. 위쪽에 주소가 생깁니다:
   `https://classroom-bingo.onrender.com` (이름에 따라 달라짐)

### 3단계 — 사용
- **선생님 화면**: `https://classroom-bingo.onrender.com/teacher`
- **학생 입장**: `https://classroom-bingo.onrender.com/`
- 이 주소를 북마크하거나 학급 페이지에 올려두면 끝. 매번 같은 주소예요.

---

## 방법 B. Replit (GitHub 없이 가장 빠름)
1. https://replit.com 가입.
2. **Create Repl → Python** 선택.
3. 왼쪽 파일 영역에 이 폴더의 파일들을 **드래그해 업로드**(`public` 폴더 포함).
4. 위쪽 **Run** 클릭 → 오른쪽 Webview에 주소(`https://....replit.dev`)가 뜹니다.
   - 선생님: 주소 뒤에 `/teacher`, 학생: 주소 그대로.

---

## 알아두면 좋은 점
- **무료 등급은 한동안 안 쓰면 잠듭니다.** 첫 접속 때 ~30~50초 깨어나요 →
  **수업 5분 전에 선생님 화면을 한 번 열어** 깨워두면 학생들은 바로 들어옵니다.
- 서버가 재시작되면 진행 중이던 판은 초기화됩니다(게임은 원래 일회성이라 괜찮아요).
- **한 주소 = 교실 1개**입니다. 다른 선생님이 동시에 쓰려면 각자 한 번씩 배포해
  **자기 주소**를 가지면 됩니다. (한 주소로 여러 반을 동시에 돌리려면 '방 코드' 기능 추가가 필요 — 요청 주세요.)
- 코드를 고쳐 GitHub에 다시 올리면 Render가 자동으로 새로 배포합니다(autoDeploy).

## 로컬(인터넷 없이)으로도 여전히 가능
인터넷이 안 되는 교실에서는 예전처럼 학교 PC에서 `python server.py`(윈도우는 `python server.py`,
Python 설치 필요)로 돌리고 같은 WiFi에서 접속하면 됩니다. 클라우드와 코드가 동일합니다.
