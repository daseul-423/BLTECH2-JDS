# 데이터 관리 정책 (중요)

이 폴더의 **운영 데이터는 git에 포함되지 않습니다.** 원천 데이터는 GitHub/Vercel 같은 공개 위치에 올리지 않고 **서버단·로컬에서만** 관리합니다.

## 파일 안내

| 파일 | git 포함 | 설명 |
|---|---|---|
| `db.json` | ❌ (gitignore) | 실제 운영 데이터. `node server.js` 실행 시 읽고/쓰는 파일. **백업은 이 파일만 복사.** 없으면 서버가 빈 DB로 자동 생성. |
| `source/` | ❌ (gitignore) | 원본 엑셀 등 원천 자료 보관용. 이 폴더에 둔 파일은 절대 커밋되지 않음. |
| `../public/seed.json` | ✅ (빈 템플릿) | 공개 정적 배포용 초기 데이터. **실데이터를 넣지 말 것** — 공개 사이트에 그대로 노출됨. 구조만 있는 빈 템플릿 유지. |

## 원칙

1. 엑셀(`.xlsx/.xls/.xlsm/.csv`)과 운영 데이터(`db.json`)는 **커밋 금지**. `.gitignore` + `.githooks/pre-commit` 으로 이중 차단됨.
2. 실데이터가 필요한 작업은 로컬에서 `cd test1 && node server.js` 로 수행.
3. 공개 사이트(Vercel)는 데이터 없이 빈 상태로 동작한다.

> 훅 활성화: `git config core.hooksPath .githooks` (최초 1회, 클론마다 필요).
