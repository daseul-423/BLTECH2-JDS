# 공유 데이터베이스 설정 (모든 방문자가 같은 데이터 보기)

공개 사이트(vercel.app)에서 **모든 사람이 같은 데이터**를 보고/입력하도록 Supabase(무료 Postgres)를 백엔드로 연결합니다.

구조: 브라우저 → Vercel 서버리스 함수(`api/[...path].js`) → Supabase. 앱 코드(app.js)는 그대로이며, `/api/*`가 동작하면 자동으로 공유 모드가 됩니다.

> ⚠️ 현재 설정상 **링크를 아는 누구나** 데이터를 보고 수정할 수 있습니다. 팀 전용(비밀번호)으로 바꾸려면 알려주세요.

## 1) Supabase 프로젝트 만들기 (무료, 카드 불필요)

1. https://supabase.com → **Start your project** → GitHub로 로그인
2. **New project** 생성 (이름/지역(Northeast Asia(Seoul)) 선택, DB 비밀번호는 아무거나 생성·보관)
3. 프로젝트 생성까지 1~2분 대기

## 2) 테이블 만들기

좌측 **SQL Editor** → 아래 붙여넣고 **Run**:

```sql
create table if not exists appdata (
  id   text primary key,
  data jsonb not null default '{}'::jsonb
);
```

## 3) 키 2개 복사 (Settings → API)

- **Project URL**  예) `https://abcdxyz.supabase.co`
- **service_role** 키 (`Project API keys` 섹션, `service_role` `secret`) — ⚠️ 비밀키. 외부 공유 금지.

## 4) Vercel 환경변수 등록

Vercel → 프로젝트(BLTECH2-JDS) → **Settings → Environment Variables** 에서 두 개 추가 (Production 체크):

| Name | Value |
|---|---|
| `SUPABASE_URL` | 위 Project URL |
| `SUPABASE_SERVICE_KEY` | 위 service_role 키 |

저장 후 **Deployments → 최신 배포 → Redeploy** (환경변수 반영).

## 5) 기존 실데이터 올리기 (1회)

로컬에서 (이 폴더 루트에서):

```powershell
$env:SUPABASE_URL="https://abcdxyz.supabase.co"
$env:SUPABASE_SERVICE_KEY="<service_role 키>"
node scripts/seed-supabase.mjs
```

→ `시드 완료 → records=…` 가 나오면 끝. 이제 어느 컴퓨터에서 접속해도 같은 데이터가 보입니다.

---

키(4번/5번)를 저에게 알려주시면 환경변수 등록·시드·검증까지 대신 처리해 드릴 수 있습니다. (단, service_role 키는 민감정보이니 신중히)
