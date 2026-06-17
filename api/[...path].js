/* 공유 백엔드 (Vercel 서버리스 함수) — 모든 방문자가 같은 데이터를 보도록 Supabase에 저장.
 *
 *   - 추가 npm 패키지 없이 Node 내장 fetch로 Supabase REST API 호출
 *   - DB는 appdata 테이블의 단일 행(id='db')에 JSONB 문서 하나로 저장 (server.js의 db.json과 동일 구조)
 *   - app.js 의 /api/* 규약을 그대로 구현 → 앱 코드 수정 불필요
 *
 *   필요 환경변수 (Vercel 프로젝트 Settings → Environment Variables):
 *     SUPABASE_URL          예) https://xxxx.supabase.co
 *     SUPABASE_SERVICE_KEY  service_role 키 (비밀! 서버에서만 사용, 절대 클라이언트 노출 금지)
 */
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const ROW_ID = 'db';
const COLLECTIONS = ['records', 'sheets', 'plans', 'standards'];
const EMPTY_DB = { records: [], sheets: [], plans: [], standards: [], masters: {}, seqs: { records: 1, sheets: 1, plans: 1, standards: 1 } };

const sbHeaders = () => ({ apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' });

async function loadDB() {
  const r = await fetch(`${SB_URL}/rest/v1/appdata?id=eq.${ROW_ID}&select=data`, { headers: sbHeaders() });
  if (!r.ok) throw new Error('DB 읽기 실패: ' + r.status + ' ' + (await r.text()));
  const rows = await r.json();
  if (!rows.length) {
    // 최초 1회: 빈 문서 생성
    await fetch(`${SB_URL}/rest/v1/appdata`, {
      method: 'POST',
      headers: { ...sbHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify({ id: ROW_ID, data: EMPTY_DB }),
    });
    return JSON.parse(JSON.stringify(EMPTY_DB));
  }
  const db = rows[0].data || {};
  db.seqs = db.seqs || { records: 1, sheets: 1, plans: 1, standards: 1 };
  COLLECTIONS.forEach((c) => { if (!db[c]) db[c] = []; });
  db.masters = db.masters || {};
  return db;
}

async function saveDB(db) {
  const r = await fetch(`${SB_URL}/rest/v1/appdata?id=eq.${ROW_ID}`, {
    method: 'PATCH',
    headers: { ...sbHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({ data: db }),
  });
  if (!r.ok) throw new Error('DB 쓰기 실패: ' + r.status + ' ' + (await r.text()));
}

module.exports = async (req, res) => {
  try {
    if (!SB_URL || !SB_KEY) {
      res.status(500).json({ error: 'DB 미설정: SUPABASE_URL / SUPABASE_SERVICE_KEY 환경변수를 설정하세요.' });
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const method = (req.method || 'GET').toUpperCase();
    const body = (method === 'POST' || method === 'PUT') ? (req.body || {}) : null;

    // 이미지 업로드: dataURL 을 그대로 사용 (표준서에 내장 저장)
    if (p === '/api/upload' && method === 'POST') { res.status(201).json({ url: body.dataUrl }); return; }

    if (p === '/api/masters') {
      const db = await loadDB();
      if (method === 'GET') { res.status(200).json(db.masters); return; }
      if (method === 'PUT') { db.masters = body; await saveDB(db); res.status(200).json(db.masters); return; }
    }

    const m = p.match(/^\/api\/(\w+)(?:\/(\d+))?$/);
    if (m && COLLECTIONS.includes(m[1])) {
      const col = m[1];
      const id = m[2] ? Number(m[2]) : null;
      const db = await loadDB();
      const items = db[col];

      if (id == null && method === 'GET') {
        let out = items.slice();
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        if (from) out = out.filter((r) => r.date >= from);
        if (to) out = out.filter((r) => r.date <= to);
        out.sort((a, b) => (a.date === b.date ? String(a.machine ?? '').localeCompare(String(b.machine ?? '')) : a.date < b.date ? 1 : -1));
        res.status(200).json(out); return;
      }
      if (id == null && method === 'POST') { body.id = db.seqs[col]++; items.push(body); await saveDB(db); res.status(201).json(body); return; }
      if (id != null) {
        const idx = items.findIndex((r) => r.id === id);
        if (idx === -1) { res.status(404).json({ error: 'not found' }); return; }
        if (method === 'PUT') { body.id = id; items[idx] = body; await saveDB(db); res.status(200).json(body); return; }
        if (method === 'DELETE') { items.splice(idx, 1); await saveDB(db); res.status(200).json({ ok: true }); return; }
      }
    }
    res.status(404).json({ error: 'unknown route: ' + p });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
