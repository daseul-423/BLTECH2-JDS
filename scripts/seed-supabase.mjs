/* 로컬 실데이터(test1/data/db.json)를 Supabase 공유 DB로 1회 업로드하는 스크립트.
 *
 *   실행 (PowerShell):
 *     $env:SUPABASE_URL="https://xxxx.supabase.co"
 *     $env:SUPABASE_SERVICE_KEY="<service_role 키>"
 *     node scripts/seed-supabase.mjs
 *
 *   - appdata 테이블의 id='db' 행에 db.json 전체를 JSONB로 upsert.
 *   - service_role 키는 비밀입니다. 절대 커밋/공유하지 마세요.
 */
import fs from 'node:fs';
import path from 'node:path';

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
if (!URL_ || !KEY) {
  console.error('환경변수 SUPABASE_URL / SUPABASE_SERVICE_KEY 가 필요합니다.');
  process.exit(1);
}

const dbPath = path.join(process.cwd(), 'test1', 'data', 'db.json');
if (!fs.existsSync(dbPath)) { console.error('db.json 없음: ' + dbPath); process.exit(1); }
const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

const headers = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'resolution=merge-duplicates,return=minimal', // 있으면 update, 없으면 insert
};

const r = await fetch(`${URL_}/rest/v1/appdata`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ id: 'db', data }),
});
if (!r.ok) {
  console.error('시드 실패:', r.status, await r.text());
  process.exit(1);
}
console.log('시드 완료 → records=%d, sheets=%d, plans=%d, standards=%d',
  data.records.length, data.sheets.length, data.plans.length, data.standards.length);
