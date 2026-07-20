// CAST 생산공정일지 관리 시스템 - 로컬 서버 (의존성 없음, Node 내장 모듈만 사용)
const http = require('http');
const fs = require('fs');
const path = require('path');

/* ---- .env 로더 (의존성 없음) ----------------------------------------------
   KEY=VALUE 형식, # 주석·빈 줄 무시, 따옴표 제거.
   이미 설정된 환경변수(셸/Vercel)는 덮어쓰지 않음 → 우선순위:
     실제 환경변수  >  test1/.env  >  저장소 루트 .env  >  test1/.openai-key(구방식 폴백)
   ⚠️ .env 는 .gitignore 로 제외되어 GitHub에 올라가지 않습니다.                */
function loadEnvFile(p) {
  try {
    fs.readFileSync(p, 'utf-8').split(/\r?\n/).forEach((line) => {
      const s = line.trim();
      if (!s || s.startsWith('#')) return;
      const i = s.indexOf('=');
      if (i === -1) return;
      const k = s.slice(0, i).trim();
      let v = s.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (k && process.env[k] === undefined) process.env[k] = v;   // 기존 환경변수 우선
    });
  } catch (e) { /* 파일 없으면 무시 */ }
}
loadEnvFile(path.join(__dirname, '.env'));            // test1/.env
loadEnvFile(path.join(__dirname, '..', '.env'));      // 저장소 루트 .env

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data', 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SEED_PATH = path.join(__dirname, 'public', 'seed.json');
const EMPTY_DB = { records: [], sheets: [], plans: [], standards: [], custspecs: [], equipchecks: [], equipment: [], masters: {}, seqs: { records: 1, sheets: 1, plans: 1, standards: 1, custspecs: 1, equipchecks: 1, equipment: 1 } };
const COLLECTIONS = ['records', 'sheets', 'plans', 'standards', 'custspecs', 'equipchecks', 'equipment'];
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
function openaiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY.trim();
  try { return fs.readFileSync(path.join(__dirname, '.openai-key'), 'utf-8').trim(); } catch (e) { return ''; }
}
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function loadDB() {
  // db.json은 git에 포함되지 않음(원천 데이터 보호). 없으면 자동 생성:
  //  - public/seed.json(빈 템플릿)이 있으면 그것으로, 없으면 빈 구조로 시작.
  if (!fs.existsSync(DB_PATH)) {
    let init = EMPTY_DB;
    try { if (fs.existsSync(SEED_PATH)) init = JSON.parse(fs.readFileSync(SEED_PATH, 'utf-8')); } catch (e) { /* fallback to EMPTY_DB */ }
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(init, null, 2), 'utf-8');
  }
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  db.seqs = db.seqs || {};
  COLLECTIONS.forEach((c) => { if (!db[c]) db[c] = []; if (db.seqs[c] == null) db.seqs[c] = 1; });
  db.masters = db.masters || {};
  return db;
}
function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
}

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    // ---- 이미지 업로드 (base64 dataURL → /uploads/ 파일) ----
    if (p === '/api/upload' && req.method === 'POST') {
      const body = await readBody(req);
      const m = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(body.dataUrl || '');
      if (!m) return sendJSON(res, 400, { error: '지원하지 않는 이미지 형식입니다.' });
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
      const fname = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, fname), Buffer.from(m[2], 'base64'));
      return sendJSON(res, 201, { url: '/uploads/' + fname });
    }

    // ---- AI 분석 챗봇 (OpenAI 프록시, 키는 서버에서만) ----
    if (p === '/api/chat' && req.method === 'POST') {
      const key = openaiKey();
      if (!key) return sendJSON(res, 500, { error: 'OPENAI_API_KEY 미설정 (env 또는 test1/.openai-key)' });
      const body = await readBody(req);
      const question = String(body.question || '').slice(0, 4000);
      const context = body.context ? JSON.stringify(body.context).slice(0, 60000) : '';
      if (!question) return sendJSON(res, 400, { error: 'question 필요' });
      const sys = `당신은 BL-TECH 생산1팀의 생산데이터 분석 도우미입니다. 아래 JSON 데이터(생산실적·불량·사양·설비 등)를 근거로 한국어로 간결하고 정확하게 답합니다. 숫자는 데이터에서 계산해 제시하고, 근거가 없으면 모른다고 하세요. 표/목록으로 보기 좋게 정리하세요.\n\n[데이터]\n${context}`;
      try {
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: OPENAI_MODEL, temperature: 0.2, messages: [{ role: 'system', content: sys }, { role: 'user', content: question }] }),
        });
        const data = await r.json();
        if (!r.ok) return sendJSON(res, 502, { error: 'OpenAI 오류: ' + ((data.error && data.error.message) || r.status) });
        return sendJSON(res, 200, { answer: (data.choices && data.choices[0] && data.choices[0].message.content) || '(응답 없음)' });
      } catch (e) { return sendJSON(res, 500, { error: String((e && e.message) || e) }); }
    }

    // ---- 컬렉션 공통 CRUD: /api/{records|sheets|plans|standards}[/:id] ----
    const colMatch = p.match(/^\/api\/(\w+)(?:\/(\d+))?$/);
    if (colMatch && COLLECTIONS.includes(colMatch[1])) {
      const col = colMatch[1];
      const id = colMatch[2] ? Number(colMatch[2]) : null;
      const db = loadDB();
      const items = db[col];

      if (id == null && req.method === 'GET') {
        let out = items;
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        if (from) out = out.filter((r) => r.date >= from);
        if (to) out = out.filter((r) => r.date <= to);
        out = [...out].sort((a, b) => (a.date === b.date ? String(a.machine ?? '').localeCompare(String(b.machine ?? '')) : a.date < b.date ? 1 : -1));
        return sendJSON(res, 200, out);
      }
      if (id == null && req.method === 'POST') {
        const body = await readBody(req);
        body.id = db.seqs[col]++;
        items.push(body);
        saveDB(db);
        return sendJSON(res, 201, body);
      }
      if (id != null) {
        const idx = items.findIndex((r) => r.id === id);
        if (idx === -1) return sendJSON(res, 404, { error: 'not found' });
        if (req.method === 'PUT') {
          const body = await readBody(req);
          body.id = id;
          items[idx] = body;
          saveDB(db);
          return sendJSON(res, 200, body);
        }
        if (req.method === 'DELETE') {
          items.splice(idx, 1);
          saveDB(db);
          return sendJSON(res, 200, { ok: true });
        }
      }
    }
    if (p === '/api/masters') {
      const db = loadDB();
      if (req.method === 'GET') return sendJSON(res, 200, db.masters);
      if (req.method === 'PUT') {
        db.masters = await readBody(req);
        saveDB(db);
        return sendJSON(res, 200, db.masters);
      }
    }

    // ---- 정적 파일 ----
    let filePath = path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403); return res.end('Forbidden');
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
      // 업로드 이미지는 파일명이 고유 → 장기 캐시. 그 외 앱 파일(html/js/css)은 항상 최신 로드(캐시로 인한 구버전 표시 방지).
      headers['Cache-Control'] = p.startsWith('/uploads/')
        ? 'public, max-age=31536000, immutable'
        : 'no-store, must-revalidate';
      res.writeHead(200, headers);
      return res.end(fs.readFileSync(filePath));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (e) {
    sendJSON(res, 500, { error: String(e) });
  }
});

server.listen(PORT, () => {
  console.log(`CAST 생산공정일지 시스템 실행 중: http://localhost:${PORT}`);
});
