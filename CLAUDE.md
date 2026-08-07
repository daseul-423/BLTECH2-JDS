# BL-TECH 생산관리 플랫폼

BL-TECH 생산1팀의 수기 공정일지·엑셀 실적 정리를 대체하는 **웹 생산관리 플랫폼**.
Firebase(Auth + Firestore + Hosting + Functions) 기반. 어느 PC에서 접속해도 같은 데이터를 봅니다.

---

## 1. 기술 스택 · 실행 · 배포

- **프레임워크 없음. 빌드 없음. 본체 npm 의존성 없음**
  - `index.html` + 클래식 `<script src="app.js">` 단일 스크립트 (약 4,000줄)
  - 전역 스코프 공유 — **`type="module"`로 바꾸지 말 것** (전역 참조 전부 깨짐)
- **DB·인증**: Firebase compat SDK (CDN) / **서버 코드**: `functions/` (Cloud Functions v2, 여기만 npm 씀)

```
로컬 실행:   node test1/server.js          → http://localhost:3000
운영 배포:   git push origin main          → https://bltech-jds.web.app
테스트 배포: git push origin test          → https://bltech-jds--test-3uj9emlr.web.app
```

- GitHub Actions(`.github/workflows/firebase-deploy.yml`)가 main→운영(hosting+functions+rules), test→프리뷰 채널(hosting만) 배포
- ⚠️ **워크플로 파일은 이 환경의 git 권한(workflow scope 없음)으로 push 불가** → 수정 필요 시 사용자가 GitHub 웹에서 편집
- 테스트 채널은 배포마다 30일 연장. 만료 후 재배포하면 **URL 해시가 바뀜**(승인 도메인은 CLI가 자동 등록)
- 테스트 페이지도 **운영 Firestore·Auth·Functions를 공유** — 저장하면 실데이터에 들어감
- 배포 확인: `gh run list` / `gh run view <id> --json status,conclusion` (gh 인증돼 있음)
- Vercel(bltech-2-jds.vercel.app)은 **구 배포처** — push 시 같이 배포되나 사용 안 함. `api/chat.js`는 Vercel용 잔재
- 흐름 원칙: **작업 → 검증 → commit → push → gh로 배포 성공 확인 → 라이브에서 마커 확인** (상시 지시)

## 2. 디렉터리

```
test1/public/          ← 앱 본체 (Hosting public)
  index.html app.js style.css   dataService.js(Firestore 계층) firebase-config.js(공개값)
  migrate.html(1회성 이전도구)  seed.json(로컬 서버용)
test1/server.js        로컬 서버 (.env 로더 + /api/chat·/api/image 프록시, 로그인 검증 없음)
test1/data/db.json     ⚠️ 원본 운영 데이터 백업 (gitignore, 삭제 금지)
functions/index.js     Cloud Functions: chat(질의응답+이미지인식), image(gpt-image-2 생성)
firebase.json          hosting(전 경로 no-cache!) + rewrites(/api/chat,/api/image) + rules 자동배포
firestore.rules        RBAC 규칙 — 배포 시 자동 게시 (콘솔 수동편집 금지, 파일이 정본)
BL-TECH_규정_QnA_작성양식.xlsx  규정 취합용 배포 양식 (git 제외)
```

## 3. 데이터 계층

**모든 읽기/쓰기: `api()` → `dataService` → Firestore.** REST 규약(`GET/POST /api/{col}`, `PUT/DELETE /api/{col}/{id}`) 유지. localStorage 폴백 제거됨.

- 컬렉션: `records sheets plans standards custspecs equipchecks equipment policies` + `masters/singleton`(기준정보+업체) + `meta/counters`(정수 id 시퀀스) + `users/{uid}`(권한)
- **정수 id 규칙**: 문서 ID = 정수 id 문자열, 문서 안에도 `id` 필드. 새 id는 counters 트랜잭션
- 감사필드 자동: `createdBy(uid) createdByEmail createdAt updatedBy updatedByEmail updatedAt` → worker "본인 문서만" 판정 기준
- 대량 처리: `createMany/updateMany/deleteMany` (400건 배치)
- 사진은 base64 dataURL로 문서 내장(Storage 미사용) → **문서 1MiB 한도 주의**

## 4. 공정 4종 (핵심 도메인)

| 파트 | 일지 폼 | 실적 계산 |
|---|---|---|
| CAST | F-PD-003A Rev.12 | `calc()` — EA, 로스율=불량÷총생산(loss포함) |
| SPLINT | F-PD-003b Rev.13 | `splintCalc()` — roll, 로스율=불량÷이론총수량, 1롤=4.55m |
| PRE-CUT | F-PD-003e Rev.9 (전용 폼) | 일지는 SPLINT 계산, **엑셀 실적은 PH 방식** |
| HYBRID | 하이브리드 일지 (전용 폼) | 일지는 CAST 계산, **엑셀 실적은 PH 방식** |

- 일지 폼: `WS_SCHEMA`, 폼 키 `wsForm`(4종) ≠ 계산 키 `wsPart`(partBase: PRE-CUT→SPLINT, HYBRID→CAST)
- **PH(프리컷·하이브리드 엑셀 실적) 수식 — 실제 엑셀로 검증됨**:
  하이브리드폐기 = 투입원단−생산수량×개당무게 · 총페기량 = 폐기+하이브리드폐기 ·
  LOSS율 = 총페기÷투입원단×100 · 완제품(roll) = 완제품(m)÷4.55 · 완제품(m)은 엑셀값 그대로
  같은 날·인치·기재type 그룹은 투입·폐기를 첫 행에 합산 기재(빈 행="↑ 합산" 표시)
- 실적관리: PRE-CUT/HYBRID 토글 시 **전용 목록**(날짜·구분·제품코드·생산수량·투입원단·총페기·LOSS율·완제품+합계행). 엑셀산 PH 실적은 수정모달 열기 차단(재업로드 덮어쓰기로 수정)
- **계산식은 엑셀 수식과 1:1 — 수정 시 반드시 실물 엑셀과 대조**

## 5. 엑셀 업로드 (관리자 → 📥 엑셀 업로드, admin/manager)

지원: **생산실적(공정별 양식) · 생산계획 · 제품표준서 · 고객사별 사양 · 업체 정보(masters.companies 병합)**
- 열 자동매칭(별칭·공백/개행/괄호 무시, `IMPORT_DEFS`) + 수동 재연결, 시트 선택, 헤더 자동 탐지
- 계산 항목은 앱이 재계산, 엑셀값과 0.05 초과 차이면 "계산값 차이" 배지
- 중복 판정(실적: 생산일+호기+제품+차수 / PH: 구분+날짜+제품코드+차수+LOT / 업체: 업체명) → 건너뛰기/덮어쓰기
- 기간 필터(범위 밖 제외), **호기 정규화**(3→"3호기"), PH는 '구분' 열로 행별 파트 자동 분류
- 파일 자체는 서버로 안 감(내용만 파싱). 실적관리에 **일괄 삭제 + 호기명 일괄 변경**(비표준 표기 선택 시) 있음

## 6. 인증 · 권한 (RBAC)

- 이메일/비밀번호 로그인 → `users/{uid}`의 `active`·`role` 통과해야 `bootApp()`. 지속성 SESSION(브라우저 닫으면 로그아웃)
- 역할: **admin / manager / worker** — 로직: `ME` `can()` `ROLE_PAGES` `WRITE_ROLES` `applyRolePerms()` `gateModal()`
- worker: 조회 + 공정일지·설비점검 작성(본인만 수정), 삭제 전면 불가. 규정관리·사용자관리·엑셀업로드·설비대장·기준정보 접근 불가. **이미지 생성도 admin/manager 전용**
- **화면 숨김 + firestore.rules 이중 차단** 원칙
- 직원 추가: 사용자 관리에서 **Auth 계정+users 문서 동시 생성**(보조 앱 `admin-usercreate`, 콘솔 불필요). 삭제 대신 `active=false`, 비번은 재설정 메일. **Admin SDK/서비스계정 키 사용 안 함** 방침

## 7. AI 어시스턴트 (Night Purple UI)

- `/api/chat`: 생산데이터+**규정·Q&A(policies)** 근거 답변(마크다운·표·이모지), 이미지 첨부 인식(최대 4장, 1024px 축소)
- `/api/image`: gpt-image-2 생성 — 비율 5종×크기 3종 프리셋, 서버 화이트리스트, **admin/manager 전용**
- 마크다운 렌더러 자체 구현(`mdToHtml` — 표·목록·코드·XSS 이스케이프), 컬러 시트 `--ai-*` 변수
- Functions에서 Firebase ID토큰 검증 + users active 확인(로그인 사용자만). 키는 Secret Manager(`firebase functions:secrets:set OPENAI_API_KEY`)
- 프론트는 `fetch('/api/chat')` 구조 유지 — 임의 변경 금지

## 8. 규정 · Q&A (policies)

- 관리자 페이지 "규정 · Q&A 관리"(admin 전용): 질문답변/회사규칙/기본규정 3탭 **표 직접입력**(빈 행 상시, 행추가/저장 일괄반영)
- 엑셀 업로드/내보내기(작성양식 3시트 자동 인식, 예시행 자동 해제)
- worker는 화면 접근 불가, **챗봇으로만 규정 확인**(rules: read=활성 사용자, write=admin)

## 9. 비밀 정보 (엄수)

| 항목 | 위치 | git |
|---|---|---|
| OpenAI 키 | 루트 `.env`(정본)·`test1/.openai-key`(폴백)·**Secret Manager**(운영) | 제외 |
| Firebase 웹 설정 | `firebase-config.js` | 커밋 O — 공개값 |
| 서비스계정 JSON | **사용 안 함** (루트에 남은 파일은 ignore됨, 삭제 권장) | 제외 |
| 운영 데이터·엑셀 | db.json, *.xlsx | 제외 |

- 키 우선순위: 환경변수 > test1/.env > 루트 .env > .openai-key. 키는 절대 클라이언트에 넣지 말 것
- 커밋 전 `git ls-files`로 비밀 미추적 확인 습관

## 10. 작업 규칙 · 함정

- 로컬 검증은 프리뷰 브라우저 + JS 평가로 (스크린샷 도구 자주 타임아웃). 로그인 필요한 검증은 사용자에게 런북 제공
- **사용자 비밀번호로 대신 로그인 금지** — Auth 필요한 실행 테스트는 사용자가
- PowerShell에서 `firebase` 실행정책 오류 → `firebase.cmd`
- 배포 후 "안 바뀌었다" → 대부분 캐시. hosting 전 경로 no-cache 적용됐으니 Ctrl+Shift+R 안내
- 관리자 PIN 제도는 폐지됨(역할 기반). masters.adminPin 잔재 데이터 무시
- Blaze 요금제 사용 중(실비≈0). 예산 알림 설정 권장

## 11. 남은 일 / 아이디어

- ⬜ Firestore 정기 백업 수립 (제안만 한 상태)
- ⬜ Vercel 정리(연동 해제), 루트의 서비스계정 JSON 파일 삭제
- ⬜ 공정일지(sheets) 엑셀 업로드 미지원 (4개 폼 구조 복잡해 보류)
- ⬜ manager/worker 실사용 피드백 반영
