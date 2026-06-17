// CAST 생산공정일지 관리 시스템 - 로컬 서버 (의존성 없음, Node 내장 모듈만 사용)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data', 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SEED_PATH = path.join(__dirname, 'public', 'seed.json');
const EMPTY_DB = { records: [], sheets: [], plans: [], standards: [], masters: {}, seqs: { records: 1, sheets: 1, plans: 1, standards: 1 } };
const COLLECTIONS = ['records', 'sheets', 'plans', 'standards'];
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
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
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
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
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
