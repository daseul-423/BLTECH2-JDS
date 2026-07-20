# BL-TECH 생산공정일지 관리 시스템

BL-TECH 생산1팀의 수기 공정일지·엑셀 실적 정리를 대체하는 **웹 생산관리 시스템**.
Firebase(Auth + Firestore) 기반 공유 데이터베이스로, 어느 PC에서 접속해도 같은 데이터를 봅니다.

---

## 1. 기술 스택 · 실행 구조

- **프레임워크 없음. 빌드 없음. npm 의존성 없음** (본체 기준)
  - `index.html` + 클래식 `<script src="app.js">` 단일 스크립트 (약 3,500줄)
  - `let`/`function` 전역 스코프 공유 — 모듈 시스템 아님. **`type="module"`로 바꾸지 말 것** (전역 참조가 전부 깨짐)
- **프론트엔드**: 바닐라 JS / **DB·인증**: Firebase (compat SDK, CDN)
- **로컬 서버**: `test1/server.js` (Node 내장 모듈만, 의존성 0)
- **배포**: GitHub `main` push → **Vercel 자동 배포**

```
로컬 실행:  node test1/server.js      → http://localhost:3000
배포:       git push origin main      → https://bltech-2-jds.vercel.app
```

---

## 2. 디렉터리

```
test1/public/          ← 실제 앱 (Vercel outputDirectory)
  index.html           페이지·모달 전체 마크업
  app.js               앱 로직 전부 (UI·계산·권한·워크스페이스)
  dataService.js       Firestore 리포지토리 계층
  firebase-config.js   Firebase 웹 설정 (공개값 — 비밀 아님)
  style.css
  migrate.html         db.json → Firestore 1회성 이전 도구
  seed.json            로컬 db.json 초기 템플릿 (server.js가 사용)
test1/server.js        로컬 서버 (+ .env 로더, /api/chat 프록시)
test1/data/db.json     ⚠️ 원본 운영 데이터 백업 (gitignore, 삭제 금지)
api/chat.js            Vercel 서버리스 챗봇 프록시 (OpenAI)
firestore.rules        Firestore 보안 규칙 (콘솔에 수동 게시 필요)
```

---

## 3. 데이터 계층 (중요)

**모든 읽기/쓰기는 `api()` → `dataService` → Firestore** 를 통합니다.
화면·계산 코드는 데이터 저장소를 몰라도 되게 설계돼 있습니다. **저장소를 바꿀 땐 `dataService.js`만 수정하세요.**

```
app.js  api('/api/records')  →  dataService.list('records')  →  Firestore
```

- `api(path, opts)`는 예전 REST 규약(`GET/POST /api/{col}`, `PUT/DELETE /api/{col}/{id}`)을 **그대로 유지**합니다. 덕분에 localStorage → Firestore 전환 때 UI·계산 코드를 한 줄도 안 고쳤습니다.
- **localStorage 폴백은 제거됨.** Firestore가 유일한 저장소입니다.

### 컬렉션
`records`(생산실적) `sheets`(공정일지) `plans`(생산계획·작업지시) `standards`(제품표준서)
`custspecs`(고객사 OEM 사양) `equipchecks`(설비 일상점검) `equipment`(설비대장)
`masters/singleton`(기준정보 + OEM 회사) `meta/counters`(id 시퀀스) `users/{uid}`(권한)

### ID 규칙 (주의)
Firestore 문서 ID는 문자열이지만, 앱 전반이 **정수 id**에 의존합니다(`Number(dataset.id)`, `r.id === id`).
→ **문서 ID = 정수 id 문자열**, 문서 안에도 `id` 필드 유지. 새 id는 `meta/counters` 트랜잭션으로 발급.

### 감사 필드 (자동)
`createdBy`(uid) `createdByEmail` `createdAt` `updatedBy` `updatedByEmail` `updatedAt`
→ worker의 "본인 문서만 수정" 판정이 `createdBy === uid` 기반입니다.

---

## 4. 공정 구분 (핵심 도메인)

**CAST / SPLINT / PRE-CUT / HYBRID** 4종. 각각 실제 종이 양식을 그대로 옮긴 폼과 계산식이 있습니다.

| 파트 | 폼(양식) | 계산 기준 |
|---|---|---|
| CAST | F-PD-003A Rev.12 | EA 단위, 로스율 = 불량 ÷ 총생산량(loss포함) |
| SPLINT | F-PD-003b Rev.13 | roll 단위, 로스율 = 불량 ÷ 이론총수량 |
| PRE-CUT | F-PD-003e Rev.9 | SPLINT 계산 기준 사용 |
| HYBRID | 하이브리드 생산일지 | CAST 계산 기준 사용 |

- 폼 정의: `WS_SCHEMA` (app.js) — 탭·블록 선언형 구조
- **폼 선택 키(`wsForm`)와 계산 기준 키(`wsPart`)는 분리**되어 있습니다.
  `wsPart = partBase(part)` (PRE-CUT→SPLINT, HYBRID→CAST), `wsForm`은 4종 그대로.
- 계산 함수: `calc` `splintCalc` `castWsCalc` `splintWsCalc` `precutAgg` 등
  → **엑셀 수식과 1:1 대응. 수정 시 반드시 실제 양식·엑셀과 대조할 것.**

---

## 5. 인증 · 권한 (RBAC)

- **Firebase Auth 이메일/비밀번호**. 로그인 전에는 업무 화면·데이터 접근 불가.
- 로그인 → `users/{uid}` 조회 → `active`·`role` 검증 → **통과해야만 데이터 로드**(`bootApp`)
- 역할 3종: **admin / manager / worker**

| | admin | manager | worker |
|---|---|---|---|
| 조회 | 전체 | 전체 | 전체(설비대장·기준정보·사용자관리 제외) |
| 등록·수정 | 전체 | 업무 데이터 전체 | 공정일지·설비점검만 |
| 공정일지·점검 수정 | 전체 | 전체 | **본인 작성만** |
| 삭제 | ✅ | ❌ | ❌ |
| 사용자 관리 | ✅ | ❌ | ❌ |

- 권한 로직: `ME` / `can(action, col, doc)` / `ROLE_PAGES` / `WRITE_ROLES` / `applyRolePerms()` / `gateModal()`
- **화면 버튼 숨김 + Firestore Rules 이중 차단.** UI만 막고 끝내지 말 것.
- **기존 PIN 관리자모드는 완전 제거됨** (역할 기반으로 대체)
- 로그인 지속성 = **SESSION** → 브라우저 닫으면 자동 로그아웃

### 사용자 추가
관리자 화면에서 **Auth 계정 + users 문서 동시 생성** (콘솔 불필요).
보조 Firebase 앱 인스턴스(`admin-usercreate`)로 계정을 만들어 **관리자 세션이 유지**됩니다.
- 계정 삭제는 하지 않고 **`active=false`** 로 운영
- 비밀번호 변경은 **재설정 메일** 방식 (Admin SDK 미사용 방침)

---

## 6. 비밀 정보 관리 (엄수)

| 항목 | 위치 | git |
|---|---|---|
| OpenAI 키 | `.env`(루트) 또는 `test1/.openai-key` | **제외** |
| Firebase **웹** 설정 | `test1/public/firebase-config.js` | 커밋 O — **비밀 아님**(공개 정상) |
| 서비스계정 JSON | 사용 안 함 | **제외** |
| 운영 데이터 | `test1/data/db.json` | **제외** |

- 키 우선순위: **실제 환경변수 > `test1/.env` > 루트 `.env` > `test1/.openai-key`**
- `server.js`에 **의존성 없는 `.env` 로더** 내장 (dotenv 불필요)
- **OpenAI 키는 절대 브라우저/클라이언트 코드에 넣지 말 것.** 항상 `/api/chat` 서버 프록시 경유.
- Vercel 배포 환경은 `.env`가 아니라 **Vercel → Settings → Environment Variables** 사용

---

## 7. AI 챗봇

- 프론트: `fetch('/api/chat')` (app.js) — **이 구조를 임의로 바꾸지 말 것**
- 로컬: `test1/server.js`의 `/api/chat`
- 배포: `api/chat.js` (Vercel 서버리스) — **`OPENAI_API_KEY` 환경변수 등록 시 동작**

---

## 8. 작업 규칙

- 변경 후 **커밋 → `git push origin main` → Vercel 자동 배포** 확인
- 커밋 전 확인: 비밀 파일 미추적(`git ls-files`), `.env`/서비스계정 키 제외
- **`firestore.rules`는 파일 수정만으로 적용되지 않음** → Firebase 콘솔 Rules에 **수동 게시** 필요
- 사진은 **base64 dataURL로 문서에 내장**(Storage 미사용) → ⚠️ **Firestore 문서 1MiB 한도** 주의
- 데이터 구조·계산식·기존 UI는 함부로 바꾸지 말 것. 저장 위치만 바뀌어 온 이력임.

---

## 9. 현재 상태 / 남은 일

- ✅ Firestore 이전 완료(**129건**), RBAC, 사용자 관리, 세션 로그아웃, `.env` 키 관리
- ⬜ Vercel에 `OPENAI_API_KEY` 등록 → 배포본 챗봇 활성화
- ⬜ (검토 중) Firebase Hosting 이전 — 정적이라 무료 플랜으로 가능
- ⬜ manager/worker 실사용 테스트, Firestore 백업 주기 수립
