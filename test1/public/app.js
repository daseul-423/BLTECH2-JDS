/* CAST 생산공정일지 관리 시스템 - 프론트엔드 (v2: 일일 공정일지 + 생산계획표) */
'use strict';

let RECORDS = [];
let SHEETS = [];
let PLANS = [];
let STANDARDS = [];
let CUSTSPECS = [];         // 고객사별 생산사양 (NEAL / OEM)
let EQUIPCHECKS = [];       // 설비 일상점검
let EQUIPMENT = [];         // 설비 대장 (+ 점검이력)
let MASTERS = {};
let editingStandardId = null;
let PART = 'CAST';          // 공정 구분 (CAST / SPLINT / PRE-CUT / HYBRID)
const PARTS = ['CAST', 'SPLINT', 'PRE-CUT', 'HYBRID'];
// 워크스페이스 폼·계산 기준: PRE-CUT은 SPLINT 방식, HYBRID는 CAST 방식으로 처리
const partBase = (p) => (p === 'SPLINT' || p === 'PRE-CUT') ? 'SPLINT' : 'CAST';
let editingId = null;       // 생산실적 모달 (CAST)
let editingSplintId = null; // 생산실적 모달 (SPLINT)
let editingPlanId = null;   // 계획 모달
let editingSheetId = null;  // 일일 일지 모달
let sheetOrigRecordIds = []; // 일지 수정 시 기존 연결 실적 id (라인 삭제 → 실적 삭제 동기화용)

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const fmt = (n, d = 0) => (n == null || n === '' || isNaN(n)) ? '-' : Number(n).toLocaleString('ko-KR', { maximumFractionDigits: d, minimumFractionDigits: 0 });
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const todayStr = () => new Date().toISOString().slice(0, 10);

/* ===================== 데이터 계층 (Firebase Firestore 전용) =====================
   - 모든 읽기/쓰기는 dataService(Firestore)를 통함. localStorage 폴백 제거.
   - api()/post() 규약(경로·반환형태)은 기존과 동일 → 화면·계산 코드는 무변경.
   - /api/chat(OpenAI)은 api()를 거치지 않고 기존대로 fetch로 직접 호출됨(구조 유지). */
const COLLECTIONS = ['records', 'sheets', 'plans', 'standards', 'custspecs', 'equipchecks', 'equipment'];
async function api(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : null;
  const url = new URL(path, location.origin);
  const p = url.pathname;
  if (p === '/api/upload' && method === 'POST') return { url: body.dataUrl }; // 사진=dataURL 내장(Storage 미사용)
  if (p === '/api/masters') {
    if (method === 'GET') return dataService.getMasters();
    if (method === 'PUT') return dataService.putMasters(body);
  }
  const m = p.match(/^\/api\/(\w+)(?:\/(\d+))?$/);
  if (m && COLLECTIONS.includes(m[1])) {
    const col = m[1], id = m[2] ? Number(m[2]) : null;
    if (id == null && method === 'GET') {
      let out = await dataService.list(col);
      const from = url.searchParams.get('from'), to = url.searchParams.get('to');
      if (from) out = out.filter((r) => r.date >= from);
      if (to) out = out.filter((r) => r.date <= to);
      out.sort((a, b) => (a.date === b.date ? String(a.machine ?? '').localeCompare(String(b.machine ?? '')) : a.date < b.date ? 1 : -1));
      return out;
    }
    if (id == null && method === 'POST') return dataService.create(col, body);
    if (id != null && method === 'PUT') return dataService.update(col, id, body);
    if (id != null && method === 'DELETE') return dataService.remove(col, id);
  }
  throw new Error('unknown route: ' + p);
}
const post = (path, body, method = 'POST') => api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const loadRecords = async () => { RECORDS = await api('/api/records'); };
const loadSheets = async () => { SHEETS = await api('/api/sheets'); };
const loadPlans = async () => { PLANS = await api('/api/plans'); };
const loadStandards = async () => { STANDARDS = await api('/api/standards'); };
const loadCustSpecs = async () => { CUSTSPECS = await api('/api/custspecs'); };
const loadEquipChecks = async () => { EQUIPCHECKS = await api('/api/equipchecks'); };
const loadEquipment = async () => { EQUIPMENT = await api('/api/equipment'); };
const loadMasters = async () => { MASTERS = await api('/api/masters'); };

/* ===================== 자동계산 (엑셀 수식 동일) ===================== */
function calc(r) {
  const totalProd = num(r.prodQty) + num(r.remainQty);                  // 총생산량
  const totalLoss = num(r.processDefect) + num(r.prodDefect);           // 총로스
  const totalProdLoss = totalProd + totalLoss;                          // 총생산량(loss포함)
  const rate = (x) => totalProdLoss ? +(x / totalProdLoss * 100).toFixed(2) : 0;
  const inputBase = +(totalProdLoss * num(r.length)).toFixed(1);        // 투입기재(m)
  const rollUsage = num(r.baseLength) ? +(inputBase / num(r.baseLength)).toFixed(2) : 0;
  const resinTotal = +(inputBase * num(r.resinPerEa) / 1000).toFixed(2);// 총투입량(kg)
  const pouchTotal = num(r.prodQty) + num(r.pouchExtra);                // 파우치 총수량
  return {
    totalProd, totalLoss, totalProdLoss,
    processLossRate: rate(num(r.processDefect)),
    prodLossRate: rate(num(r.prodDefect)),
    totalLossRate: rate(totalLoss),
    inputBase, rollUsage, resinTotal, pouchTotal,
  };
}

function lossBadge(rate) {
  const r = num(rate);
  const cls = r < 3 ? 'ok' : r < 8 ? 'warn' : 'bad';
  return `<span class="badge ${cls}">${r.toFixed(2)}%</span>`;
}
function statusBadge(s) {
  const cls = { '완료': 'ok', '진행': 'warn', '보류': 'bad', '계획': 'plain' }[s] || 'plain';
  return `<span class="badge ${cls}">${esc(s || '계획')}</span>`;
}

/* ===================== 공정 구분 (CAST/SPLINT) ===================== */
const partOf = (r) => r.part || 'CAST';
const partRecords = () => RECORDS.filter((r) => partOf(r) === PART);

function setPart(p) {
  PART = p;
  $$('.part-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.part === p));
  updateMetricLabels();
  refreshCurrentPage();
}
$$('.part-toggle button').forEach((b) => b.addEventListener('click', () => setPart(b.dataset.part)));

/* SPLINT 자동계산 (엑셀 수식 동일, roll 기준) */
function splintCalc(r) {
  const rollLen = num(r.rollLen) || 4.55;
  const prRoll = +(num(r.prM) / rollLen).toFixed(3);                       // PR(roll) = PR(m)/롤길이
  const totalM = +(num(r.prM) + num(r.spM)).toFixed(2);                    // 총수량(m)
  const totalRoll = +(num(r.spDom) + num(r.spOvs) + prRoll).toFixed(3);    // 총수량(roll)
  const baseM = Math.max(num(r.baseMid), num(r.baseUp), num(r.baseDown));  // 기재 투입(m)
  const theoRoll = baseM ? +(baseM / rollLen).toFixed(3) : 0;              // 이론총수량(roll)
  const totalLossRoll = num(r.weight) ? +(num(r.lossG) / num(r.weight)).toFixed(3) : 0; // 총로스(g)→roll
  const prodDefect = +(totalLossRoll - num(r.processDefect)).toFixed(3);   // 생산불량 = 총로스 - 공정불량
  const theoLoss = +(theoRoll - totalRoll).toFixed(3);
  const prodPlusLoss = +(totalRoll + totalLossRoll).toFixed(3);
  const rate = (x) => theoRoll ? +(x / theoRoll * 100).toFixed(2) : 0;     // 로스율 = 불량/이론총수량
  const pouchPR = prRoll;
  const pouchLoss = +(num(r.pouchTotal) - num(r.pouchSP) - pouchPR).toFixed(3);
  return {
    prRoll, totalM, totalRoll, theoRoll, totalLossRoll, prodDefect, theoLoss, prodPlusLoss,
    processLossRate: rate(num(r.processDefect)),
    prodLossRate: rate(prodDefect),
    totalLossRate: rate(num(r.processDefect) + prodDefect),
    pouchPR, pouchLoss,
  };
}

/* CAST 워크스페이스(작업흐름형) 자동계산 — 제품별 생산량/잔량/총로스량 기준 */
function castWsCalc(r) {
  const prodQty = num(r.prodQty), remain = num(r.remainQty), loss = num(r.loss);
  const totalProd = prodQty + remain;
  const totalLoss = loss;
  const totalProdLoss = totalProd + totalLoss;
  const rate = totalProdLoss ? +(totalLoss / totalProdLoss * 100).toFixed(2) : 0;
  const pouchTotal = prodQty + num(r.pouchExtra);
  return {
    prodQty, remainQty: remain, totalProd, totalLoss, totalProdLoss, pouchTotal,
    processDefect: 0, prodDefect: loss,
    processLossRate: 0, prodLossRate: rate, totalLossRate: rate,
  };
}

/* 제품무게 측정 통계 (+ 기준 이탈 수량) */
function weightStatsArr(weights, specMin, specMax) {
  const vals = (weights || []).map((w) => num(w.value)).filter((v) => v > 0);
  const r = { weightCount: vals.length, weightAvg: '', weightMin: '', weightMax: '', outOfSpec: 0 };
  if (vals.length) {
    r.weightAvg = +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1);
    r.weightMin = Math.min(...vals);
    r.weightMax = Math.max(...vals);
    const lo = num(specMin), hi = num(specMax);
    if (lo || hi) r.outOfSpec = vals.filter((v) => (lo && v < lo) || (hi && v > hi)).length;
  }
  return r;
}

/* 제품명으로 PRECUT(반제품) 여부 판정 */
const isPrecut = (name) => /precut|프리컷|pre-?cut/i.test(String(name || ''));
/* SPLINT 작업 로스 항목 */
const LOSS_CATS = ['setting', 'joint', 'stain', 'stop', 'drum', 'sample', 'etc'];
const rowLoss = (l) => LOSS_CATS.reduce((a, k) => a + num(l[k]), 0);

/* SPLINT 워크스페이스(작업흐름형) 자동계산 — 제품별 ROLL/PRECUT 생산량 + 작업로스 기준.
   분석·대시보드 호환을 위해 기존 레코드 필드(spDom/prRoll/totalRoll/theoRoll/…)도 함께 채운다. */
function splintWsCalc(r) {
  let roll, precut;
  if (r.rollQty != null || r.precutQty != null) { roll = num(r.rollQty); precut = num(r.precutQty); }
  else { const g = num(r.qty); precut = isPrecut(r.product) ? g : 0; roll = g - precut; }
  const good = roll + precut, loss = num(r.loss);          // 생산량(ROLL+PRECUT) / 작업로스
  const theo = +(good + loss).toFixed(3);                 // 이론총수량 = 생산량 + 로스
  const rate = theo ? +(loss / theo * 100).toFixed(2) : 0;
  // 무게 통계·기준이탈은 시트 단위 → 시트 첫 제품 레코드에만 집계(중복합산 방지)
  const ws = r.isFirst ? weightStatsArr(r.weights, r.specMin, r.specMax) : { weightCount: 0, weightAvg: '', weightMin: '', weightMax: '', outOfSpec: 0 };
  return {
    qty: good, lossQty: loss, rollQty: roll, precutQty: precut,
    spDom: roll, spOvs: 0, prM: 0, spM: 0,               // 레거시 호환
    prRoll: precut, totalM: 0, totalRoll: good, theoRoll: theo,
    processDefect: 0, prodDefect: loss, totalLossRoll: loss, theoLoss: 0, prodPlusLoss: theo,
    processLossRate: 0, prodLossRate: rate, totalLossRate: rate,
    weight: r.avgWeight != null && r.avgWeight !== '' ? r.avgWeight : (ws.weightAvg || null),
    weightCount: ws.weightCount, weightAvg: ws.weightAvg, weightMin: ws.weightMin, weightMax: ws.weightMax,
    outOfSpec: ws.outOfSpec, rollLen: 4.55,
  };
}

/* ===================== 네비게이션 ===================== */
$$('.nav-btn').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.page)));
/* ===================== 역할 기반 권한 (RBAC) — PIN 관리자모드 대체 ===================== */
let ME = null; // 로그인 사용자 권한 { uid, email, name, role, active }

const ROLE_PAGES = {
  admin:   ['home', 'dashboard', 'plans', 'sheets', 'equipchecks', 'logs', 'analysis', 'companies', 'standards', 'custspecs', 'equipment', 'overview', 'masters', 'users'],
  manager: ['home', 'dashboard', 'plans', 'sheets', 'equipchecks', 'logs', 'analysis', 'companies', 'standards', 'custspecs', 'equipment', 'overview', 'masters'],
  worker:  ['home', 'dashboard', 'plans', 'sheets', 'equipchecks', 'logs', 'analysis', 'companies', 'standards', 'custspecs', 'overview'],
};
// 등록/수정 가능 역할 (컬렉션별). 삭제는 admin 전용. companies=masters.companies 문서 쓰기.
const WRITE_ROLES = {
  records: ['admin', 'manager'], plans: ['admin', 'manager'], standards: ['admin', 'manager'],
  custspecs: ['admin', 'manager'], companies: ['admin', 'manager'], masters: ['admin', 'manager'],
  equipment: ['admin', 'manager'],
  sheets: ['admin', 'manager', 'worker'], equipchecks: ['admin', 'manager', 'worker'],
  users: ['admin'],
};
const canAccessPage = (page) => !ME || (ROLE_PAGES[ME.role] || []).includes(page);
function can(action, col, doc) {
  if (!ME) return false;
  const r = ME.role;
  if (action === 'read') return true;
  if (action === 'delete') return r === 'admin';
  if (action === 'create') return (WRITE_ROLES[col] || []).includes(r);
  if (action === 'update') {
    if (r === 'admin') return true;
    if (r === 'manager') return (WRITE_ROLES[col] || []).includes('manager');
    if (r === 'worker') return (col === 'sheets' || col === 'equipchecks') && !!doc && doc.createdBy === ME.uid;
  }
  return false;
}
/* 모달 저장/삭제 버튼 노출 제어 (권한 없으면 조회 전용) */
function gateModal(formSel, canEdit, canDelete) {
  const form = $(formSel);
  if (!form) return;
  form.querySelectorAll('button[type="submit"]').forEach((b) => (b.hidden = !canEdit));
  form.querySelectorAll('.btn.danger').forEach((b) => { if (/delete|삭제/i.test((b.id || '') + b.textContent)) b.hidden = !canDelete; });
}

$$('.nav-btn').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.page)));
function showPage(page) {
  if (!canAccessPage(page)) page = 'home';
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach((p) => (p.hidden = p.id !== 'page-' + page));
  const render = { dashboard: renderDashboard, plans: renderPlans, sheets: renderSheets, logs: renderLogs, analysis: renderAnalysis, overview: renderOverview, standards: renderStandards, custspecs: renderCustSpecs, companies: renderCompanies, equipchecks: renderEquipChecks, equipment: renderEquipment, masters: renderMasters, users: renderUsers }[page];
  if (render) render();
  applyCreateButtons();
}
function refreshCurrentPage() {
  const cur = $('.nav-btn.active');
  showPage(cur ? cur.dataset.page : 'home');
}

/* 생성 버튼 노출(역할별) */
const CREATE_BTNS = {
  plans: '#btn-new-plan', standards: '#btn-new-standard', custspecs: '#btn-new-custspec',
  companies: '#btn-new-company', equipchecks: '#btn-new-equipcheck', equipment: '#btn-new-equipment',
  sheets: '#btn-new-sheet', users: '#btn-new-user',
};
function applyCreateButtons() {
  Object.keys(CREATE_BTNS).forEach((col) => { const el = $(CREATE_BTNS[col]); if (el) el.hidden = !can('create', col); });
}
/* 역할에 따라 메뉴 표시 + 생성 버튼 노출 */
function applyRolePerms() {
  if (!ME) return;
  document.body.dataset.role = ME.role;
  const allowed = ROLE_PAGES[ME.role] || [];
  $$('.nav-btn').forEach((b) => { const pg = b.dataset.page; if (pg) b.hidden = !allowed.includes(pg); });
  $$('.nav-group').forEach((g) => { g.hidden = ![...g.querySelectorAll('.nav-btn')].some((b) => !b.hidden); });
  $$('.hub-card[data-goto]').forEach((c) => { c.hidden = !allowed.includes(c.dataset.goto); });
  applyCreateButtons();
}
/* 카드 허브 → 영역 이동 (권한 없으면 무시) */
function goArea(page) { if (canAccessPage(page)) showPage(page); }
document.addEventListener('click', (e) => { const c = e.target.closest('.hub-card[data-goto]'); if (c) goArea(c.dataset.goto); });

/* ===================== 사용자 관리 (admin 전용) ===================== */
let editingUserUid = null, LAST_USERS = [];
const userRoleBadge = (r) => `<span class="badge ${r === 'admin' ? 'bad' : r === 'manager' ? 'warn' : 'ok'}">${esc(r || '-')}</span>`;
async function renderUsers() {
  const box = $('#users-list');
  try { LAST_USERS = await dataService.listUsers(); }
  catch (e) { box.innerHTML = '<div class="empty">사용자 목록을 불러오지 못했습니다. (admin 권한 필요)</div>'; return; }
  let users = LAST_USERS.slice();
  const q = ($('#user-search').value || '').trim().toLowerCase();
  if (q) users = users.filter((u) => [u.email, u.name, u.role].some((v) => String(v || '').toLowerCase().includes(q)));
  users.sort((a, b) => String(a.email || '').localeCompare(String(b.email || '')));
  const rows = users.map((u) => `<tr class="user-row" data-uid="${esc(u.uid)}" style="cursor:pointer">
    <td>${esc(u.email || '-')}</td><td>${esc(u.name || '-')}</td><td>${userRoleBadge(u.role)}</td>
    <td>${u.active === false ? '<span class="badge bad">비활성</span>' : '<span class="badge ok">활성</span>'}</td>
    <td>${esc((u.updatedAt || '').slice(0, 16).replace('T', ' '))}</td>
    <td><button type="button" class="btn small user-edit" data-uid="${esc(u.uid)}">수정</button></td>
  </tr>`).join('');
  box.innerHTML = users.length
    ? `<table><thead><tr><th>이메일</th><th>이름</th><th>역할</th><th>활성</th><th>마지막 수정</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : '<div class="empty">등록된 users 문서가 없습니다. [＋ users 문서 등록]으로 추가하세요.</div>';
}
function friendlyAuthError(err) {
  const c = (err && err.code) || '';
  const map = {
    'auth/email-already-in-use': '이미 사용 중인 이메일입니다. (해당 계정은 Firebase 콘솔에서 확인하세요)',
    'auth/invalid-email': '이메일 형식이 올바르지 않습니다.',
    'auth/weak-password': '비밀번호가 너무 약합니다. (6자 이상)',
    'auth/operation-not-allowed': '이메일/비밀번호 로그인이 콘솔에서 비활성 상태입니다.',
    'auth/network-request-failed': '네트워크 오류입니다. 잠시 후 다시 시도하세요.',
    'permission-denied': '권한이 없습니다. (admin만 가능)',
  };
  return map[c] || (err && err.message) || String(err);
}
function openUserModal(uid = null) {
  editingUserUid = uid;
  const isNew = !uid;
  const f = $('#user-form'); f.reset();
  $('#user-modal-title').textContent = isNew ? '직원 추가 (Auth 계정 + 권한 문서)' : '직원 정보 수정';
  const u = uid ? LAST_USERS.find((x) => x.uid === uid) : null;
  // 신규: 이메일·초기 비밀번호 입력 → 계정 생성 / 수정: 문서만(이메일 변경은 콘솔)
  $('#user-uid-row').hidden = isNew;
  $('#user-pw-row').hidden = !isNew;
  $('#user-reset-pw').hidden = isNew;
  f.elements.email.readOnly = !isNew;
  f.elements.email.required = isNew;
  f.elements.password.required = isNew;
  if (u) {
    f.elements.uid.value = u.uid;
    f.elements.email.value = u.email || '';
    f.elements.name.value = u.name || '';
    f.elements.role.value = u.role || 'worker';
    f.elements.active.value = String(u.active !== false);
  } else { f.elements.role.value = 'worker'; f.elements.active.value = 'true'; }
  $('#user-updated').textContent = u
    ? `UID: ${u.uid} · 마지막 수정 ${(u.updatedAt || '').slice(0, 16).replace('T', ' ')} (${esc(u.updatedByEmail || u.updatedBy || '')})`
    : '이메일과 초기 비밀번호로 Firebase 계정과 권한 문서를 함께 생성합니다. (직원은 최초 로그인 후 비밀번호 변경 권장)';
  $('#user-modal').hidden = false;
}
if ($('#btn-new-user')) $('#btn-new-user').addEventListener('click', () => openUserModal());
if ($('#user-close')) $('#user-close').addEventListener('click', () => ($('#user-modal').hidden = true));
if ($('#user-cancel')) $('#user-cancel').addEventListener('click', () => ($('#user-modal').hidden = true));
if ($('#user-search')) $('#user-search').addEventListener('input', renderUsers);
document.addEventListener('click', (e) => { const r = e.target.closest('.user-row'); if (r) openUserModal(r.dataset.uid); });
if ($('#user-reset-pw')) $('#user-reset-pw').addEventListener('click', async () => {
  const email = ($('#user-form').elements.email.value || '').trim();
  if (!email) return alert('이메일이 없습니다.');
  if (!confirm(`${email} 로 비밀번호 재설정 메일을 보낼까요?`)) return;
  try { await dataService.sendPasswordReset(email); alert('재설정 메일을 발송했습니다.'); }
  catch (err) { alert('메일 발송 실패: ' + friendlyAuthError(err)); }
});
if ($('#user-form')) $('#user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const email = (f.elements.email.value || '').trim();
  const name = (f.elements.name.value || '').trim() || null;
  const role = f.elements.role.value;
  const active = f.elements.active.value === 'true';
  const submitBtn = f.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    if (!editingUserUid) {
      const pw = f.elements.password.value;
      if (!email) throw new Error('이메일을 입력하세요.');
      if (!pw || pw.length < 6) throw new Error('초기 비밀번호는 6자 이상이어야 합니다.');
      await dataService.createEmployee(email, pw, { name, role, active });
      alert('직원 계정과 권한 문서가 생성되었습니다.');
    } else {
      await dataService.saveUser(editingUserUid, { email: email || null, name, role, active }, false);
    }
    $('#user-modal').hidden = true;
    renderUsers();
  } catch (err) { alert('저장 실패: ' + friendlyAuthError(err)); }
  finally { submitBtn.disabled = false; }
});

/* ===================== AI 분석 챗봇 (서버 /api/chat 프록시) ===================== */
function buildAiContext() {
  const recs = (RECORDS || []).map((r) => ({ date: r.date, part: r.part || 'CAST', machine: r.machine, customer: r.customer, product: r.product, color: r.color, planQty: r.planQty, prodQty: r.prodQty, processDefect: r.processDefect, prodDefect: r.prodDefect, totalLossRate: r.totalLossRate, workers: r.workers }));
  return {
    설명: 'BL-TECH 생산1팀 데이터. totalLossRate=총로스율(%), processDefect=공정불량, prodDefect=생산불량, prodQty=정품생산량, workers=작업조(/로 구분).',
    건수: { records: RECORDS.length, sheets: SHEETS.length, plans: PLANS.length, standards: STANDARDS.length, custspecs: CUSTSPECS.length, equipchecks: EQUIPCHECKS.length, equipment: EQUIPMENT.length },
    records: recs,
    companies: (MASTERS.companies || []).map((c) => ({ name: c.name, specType: c.specType, country: c.country, toner: c.toner, colors: c.colors, notes: c.notes })),
    custspecs: (CUSTSPECS || []).map((s) => ({ product: s.product, customer: s.customer, specType: s.specType, coatingMid: s.coatingMid, toner: s.toner })),
    equipchecks: (EQUIPCHECKS || []).map((e) => ({ date: e.date, machine: e.machine, abnormal: e.abnormal, note: e.note })),
    equipment: (EQUIPMENT || []).map((e) => ({ name: e.name, model: e.model, manager: e.manager, 이력수: (e.history || []).length })),
  };
}
const aiFormat = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
async function aiAsk(q) {
  const msgs = $('#ai-messages');
  msgs.insertAdjacentHTML('beforeend', `<div class="ai-msg user">${esc(q)}</div>`);
  const loading = document.createElement('div');
  loading.className = 'ai-msg bot'; loading.textContent = '분석 중…';
  msgs.appendChild(loading); msgs.scrollTop = msgs.scrollHeight;
  try {
    // 로그인 사용자만 호출 가능하도록 Firebase ID 토큰 첨부 (배포본 함수가 검증. 로컬 서버는 무시)
    const headers = { 'Content-Type': 'application/json' };
    try { const u = dataService.auth.currentUser; if (u) headers.Authorization = 'Bearer ' + (await u.getIdToken()); } catch (e) { /* 토큰 없어도 진행 */ }
    const res = await fetch('/api/chat', { method: 'POST', headers, body: JSON.stringify({ question: q, context: buildAiContext() }) });
    const data = await res.json().catch(() => ({}));
    loading.innerHTML = res.ok ? aiFormat(data.answer || '(응답 없음)') : `<span class="ai-err">오류: ${esc(data.error || res.status)}</span>`;
  } catch (e) { loading.innerHTML = `<span class="ai-err">연결 실패: ${esc(e.message)}</span>`; }
  msgs.scrollTop = msgs.scrollHeight;
}
$('#ai-fab').addEventListener('click', () => { const p = $('#ai-panel'); p.hidden = !p.hidden; if (!p.hidden) $('#ai-q').focus(); });
$('#ai-close').addEventListener('click', () => ($('#ai-panel').hidden = true));
const aiSend = () => { const q = $('#ai-q').value.trim(); if (q) { aiAsk(q); $('#ai-q').value = ''; } };
$('#ai-send').addEventListener('click', aiSend);
$('#ai-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') aiSend(); });

/* ===================== 대시보드 ===================== */
function renderDashboard() {
  const month = $('#dash-month').value;
  const recs = partRecords().filter((r) => r.date && r.date.startsWith(month));
  const sum = (k) => recs.reduce((a, r) => a + num(r[k]), 0);
  const days = new Set(recs.map((r) => r.date)).size;

  const monthPlans = PLANS.filter((p) => (p.part || 'CAST') === PART && p.date && p.date.startsWith(month));
  const planSum = monthPlans.reduce((a, p) => a + num(p.planQty), 0);
  const planDone = monthPlans.filter((p) => p.status === '완료').length;
  const planKpi = `<div class="kpi"><div class="k-label">생산계획 (${PART})</div><div class="k-value">${fmt(monthPlans.length)}<small>건</small></div><div class="k-sub">계획수량 ${fmt(planSum)} · 완료 ${planDone}건</div></div>`;

  const byDay = {}, byMc = {};
  if (partBase(PART) === 'CAST') {
    const prodQty = sum('prodQty'), totalProdLoss = sum('totalProdLoss'), totalLoss = sum('totalLoss');
    const lossRate = totalProdLoss ? (totalLoss / totalProdLoss * 100) : 0;
    $('#kpi-grid').innerHTML = `
      <div class="kpi accent"><div class="k-label">생산수량 (정품)</div><div class="k-value">${fmt(prodQty)}</div><div class="k-sub">${month} · 가동 ${days}일 · ${recs.length}건</div></div>
      <div class="kpi"><div class="k-label">총생산량 (LOSS 포함)</div><div class="k-value">${fmt(totalProdLoss)}</div><div class="k-sub">실적계획 ${fmt(sum('planQty'))}</div></div>
      <div class="kpi red"><div class="k-label">총 LOSS</div><div class="k-value">${fmt(totalLoss)}</div><div class="k-sub">공정 ${fmt(sum('processDefect'))} · 생산 ${fmt(sum('prodDefect'))}</div></div>
      <div class="kpi ${lossRate < 3 ? 'green' : 'red'}"><div class="k-label">평균 총로스율</div><div class="k-value">${lossRate.toFixed(2)}%</div><div class="k-sub">목표 3.0% 미만</div></div>
      ${planKpi}
      <div class="kpi"><div class="k-label">수지 총투입량</div><div class="k-value">${fmt(sum('resinTotal'), 1)}<small>kg</small></div><div class="k-sub">기재 ${fmt(sum('inputBase'))}m</div></div>`;
    recs.forEach((r) => { byDay[r.date] = (byDay[r.date] || 0) + num(r.prodQty); });
    recs.forEach((r) => {
      const m = r.machine || '미지정';
      byMc[m] = byMc[m] || { loss: 0, total: 0 };
      byMc[m].loss += num(r.totalLoss);
      byMc[m].total += num(r.totalProdLoss);
    });
    $('#page-dashboard .grid-2 .card:first-child h3').textContent = '일별 생산량 (정품)';
  } else {
    const totalRoll = sum('totalRoll'), theoRoll = sum('theoRoll');
    const pDef = sum('processDefect'), gDef = sum('prodDefect');
    const lossRate = theoRoll ? ((pDef + gDef) / theoRoll * 100) : 0;
    const rollSum = recs.reduce((a, r) => a + (r.rollQty != null ? num(r.rollQty) : num(r.spDom) + num(r.spOvs)), 0);
    const precutSum = recs.reduce((a, r) => a + (r.precutQty != null ? num(r.precutQty) : num(r.prRoll)), 0);
    const lossSum = recs.reduce((a, r) => a + (r.lossQty != null ? num(r.lossQty) : num(r.processDefect) + num(r.prodDefect)), 0);
    const oosSum = recs.reduce((a, r) => a + num(r.outOfSpec), 0);
    $('#kpi-grid').innerHTML = `
      <div class="kpi accent"><div class="k-label">총수량 (ROLL+PRECUT)</div><div class="k-value">${fmt(totalRoll)}</div><div class="k-sub">${month} · 가동 ${days}일 · ${recs.length}건</div></div>
      <div class="kpi"><div class="k-label">ROLL / PRECUT</div><div class="k-value">${fmt(rollSum)} / ${fmt(precutSum)}</div><div class="k-sub">PRECUT = 기준미달 전환 반제품</div></div>
      <div class="kpi red"><div class="k-label">총 로스량</div><div class="k-value">${fmt(lossSum, 1)}</div><div class="k-sub">기준이탈 무게 ${fmt(oosSum)}건</div></div>
      <div class="kpi ${lossRate < 5 ? 'green' : 'red'}"><div class="k-label">평균 생산총로스율</div><div class="k-value">${lossRate.toFixed(2)}%</div><div class="k-sub">로스 ÷ (양품+로스)</div></div>
      ${planKpi}
      <div class="kpi"><div class="k-label">수지 투입량</div><div class="k-value">${fmt(sum('resinInput'), 1)}<small>kg</small></div><div class="k-sub">기재 ${fmt(sum('baseMid') + sum('baseUp') + sum('baseDown'))}m</div></div>`;
    recs.forEach((r) => { byDay[r.date] = (byDay[r.date] || 0) + num(r.totalRoll); });
    recs.forEach((r) => {
      const m = r.machine || '미지정';
      byMc[m] = byMc[m] || { loss: 0, total: 0 };
      byMc[m].loss += num(r.processDefect) + num(r.prodDefect);
      byMc[m].total += num(r.theoRoll);
    });
    $('#page-dashboard .grid-2 .card:first-child h3').textContent = '일별 생산량 (roll)';
  }

  $('#chart-daily').innerHTML = barChart(Object.keys(byDay).sort().map((d) => ({ label: d.slice(8) + '일', value: Math.round(byDay[d]) })));
  $('#chart-machine').innerHTML = barChart(Object.keys(byMc).sort().map((m) => ({
    label: m, value: byMc[m].total ? +(byMc[m].loss / byMc[m].total * 100).toFixed(2) : 0,
  })), { red: true, suffix: '%' });

  $('#dash-recent').innerHTML = recordTable(partRecords().slice(0, 8));
}

/* ===================== 생산계획표 ===================== */
function planActual(p) {
  // 같은 공정+날짜+호기+제품(+차수)의 실적 합계 (SPLINT는 총수량 roll)
  const part = p.part || 'CAST';
  const matched = RECORDS.filter((r) =>
    partOf(r) === part && r.date === p.date && r.machine === p.machine && r.product === p.product &&
    (!p.orderNo || num(r.orderNo) === num(p.orderNo)));
  return +matched.reduce((a, r) => a + num(partBase(part) === 'SPLINT' ? r.totalRoll : r.prodQty), 0).toFixed(1);
}

function renderPlans() {
  let plans = PLANS.filter((p) => (p.part || 'CAST') === PART);
  const from = $('#p-from').value, to = $('#p-to').value;
  const mc = $('#p-machine').value, st = $('#p-status').value;
  if (from) plans = plans.filter((p) => p.date >= from);
  if (to) plans = plans.filter((p) => p.date <= to);
  if (mc) plans = plans.filter((p) => p.machine === mc);
  if (st) plans = plans.filter((p) => (p.status || '계획') === st);

  if (!plans.length) { $('#plans-table').innerHTML = '<div class="empty">등록된 생산계획이 없습니다. [＋ 계획 등록]으로 추가하세요.</div>'; return; }

  const rows = plans.map((p) => {
    const actual = planActual(p);
    const achieve = num(p.planQty) ? actual / num(p.planQty) * 100 : 0;
    const aBadge = actual === 0 ? '<span class="badge plain">-</span>'
      : `<span class="badge ${achieve >= 100 ? 'ok' : 'warn'}">${achieve.toFixed(0)}%</span>`;
    return `<tr data-plan-id="${p.id}">
      <td>${esc(p.date)}</td><td>${esc(p.machine)}</td><td>${esc(p.customer ?? '')}</td>
      <td class="num">${p.orderNo ?? '-'}</td><td><b>${esc(p.product)}</b> ${esc(p.color ?? '')}</td>
      <td class="num">${p.length ?? '-'}</td><td class="num">${fmt(p.planQty)}</td>
      <td class="num">${actual ? fmt(actual) : '-'}</td><td>${aBadge}</td>
      <td>${statusBadge(p.status)}</td><td>${esc(p.note ?? '')}</td>
      <td><button class="btn small order-btn" data-order-id="${p.id}">🖨 지시서</button></td>
    </tr>`;
  }).join('');
  $('#plans-table').innerHTML = `<table><thead><tr>
    <th>생산일</th><th>호기</th><th>업체</th><th class="num">차수</th><th>제품</th>
    <th class="num">길이</th><th class="num">계획수량</th><th class="num">실적(정품)</th><th>달성률</th><th>상태</th><th>비고</th><th>작업지시</th>
  </tr></thead><tbody>${rows}</tbody></table>`;
}

const planForm = $('#plan-form');
function openPlanModal(id = null) {
  editingPlanId = id;
  planForm.reset();
  $('#plan-modal-title').textContent = id ? '생산계획 수정' : '생산계획 등록';
  $('#plan-delete').hidden = !id;
  if (id) {
    const p = PLANS.find((x) => x.id === id);
    if (!p) return;
    [...planForm.elements].forEach((el) => { if (el.name && p[el.name] != null) el.value = p[el.name]; });
  } else {
    planForm.elements.date.value = todayStr();
    planForm.elements.part.value = PART;
  }
  gateModal('#plan-form', id ? can('update', 'plans') : can('create', 'plans'), !!id && can('delete', 'plans'));
  $('#plan-modal').hidden = false;
}
$('#btn-new-plan').addEventListener('click', () => openPlanModal());
$('#plan-modal-close').addEventListener('click', () => ($('#plan-modal').hidden = true));
$('#plan-cancel').addEventListener('click', () => ($('#plan-modal').hidden = true));
$('#plan-modal').addEventListener('click', (e) => { if (e.target === $('#plan-modal')) $('#plan-modal').hidden = true; });

planForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const p = {};
  [...planForm.elements].forEach((el) => {
    if (!el.name) return;
    p[el.name] = el.type === 'number' ? (el.value === '' ? null : Number(el.value)) : (el.value || null);
  });
  try {
    if (editingPlanId) await post('/api/plans/' + editingPlanId, p, 'PUT');
    else await post('/api/plans', p);
    await loadPlans();
    $('#plan-modal').hidden = true;
    refreshCurrentPage();
  } catch (err) { alert('저장 실패: ' + err.message); }
});
$('#plan-delete').addEventListener('click', async () => {
  if (!editingPlanId || !confirm('이 계획을 삭제하시겠습니까?')) return;
  await api('/api/plans/' + editingPlanId, { method: 'DELETE' });
  await loadPlans();
  $('#plan-modal').hidden = true;
  refreshCurrentPage();
});
document.addEventListener('click', (e) => {
  const orderBtn = e.target.closest('.order-btn');
  if (orderBtn) { openOrderModal(Number(orderBtn.dataset.orderId)); return; }
  const tr = e.target.closest('tr[data-plan-id]');
  if (tr) openPlanModal(Number(tr.dataset.planId));
});

/* ===================== 작업지시서 ===================== */
/* 제품군 코드: NHC-3F → NHC-F (코팅량 규격표는 제품군 단위) */
const familyOf = (product) => String(product || '').trim().replace(/-(\d+)/, '-');

/* 계획과 가장 잘 맞는 제품표준서 찾기.
   우선순위: 제품명 정확 일치 > 제품군 일치. 'NPC-F(시그맥스)'처럼 괄호 변형은 업체명과 대조. 칼라·업체 일치 시 가점 */
function findStandard(plan) {
  const prod = (plan.product || '').trim();
  const fam = familyOf(prod);
  const part = plan.part || 'CAST';
  let best = null, bestScore = 0;
  for (const s of STANDARDS) {
    if ((s.part || 'CAST') !== part) continue;
    const sp = (s.product || '').trim();
    const paren = /^(.+?)\s*\((.+)\)$/.exec(sp);
    const spBase = paren ? paren[1].trim() : sp;
    const variant = paren ? paren[2].trim() : '';
    let score;
    if (sp === prod) score = 10;
    else if (spBase === prod) score = 8;
    else if (sp === fam || spBase === fam) score = 5;
    else continue;
    if (variant) score += plan.customer && String(plan.customer).includes(variant) ? 3 : -2;
    if (s.color && plan.color && s.color.trim().toUpperCase() === String(plan.color).trim().toUpperCase()) score += 2;
    else if (s.color && plan.color) score -= 1;
    if (s.customer && s.customer === plan.customer) score += 1;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best;
}

const coatingSpec = (s) => (s.coatingMid != null && s.coatingMid !== '')
  ? `하 ${s.coatingMin ?? '-'} / 중심 ${s.coatingMid} / 상 ${s.coatingMax ?? '-'}`
  : '';

/* 고객사 사양 구분 (기준정보 masters.customerTypes) — 미지정 시 NEAL. 고객사명 포함관계도 허용 */
function customerSpecType(customer) {
  const t = MASTERS.customerTypes || {};
  const c = String(customer ?? '').trim();
  if (!c) return 'NEAL';
  if (t[c]) return t[c];
  for (const k of Object.keys(t)) { if (k && (c.includes(k) || k.includes(c))) return t[k]; }
  return 'NEAL';
}

/* 고객사별 생산사양 조회: 고객사 타입(NEAL/OEM)에 맞는 사양을 제품명·색상으로 매칭.
   OEM인데 해당 사양이 없으면 기본 NEAL 사양으로 폴백(fellBack=true). */
function findCustSpec(p) {
  const part = p.part || 'CAST';
  const prod = String(p.product || '').trim();
  const fam = familyOf(prod);
  const type = customerSpecType(p.customer);
  const custMatch = (sc) => {
    const a = String(sc || '').trim(), b = String(p.customer || '').trim();
    return a === b || (!!a && !!b && (a.includes(b) || b.includes(a)));
  };
  const pick = (specType) => {
    let best = null, bestScore = -1;
    for (const s of CUSTSPECS) {
      if ((s.part || 'CAST') !== part) continue;
      if ((s.specType || 'NEAL') !== specType) continue;
      if (specType === 'OEM' && !custMatch(s.customer)) continue;
      const sp = String(s.product || '').trim();
      let score;
      if (sp === prod) score = 10;
      else if (sp === fam || familyOf(sp) === fam) score = 5;
      else continue;
      if (s.color && p.color && String(s.color).toUpperCase() === String(p.color).toUpperCase()) score += 2;
      else if (s.color && p.color) score -= 1;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best;
  };
  let spec = pick(type), fellBack = false;
  if (!spec && type === 'OEM') { spec = pick('NEAL'); fellBack = !!spec; }
  return { spec: spec || null, type, fellBack };
}

function orderPhoto(label, url) {
  return `<div class="order-photo">
    <div class="order-photo-label">${esc(label)}</div>
    ${url ? `<img src="${esc(url)}" alt="${esc(label)}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'order-photo-empty',textContent:'사진 없음'}))">` : '<div class="order-photo-empty">사진 미등록</div>'}
  </div>`;
}

function openOrderModal(planId) {
  const p = PLANS.find((x) => x.id === planId);
  if (p) openOrderDoc(p, `WO-${esc(p.date ?? '').replace(/-/g, '')}-${p.id}`);
}
/* 작업지시서 문서 렌더 — p는 계획 또는 제품정보 기반 plan-like 객체.
   자재기준=제품표준서(standards), 생산/포장 사양=고객사별 생산사양(custspecs), 예외=p.orderException */
function openOrderDoc(p, docNo) {
  const s = findStandard(p) || {};
  const { spec, type, fellBack } = findCustSpec(p);
  const cs = spec || {};
  const img = cs.images || {};
  const row = (label, v) => `<tr><th>${label}</th><td>${esc(v ?? '') || '-'}</td></tr>`;
  const badge = type === 'OEM'
    ? `<span class="order-badge oem">고객사 OEM 사양</span>${fellBack ? ' <span class="badge warn">OEM 사양 미등록 → 기본 NEAL 대체</span>' : ''}`
    : '<span class="order-badge neal">기본 NEAL 사양</span>';

  $('#order-body').innerHTML = `
    <div class="order-doc">
      <div class="order-head">
        <div class="order-title">작 업 지 시 서</div>
        <table class="order-sign"><tr><th>작성</th><th>검토</th><th>승인</th></tr><tr><td></td><td></td><td></td></tr></table>
      </div>
      <div class="order-meta">발행일: ${todayStr()} · 문서번호: ${esc(docNo || '')}</div>
      <div style="margin:10px 0">${badge}</div>
      <h4>1. 생산 계획</h4>
      <table class="order-table">
        ${row('생산일', p.date)}${row('호기', p.machine)}${row('업체명', p.customer)}${row('주문 차수', p.orderNo)}
        ${row('제품명', `${p.product ?? ''} ${p.color ?? ''}`)}${row('제품코드', s.productCode)}${row('브랜드', s.brand)}
        ${row('규격', s.sizeSpec || (p.length ? p.length + 'm' : ''))}${row('계획수량', p.planQty != null ? fmt(p.planQty) + ' EA' : '')}${row('비고', p.note)}
      </table>
      <h4>2. 자재 기준 ${s.id ? `<span class="muted" style="font-weight:400">— 제품표준서: ${esc(s.product)}</span>` : '<span class="badge bad">제품표준서 미등록</span>'}</h4>
      <table class="order-table">
        ${row('기재 종류', s.baseType)}${row('수지 종류', s.resinType)}${row('촉매', s.catalyst)}${row('코어 종류', s.core)}
      </table>
      <h4>3. 생산사양 ${cs.id ? `<span class="muted" style="font-weight:400">— ${type === 'OEM' && !fellBack ? 'OEM: ' + esc(cs.customer || '') : '기본 NEAL'}</span>` : '<span class="badge bad">생산사양 미등록 — 고객사별 생산사양에서 등록</span>'}</h4>
      <table class="order-table">
        ${row('코팅량 규격', coatingSpec(cs))}${row('토너', cs.toner)}
      </table>
      <h4>4. 포장 사양</h4>
      <table class="order-table">
        ${row('라벨 표기', cs.labelSpec)}${row('파우치', cs.pouchType)}${row('In Box', cs.inBoxSpec)}${row('Out Box', cs.outBoxSpec)}
        ${row('설명서', cs.manualSpec)}${row('동봉품', cs.enclosures)}${row('포장 주의사항', cs.packingNote)}
      </table>
      <div class="order-photos">
        ${orderPhoto('라벨 · 파우치', img.pouch)}
        ${orderPhoto('In Box (내박스)', img.inBox)}
        ${orderPhoto('Out Box (외박스)', img.outBox)}
      </div>
      ${p.orderException ? `<h4>5. 수주별 예외사항</h4><div class="order-exception">${esc(p.orderException)}</div>` : ''}
      <div class="no-print" style="margin-top:16px;text-align:center">
        <button class="btn primary" id="order-start-record">▶ 이 제품으로 공정기록 · 실적 입력</button>
      </div>
    </div>`;
  const startBtn = $('#order-start-record');
  if (startBtn) startBtn.addEventListener('click', () => startRecordingFrom(p));
  $('#order-modal').hidden = false;
}

/* 작업지시 → 공정기록·실적 입력: 같은 날짜/호기 일지가 있으면 열고, 없으면 새로 만들어 제품 프리필 */
async function startRecordingFrom(p) {
  const part = p.part || 'CAST';
  $('#order-modal').hidden = true;
  const existing = SHEETS.find((x) => (x.part || 'CAST') === part && x.date === p.date && x.machine === p.machine);
  if (existing) { openWorkspace(part, existing.id); return; }
  try {
    await openWorkspace(part);
    if (WS) {
      if (p.date) WS.date = p.date;
      if (p.machine) WS.machine = p.machine;
      WS.productInfos = WS.productInfos || [];
      WS.productInfos.push({ product: p.product || '', customer: p.customer || '', color: p.color || '', lotNo: '', size: p.size ?? '' });
      renderWorkspace();
      scheduleWsSave();
    }
  } catch (e) { /* 프리필 실패해도 워크스페이스는 열림 */ }
}
$('#order-close').addEventListener('click', () => ($('#order-modal').hidden = true));
$('#order-modal').addEventListener('click', (e) => { if (e.target === $('#order-modal')) $('#order-modal').hidden = true; });
$('#order-print').addEventListener('click', () => {
  document.body.classList.add('print-order');
  window.print();
});
window.addEventListener('afterprint', () => document.body.classList.remove('print-order'));

/* 일일 공정일지 기본정보 제품 → 작업지시서 바로보기 */
function openOrderForProduct(productName) {
  if (!WS) return;
  const info = (WS.productInfos || []).find((p) => p.product === productName);
  if (!info) return;
  const prod = (WS.products || []).find((x) => x.key === productName) || {};
  openOrderDoc({
    part: wsPart, date: WS.date, machine: WS.machine,
    customer: info.customer, product: info.product, color: info.color,
    orderNo: info.orderNo ?? null, size: info.size,
    length: prod.length ?? info.size ?? null, planQty: prod.planQty ?? null, note: '',
  }, `WO-${esc(WS.date ?? '').replace(/-/g, '')}-${esc(productName)}`);
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('.ws-order-btn');
  if (b) openOrderForProduct(b.dataset.product);
});

/* 일일 공정일지(목록) → 해당 일지에 들어간 제품의 작업지시서 보기 */
function sheetOrderItems(sheet) {
  const lines = (sheet.lines || []).filter((l) => l.product || l.productCode);
  if (lines.length) return lines;
  return (sheet.productInfos || []).filter((p) => p.product || p.productCode);
}
function buildPlanFromSheetItem(sheet, it) {
  return {
    part: sheet.part || 'CAST', date: sheet.date, machine: sheet.machine,
    customer: it.customer, product: it.product || it.productCode, color: it.color,
    orderNo: it.orderNo ?? null, size: it.size,
    length: it.length ?? it.size ?? null,
    planQty: it.planQty ?? it.qty ?? it.prodQty ?? null, note: '',
  };
}
function openOrderForSheet(sheetId, idx = 0) {
  const sheet = SHEETS.find((x) => x.id === sheetId);
  if (!sheet) return;
  const items = sheetOrderItems(sheet);
  if (!items.length) { alert('이 일지에는 작업지시서를 만들 제품 정보가 없습니다.'); return; }
  const i = Math.min(Math.max(idx, 0), items.length - 1);
  const it = items[i];
  const prod = it.product || it.productCode;
  openOrderDoc(buildPlanFromSheetItem(sheet, it),
    `WO-${esc(sheet.date ?? '').replace(/-/g, '')}-${esc(sheet.machine ?? '')}-${esc(prod)}`);
  if (items.length > 1) {
    const tabs = items.map((x, j) => {
      const name = x.product || x.productCode;
      return `<button type="button" class="btn small ${j === i ? 'primary' : ''} sheet-order-tab" data-sheet-id="${sheetId}" data-idx="${j}">${esc(name)}</button>`;
    }).join('');
    $('#order-body').insertAdjacentHTML('afterbegin',
      `<div class="no-print" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:12px"><span class="muted">제품 선택:</span>${tabs}</div>`);
  }
}
document.addEventListener('click', (e) => {
  const t = e.target.closest('.sheet-order-tab');
  if (t) openOrderForSheet(Number(t.dataset.sheetId), Number(t.dataset.idx));
});

/* ===================== 제품표준서 ===================== */
function renderStandards() {
  const q = $('#st-search').value.trim().toLowerCase();
  let items = STANDARDS.filter((s) => (s.part || 'CAST') === PART);
  if (q) items = items.filter((s) =>
    [s.product, s.productCode, s.customer, s.brand, s.color].some((v) => String(v ?? '').toLowerCase().includes(q)));
  if (!items.length) { $('#standards-list').innerHTML = '<div class="empty">등록된 표준서가 없습니다. [＋ 표준서 등록]으로 추가하세요.</div>'; return; }
  $('#standards-list').innerHTML = items.map((s) => {
    const img = s.images || {};
    const thumb = img.pouch || img.inBox || img.outBox;
    return `<div class="standard-card" data-standard-id="${s.id}">
      <div class="standard-thumb">${thumb ? `<img src="${esc(thumb)}" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'📦'}))">` : '<span>📦</span>'}</div>
      <div class="standard-info">
        <div class="standard-name"><b>${esc(s.product)}</b> ${esc(s.color ?? '')} <span class="muted">${esc(s.productCode ?? '')}</span></div>
        <div class="muted">${esc(s.category || 'CAST')} · ${esc(s.customer || '공용')}${s.brand ? ' · ' + esc(s.brand) : ''}</div>
        <div class="standard-mats">기재 ${esc(s.baseType ?? '-')} · 수지 ${esc(s.resinType ?? '-')} · 촉매 ${esc(s.catalyst ?? '-')}</div>
        <div class="standard-mats">코팅 ${s.coatingMid != null && s.coatingMid !== '' ? `${esc(s.coatingMin)}~${esc(s.coatingMax)} (중심 ${esc(s.coatingMid)})` : '-'} · 코어 ${esc(s.core ?? '-')}</div>
      </div>
    </div>`;
  }).join('');
}
$('#st-search').addEventListener('input', renderStandards);
document.addEventListener('click', (e) => {
  const card = e.target.closest('.standard-card');
  if (card) openStandardModal(Number(card.dataset.standardId));
});

const standardForm = $('#standard-form');

/* 사진 슬롯: 선택 → 리사이즈 → 업로드 → 미리보기 (URL은 slot.dataset.url에 보관) */
function initPhotoSlot(slot) {
  const file = slot.querySelector('input[type="file"]');
  const imgEl = slot.querySelector('img');
  const emptyEl = slot.querySelector('.photo-empty');
  const delBtn = slot.querySelector('.photo-del');
  imgEl.onerror = () => { imgEl.hidden = true; emptyEl.hidden = false; emptyEl.textContent = '사진을 불러올 수 없음'; };
  const setUrl = (url) => {
    slot.dataset.url = url || '';
    imgEl.hidden = !url;
    if (url) imgEl.src = url;
    emptyEl.hidden = !!url;
    emptyEl.textContent = '사진 없음';
    delBtn.hidden = !url;
  };
  slot._setUrl = setUrl;
  slot.querySelector('.photo-pick').addEventListener('click', () => file.click());
  delBtn.addEventListener('click', () => setUrl(''));
  file.addEventListener('change', async () => {
    if (!file.files[0]) return;
    try {
      const url = await uploadImage(file.files[0]);
      setUrl(url);
    } catch (err) { alert('업로드 실패: ' + err.message); }
    file.value = '';
  });
}
$$('#standard-form .photo-slot').forEach(initPhotoSlot);
$$('#custspec-form .photo-slot').forEach(initPhotoSlot);
$$('#equipcheck-form .photo-slot').forEach(initPhotoSlot);

async function uploadImage(f) {
  // 큰 사진은 1280px로 줄여 저장 (db 용량·인쇄 속도 보호)
  const bmp = await createImageBitmap(f);
  const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  const res = await post('/api/upload', { name: f.name, dataUrl });
  return res.url;
}

function openStandardModal(id = null) {
  editingStandardId = id;
  standardForm.reset();
  $('#standard-modal-title').textContent = id ? '제품표준서 수정' : '제품표준서 등록';
  $('#standard-delete').hidden = !id;
  const s = id ? STANDARDS.find((x) => x.id === id) : null;
  if (s) {
    [...standardForm.elements].forEach((el) => { if (el.name && s[el.name] != null && typeof s[el.name] !== 'object') el.value = s[el.name]; });
    standardForm.elements.part.value = s.part || 'CAST';
  } else {
    standardForm.elements.part.value = PART;
  }
  $$('#standard-form .photo-slot').forEach((slot) => slot._setUrl((s && s.images && s.images[slot.dataset.img]) || ''));
  gateModal('#standard-form', id ? can('update', 'standards') : can('create', 'standards'), !!id && can('delete', 'standards'));
  $('#standard-modal').hidden = false;
}
$('#btn-new-standard').addEventListener('click', () => openStandardModal());
$('#standard-modal-close').addEventListener('click', () => ($('#standard-modal').hidden = true));
$('#standard-cancel').addEventListener('click', () => ($('#standard-modal').hidden = true));

standardForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const s = {};
  [...standardForm.elements].forEach((el) => {
    if (!el.name) return;
    s[el.name] = el.type === 'number' ? (el.value === '' ? null : Number(el.value)) : (el.value || null);
  });
  s.images = {};
  $$('#standard-form .photo-slot').forEach((slot) => (s.images[slot.dataset.img] = slot.dataset.url || ''));
  try {
    if (editingStandardId) await post('/api/standards/' + editingStandardId, s, 'PUT');
    else await post('/api/standards', s);
    await loadStandards();
    $('#standard-modal').hidden = true;
    refreshCurrentPage();
  } catch (err) { alert('저장 실패: ' + err.message); }
});
$('#standard-delete').addEventListener('click', async () => {
  if (!editingStandardId || !confirm('이 표준서를 삭제하시겠습니까?')) return;
  await api('/api/standards/' + editingStandardId, { method: 'DELETE' });
  await loadStandards();
  $('#standard-modal').hidden = true;
  refreshCurrentPage();
});

/* ===================== 고객사별 생산사양 (custspecs) ===================== */
let editingCustSpecId = null;
const custspecForm = $('#custspec-form');

function specBadge(type) {
  return type === 'OEM'
    ? '<span class="badge oem">고객사 OEM</span>'
    : '<span class="badge neal">기본 NEAL</span>';
}

function renderCustSpecs() {
  const q = $('#cs-search').value.trim().toLowerCase();
  let items = CUSTSPECS.filter((s) => (s.part || 'CAST') === PART);
  if (q) items = items.filter((s) => [s.product, s.customer, s.color].some((v) => String(v ?? '').toLowerCase().includes(q)));
  items = items.slice().sort((a, b) =>
    (a.product || '').localeCompare(b.product || '')
    || (a.specType === b.specType ? String(a.customer || '').localeCompare(String(b.customer || '')) : (a.specType === 'NEAL' ? -1 : 1)));
  if (!items.length) { $('#custspecs-list').innerHTML = '<div class="empty">등록된 생산사양이 없습니다. [＋ 사양 등록]으로 추가하세요.</div>'; return; }
  $('#custspecs-list').innerHTML = items.map((s) => {
    const img = s.images || {};
    const thumb = img.pouch || img.inBox || img.outBox;
    const coat = (s.coatingMid != null && s.coatingMid !== '') ? `${esc(s.coatingMin)}~${esc(s.coatingMax)} (중심 ${esc(s.coatingMid)})` : '-';
    return `<div class="standard-card" data-custspec-id="${s.id}">
      <div class="standard-thumb">${thumb ? `<img src="${esc(thumb)}" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'🏷'}))">` : '<span>🏷</span>'}</div>
      <div class="standard-info">
        <div class="standard-name"><b>${esc(s.product)}</b>${s.variant ? ` <span class="muted">(${esc(s.variant)})</span>` : ''} ${esc(s.color ?? '')} ${specBadge(s.specType)}</div>
        <div class="muted">${s.specType === 'OEM' ? esc(s.customer || '(고객사 미지정)') : '제품 공통'}</div>
        <div class="standard-mats">코팅 ${coat} · 토너 ${esc(s.toner ?? '-')} · 파우치 ${esc(s.pouchType ?? '-')}</div>
        <div class="standard-mats">라벨 ${s.labelSpec ? '있음' : '-'} · 설명서 ${s.manualSpec ? '있음' : '-'} · 동봉품 ${s.enclosures ? '있음' : '-'}</div>
      </div>
    </div>`;
  }).join('');
}
$('#cs-search').addEventListener('input', renderCustSpecs);
document.addEventListener('click', (e) => {
  const card = e.target.closest('.standard-card[data-custspec-id]');
  if (card) openCustSpecModal(Number(card.dataset.custspecId));
});

/* 적용 대상 드롭다운: [기본 NEAL] + 각 고객사 (기준정보 masters.customers) */
function fillSpecTarget() {
  custspecForm.elements.specTarget.innerHTML = '<option value="__NEAL__">기본 NEAL (제품 공통)</option>'
    + (MASTERS.customers || []).map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
}

function openCustSpecModal(id = null) {
  editingCustSpecId = id;
  custspecForm.reset();
  $('#custspec-modal-title').textContent = id ? '생산사양 수정' : '생산사양 등록';
  $('#custspec-delete').hidden = !id;
  const s = id ? CUSTSPECS.find((x) => x.id === id) : null;
  fillSpecTarget();
  if (s) {
    [...custspecForm.elements].forEach((el) => { if (el.name && s[el.name] != null && typeof s[el.name] !== 'object') el.value = s[el.name]; });
    custspecForm.elements.part.value = s.part || 'CAST';
    const target = (s.specType === 'OEM' && s.customer) ? s.customer : '__NEAL__';
    const sel = custspecForm.elements.specTarget;
    if (target !== '__NEAL__' && ![...sel.options].some((o) => o.value === target)) {
      sel.insertAdjacentHTML('beforeend', `<option value="${esc(target)}">${esc(target)}</option>`);
    }
    sel.value = target;
  } else {
    custspecForm.elements.part.value = PART;
    custspecForm.elements.specTarget.value = '__NEAL__';
  }
  $$('#custspec-form .photo-slot').forEach((slot) => slot._setUrl((s && s.images && s.images[slot.dataset.img]) || ''));
  gateModal('#custspec-form', id ? can('update', 'custspecs') : can('create', 'custspecs'), !!id && can('delete', 'custspecs'));
  $('#custspec-modal').hidden = false;
}
$('#btn-new-custspec').addEventListener('click', () => openCustSpecModal());
$('#custspec-modal-close').addEventListener('click', () => ($('#custspec-modal').hidden = true));
$('#custspec-cancel').addEventListener('click', () => ($('#custspec-modal').hidden = true));

custspecForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const s = {};
  [...custspecForm.elements].forEach((el) => {
    if (!el.name) return;
    s[el.name] = el.type === 'number' ? (el.value === '' ? null : Number(el.value)) : (el.value || null);
  });
  const target = s.specTarget; delete s.specTarget;
  s.specType = (target && target !== '__NEAL__') ? 'OEM' : 'NEAL';
  s.customer = s.specType === 'OEM' ? target : null;
  s.images = {};
  $$('#custspec-form .photo-slot').forEach((slot) => (s.images[slot.dataset.img] = slot.dataset.url || ''));
  try {
    if (editingCustSpecId) await post('/api/custspecs/' + editingCustSpecId, s, 'PUT');
    else await post('/api/custspecs', s);
    await loadCustSpecs();
    $('#custspec-modal').hidden = true;
    refreshCurrentPage();
  } catch (err) { alert('저장 실패: ' + err.message); }
});
$('#custspec-delete').addEventListener('click', async () => {
  if (!editingCustSpecId || !confirm('이 생산사양을 삭제하시겠습니까?')) return;
  await api('/api/custspecs/' + editingCustSpecId, { method: 'DELETE' });
  await loadCustSpecs();
  $('#custspec-modal').hidden = true;
  refreshCurrentPage();
});

/* ===================== 전체 사양 보기 (제품표준서 + 모든 고객사별 생산사양) ===================== */
function renderOverview() {
  const q = $('#ov-search').value.trim().toLowerCase();
  const hit = (x, fields) => !q || fields.some((f) => String(x[f] ?? '').toLowerCase().includes(q));

  // 고객사별 생산사양 — 고객사별로 묶어서 표시 (OEM 고객사 먼저, 기본 NEAL 마지막)
  const specsAll = CUSTSPECS.filter((s) => hit(s, ['product', 'customer', 'color', 'toner', 'pouchType', 'labelSpec']));
  const groups = new Map();
  for (const s of specsAll) {
    const isOem = (s.specType || 'NEAL') === 'OEM';
    const key = isOem ? 'OEM::' + (s.customer || '(고객사 미지정)') : 'NEAL';
    if (!groups.has(key)) groups.set(key, { type: isOem ? 'OEM' : 'NEAL', label: isOem ? (s.customer || '(고객사 미지정)') : '기본 NEAL 사양 (제품 공통)', items: [] });
    groups.get(key).items.push(s);
  }
  const ordered = [...groups.values()].sort((a, b) =>
    (a.type === b.type ? 0 : (a.type === 'OEM' ? -1 : 1)) || a.label.localeCompare(b.label));
  const csRow = (s) => `<tr class="ov-cs-row" data-id="${s.id}" style="cursor:pointer">
    <td>${esc(s.part || 'CAST')}</td><td><b>${esc(s.product)}</b>${s.variant ? ` <span class="muted">(${esc(s.variant)})</span>` : ''}</td><td>${esc(s.color || '-')}</td>
    <td class="num">${(s.coatingMid != null && s.coatingMid !== '') ? `${esc(s.coatingMin)}~${esc(s.coatingMax)}` : '-'}</td>
    <td>${esc(s.toner || '-')}</td><td>${esc(s.pouchType || '-')}</td>
    <td>${s.labelSpec ? '✓' : '-'}</td><td>${s.manualSpec ? '✓' : '-'}</td><td>${s.enclosures ? '✓' : '-'}</td>
  </tr>`;
  $('#ov-custspecs').innerHTML = ordered.length
    ? ordered.map((g) => {
        const items = g.items.slice().sort((a, b) => (a.part || '').localeCompare(b.part || '') || (a.product || '').localeCompare(b.product || ''));
        return `<div class="ov-group">
          <div class="ov-group-head">${specBadge(g.type)} <b>${esc(g.label)}</b> <span class="muted">${items.length}건</span></div>
          <table><thead><tr><th>공정</th><th>제품</th><th>색상</th><th class="num">코팅</th><th>토너</th><th>파우치</th><th>라벨</th><th>설명서</th><th>동봉품</th></tr></thead><tbody>${items.map(csRow).join('')}</tbody></table>
        </div>`;
      }).join('')
    : '<div class="empty">등록된 생산사양이 없습니다.</div>';

  // 제품표준서
  const stds = STANDARDS.filter((s) => hit(s, ['product', 'productCode', 'color', 'brand', 'baseType', 'resinType']))
    .sort((a, b) => (a.part || '').localeCompare(b.part || '') || (a.product || '').localeCompare(b.product || ''));
  const stRows = stds.map((s) => `<tr class="ov-std-row" data-id="${s.id}" style="cursor:pointer">
    <td>${esc(s.part || 'CAST')}</td><td><b>${esc(s.product)}</b></td><td>${esc(s.color || '-')}</td>
    <td>${esc(s.productCode || '-')}</td><td>${esc(s.brand || '-')}</td>
    <td>${esc(s.baseType || '-')}</td><td>${esc(s.resinType || '-')}</td><td>${esc(s.catalyst || '-')}</td>
    <td>${esc(s.core || '-')}</td><td>${esc(s.sizeSpec || '-')}</td>
  </tr>`).join('');
  $('#ov-standards').innerHTML = stds.length
    ? `<table><thead><tr><th>공정</th><th>제품</th><th>색상</th><th>제품코드</th><th>브랜드</th><th>기재</th><th>수지</th><th>촉매</th><th>코어</th><th>규격</th></tr></thead><tbody>${stRows}</tbody></table>`
    : '<div class="empty">등록된 제품표준서가 없습니다.</div>';
}
$('#ov-search').addEventListener('input', renderOverview);
document.addEventListener('click', (e) => {
  const cs = e.target.closest('.ov-cs-row');
  if (cs) { openCustSpecModal(Number(cs.dataset.id)); return; }
  const st = e.target.closest('.ov-std-row');
  if (st) openStandardModal(Number(st.dataset.id));
});

/* ===================== 업체 정보 (masters.companies) ===================== */
let editingCompanyId = null;
const companyForm = $('#company-form');

/* 해당 고객사(업체)와 매칭되는 OEM 생산사양(코팅) — 이름 느슨 매칭 */
function coatingsForCompany(co) {
  const nm = String(co.name || '').toLowerCase();
  const base = nm.split('(')[0].trim();
  return (CUSTSPECS || []).filter((cs) => {
    if (cs.specType !== 'OEM' || !cs.customer) return false;
    const c = String(cs.customer).toLowerCase();
    return c && (nm.includes(c) || (base && (base.includes(c) || c.includes(base))));
  });
}
function coatingText(cs) {
  const coat = (cs.coatingMid != null && cs.coatingMid !== '') ? `${cs.coatingMin ?? ''}~${cs.coatingMax ?? ''}` : '';
  return `${cs.product}${cs.variant ? `(${cs.variant})` : ''}${coat ? ' ' + coat : ''}`;
}

function renderCompanies() {
  const q = $('#co-search').value.trim().toLowerCase();
  let items = (MASTERS.companies || []).slice().map((c) => {
    const coats = coatingsForCompany(c);
    return { ...c, _coats: coats, _oem: c.specType === 'OEM' || coats.length > 0 };
  });
  if (q) items = items.filter((c) => ['name', 'country', 'colors', 'resin', 'toner', 'notes'].some((f) => String(c[f] ?? '').toLowerCase().includes(q))
    || c._coats.some((cs) => String(cs.product || '').toLowerCase().includes(q)));
  items.sort((a, b) => (a._oem === b._oem ? 0 : (a._oem ? -1 : 1)) || String(a.name || '').localeCompare(String(b.name || '')));
  $('#co-count').textContent = `총 ${items.length}개 · OEM ${items.filter((c) => c._oem).length}`;
  const rows = items.map((c) => `<tr class="co-row" data-id="${c.id}" style="cursor:pointer">
    <td><b>${esc(c.name || '')}</b></td><td>${esc(c.country || '-')}</td><td>${specBadge(c._oem ? 'OEM' : 'NEAL')}</td>
    <td>${esc(c.colors || '-')}</td><td>${esc(c.toner || '-')}</td>
    <td>${c._coats.length ? esc(c._coats.map(coatingText).join(', ')) : '<span class="muted">-</span>'}</td>
    <td>${esc(c.packInBox || '-')}</td><td>${esc(c.packOutBox || '-')}</td><td>${esc(c.packLabel || '-')}</td>
    <td>${esc(c.resin || '-')} ${esc(c.baseLength || '')}</td><td>${esc(c.notes || '')}</td>
  </tr>`).join('');
  $('#companies-list').innerHTML = items.length
    ? `<table><thead><tr><th>고객사</th><th>나라</th><th>구분</th><th>컬러</th><th>토너</th><th>코팅(제품별)</th><th>인박스</th><th>아웃박스</th><th>파우치/라벨</th><th>수지/기재</th><th>특이사항</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<div class="empty">등록된 고객사가 없습니다.</div>';
}

function openCompanyModal(id = null) {
  editingCompanyId = id;
  companyForm.reset();
  $('#company-modal-title').textContent = id ? '업체 정보 수정' : '업체 등록';
  $('#company-delete').hidden = !id;
  const c = id ? (MASTERS.companies || []).find((x) => x.id === id) : null;
  if (c) [...companyForm.elements].forEach((el) => { if (el.name && c[el.name] != null) el.value = c[el.name]; });
  companyForm.elements.specType.value = c ? (c.specType || 'NEAL') : 'NEAL';
  gateModal('#company-form', id ? can('update', 'companies') : can('create', 'companies'), !!id && can('delete', 'companies'));
  $('#company-modal').hidden = false;
}
$('#btn-new-company').addEventListener('click', () => openCompanyModal());
$('#company-modal-close').addEventListener('click', () => ($('#company-modal').hidden = true));
$('#company-cancel').addEventListener('click', () => ($('#company-modal').hidden = true));
document.addEventListener('click', (e) => { const r = e.target.closest('.co-row'); if (r) openCompanyModal(Number(r.dataset.id)); });
$('#co-search').addEventListener('input', renderCompanies);

companyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const c = {};
  [...companyForm.elements].forEach((el) => { if (el.name) c[el.name] = el.value || null; });
  MASTERS.companies = MASTERS.companies || [];
  if (editingCompanyId) {
    c.id = editingCompanyId;
    const i = MASTERS.companies.findIndex((x) => x.id === editingCompanyId);
    if (i >= 0) MASTERS.companies[i] = c; else MASTERS.companies.push(c);
  } else {
    c.id = Math.max(0, ...MASTERS.companies.map((x) => x.id || 0)) + 1;
    MASTERS.companies.push(c);
  }
  try { MASTERS = await post('/api/masters', MASTERS, 'PUT'); $('#company-modal').hidden = true; refreshCurrentPage(); }
  catch (err) { alert('저장 실패: ' + err.message); }
});
$('#company-delete').addEventListener('click', async () => {
  if (!editingCompanyId || !confirm('이 업체 정보를 삭제하시겠습니까?')) return;
  MASTERS.companies = (MASTERS.companies || []).filter((x) => x.id !== editingCompanyId);
  MASTERS = await post('/api/masters', MASTERS, 'PUT');
  $('#company-modal').hidden = true;
  refreshCurrentPage();
});

/* ===================== 설비 일상점검 (equipchecks) ===================== */
let editingEquipCheckId = null;
const equipcheckForm = $('#equipcheck-form');
function renderEquipChecks() {
  const month = $('#ec-month').value, mc = $('#ec-machine').value, pt = $('#ec-part').value;
  let items = EQUIPCHECKS.slice();
  if (month) items = items.filter((x) => (x.date || '').startsWith(month));
  if (mc) items = items.filter((x) => x.machine === mc);
  if (pt) items = items.filter((x) => (x.part || 'CAST') === pt);
  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) || String(a.machine || '').localeCompare(String(b.machine || '')));
  const ck = (v) => v ? '✔' : '<span class="muted">-</span>';
  const num = (v) => v != null && v !== '' ? esc(v) : '-';
  const photoCount = (x) => Object.values(x.images || {}).filter(Boolean).length;
  const rows = items.map((x) => {
    const pc = photoCount(x);
    return `<tr class="ec-row" data-id="${x.id}" style="cursor:pointer">
    <td>${esc(x.date)}</td><td>${esc(x.part || 'CAST')}</td><td>${esc(x.machine || '')}</td><td>${esc(x.checker || '')}</td>
    <td class="num">${ck(x.clean)}</td><td class="num">${ck(x.sealer)}</td><td class="num">${ck(x.pressure)}</td><td class="num">${ck(x.safety)}</td>
    <td class="num">${ck(x.dehum1)}</td><td class="num">${ck(x.dehum2)}</td>
    <td class="num">${num(x.temp)}</td><td class="num">${num(x.humid)}</td>
    <td class="num">${pc ? `<span class="badge ok">📷 ${pc}</span>` : '<span class="muted">-</span>'}</td>
    <td>${x.abnormal ? `<span class="badge bad">이상</span> ${esc(x.abnormalNote || '')}` : '<span class="badge ok">정상</span>'}</td><td>${esc(x.note || '')}</td>
  </tr>`;
  }).join('');
  $('#equipchecks-list').innerHTML = items.length
    ? `<table><thead><tr><th>점검일</th><th>공정</th><th>호기</th><th>점검자</th><th>청결</th><th>실링기</th><th>압력</th><th>안전</th><th>제습기1</th><th>제습기2</th><th>온도</th><th>습도</th><th>사진</th><th>이상유무</th><th>비고</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<div class="empty">점검 기록이 없습니다. [＋ 점검 등록]으로 추가하세요.</div>';
}
function openEquipCheckModal(id = null) {
  editingEquipCheckId = id;
  equipcheckForm.reset();
  $('#equipcheck-modal-title').textContent = id ? '일상점검 수정' : '일상점검 등록';
  $('#equipcheck-delete').hidden = !id;
  equipcheckForm.elements.machine.innerHTML = '<option value="">선택</option>' + (MASTERS.machines || []).map((m) => `<option>${esc(m)}</option>`).join('');
  const x = id ? EQUIPCHECKS.find((e) => e.id === id) : null;
  if (x) {
    [...equipcheckForm.elements].forEach((el) => { if (!el.name) return; if (el.type === 'checkbox') el.checked = !!x[el.name]; else if (x[el.name] != null) el.value = x[el.name]; });
  } else { equipcheckForm.elements.date.value = todayStr(); equipcheckForm.elements.part.value = PART; }
  $$('#equipcheck-form .photo-slot').forEach((slot) => slot._setUrl((x && x.images && x.images[slot.dataset.img]) || ''));
  gateModal('#equipcheck-form', id ? can('update', 'equipchecks', EQUIPCHECKS.find((e) => e.id === id)) : can('create', 'equipchecks'), !!id && can('delete', 'equipchecks'));
  $('#equipcheck-modal').hidden = false;
}
$('#btn-new-equipcheck').addEventListener('click', () => openEquipCheckModal());
$('#equipcheck-close').addEventListener('click', () => ($('#equipcheck-modal').hidden = true));
$('#equipcheck-cancel').addEventListener('click', () => ($('#equipcheck-modal').hidden = true));
document.addEventListener('click', (e) => { const r = e.target.closest('.ec-row'); if (r) openEquipCheckModal(Number(r.dataset.id)); });
equipcheckForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const x = {};
  [...equipcheckForm.elements].forEach((el) => { if (!el.name) return; x[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? (el.value === '' ? null : Number(el.value)) : (el.value || null); });
  x.images = {};
  $$('#equipcheck-form .photo-slot').forEach((slot) => { x.images[slot.dataset.img] = slot.dataset.url || ''; });
  try {
    if (editingEquipCheckId) await post('/api/equipchecks/' + editingEquipCheckId, x, 'PUT'); else await post('/api/equipchecks', x);
    await loadEquipChecks(); $('#equipcheck-modal').hidden = true; refreshCurrentPage();
  } catch (err) { alert('저장 실패: ' + err.message); }
});
$('#equipcheck-delete').addEventListener('click', async () => {
  if (!editingEquipCheckId || !confirm('이 점검 기록을 삭제하시겠습니까?')) return;
  await api('/api/equipchecks/' + editingEquipCheckId, { method: 'DELETE' });
  await loadEquipChecks(); $('#equipcheck-modal').hidden = true; refreshCurrentPage();
});
['ec-month', 'ec-machine', 'ec-part'].forEach((id) => $('#' + id).addEventListener('input', renderEquipChecks));

/* ===================== 설비 대장 (설비별 탭 → 체크리스트 + 점검·수리 이력) ===================== */
let editingEquipmentId = null;      // 설비 정보 등록/수정 모달 대상
let selectedEquipId = null;         // 현재 선택된 설비 탭
let editRecEquipId = null;          // 점검·수리 기록 모달: 대상 설비
let editRecId = null;               // 점검·수리 기록 모달: 편집 중 기록 id (null=신규)
let eqrPhotos = [];                 // 기록 모달 첨부 사진
let eqClSaveTimer = null;
const equipmentForm = $('#equipment-form');
const EQ_TYPES = ['정기점검', '점검', '수리', '교체', '기타'];
const eqTypeBadge = (t) => t === '수리' ? 'bad' : t === '교체' ? 'warn' : t === '기타' ? 'plain' : 'ok';

/* --- 목록: 설비 탭 + 상세 패널 --- */
function renderEquipment() {
  const q = $('#eq-search').value.trim().toLowerCase();
  let items = EQUIPMENT.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  if (q) items = items.filter((x) => ['name', 'model', 'serialNo', 'manager', 'location'].some((f) => String(x[f] ?? '').toLowerCase().includes(q)));
  const tabs = $('#eq-tabs'), detail = $('#eq-detail');
  if (!items.length) {
    tabs.innerHTML = '';
    detail.innerHTML = '<div class="empty">등록된 설비가 없습니다. [＋ 설비 등록]으로 추가하세요.</div>';
    return;
  }
  if (!items.some((e) => e.id === selectedEquipId)) selectedEquipId = items[0].id;
  tabs.innerHTML = items.map((e) => {
    const hh = (e.history || []).length;
    return `<button type="button" class="eq-tab ${e.id === selectedEquipId ? 'active' : ''}" data-id="${e.id}">
      <span class="eq-tab-name">${esc(e.name || '(무명)')}</span>
      <span class="eq-tab-sub">${esc(e.model || '')}${hh ? ` · 이력 ${hh}` : ''}</span>
    </button>`;
  }).join('');
  renderEquipDetail(selectedEquipId);
}

function checklistRowHtml(c) {
  return `<div class="eq-crow" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:6px">
    <input type="text" data-c="item" value="${esc(c.item || '')}" placeholder="점검항목" style="flex:1;min-width:150px">
    <input type="text" data-c="method" value="${esc(c.method || '')}" placeholder="점검방법" list="dl-eqMethods" style="width:130px">
    <input type="text" data-c="standard" value="${esc(c.standard || '')}" placeholder="판정기준" style="width:160px">
    <input type="text" data-c="cycle" value="${esc(c.cycle || '')}" placeholder="주기" list="dl-eqCycles" style="width:90px">
    <button type="button" class="btn small danger eq-cdel" title="삭제">✕</button>
  </div>`;
}

function renderEquipDetail(id) {
  const e = EQUIPMENT.find((x) => x.id === id);
  const box = $('#eq-detail');
  if (!e) { box.innerHTML = ''; return; }
  // 구버전 이력에 id 없으면 부여 (설비 내 고유)
  (e.history || []).forEach((h, i) => { if (h.id == null) h.id = i + 1; });
  const meta = [['모델', e.model], ['업체명', e.vendor], ['관리번호', e.serialNo], ['구입일', e.buyDate], ['담당자', e.manager], ['위치', e.location], ['정기점검', e.inspCycle]]
    .filter(([, v]) => v)
    .map(([k, v]) => `<span class="eq-meta"><b>${esc(k)}</b> ${esc(v)}</span>`).join('');
  const cl = e.checklist || [];
  const clRows = cl.length ? cl.map(checklistRowHtml).join('') : '<div class="muted">점검항목이 없습니다. [＋ 점검항목 추가]로 등록하세요.</div>';
  const hist = (e.history || []).slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const histHtml = hist.length ? hist.map((h) => {
    const photos = (h.photos || []).filter((p) => p.url);
    const thumbs = photos.length ? `<div class="eq-rec-photos">${photos.map((p) => `<figure class="eq-thumb"><img src="${esc(p.url)}" data-full="${esc(p.url)}" alt="${esc(p.label || '')}"><figcaption>${esc(p.label || '')}</figcaption></figure>`).join('')}</div>` : '';
    return `<div class="eq-rec">
      <div class="eq-rec-head">
        <span class="badge ${eqTypeBadge(h.type)}">${esc(h.type || '점검')}</span>
        <b>${esc(h.date || '')}</b>
        ${h.by ? `<span class="muted">· ${esc(h.by)}</span>` : ''}
        <span class="spacer"></span>
        <button type="button" class="btn small eq-rec-edit" data-rec="${h.id}">수정</button>
      </div>
      ${h.detail ? `<div class="eq-rec-detail">${esc(h.detail)}</div>` : ''}
      ${thumbs}
    </div>`;
  }).join('') : '<div class="muted">점검·수리 기록이 없습니다. [＋ 점검·수리 기록]으로 추가하세요.</div>';

  box.innerHTML = `
    <div class="eq-detail-head">
      <div>
        <h2 class="eq-detail-name">${esc(e.name || '(무명)')}</h2>
        <div class="eq-meta-row">${meta}</div>
        ${e.note ? `<div class="muted" style="margin-top:4px">${esc(e.note)}</div>` : ''}
      </div>
      <div class="eq-detail-actions">
        <button type="button" class="btn small" id="eq-info-edit">✎ 설비정보 수정</button>
        <button type="button" class="btn small danger" id="eq-info-del">🗑 설비 삭제</button>
      </div>
    </div>
    <div class="eq-section">
      <div class="eq-section-head"><h3>설비 체크리스트</h3><span class="ws-save" id="eq-cl-save"></span><span class="spacer"></span><button type="button" class="btn small" id="eq-cl-add">＋ 점검항목 추가</button></div>
      <div id="eq-detail-checklist">${clRows}</div>
    </div>
    <div class="eq-section">
      <div class="eq-section-head"><h3>점검 · 수리 이력</h3><span class="spacer"></span><button type="button" class="btn small primary" id="eq-rec-add">＋ 점검·수리 기록</button></div>
      <div class="eq-rec-list">${histHtml}</div>
    </div>`;
}

/* 체크리스트: 상세 패널에서 인라인 편집 → 자동저장 (재렌더 없이) */
function harvestDetailChecklist() {
  const e = EQUIPMENT.find((x) => x.id === selectedEquipId);
  if (!e) return null;
  e.checklist = $$('#eq-detail-checklist .eq-crow').map((row) => {
    const g = (k) => { const el = row.querySelector(`[data-c="${k}"]`); return el ? el.value : ''; };
    return { item: g('item') || null, method: g('method') || null, standard: g('standard') || null, cycle: g('cycle') || null };
  }).filter((c) => c.item || c.method || c.standard);
  return e;
}
async function saveEquipmentNow(e, statusSel) {
  if (!e) return;
  const s = statusSel && $(statusSel);
  if (s) s.textContent = '저장 중…';
  try { await post('/api/equipment/' + e.id, e, 'PUT'); if (s) s.textContent = '저장됨 ✓'; }
  catch (err) { if (s) s.textContent = '저장 실패'; }
}
function scheduleChecklistSave() {
  const s = $('#eq-cl-save'); if (s) s.textContent = '저장 중…';
  clearTimeout(eqClSaveTimer);
  eqClSaveTimer = setTimeout(() => saveEquipmentNow(harvestDetailChecklist(), '#eq-cl-save'), 600);
}

/* --- 설비 탭 / 상세 패널 이벤트 (정적 부모에 위임) --- */
$('#eq-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.eq-tab'); if (!b) return;
  selectedEquipId = Number(b.dataset.id); renderEquipment();
});
$('#eq-detail').addEventListener('click', (e) => {
  if (e.target.closest('#eq-info-edit')) return openEquipmentModal(selectedEquipId);
  if (e.target.closest('#eq-info-del')) return deleteEquipment(selectedEquipId);
  if (e.target.closest('#eq-cl-add')) {
    const cont = $('#eq-detail-checklist');
    if (cont.querySelector('.muted')) cont.innerHTML = '';
    cont.insertAdjacentHTML('beforeend', checklistRowHtml({ method: '육안검사', cycle: '일일' }));
    const rows = cont.querySelectorAll('.eq-crow'); const last = rows[rows.length - 1];
    const inp = last && last.querySelector('[data-c="item"]'); if (inp) inp.focus();
    saveEquipmentNow(harvestDetailChecklist(), '#eq-cl-save');
    return;
  }
  const cdel = e.target.closest('.eq-cdel');
  if (cdel) { cdel.closest('.eq-crow').remove(); saveEquipmentNow(harvestDetailChecklist(), '#eq-cl-save'); return; }
  if (e.target.closest('#eq-rec-add')) return openRecordModal(selectedEquipId, null);
  const re = e.target.closest('.eq-rec-edit'); if (re) return openRecordModal(selectedEquipId, Number(re.dataset.rec));
  const img = e.target.closest('.eq-thumb img'); if (img) return openPhotoViewer(img.dataset.full);
});
$('#eq-detail').addEventListener('input', (e) => { if (e.target.closest('#eq-detail-checklist')) scheduleChecklistSave(); });

/* --- 설비 정보 등록/수정 모달 (정보만) --- */
function openEquipmentModal(id = null) {
  editingEquipmentId = id;
  equipmentForm.reset();
  $('#equipment-modal-title').textContent = id ? '설비 정보 수정' : '설비 등록';
  $('#equipment-delete').hidden = !id;
  const x = id ? EQUIPMENT.find((e) => e.id === id) : null;
  if (x) [...equipmentForm.elements].forEach((el) => { if (el.name && x[el.name] != null && typeof x[el.name] !== 'object') el.value = x[el.name]; });
  gateModal('#equipment-form', id ? can('update', 'equipment') : can('create', 'equipment'), !!id && can('delete', 'equipment'));
  $('#equipment-modal').hidden = false;
}
$('#btn-new-equipment').addEventListener('click', () => openEquipmentModal());
$('#equipment-close').addEventListener('click', () => ($('#equipment-modal').hidden = true));
$('#equipment-cancel').addEventListener('click', () => ($('#equipment-modal').hidden = true));
equipmentForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const cur = editingEquipmentId ? EQUIPMENT.find((x) => x.id === editingEquipmentId) : null;
  const x = cur ? { ...cur } : {};
  [...equipmentForm.elements].forEach((el) => { if (el.name) x[el.name] = el.value || null; });
  x.checklist = (cur && cur.checklist) || [];   // 체크리스트·이력은 상세 패널에서 관리 → 보존
  x.history = (cur && cur.history) || [];
  try {
    let saved;
    if (editingEquipmentId) saved = await post('/api/equipment/' + editingEquipmentId, x, 'PUT');
    else saved = await post('/api/equipment', x);
    if (saved && saved.id) selectedEquipId = saved.id;
    await loadEquipment(); $('#equipment-modal').hidden = true; renderEquipment();
  } catch (err) { alert('저장 실패: ' + err.message); }
});
$('#equipment-delete').addEventListener('click', () => deleteEquipment(editingEquipmentId));
async function deleteEquipment(id) {
  if (!id || !confirm('이 설비를 삭제하시겠습니까?\n체크리스트·점검이력도 함께 삭제됩니다.')) return;
  await api('/api/equipment/' + id, { method: 'DELETE' });
  if (selectedEquipId === id) selectedEquipId = null;
  await loadEquipment(); $('#equipment-modal').hidden = true; renderEquipment();
}
$('#eq-search').addEventListener('input', renderEquipment);

/* --- 점검·수리 기록 모달 (날짜/구분/담당/내용 + 사진 첨부) --- */
function openRecordModal(equipId, recId) {
  editRecEquipId = equipId; editRecId = recId;
  const e = EQUIPMENT.find((x) => x.id === equipId); if (!e) return;
  const rec = recId ? (e.history || []).find((h) => h.id === recId) : null;
  const f = $('#equip-record-form'); f.reset();
  $('#equip-record-title').textContent = rec ? '점검·수리 기록 수정' : '점검·수리 기록 추가';
  $('#equip-record-sub').textContent = e.name || '';
  $('#equip-record-delete').hidden = !rec;
  f.elements.date.value = (rec && rec.date) || todayStr();
  f.elements.type.value = (rec && rec.type) || '정기점검';
  f.elements.by.value = (rec && rec.by) || '';
  f.elements.detail.value = (rec && rec.detail) || '';
  eqrPhotos = rec && Array.isArray(rec.photos) ? rec.photos.map((p) => ({ ...p })) : [];
  renderEqrPhotos();
  gateModal('#equip-record-form', can('update', 'equipment'), can('update', 'equipment'));
  $('#equip-record-modal').hidden = false;
}
function harvestEqrLabels() {
  $$('#eqr-photos .eq-photo').forEach((card) => {
    const i = Number(card.dataset.i);
    const l = card.querySelector('.eq-photo-label');
    if (eqrPhotos[i]) eqrPhotos[i].label = l ? l.value : '';
  });
}
function renderEqrPhotos() {
  const box = $('#eqr-photos');
  box.innerHTML = eqrPhotos.map((p, i) => `<div class="photo-slot eq-photo" data-i="${i}">
    <input type="text" class="eq-photo-label" value="${esc(p.label || '')}" placeholder="구분 (예: 수리 전/후, 점검부위)" style="width:100%;margin-bottom:6px">
    <div class="photo-box">${p.url ? `<img src="${esc(p.url)}">` : '<span class="photo-empty">사진 없음</span>'}</div>
    <div class="photo-btns">
      <button type="button" class="btn small eq-photo-pick">📷 촬영/선택</button>
      <button type="button" class="btn small danger eq-photo-del">삭제</button>
    </div>
    <input type="file" accept="image/*" capture="environment" hidden>
  </div>`).join('') || '<div class="muted">사진이 없습니다. [＋ 사진 추가]로 첨부하세요.</div>';
  $$('#eqr-photos .eq-photo').forEach((card) => {
    const i = Number(card.dataset.i);
    const file = card.querySelector('input[type=file]');
    card.querySelector('.eq-photo-pick').addEventListener('click', () => file.click());
    card.querySelector('.eq-photo-del').addEventListener('click', () => { harvestEqrLabels(); eqrPhotos.splice(i, 1); renderEqrPhotos(); });
    file.addEventListener('change', async () => {
      if (!file.files[0]) return;
      try { harvestEqrLabels(); eqrPhotos[i].url = await uploadImage(file.files[0]); renderEqrPhotos(); }
      catch (err) { alert('업로드 실패: ' + err.message); }
      file.value = '';
    });
  });
}
$('#eqr-photo-add').addEventListener('click', () => { harvestEqrLabels(); eqrPhotos.push({ label: '', url: '' }); renderEqrPhotos(); });
$('#equip-record-close').addEventListener('click', () => ($('#equip-record-modal').hidden = true));
$('#equip-record-cancel').addEventListener('click', () => ($('#equip-record-modal').hidden = true));
$('#equip-record-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  harvestEqrLabels();
  const eq = EQUIPMENT.find((x) => x.id === editRecEquipId); if (!eq) return;
  const f = e.target;
  const rec = {
    id: editRecId || nextRecordId(eq),
    date: f.elements.date.value || null,
    type: f.elements.type.value || null,
    detail: f.elements.detail.value || null,
    by: f.elements.by.value || null,
    photos: eqrPhotos.filter((p) => p.url),
  };
  eq.history = eq.history || [];
  const idx = editRecId ? eq.history.findIndex((h) => h.id === editRecId) : -1;
  if (idx >= 0) eq.history[idx] = rec; else eq.history.push(rec);
  try {
    await post('/api/equipment/' + eq.id, eq, 'PUT');
    await loadEquipment(); $('#equip-record-modal').hidden = true; renderEquipment();
  } catch (err) { alert('저장 실패: ' + err.message); }
});
$('#equip-record-delete').addEventListener('click', async () => {
  if (!editRecId || !confirm('이 점검·수리 기록을 삭제하시겠습니까?')) return;
  const eq = EQUIPMENT.find((x) => x.id === editRecEquipId); if (!eq) return;
  eq.history = (eq.history || []).filter((h) => h.id !== editRecId);
  try {
    await post('/api/equipment/' + eq.id, eq, 'PUT');
    await loadEquipment(); $('#equip-record-modal').hidden = true; renderEquipment();
  } catch (err) { alert('삭제 실패: ' + err.message); }
});
function nextRecordId(eq) { return (eq.history || []).reduce((m, h) => Math.max(m, Number(h.id) || 0), 0) + 1; }

/* --- 사진 확대 뷰어 --- */
function openPhotoViewer(url) {
  let ov = $('#img-viewer');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'img-viewer'; ov.className = 'img-viewer';
    ov.innerHTML = '<img alt="확대 사진">';
    ov.addEventListener('click', () => ov.classList.remove('show'));
    document.body.appendChild(ov);
  }
  ov.querySelector('img').src = url; ov.classList.add('show');
}

/* ===================== 일일 공정일지 ===================== */
function renderSheets() {
  let sheets = SHEETS.filter((s) => (s.part || 'CAST') === PART);
  const month = $('#s-month').value, mc = $('#s-machine').value;
  if (month) sheets = sheets.filter((s) => s.date && s.date.startsWith(month));
  if (mc) sheets = sheets.filter((s) => s.machine === mc);

  if (!sheets.length) { $('#sheets-table').innerHTML = '<div class="empty">작성된 일지가 없습니다. [＋ 일지 작성]으로 추가하세요.</div>'; return; }

  const rows = sheets.map((s) => {
    const lines = s.lines || [];
    const prodSum = partBase(s.part || 'CAST') === 'SPLINT'
      ? lines.reduce((a, l) => a + num(l.rollQty) + num(l.precutQty), 0)
      : lines.reduce((a, l) => a + num(l.qty != null ? l.qty : l.prodQty), 0);
    const items = (s.product ? s.product + (lines.length > 1 ? ` 외 ${lines.length - 1}` : '') : lines.map((l) => l.product || l.productCode).filter(Boolean).join(', '));
    const st = s.status || '완료';
    const stCls = st === '완료' ? 'ok' : st === '진행' ? 'warn' : 'plain';
    return `<tr data-sheet-id="${s.id}">
      <td>${esc(s.date)}</td><td>${esc(s.machine)}</td><td>${esc(s.writer ?? '')}</td>
      <td>${esc(items) || '-'}</td><td class="num">${lines.length}</td><td class="num"><b>${fmt(prodSum)}</b></td>
      <td>${esc(s.startTime ?? '')}~${esc(s.endTime ?? '')}</td>
      <td><span class="badge ${stCls}">${esc(st)}</span></td><td>${esc(s.remarks ?? '')}</td>
      <td><button type="button" class="btn small sheet-order-btn" data-sheet-id="${s.id}">🖨 작업지시서</button></td>
    </tr>`;
  }).join('');
  $('#sheets-table').innerHTML = `<table><thead><tr>
    <th>생산일</th><th>호기</th><th>작업자</th><th>생산 품목</th><th class="num">라인</th><th class="num">생산합계</th><th>작업시간</th><th>상태</th><th>특이사항</th><th>작업지시서</th>
  </tr></thead><tbody>${rows}</tbody></table>`;
}

/* --- 동적 행 정의 --- */
const DYN_DEFS = {
  pinfo: { // SPLINT 기본정보 생산 제품 (여러 제품)
    container: '#--pinfo',
    fields: [
      { key: 'product', label: '제품명', list: 'dl-products' },
      { key: 'lotNo', label: 'LOT' },
      { key: 'customer', label: '업체명', list: 'dl-customers' },
      { key: 'size', label: '인치', type: 'number' },
      { key: 'specMin', label: '기준무게 하한(g)', type: 'number' },
      { key: 'specMax', label: '기준무게 상한(g)', type: 'number' },
    ],
  },
  swt: { // SPLINT 제품무게 측정
    container: '#--swt',
    fields: [
      { key: 'time', label: '시간', type: 'time', now: true },
      { key: 'product', label: '제품명', list: 'dl-products' },
      { key: 'value', label: '무게(g)', type: 'number', step: '0.1' },
    ],
  },
  wchange: { // 기재 교체 이력 (CAST 기재교체 / SPLINT 중피·상지·하지)
    container: '#--wchange',
    fields: [
      { key: 'time', label: '시간', type: 'time', now: true },
      { key: 'note', label: '비고' },
    ],
  },
  cpinfo: { // CAST 기본정보 생산 제품 (여러 제품)
    container: '#--cpinfo',
    fields: [
      { key: 'product', label: '제품명', list: 'dl-products' },
      { key: 'lotNo', label: 'LOT' },
      { key: 'customer', label: '업체명', list: 'dl-customers' },
      { key: 'size', label: '인치', type: 'number' },
      { key: 'color', label: '색상', list: 'dl-colors' },
    ],
  },
  cbasechg: { // CAST 기재 교체 이력
    container: '#--cbasechg',
    fields: [
      { key: 'baseType', label: '기재종류', list: 'dl-qcItems' },
      { key: 'time', label: '시간', type: 'time', now: true },
      { key: 'note', label: '비고' },
    ],
  },
  cbaseloss: { // CAST 기재 로스 (기재종류별)
    container: '#--cbaseloss',
    fields: [
      { key: 'baseType', label: '기재종류', list: 'dl-qcItems' },
      { key: 'joint', label: '이음매 개수', type: 'number' },
      { key: 'knot', label: '매듭 개수', type: 'number' },
      { key: 'defect', label: '불량 개수', type: 'number' },
    ],
  },
  cbtest: { // CAST 기포테스트 (시간별 실링기 점검 체크)
    container: '#--cbtest',
    fields: [
      { key: 'time', label: '시간', type: 'time', now: true },
      { key: 'checker', label: '확인자', list: 'dl-workers' },
      { key: 'sealTape', label: '실링테이프', type: 'checkbox' },
      { key: 'temp', label: '온도', type: 'checkbox' },
      { key: 'pressure', label: '압력', type: 'checkbox' },
      { key: 'heaterGap', label: '히터공 간격', type: 'checkbox' },
    ],
  },
  cresin: { // CAST 수지 정보 (여러 수지)
    container: '#--cresin',
    fields: [
      { key: 'name', label: '수지명', list: 'dl-resins' },
      { key: 'color', label: '컬러', list: 'dl-colors' },
      { key: 'synth', label: '합성일', type: 'date' },
      { key: 'mix', label: '배합일', type: 'date' },
      { key: 'catalyst', label: '촉매' },
      { key: 'no', label: '번호' },
      { key: 'weight', label: '무게' },
      { key: 'note', label: '비고' },
    ],
  },
  cprod: { // CAST 제품별 생산실적
    container: '#--cprod',
    fields: [
      { key: 'product', label: '제품명', list: 'dl-products' },
      { key: 'qty', label: '생산량', type: 'number' },
      { key: 'loss', label: '작업 로스', type: 'number' },
      { key: 'note', label: '비고' },
    ],
  },
  sprod: { // SPLINT 제품별 생산실적 (ROLL / PRECUT 생산량 + 총로스량 자동)
    container: '#--sprod',
    fields: [
      { key: 'product', label: '제품명', list: 'dl-products' },
      { key: 'rollQty', label: 'ROLL 생산량', type: 'number' },
      { key: 'precutQty', label: 'PRECUT 생산량', type: 'number' },
      { key: 'lossTotal', label: '총로스량', type: 'number', readonly: true },
      { key: 'note', label: '비고' },
    ],
  },
  pcprod: { // PRE-CUT 생산 수량 (제품종류 · Roll Splint Type · 생산LOT · 생산수량 · 사용설명서 · 내수/수출)
    container: '#--pcprod',
    fields: [
      { key: 'product', label: '제품종류(코드)', list: 'dl-products' },
      { key: 'rollType', label: 'Roll Splint Type' },
      { key: 'lotNo', label: '생산 LOT' },
      { key: 'prodQty', label: '생산수량', type: 'number' },
      { key: 'ifuPrep', label: '설명서 준비수량', type: 'number' },
      { key: 'ifuUsed', label: '설명서 사용수량', type: 'number' },
      { key: 'ifuReturn', label: '설명서 반납수량', type: 'number' },
      { key: 'market', label: '내수/수출', type: 'select', options: ['내수', '수출'] },
      { key: 'sign', label: '확인 서명', list: 'dl-workers' },
      { key: 'note', label: '비고' },
    ],
  },
  pcbase: { // PRE-CUT 기재사용 내용 (기재종류 · LOT · 사용량 · 코팅량 · 폐기량)
    container: '#--pcbase',
    fields: [
      { key: 'baseType', label: '기재종류', list: 'dl-baseTypes' },
      { key: 'lotNo', label: 'LOT' },
      { key: 'used', label: '사용량', type: 'number' },
      { key: 'coating', label: '코팅량', type: 'number', step: '0.01' },
      { key: 'waste', label: '폐기량', type: 'number' },
    ],
  },
  pcbubble: { // PRE-CUT 기포테스트 확인 (시간 · 담당)
    container: '#--pcbubble',
    fields: [
      { key: 'time', label: '시간', type: 'time', now: true },
      { key: 'checker', label: '담당', list: 'dl-workers' },
    ],
  },
  sresin: { // SPLINT 수지 원료 (원료별 추가)
    container: '#--sresin',
    fields: [
      { key: 'name', label: '원료명', list: 'dl-resins' },
      { key: 'weight', label: '무게' },
      { key: 'catalyst', label: '촉매량' },
      { key: 'drum', label: '드럼번호' },
      { key: 'synth', label: '합성일', type: 'date' },
    ],
  },
  bubble: {
    container: '#bubble-rows',
    fields: [
      { key: 'time', label: '시간', type: 'time' },
      { key: 'checker', label: '확인자', list: 'dl-workers' },
    ],
  },
  base: {
    container: '#base-rows',
    fields: [
      { key: 'base', label: '기재', list: 'dl-baseTypes' },
      { key: 'time', label: '교체시간', type: 'time' },
    ],
  },
  resin: {
    container: '#resin-rows',
    fields: [
      { key: 'name', label: '수지명', list: 'dl-resins' },
      { key: 'color', label: '컬러', list: 'dl-colors' },
      { key: 'synthDate', label: '합성일', type: 'date' },
      { key: 'catalyst', label: '촉매' },
      { key: 'no', label: '번호' },
      { key: 'weight', label: '무게' },
      { key: 'mixDate', label: '배합일', type: 'date' },
    ],
  },
  weight: {
    container: '#weight-rows',
    fields: [
      { key: 'time', label: '측정 시간', type: 'time' },
      { key: 'value', label: '무게(g)', type: 'number', step: '0.1' },
      { key: 'note', label: '비고' },
    ],
  },
  sbubble: { // SPLINT 파우치 버블테스트
    container: '#sbubble-rows',
    fields: [
      { key: 'time', label: '시간', type: 'time' },
      { key: 'checker', label: '확인자', list: 'dl-workers' },
    ],
  },
  sloss: { // SPLINT 작업 로스 (제품별 · 전 항목)
    container: '#sloss-rows',
    fields: [
      { key: 'product', label: '제품명', list: 'dl-products' },
      { key: 'setting', label: '셋팅불량', type: 'number' },
      { key: 'joint', label: '이음매', type: 'number' },
      { key: 'stain', label: '오염', type: 'number' },
      { key: 'stop', label: '멈춤', type: 'number' },
      { key: 'drum', label: '드럼교체', type: 'number' },
      { key: 'sample', label: '샘플', type: 'number' },
      { key: 'etc', label: '기타', type: 'number' },
    ],
  },
  sline: { // SPLINT 생산 라인
    container: '#sline-rows',
    fields: [
      { key: 'product', label: '제품명', list: 'dl-products' },
      { key: 'customer', label: '업체명', list: 'dl-customers' },
      { key: 'orderNo', label: '차수', type: 'number' },
      { key: 'size', label: '인치', type: 'number' },
      { key: 'baseType', label: '기재타입', list: 'dl-baseTypes' },
      { key: 'weight', label: '무게1개(g)', type: 'number' },
      { key: 'spDom', label: 'SP내수(roll)', type: 'number' },
      { key: 'spOvs', label: 'SP해외(roll)', type: 'number' },
      { key: 'spM', label: 'SP(m)', type: 'number', step: '0.01' },
      { key: 'prM', label: 'PR(m)', type: 'number', step: '0.01' },
      { key: 'baseMid', label: '중피(m)', type: 'number', step: '0.1' },
      { key: 'baseUp', label: '상지(m)', type: 'number', step: '0.01' },
      { key: 'baseDown', label: '하지(m)', type: 'number', step: '0.01' },
      { key: 'lossG', label: '총로스(g)', type: 'number' },
      { key: 'processDefect', label: '공정불량(roll)', type: 'number', step: '0.01' },
    ],
  },
  line: {
    container: '#line-rows',
    fields: [
      { key: 'productCode', label: '제품코드', list: 'dl-productCodes' },
      { key: 'product', label: '제품명', list: 'dl-products' },
      { key: 'orderNo', label: '차수', type: 'number' },
      { key: 'lotNo', label: 'LOT' },
      { key: 'exp', label: 'EXP', type: 'date' },
      { key: 'customer', label: '업체명', list: 'dl-customers' },
      { key: 'size', label: '인치', type: 'number' },
      { key: 'color', label: '색상', list: 'dl-colors' },
      { key: 'length', label: '길이', type: 'number', step: '0.1' },
      { key: 'planQty', label: '계획수량', type: 'number' },
      { key: 'prodQty', label: '정품수량', type: 'number' },
      { key: 'remainQty', label: '잔량', type: 'number' },
      { key: 'pouchExtra', label: '파우치추가', type: 'number' },
      { key: 'coating', label: '코팅량', type: 'number', step: '0.01' },
      { key: 'weight', label: '무게', type: 'number', step: '0.1' },
      { key: 'processDefect', label: '공정불량', type: 'number' },
      { key: 'prodDefect', label: '생산불량', type: 'number' },
    ],
  },
};

function addDynRow(kind, data = {}, containerEl) {
  const def = DYN_DEFS[kind];
  const container = containerEl || $(def.container);
  const row = document.createElement('div');
  row.className = 'dyn-row' + (kind === 'line' || kind === 'sline' || kind === 'pcprod' ? ' line-row' : '');
  row.dataset.kind = kind;
  if (data.recordId) row.dataset.recordId = data.recordId;
  row.innerHTML = def.fields.map((f) => {
    if (f.type === 'checkbox') {
      return `<label class="chk-field"><span class="field-wrap"><input type="checkbox" data-key="${f.key}" ${data[f.key] ? 'checked' : ''}>${esc(f.label)}</span></label>`;
    }
    let inp;
    if (f.type === 'select') {
      const cur = data[f.key] ?? '';
      const opts = (f.options || []).map((o) => `<option ${String(o) === String(cur) ? 'selected' : ''}>${esc(o)}</option>`).join('');
      inp = `<select data-key="${f.key}"><option value="">선택</option>${opts}</select>`;
    } else {
      inp = `<input type="${f.type || 'text'}" ${f.step ? `step="${f.step}"` : ''} ${f.readonly ? 'readonly tabindex="-1"' : ''} data-key="${f.key}" ${f.list ? `list="${f.list}"` : ''} value="${esc(data[f.key] ?? '')}">`;
    }
    const nowB = f.now ? '<button type="button" class="btn small now-btn" tabindex="-1">지금</button>' : '';
    return `<label class="${f.now ? 'has-now' : ''}">${f.label}<span class="field-wrap">${inp}${nowB}</span></label>`;
  }).join('') + '<button type="button" class="btn icon dyn-del" title="행 삭제">✕</button>';
  row.querySelector('.dyn-del').addEventListener('click', () => {
    row.remove();
    container.dispatchEvent(new Event('input', { bubbles: true })); // 자동계산/자동저장 갱신
  });
  row.querySelectorAll('.now-btn').forEach((b) => b.addEventListener('click', () => {
    b.previousElementSibling.value = nowTime();
    container.dispatchEvent(new Event('input', { bubbles: true }));
  }));
  container.appendChild(row);
}
function collectDynRows(kind, containerEl) {
  const def = DYN_DEFS[kind];
  const container = containerEl || $(def.container);
  return [...container.querySelectorAll('.dyn-row')].map((row) => {
    const obj = {};
    if (row.dataset.recordId) obj.recordId = Number(row.dataset.recordId);
    row.querySelectorAll('input[data-key], select[data-key]').forEach((el) => {
      const f = def.fields.find((x) => x.key === el.dataset.key);
      if (f && f.type === 'checkbox') obj[el.dataset.key] = el.checked;
      else obj[el.dataset.key] = f && f.type === 'number' ? (el.value === '' ? null : Number(el.value)) : (el.value || '');
    });
    return obj;
  }).filter((o) => Object.entries(o).some(([k, v]) => k !== 'recordId' && v !== '' && v != null && v !== false));
}
$$('[data-add]').forEach((b) => b.addEventListener('click', () => addDynRow(b.dataset.add)));

const getByPath = (obj, path) => path.split('.').reduce((o, k) => (o || {})[k], obj);
const setByPath = (obj, path, v) => {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] = o[k] || {};
  o[keys.at(-1)] = v;
};

/* 일지 라인 → 생산실적(records) 동기화 (CAST/SPLINT 공용) */
async function syncSheetLines(s, origRecordIds) {
  const isSplint = partBase(s.part) === 'SPLINT';
    for (const line of s.lines) {
      const base = isSplint
        ? {
          part: s.part || 'SPLINT',
          date: s.date, machine: s.machine, workers: s.writer || null,
          lotNo: line.lotNo || s.lotNo || null,
          customer: line.customer || s.customer || null,
          product: line.product || null, size: line.size ?? s.size ?? null, baseType: line.baseType || s.baseType || null,
          rollQty: line.rollQty ?? null, precutQty: line.precutQty ?? null,
          loss: line.loss ?? null, note: line.note || null,
          lossItems: line.lossItems || null,
          weights: line.weights || [], specMin: line.specMin ?? null, specMax: line.specMax ?? null,
          avgWeight: line.avgWeight ?? null, isFirst: !!line.isFirst, rollLen: 4.55,
        }
        : {
          part: s.part || 'CAST',
          date: s.date, machine: s.machine, workers: s.writer || null,
          lotNo: line.lotNo || null,
          customer: line.customer || s.customer || null,
          product: line.product || null, color: line.color || null, size: line.size ?? null,
          length: line.length ?? null, planQty: line.planQty ?? null,
          prodQty: line.prodQty ?? null, remainQty: line.remainQty ?? null,
          pouchExtra: line.pouchExtra ?? null, coating: line.coating ?? null, weight: line.weight ?? null,
          resinType: line.resinType || null,
          loss: line.loss ?? null, note: line.note || null,
        };
      const calcFn = isSplint ? splintWsCalc : castWsCalc;
      // 제품표준서에서 기재·수지·파우치 기준 자동 보완 (비어있는 항목만)
      const enrich = (rec) => {
        const std = findStandard({ part: s.part, product: line.product, color: line.color, customer: line.customer });
        if (!std) return;
        const fills = isSplint
          ? { baseType: std.baseType, resinType: std.resinType, pouchType: std.pouchType }
          : { productCode: std.productCode, baseType: std.baseType, resinType: std.resinType, pouchType: std.pouchType };
        for (const [k, v] of Object.entries(fills)) {
          if ((rec[k] == null || rec[k] === '') && v) rec[k] = v;
        }
      };
      if (line.recordId) {
        const old = RECORDS.find((r) => r.id === line.recordId);
        const merged = { ...(old || {}), ...base };
        enrich(merged);
        Object.assign(merged, calcFn(merged));
        await post('/api/records/' + line.recordId, merged, 'PUT');
      } else {
        const rec = { ...base };
        enrich(rec);
        Object.assign(rec, calcFn(rec));
        const saved = await post('/api/records', rec);
        line.recordId = saved.id;
      }
    }
  // 일지에서 삭제된 라인의 실적도 함께 삭제
  const keep = s.lines.map((l) => l.recordId).filter(Boolean);
  for (const oldId of origRecordIds) {
    if (!keep.includes(oldId)) await api('/api/records/' + oldId, { method: 'DELETE' }).catch(() => {});
  }
}

/* ===================== 공정일지 워크스페이스 (탭 누적 입력 → 자동완성) ===================== */
const nowTime = () => { const d = new Date(); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); };

const WS_SCHEMA = {
  CAST: {
    formNo: 'F-PD-003A (Rev.12) · 작업흐름형',
    tabs: [
      { id: 'basic', label: '① 기본정보', blocks: [
        { type: 'startstop', which: 'start' },
        { type: 'grid', title: '기본 정보', fields: [
          { name: 'date', label: '생산일', type: 'date' },
          { name: 'machine', label: '호기', type: 'select', master: 'machines' },
          { name: 'writer1', label: '작업자 1', list: 'dl-workers' },
          { name: 'writer2', label: '작업자 2', list: 'dl-workers' },
        ] },
        { type: 'rows', title: '생산 제품 (여러 제품 등록)', kind: 'cpinfo', store: 'productInfos', minRows: 1 },
        { type: 'orderLinks' },
        { type: 'startcheck' },
      ] },
      { id: 'prep', label: '② 생산준비·정기점검', blocks: [
        { type: 'note', text: '휴게시간 후 재가동 전 확인 항목입니다. (10:30 / 15:30)' },
        { type: 'matrix', title: '정기점검 (10:30 / 15:30)', group: 'checks',
          rows: [{ key: 't1030', label: '10:30' }, { key: 't1530', label: '15:30' }],
          cols: [{ key: 'sealTemp', label: '실링기온도(℃)' }, { key: 'roomT', label: '실내온도(℃)' }, { key: 'roomH', label: '실내습도(%)' }, { key: 'machT', label: '기계내부온도(℃)' }, { key: 'machH', label: '기계내부습도(%)' }, { key: 'scale', label: '저울(1.0g/)' }, { key: 'wRange1', label: '제품무게①/③' }, { key: 'wRange2', label: '제품무게②/④' }, { key: 'dehum1', label: '저압제습기1' }, { key: 'dehum2', label: '저압제습기2' }] },
        { type: 'grid', title: '실링기 점검', fields: [
          { name: 'sealerNo', label: '실링기 번호' },
        ] },
        { type: 'rows', title: '기포테스트 (시간별 실링기 점검)', kind: 'cbtest', store: 'bubbleTests', minRows: 1 },
      ] },
      { id: 'during', label: '③ 생산중 기록 ★', blocks: [
        { type: 'castResults' },
        { type: 'rows', title: '기재 교체 이력', kind: 'cbasechg', store: 'baseChanges' },
        { type: 'rows', title: '기재 로스 (기재종류별)', kind: 'cbaseloss', store: 'baseLoss', minRows: 1 },
        { type: 'rows', title: '수지 정보 (여러 수지)', kind: 'cresin', store: 'resins', minRows: 1 },
        { type: 'grid', title: '특이사항', fields: [{ name: 'remarks', label: '특이사항', type: 'textarea' }] },
      ] },
      { id: 'quality', label: '④ 품질확인', blocks: [
        { type: 'grid', title: '자체 품질 체크 (경화시간)', fields: [
          { name: 'qcItem', label: '품목', type: 'select', master: 'qcItems' },
          { name: 'qcResult', label: '결과 (시간)', type: 'time' },
        ] },
        { type: 'castFoam' },
        { type: 'castQcProducts' },
      ] },
      { id: 'finish', label: '⑤ 생산종료', blocks: [
        { type: 'castSummary' },
        { type: 'startstop', which: 'end' },
      ] },
    ],
  },
  SPLINT: {
    formNo: 'F-PD-003b (Rev.13) · 작업흐름형',
    tabs: [
      { id: 'basic', label: '① 기본정보', blocks: [
        { type: 'startstop', which: 'start' },
        { type: 'grid', title: '기본 정보 · 작업조', fields: [
          { name: 'date', label: '생산일', type: 'date' },
          { name: 'machine', label: '호기', type: 'select', master: 'machines' },
          { name: 'leader', label: '호기장', list: 'dl-workers' },
          { name: 'assistant', label: '보조', list: 'dl-workers' },
          { name: 'pack1', label: '포장1', list: 'dl-workers' },
          { name: 'pack2', label: '포장2', list: 'dl-workers' },
          { name: 'baseType', label: '기재타입', list: 'dl-baseTypes' },
        ] },
        { type: 'rows', title: '생산 제품 (여러 제품 등록)', kind: 'pinfo', store: 'productInfos', minRows: 1 },
        { type: 'orderLinks' },
        { type: 'startcheck' },
      ] },
      { id: 'prep', label: '② 생산준비·정기점검', blocks: [
        { type: 'note', text: '휴게시간 후 재가동 전 확인 항목입니다. (10:30 / 15:30)' },
        { type: 'matrix', title: '정기점검 (Chamber 내부) — 온도 상한 30℃ · 습도 상한 20%', group: 'schecks',
          rows: [{ key: 't1030', label: '10:30' }, { key: 't1530', label: '15:30' }],
          cols: [{ key: 'roomT', label: '실내온도(℃)' }, { key: 'roomH', label: '실내습도(%)' }, { key: 'machT', label: '기기내온도(℃)' }, { key: 'machH', label: '기기내습도(%)' }, { key: 'chamT', label: '챔버온도(℃)' }, { key: 'chamH', label: '챔버습도(%)' }, { key: 'dehum1', label: '저압제습기1' }, { key: 'dehum2', label: '저압제습기2' }, { key: 'reg', label: '레귤레이터(1bar↑)' }, { key: 'chamClean', label: '챔버·다이 청결' }] },
        { type: 'grid', title: '생산준비', fields: [
          { name: 'prepManager', label: '담당자', list: 'dl-workers' },
          { name: 'ifu', label: 'IFU(사용설명서)' },
          { name: 'clip', label: '기타 포장재(Clip)' },
          { name: 'resinTempAM', label: '수지온도℃(오전)' },
          { name: 'resinTempPM', label: '수지온도℃(오후)' },
          { name: 'bonding', label: '양면/초음파 접착' },
          { name: 'sealerCheck', label: '실링기(히팅/쿨링)' },
          { name: 'markerLot', label: '각인기 LOT/EXP' },
          { name: 'baseWidth', label: '기재(폭)' },
        ] },
        { type: 'grid', title: '수지 확인', fields: [
          { name: 'resinManager', label: '담당자', list: 'dl-workers' },
          { name: 'resinRemain1', label: '수지잔량1' },
          { name: 'resinRemain2', label: '수지잔량2' },
        ] },
        { type: 'rows', title: '수지 원료 (원료별 추가)', kind: 'sresin', store: 'resinLots', minRows: 1 },
        { type: 'grid', title: '작업사항 확인', fields: [
          { name: 'workManager', label: '담당자', list: 'dl-workers' },
          { name: 'foamTest', label: '발포 테스트' },
          { name: 'tapeLot', label: '양면테이프 LOT' },
          { name: 'tapeTest', label: '양면접착 테스트' },
          { name: 'qc3SP', label: '자체품질 3SP' },
          { name: 'qc3N', label: '자체품질 3N' },
          { name: 'qc3F', label: '자체품질 3F' },
        ] },
        { type: 'splintDetector' },
      ] },
      { id: 'during', label: '③ 생산중 기록 ★', blocks: [
        { type: 'splintProducts' },
        { type: 'rows', title: '작업 로스 (제품별 · 전 항목)', kind: 'sloss', store: 'losses', minRows: 1 },
        { type: 'rows', title: '제품무게 측정', kind: 'swt', store: 'weights' },
        { type: 'matrix', title: '기재 교체 (중피 · 상지 · 하지)', group: 'baseChg',
          rows: [{ key: 'mid', label: '중피' }, { key: 'up', label: '상지' }, { key: 'down', label: '하지' }],
          cols: [{ key: 'in', label: '투입수량' }, { key: 'knot', label: '매듭수량' }, { key: 'used', label: '사용량' }] },
        { type: 'grid', title: '특이사항', fields: [{ name: 'remarks', label: '특이사항', type: 'textarea' }] },
      ] },
      { id: 'quality', label: '④ 품질확인', blocks: [
        { type: 'rows', title: '파우치 버블테스트 (시간/확인자)', kind: 'sbubble', store: 'bubbleTests' },
        { type: 'grid', title: '생산제품 · 라벨 확인', fields: [
          { name: 'prodManager', label: '담당자', list: 'dl-workers' },
          { name: 'labelRecv', label: '라벨 인수(인/브/아)' },
          { name: 'labelUsed', label: '라벨 사용(인/브/아)' },
          { name: 'labelLeft', label: '라벨 남은(인/브/아)' },
        ] },
        { type: 'matrix', title: '코팅량 (시간/측정)', group: 'coat',
          rows: [{ key: 't1', label: '타임1' }, { key: 't2', label: '타임2' }, { key: 't3', label: '타임3' }],
          cols: [{ key: 'time', label: '시간' }, { key: 'val', label: '측정값(/%)' }] },
      ] },
      { id: 'finish', label: '⑤ 생산종료', blocks: [
        { type: 'splintSummary' },
        { type: 'startstop', which: 'end' },
      ] },
    ],
  },
  'PRE-CUT': {
    formNo: 'F-PD-003e (Rev.9) · 프리컷 생산공정일지',
    tabs: [
      { id: 'basic', label: '① 기본정보', blocks: [
        { type: 'startstop', which: 'start' },
        { type: 'grid', title: '기본 정보', fields: [
          { name: 'date', label: '생산일', type: 'date' },
          { name: 'weekday', label: '요일' },
          { name: 'weather', label: '날씨' },
          { name: 'machine', label: '호기', type: 'select', master: 'machines' },
          { name: 'writer1', label: '작업자 1', list: 'dl-workers' },
          { name: 'writer2', label: '작업자 2', list: 'dl-workers' },
        ] },
        { type: 'note', text: '공정 점검 (Chamber 내부) — 온도 상한값 30℃ / 습도 상한값 20% · 초과 시 작업중지 후 보고' },
        { type: 'matrix', title: '공정 점검 (Chamber 내부) — 측정시간별 온·습도', group: 'pcChecks',
          rows: [{ key: 't1030', label: '10:30' }, { key: 't1530', label: '15:30' }],
          cols: [{ key: 'temp', label: '온도(℃)' }, { key: 'humid', label: '습도(%)' }, { key: 'note', label: '비고' }] },
        { type: 'grid', title: '저압제습기 상태', fields: [
          { name: 'dehum1AM', label: '저압제습기1 오전' },
          { name: 'dehum1PM', label: '저압제습기1 오후' },
          { name: 'dehum2AM', label: '저압제습기2 오전' },
          { name: 'dehum2PM', label: '저압제습기2 오후' },
        ] },
      ] },
      { id: 'during', label: '② 생산 수량 ★', blocks: [
        { type: 'pcProducts' },
        { type: 'rows', title: '기재사용 내용', kind: 'pcbase', store: 'baseUse', minRows: 1 },
        { type: 'grid', title: '특이사항 (공정이상 발생시 내용기록)', fields: [{ name: 'remarks', label: '특이사항', type: 'textarea' }] },
      ] },
      { id: 'quality', label: '③ 기포테스트', blocks: [
        { type: 'rows', title: '기포테스트 확인 (시간 / 담당)', kind: 'pcbubble', store: 'bubbleTests', minRows: 1 },
      ] },
      { id: 'finish', label: '④ 생산종료', blocks: [
        { type: 'pcSummary' },
        { type: 'startstop', which: 'end' },
      ] },
    ],
  },
  HYBRID: {
    formNo: '하이브리드 공정생산일지 · 작업흐름형',
    tabs: [
      { id: 'basic', label: '① 기본정보', blocks: [
        { type: 'startstop', which: 'start' },
        { type: 'grid', title: '기본 정보', fields: [
          { name: 'date', label: '날짜', type: 'date' },
          { name: 'orderNo', label: '주문차수' },
          { name: 'machine', label: '호기', type: 'select', master: 'machines' },
          { name: 'checker', label: '확인자', list: 'dl-workers' },
          { name: 'workSupport', label: '지지체 작업자', list: 'dl-workers' },
          { name: 'workCover', label: '커버 실링작업자(초음파)', list: 'dl-workers' },
          { name: 'workPouch', label: '파우치 실링작업자', list: 'dl-workers' },
          { name: 'workStd', label: '작업표준서 참조' },
        ] },
        { type: 'note', text: '※ 온도 및 습도는 매일 10:30, 15:30에 측정하여 기록' },
        { type: 'matrix', title: '챔버 온·습도 (측정시간별)', group: 'hchamber',
          rows: [{ key: 't1030', label: '10:30' }, { key: 't1530', label: '15:30' }],
          cols: [{ key: 'c1t', label: '챔버1 온도' }, { key: 'c1h', label: '챔버1 습도' }, { key: 'c2t', label: '챔버2 온도' }, { key: 'c2h', label: '챔버2 습도' }, { key: 'c3t', label: '챔버3 온도' }, { key: 'c3h', label: '챔버3 습도' }] },
        { type: 'grid', title: '저압제습기 상태', fields: [
          { name: 'dehum1AM', label: '저압제습기1 오전' },
          { name: 'dehum1PM', label: '저압제습기1 오후' },
          { name: 'dehum2AM', label: '저압제습기2 오전' },
          { name: 'dehum2PM', label: '저압제습기2 오후' },
        ] },
      ] },
      { id: 'prep', label: '② 설비·작업 점검', blocks: [
        { type: 'hybridCheck' },
      ] },
      { id: 'during', label: '③ 생산기록 ★', blocks: [
        { type: 'grid', title: '생산 정보', fields: [
          { name: 'product', label: '생산품목명', list: 'dl-products' },
          { name: 'totalQty', label: '생산 총수량(개) — 미입력 시 시간대 합계', type: 'number' },
          { name: 'labelLot', label: '라벨 LOT NO' },
          { name: 'labelExp', label: '라벨 EXP NO' },
        ] },
        { type: 'hybridTimes' },
        { type: 'grid', title: '부가 정보', fields: [
          { name: 'nnsUse', label: 'NNS-N 사용량' },
          { name: 'semiLot', label: '반제품 LOT' },
          { name: 'avgWeight', label: '평균무게', type: 'number', step: '0.1' },
          { name: 'zipWeight', label: '지퍼백 무게', type: 'number', step: '0.1' },
        ] },
        { type: 'grid', title: '특이사항', fields: [{ name: 'remarks', label: '특이사항', type: 'textarea' }] },
      ] },
      { id: 'finish', label: '④ 생산종료', blocks: [
        { type: 'hybridSummary' },
        { type: 'startstop', which: 'end' },
      ] },
    ],
  },
};

/* HYBRID 설비·작업 점검 항목 (고정) · 시간대별 생산 (고정) */
const HYBRID_CHECKS = [
  { key: 'ck1', item: '컷팅칼날 목형 및 밑판 상태', method: '육안검사', std: '수지 및 이물질이 없을 것' },
  { key: 'ck2', item: '초음파 설비의 압력상태', method: '게이지 확인', std: '0.5 ~ 0.6 Mpa' },
  { key: 'ck3', item: 'check 버튼 확인', method: '게이지 확인', std: '3 V 이하' },
  { key: 'ck4', item: '실링기 최고 속도', method: '설정상태 확인', std: '스위치 지정 위치' },
  { key: 'ck5', item: '실링기 온도 체크', method: '설정상태 기록', std: '실링기 온도 체크' },
  { key: 'ck6', item: '파우치 실링상태', method: '파우치 버블 테스트', std: '기포 나오지 않을 것' },
  { key: 'ck7', item: '제품 외관 확인', method: '육안검사', std: '오염 및 이물질이 없을 것' },
];
const HYBRID_TIMES = [
  { key: 'a', label: 'A time (08:30 ~ 10:30)' },
  { key: 'b', label: 'B time (10:40 ~ 12:00)' },
  { key: 'c', label: 'C time (13:00 ~ 15:00)' },
  { key: 'd', label: 'D time (15:10 ~ 17:30)' },
  { key: 'e', label: 'E time (18:00 ~ 21:00)' },
];

let WS = null, wsPart = 'CAST', wsForm = 'CAST', wsTab = 'basic', wsIsNew = false, wsSaveTimer = null, wsOrigRecordIds = [], wsCanEdit = true;

/* --- 블록 렌더링 --- */
function wsFieldHtml(f) {
  const v = WS[f.name] ?? '';
  if (f.type === 'textarea') {
    return `<label class="wide">${esc(f.label)}<textarea class="ws-textarea" data-grid="${f.name}" rows="4">${esc(v)}</textarea></label>`;
  }
  if (f.type === 'select') {
    const opts = (MASTERS[f.master] || []).map((o) => `<option ${String(o) === String(v) ? 'selected' : ''}>${esc(o)}</option>`).join('');
    return `<label>${esc(f.label)}<select data-grid="${f.name}"><option value="">선택</option>${opts}</select></label>`;
  }
  return `<label>${esc(f.label)}<input type="${f.type || 'text'}" ${f.step ? `step="${f.step}"` : ''} data-grid="${f.name}" ${f.list ? `list="${f.list}"` : ''} value="${esc(v)}"></label>`;
}
/* 기본정보(제품) / 수지정보(수지명)와 연동되는 표.
   표시열(display)은 source 항목에서 읽기전용, 편집열(edit)만 store에 key(제품명/수지명) 기준으로 저장 */
function linkedTableHtml(o) {
  const keyField = o.source === 'resins' ? 'name' : 'product';
  const src = (WS[o.source] || []).filter((r) => r[keyField]);
  const data = WS[o.store] || [];
  const head = `<tr>${o.display.map((d) => `<th>${esc(d.label)}</th>`).join('')}${o.edit.map((f) => `<th class="num">${esc(f.label)}</th>`).join('')}</tr>`;
  const body = src.length ? src.map((r) => {
    const k = r[keyField];
    const d = data.find((x) => x.key === k) || {};
    const disp = o.display.map((c, i) => `<td>${i === 0 ? `<b>${esc(r[c.key] ?? '')}</b>` : esc(r[c.key] ?? '')}</td>`).join('');
    const edit = o.edit.map((f) => {
      if (f.type === 'checkbox') return `<td class="num"><input type="checkbox" data-lk="${f.key}" ${d[f.key] ? 'checked' : ''}></td>`;
      return `<td><input type="${f.type || 'number'}" ${f.step ? `step="${f.step}"` : ''} data-lk="${f.key}" value="${esc(d[f.key] ?? '')}"></td>`;
    }).join('');
    return `<tr data-lp-key="${esc(k)}">${disp}${edit}</tr>`;
  }).join('') : `<tr class="no-click"><td colspan="${o.display.length + o.edit.length}" class="empty" style="padding:18px">${esc(o.empty || '먼저 등록하세요.')}</td></tr>`;
  return `<div class="ws-block"><h4>${esc(o.title)} <span class="auto-tag">${esc(o.note || '')}</span></h4>
    <div class="table-wrap"><table class="input-table linked" data-linked-store="${o.store}">${head}${body}</table></div>${o.live || ''}</div>`;
}

function wsBlockHtml(b) {
  if (b.type === 'startstop') {
    if (b.which === 'start') {
      return `<div class="ws-bigbtn-wrap">
        <button type="button" class="ws-bigbtn start" id="ws-start">▶ 생산시작</button>
        <div class="ws-time-disp">시작시간 <b>${esc(WS.startTime || '미기록')}</b></div></div>`;
    }
    return `<div class="ws-bigbtn-wrap">
      <button type="button" class="ws-bigbtn end" id="ws-end">■ 생산종료 (시간 기록)</button>
      <div class="ws-time-disp">종료시간 <b>${esc(WS.endTime || '미기록')}</b></div>
      <button type="button" class="btn primary ws-finish" id="ws-finish">✔ 공정일지 완료 · 생산실적 반영</button></div>`;
  }
  if (b.type === 'note') return `<div class="ws-note">${esc(b.text)}</div>`;
  if (b.type === 'grid') {
    return `<div class="ws-block">${b.title ? `<h4>${esc(b.title)}</h4>` : ''}<div class="form-grid">${b.fields.map(wsFieldHtml).join('')}</div></div>`;
  }
  if (b.type === 'checks') {
    return `<div class="ws-block"><h4>${esc(b.title)}</h4><div class="chk-row">${b.items.map((it) => `<label><input type="checkbox" data-check="${it.name}" ${WS[it.name] ? 'checked' : ''}>${esc(it.label)}</label>`).join('')}</div></div>`;
  }
  if (b.type === 'matrix') {
    const head = `<tr><th></th>${b.cols.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr>`;
    const body = b.rows.map((r) => `<tr><td class="mx-row">${esc(r.label)}</td>${b.cols.map((c) => {
      const v = getByPath(WS[b.group] || {}, `${r.key}.${c.key}`) ?? '';
      return `<td><input data-matrix="${b.group}.${r.key}.${c.key}" value="${esc(v)}"></td>`;
    }).join('')}</tr>`).join('');
    return `<div class="ws-block"><h4>${esc(b.title)}</h4><div class="table-wrap"><table class="input-table">${head}${body}</table></div></div>`;
  }
  if (b.type === 'rows') {
    const min = b.minRows ? ` data-rows-min="${b.minRows}"` : '';
    const addLabel = b.kind === 'sresin' ? '＋ 원료 추가'
      : (b.kind === 'cbaseloss' || b.kind === 'pcbase') ? '＋ 기재 추가'
      : (b.kind === 'sloss' || b.kind === 'pinfo' || b.kind === 'cpinfo') ? '＋ 제품 추가'
      : '＋ 행 추가';
    return `<div class="ws-block"><h4>${esc(b.title)}</h4>
      <div class="dyn-rows" data-rows-store="${b.store}" data-rows-kind="${b.kind}"${min}></div>
      <button type="button" class="btn small" data-add-rows data-kind="${b.kind}" data-store="${b.store}">${addLabel}</button></div>`;
  }
  if (b.type === 'lines') {
    return `<div class="ws-block"><h4>${esc(b.title)} <span class="auto-tag">저장 시 생산실적에 자동 반영</span></h4>
      <div class="dyn-rows" data-rows-store="${b.store}" data-rows-kind="${b.kind}"></div>
      <div class="ws-block-actions">
        <button type="button" class="btn small" data-add-rows data-kind="${b.kind}" data-store="${b.store}">＋ 라인 추가</button>
        <button type="button" class="btn small" id="ws-load-plan">🗓 생산계획 불러오기</button></div></div>`;
  }
  if (b.type === 'splintProducts') {
    return `<div class="ws-block ws-prod"><h4>제품별 생산실적 <span class="auto-tag">제품명 · ROLL 생산량 · PRECUT 생산량 · 비고</span></h4>
      <div class="dyn-rows" data-rows-store="products" data-rows-kind="sprod" data-rows-min="1"></div>
      <button type="button" class="btn small" data-add-rows data-kind="sprod" data-store="products">＋ 제품 추가</button></div>`;
  }
  if (b.type === 'splintSummary') {
    return `<div class="ws-block ws-summary-block"><h4>제품별 생산실적</h4><div id="ws-prod-list"></div></div>`;
  }
  if (b.type === 'pcProducts') {
    return `<div class="ws-block ws-prod"><h4>생산 수량 <span class="auto-tag">제품종류 · Roll Splint Type · 생산LOT · 생산수량 · 사용설명서 · 내수/수출</span></h4>
      <div class="dyn-rows" data-rows-store="pcProducts" data-rows-kind="pcprod" data-rows-min="1"></div>
      <button type="button" class="btn small" data-add-rows data-kind="pcprod" data-store="pcProducts">＋ 제품 추가</button>
      <div class="qty-live">총 생산량 <b data-live="pcTotal" class="big">0</b></div></div>`;
  }
  if (b.type === 'pcSummary') {
    return `<div class="ws-block ws-summary-block"><h4>생산종료 자동 집계</h4><div id="ws-pc-summary"></div></div>`;
  }
  if (b.type === 'hybridCheck') {
    const c = WS.hchecks || {};
    const rows = HYBRID_CHECKS.map((x) => {
      const cur = (c[x.key] || {}).result || '';
      const opt = (o) => `<option ${o === cur ? 'selected' : ''}>${o}</option>`;
      return `<tr><td class="mx-row" style="text-align:left">${esc(x.item)}</td><td>${esc(x.method)}</td><td>${esc(x.std)}</td>
        <td><select data-matrix="hchecks.${x.key}.result"><option value="">-</option>${opt('OK')}${opt('NG')}</select></td></tr>`;
    }).join('');
    return `<div class="ws-block"><h4>설비·작업 점검 <span class="auto-tag">판정 OK / NG</span></h4>
      <div class="table-wrap"><table class="input-table"><tr><th>체크항목</th><th>체크방법</th><th>판정기준</th><th>판정</th></tr>${rows}</table></div></div>`;
  }
  if (b.type === 'hybridTimes') {
    const t = WS.htimes || {};
    const rows = HYBRID_TIMES.map((r) => {
      const v = t[r.key] || {};
      return `<tr><td class="mx-row" style="text-align:left">${esc(r.label)}</td>
        <td><input type="number" data-matrix="htimes.${r.key}.qty" value="${esc(v.qty ?? '')}"></td>
        <td class="num" data-cum="${r.key}">-</td>
        <td><input data-matrix="htimes.${r.key}.note" value="${esc(v.note ?? '')}"></td></tr>`;
    }).join('');
    return `<div class="ws-block ws-prod"><h4>생산 시간대별 수량 <span class="auto-tag">생산누계수량 자동 계산</span></h4>
      <div class="table-wrap"><table class="input-table"><tr><th>항목</th><th>생산수량</th><th>생산누계수량</th><th>비고</th></tr>${rows}
      <tr class="prod-total"><td><b>생산 총수량</b></td><td class="num"><b data-live="htTotal">0</b> 개</td><td></td><td></td></tr></table></div></div>`;
  }
  if (b.type === 'hybridSummary') {
    return `<div class="ws-block ws-summary-block"><h4>생산종료 자동 집계</h4><div id="ws-hybrid-summary"></div></div>`;
  }
  if (b.type === 'castResults') {
    return linkedTableHtml({
      store: 'products', source: 'productInfos', title: '제품별 생산실적',
      note: '제품·업체·인치·색상은 기본정보 연동', empty: '기본정보 탭에서 생산 제품을 먼저 등록하세요.',
      display: [{ key: 'product', label: '제품명' }, { key: 'customer', label: '업체명' }, { key: 'size', label: '인치' }, { key: 'color', label: '색상' }],
      edit: [
        { key: 'length', label: '길이', step: '0.1' }, { key: 'planQty', label: '계획수량' },
        { key: 'prodQty', label: '생산량' }, { key: 'remainQty', label: '잔량' },
        { key: 'pouchExtra', label: '파우치(추가량)' }, { key: 'loss', label: '제품별 총로스량' },
      ],
      live: '<div class="qty-live">총 로스량 <b data-live="totLoss" class="big">0</b></div>',
    });
  }
  if (b.type === 'castQcProducts') {
    return linkedTableHtml({
      store: 'qcProducts', source: 'productInfos', title: '생산제품별 품질확인',
      note: '제품·업체·인치는 기본정보 연동', empty: '기본정보 탭에서 생산 제품을 먼저 등록하세요.',
      display: [{ key: 'product', label: '제품명' }, { key: 'customer', label: '업체명' }, { key: 'size', label: '인치' }],
      edit: [{ key: 'coating', label: '코팅량', step: '0.01' }, { key: 'weight', label: '무게', step: '0.1' }],
    });
  }
  if (b.type === 'castFoam') {
    return linkedTableHtml({
      store: 'foamChecks', source: 'resins', title: '수지명별 발포확인',
      note: '수지명은 생산중 기록의 수지 정보 연동', empty: '생산중 기록 탭에서 수지 정보를 먼저 입력하세요.',
      display: [{ key: 'name', label: '수지명' }],
      edit: [{ key: 'foam', label: '발포확인', type: 'checkbox' }, { key: 'foamTime', label: '발포확인 시간', type: 'time' }],
    });
  }
  if (b.type === 'orderLinks') {
    return `<div class="ws-block"><h4>제품별 작업지시서 <span class="auto-tag">기본정보 제품 연동 · 제품표준서 기준</span></h4><div id="ws-order-links"></div></div>`;
  }
  if (b.type === 'startcheck') {
    return `<div class="ws-block"><h4>생산 시작 점검 — 라벨 · LOT <span class="auto-tag">기준 사양 대조 · LOT 자동확인</span></h4>
      <div id="ws-startcheck-summary"></div>
      <button type="button" class="btn small primary" id="btn-startcheck" style="margin-top:8px">📷 라벨·LOT 점검 열기</button></div>`;
  }
  if (b.type === 'castSummary') {
    return `<div class="ws-block ws-summary-block"><h4>생산종료 자동 집계</h4><div id="ws-cast-summary"></div></div>`;
  }
  if (b.type === 'splintDetector') {
    const chk = (n, l) => `<label><input type="checkbox" data-check="${n}" ${WS[n] ? 'checked' : ''}>${esc(l)}</label>`;
    return `<div class="ws-block"><h4>금속/기재 탐지기 확인</h4>
      <div class="form-grid" style="margin-bottom:8px">
        <label>탐지 시간<input type="time" data-grid="detectTime" value="${esc(WS.detectTime || '')}"></label>
        <label>확인자1<input list="dl-workers" data-grid="detectChk1" value="${esc(WS.detectChk1 || '')}"></label>
        <label>확인자2<input list="dl-workers" data-grid="detectChk2" value="${esc(WS.detectChk2 || '')}"></label>
      </div>
      <div class="chk-row"><span class="chk-title">감지테스트</span>${chk('dtJochul', '조출')}${chk('dtAM', '오전')}${chk('dtPM', '오후')}${chk('dtEve', '저녁')}</div>
      <div class="chk-row"><span class="chk-title">세팅</span>${chk('setAMneutral', '오전 중성')}${chk('setAM80', '오전 강도80')}${chk('setPMneutral', '오후 중성')}${chk('setPM80', '오후 강도80')}</div>
      <div class="chk-row"><span class="chk-title">이상유무</span>${chk('abnormal', '이상 있음')}<input data-grid="abnormalNote" value="${esc(WS.abnormalNote || '')}" placeholder="이상 내용" style="flex:1;min-width:160px"></div></div>`;
  }
  return '';
}
/* 제품별 생산실적 + 작업로스 집계 (제품명으로 매칭, 기본정보 등록 제품 포함) */
function splintAgg() {
  const infos = (WS.productInfos || []).filter((p) => p.product || p.lotNo || p.customer);
  const prods = (WS.products || []).filter((p) => p.product || p.rollQty != null || p.precutQty != null);
  const losses = (WS.losses || []).filter((l) => l.product || LOSS_CATS.some((k) => l[k] != null));
  const lossByProd = {};
  losses.forEach((l) => { const k = l.product || '(미지정)'; lossByProd[k] = (lossByProd[k] || 0) + rowLoss(l); });
  const totLoss = losses.reduce((a, l) => a + rowLoss(l), 0);
  // 제품 union (기본정보 등록 + 생산 + 로스)
  const names = [];
  const addName = (n) => { if (!names.includes(n)) names.push(n); };
  infos.forEach((p) => addName(p.product || '(미지정)'));
  prods.forEach((p) => addName(p.product || '(미지정)'));
  Object.keys(lossByProd).forEach(addName);
  const rows = names.map((n) => {
    const p = prods.find((x) => (x.product || '(미지정)') === n) || {};
    return { product: n, rollQty: num(p.rollQty), precutQty: num(p.precutQty), loss: lossByProd[n] || 0 };
  });
  return { infos, prods, losses, lossByProd, totLoss, rows };
}

/* PRE-CUT 생산 수량 집계 (생산 수량 표 기준) */
function precutAgg() {
  const prods = (WS.pcProducts || []).filter((p) => p.product || p.prodQty != null || p.lotNo);
  const bases = (WS.baseUse || []).filter((b) => b.baseType || b.lotNo || b.used != null || b.coating != null || b.waste != null);
  const total = prods.reduce((a, p) => a + num(p.prodQty), 0);
  return { prods, bases, total };
}

/* CAST 제품별 생산실적 집계 (기본정보 제품 + 생산실적 연동, key=제품명) */
function castAgg() {
  const infos = (WS.productInfos || []).filter((p) => p.product);
  const prods = WS.products || [];
  const rows = infos.map((info) => {
    const p = prods.find((x) => x.key === info.product) || {};
    return { product: info.product, customer: info.customer, size: info.size, color: info.color, prodQty: num(p.prodQty), loss: num(p.loss) };
  });
  const totLoss = rows.reduce((a, r) => a + r.loss, 0);
  return { infos, rows, totLoss };
}

/* 기본정보 제품별 작업지시서 바로보기 목록 */
function updateOrderLinks() {
  const box = $('#ws-order-links');
  if (!box) return;
  const infos = (WS.productInfos || []).filter((p) => p.product);
  box.innerHTML = infos.length
    ? `<table class="prod-table"><thead><tr><th>제품명</th><th>업체명</th><th>색상</th><th>제품표준서</th><th></th></tr></thead><tbody>${infos.map((info) => {
      const s = findStandard({ part: wsPart, product: info.product, color: info.color, customer: info.customer });
      const stCell = s ? `<span class="badge ok">연동됨</span> ${esc(s.product)}` : '<span class="badge bad">표준서 미등록</span>';
      return `<tr class="no-click"><td><b>${esc(info.product)}</b></td><td>${esc(info.customer || '')}</td><td>${esc(info.color || '')}</td><td>${stCell}</td><td><button type="button" class="btn small primary ws-order-btn" data-product="${esc(info.product)}">🖨 작업지시서 보기</button></td></tr>`;
    }).join('')}</tbody></table>`
    : '<div class="empty">기본정보에 생산 제품을 등록하면 제품별 작업지시서가 연동됩니다.</div>';
}

/* ===================== 생산 시작 점검 (라벨·LOT 대조) ===================== */
function scLotResult(info, lotRead) {
  const expected = String(info.lotNo || '').trim();
  const read = String(lotRead || '').trim();
  if (!read) return '<span class="muted">라벨 LOT 입력 대기</span>';
  const parts = [];
  if (expected) parts.push(read.toUpperCase() === expected.toUpperCase()
    ? '<span class="badge ok">일지 LOT 일치</span>'
    : `<span class="badge bad">일지 LOT 불일치</span> <span class="muted">일지: ${esc(expected)}</span>`);
  else parts.push('<span class="badge warn">일지에 LOT 미기재</span>');
  const dateCode = String(WS && WS.date || '').replace(/-/g, '').slice(2); // YYMMDD
  if (dateCode) parts.push(read.includes(dateCode)
    ? `<span class="badge ok">생산일(${dateCode}) 포함</span>`
    : `<span class="badge warn">생산일(${dateCode}) 미포함</span>`);
  return parts.join(' ');
}

function updateStartCheck() {
  const box = $('#ws-startcheck-summary');
  if (!box || !WS) return;
  const infos = (WS.productInfos || []).filter((p) => p.product);
  if (!infos.length) { box.innerHTML = '<div class="empty">기본정보에 제품을 등록하면 라벨·LOT 점검을 할 수 있습니다.</div>'; return; }
  const sc = WS.startChecks || {};
  box.innerHTML = `<table class="prod-table"><thead><tr><th>제품</th><th>라벨 대조</th><th>LOT 확인</th></tr></thead><tbody>${infos.map((info) => {
    const c = sc[info.product] || {};
    const label = c.labelOk ? '<span class="badge ok">확인</span>' : '<span class="badge plain">미확인</span>';
    const expected = String(info.lotNo || '').trim();
    let lot;
    if (!c.lotRead) lot = '<span class="badge plain">미입력</span>';
    else if (expected && String(c.lotRead).toUpperCase() === expected.toUpperCase()) lot = '<span class="badge ok">일치</span>';
    else lot = '<span class="badge bad">불일치</span>';
    return `<tr class="no-click"><td><b>${esc(info.product)}</b> ${esc(info.color || '')}</td><td>${label}</td><td>${lot}</td></tr>`;
  }).join('')}</tbody></table>`;
}

function openStartCheckModal() {
  if (!WS) return;
  const infos = (WS.productInfos || []).filter((p) => p.product);
  const body = $('#startcheck-body');
  if (!infos.length) {
    body.innerHTML = '<div class="empty">먼저 기본정보에 생산 제품을 등록하세요.</div>';
  } else {
    WS.startChecks = WS.startChecks || {};
    body.innerHTML = infos.map((info) => {
      const cs = findCustSpec({ part: wsPart, product: info.product, color: info.color, customer: info.customer });
      const ref = (cs && cs.images) || {};
      const type = customerSpecType(info.customer);
      const c = WS.startChecks[info.product] || {};
      return `<div class="sc-row" data-product="${esc(info.product)}">
        <div class="sc-title"><b>${esc(info.product)}</b> ${esc(info.color || '')} · ${esc(info.customer || '내수')} ${specBadge(type)}${cs ? '' : ' <span class="badge bad">사양 미등록</span>'}</div>
        <div class="sc-photos">
          <div class="sc-ref">
            <div class="photo-head">기준 라벨(사양)</div>
            <div class="photo-box">${ref.pouch ? `<img src="${esc(ref.pouch)}">` : '<span class="photo-empty">기준 사진 미등록</span>'}</div>
          </div>
          <div class="photo-slot" data-img="cap">
            <div class="photo-head">📷 현장 촬영 (라벨/LOT 실링)</div>
            <div class="photo-box"><img hidden><span class="photo-empty">사진 없음</span></div>
            <div class="photo-btns"><button type="button" class="btn small photo-pick">촬영/선택</button><button type="button" class="btn small danger photo-del" hidden>삭제</button></div>
            <input type="file" accept="image/*" capture="environment" hidden>
          </div>
        </div>
        <label class="sc-ok"><input type="checkbox" data-sc-ok ${c.labelOk ? 'checked' : ''}> 기준 라벨과 일치함을 확인</label>
        <div class="sc-lot">
          <span>LOT(일지 기재): <b>${esc(info.lotNo || '(미기재)')}</b></span>
          <label>라벨 LOT 입력<input type="text" data-sc-lot value="${esc(c.lotRead || '')}" placeholder="라벨에 인쇄된 LOT"></label>
          <div class="sc-lot-result">${scLotResult(info, c.lotRead)}</div>
        </div>
      </div>`;
    }).join('');
    $$('#startcheck-body .photo-slot').forEach(initPhotoSlot);
    $$('#startcheck-body .sc-row').forEach((row) => {
      const c = WS.startChecks[row.dataset.product] || {};
      const slot = row.querySelector('.photo-slot');
      if (slot) slot._setUrl(c.photo || '');
    });
  }
  $('#startcheck-modal').hidden = false;
}
$('#startcheck-body').addEventListener('input', (e) => {
  const lotInput = e.target.closest('[data-sc-lot]');
  if (!lotInput || !WS) return;
  const row = e.target.closest('.sc-row');
  const info = (WS.productInfos || []).find((p) => p.product === row.dataset.product) || {};
  row.querySelector('.sc-lot-result').innerHTML = scLotResult(info, lotInput.value);
});
$('#startcheck-save').addEventListener('click', () => {
  if (!WS) return;
  WS.startChecks = WS.startChecks || {};
  $$('#startcheck-body .sc-row').forEach((row) => {
    const slot = row.querySelector('.photo-slot');
    WS.startChecks[row.dataset.product] = {
      labelOk: !!row.querySelector('[data-sc-ok]').checked,
      lotRead: (row.querySelector('[data-sc-lot]').value || '').trim(),
      photo: slot ? (slot.dataset.url || '') : '',
    };
  });
  saveWsNow();
  $('#startcheck-modal').hidden = true;
  updateStartCheck();
});
$('#startcheck-close').addEventListener('click', () => ($('#startcheck-modal').hidden = true));
$('#startcheck-cancel').addEventListener('click', () => ($('#startcheck-modal').hidden = true));
document.addEventListener('click', (e) => { if (e.target.closest('#btn-startcheck')) openStartCheckModal(); });

function updateSplintLive() {
  updateOrderLinks();
  updateStartCheck();
  const set = (k, v) => { const el = $(`#ws-panel [data-live="${k}"]`); if (el) el.textContent = v; };
  if (wsForm === 'PRE-CUT') {
    const ag = precutAgg();
    set('pcTotal', fmt(ag.total));
    const box = $('#ws-pc-summary');
    if (box) {
      const prodTbl = ag.prods.length
        ? `<table class="prod-table big"><thead><tr><th>제품종류(코드)</th><th>Roll Splint Type</th><th>생산 LOT</th><th class="num">생산수량</th><th>내수/수출</th></tr></thead><tbody>${ag.prods.map((p) => `<tr><td><b>${esc(p.product || '-')}</b></td><td>${esc(p.rollType || '')}</td><td>${esc(p.lotNo || '')}</td><td class="num roll">${fmt(p.prodQty)}</td><td>${esc(p.market || '')}</td></tr>`).join('')}<tr class="prod-total"><td colspan="3"><b>총 생산량</b></td><td class="num"><b>${fmt(ag.total)}</b></td><td></td></tr></tbody></table>`
        : '<div class="empty">생산 수량 탭에서 제품을 추가하세요.</div>';
      const baseTbl = ag.bases.length
        ? `<h4 style="margin-top:14px">기재사용 내용</h4><table class="prod-table"><thead><tr><th>기재종류</th><th>LOT</th><th class="num">사용량</th><th class="num">코팅량</th><th class="num">폐기량</th></tr></thead><tbody>${ag.bases.map((x) => `<tr><td>${esc(x.baseType || '-')}</td><td>${esc(x.lotNo || '')}</td><td class="num">${fmt(x.used)}</td><td class="num">${fmt(x.coating, 2)}</td><td class="num">${fmt(x.waste)}</td></tr>`).join('')}</tbody></table>`
        : '';
      const bt = (WS.bubbleTests || []).filter((x) => x.time || x.checker);
      const btTbl = bt.length
        ? `<h4 style="margin-top:14px">기포테스트 확인</h4><table class="prod-table"><thead><tr><th>시간</th><th>담당</th></tr></thead><tbody>${bt.map((x) => `<tr><td>${esc(x.time || '')}</td><td>${esc(x.checker || '')}</td></tr>`).join('')}</tbody></table>`
        : '';
      box.innerHTML = prodTbl + baseTbl + btTbl;
    }
    return;
  }
  if (wsForm === 'HYBRID') {
    const t = WS.htimes || {};
    let cum = 0;
    HYBRID_TIMES.forEach((r) => {
      cum += num((t[r.key] || {}).qty);
      const el = $(`#ws-panel [data-cum="${r.key}"]`);
      if (el) el.textContent = ((t[r.key] || {}).qty == null || (t[r.key] || {}).qty === '') ? '-' : fmt(cum);
    });
    const total = cum || num(WS.totalQty);
    set('htTotal', fmt(total));
    const box = $('#ws-hybrid-summary');
    if (box) {
      const c = WS.hchecks || {};
      const ng = HYBRID_CHECKS.filter((x) => (c[x.key] || {}).result === 'NG');
      const done = HYBRID_CHECKS.filter((x) => (c[x.key] || {}).result).length;
      const timeTbl = `<table class="prod-table big"><thead><tr><th>항목</th><th class="num">생산수량</th><th class="num">누계</th><th>비고</th></tr></thead><tbody>${(() => {
        let acc = 0;
        return HYBRID_TIMES.map((r) => {
          const v = t[r.key] || {};
          acc += num(v.qty);
          return `<tr><td>${esc(r.label)}</td><td class="num roll">${fmt(v.qty)}</td><td class="num">${v.qty == null || v.qty === '' ? '-' : fmt(acc)}</td><td>${esc(v.note || '')}</td></tr>`;
        }).join('');
      })()}<tr class="prod-total"><td><b>생산 총수량</b></td><td class="num"><b>${fmt(total)}</b> 개</td><td colspan="2"></td></tr></tbody></table>`;
      const info = `<div class="ws-note" style="margin-top:10px">품목: <b>${esc(WS.product || '-')}</b> · 라벨 LOT: ${esc(WS.labelLot || '-')} · EXP: ${esc(WS.labelExp || '-')} · 평균무게: ${esc(WS.avgWeight ?? '-')} · 반제품 LOT: ${esc(WS.semiLot || '-')}</div>`;
      const chkState = ng.length
        ? `<b style="color:#e03131">NG ${ng.length}건</b> (${ng.map((x) => esc(x.item)).join(', ')})`
        : done === HYBRID_CHECKS.length
          ? '<b style="color:#2f9e44">전 항목 이상 없음</b>'
          : `<b style="color:#e8590c">미판정 ${HYBRID_CHECKS.length - done}건</b>`;
      const chk = `<div class="ws-note" style="margin-top:10px">설비·작업 점검: ${done}/${HYBRID_CHECKS.length} 판정 · ${chkState}</div>`;
      box.innerHTML = timeTbl + info + chk;
    }
    return;
  }
  if (wsPart === 'SPLINT') {
    const ag = splintAgg();
    set('totLoss', fmt(ag.totLoss));
    // 제품별 생산실적 행의 '총로스량'(읽기전용)에 해당 제품 작업로스 합계 자동 반영
    const pcont = $('#ws-panel [data-rows-store="products"]');
    if (pcont) pcont.querySelectorAll('.dyn-row').forEach((row) => {
      const pn = (row.querySelector('[data-key="product"]') || {}).value || '';
      const lt = row.querySelector('[data-key="lossTotal"]');
      if (lt) lt.value = fmt(ag.lossByProd[pn] || 0);
    });
    const list = $('#ws-prod-list');
    if (list) {
      list.innerHTML = ag.rows.length
        ? `<table class="prod-table big"><thead><tr><th>제품명</th><th class="num">ROLL 생산량</th><th class="num">PRECUT 생산량</th><th class="num">총 로스량</th></tr></thead><tbody>${ag.rows.map((r) => `<tr><td><b>${esc(r.product)}</b></td><td class="num roll">${fmt(r.rollQty)}</td><td class="num precut">${fmt(r.precutQty)}</td><td class="num loss">${fmt(r.loss)}</td></tr>`).join('')}<tr class="prod-total"><td><b>합계</b></td><td class="num"><b>${fmt(ag.rows.reduce((a, r) => a + r.rollQty, 0))}</b></td><td class="num"><b>${fmt(ag.rows.reduce((a, r) => a + r.precutQty, 0))}</b></td><td class="num"><b>${fmt(ag.totLoss)}</b></td></tr></tbody></table>`
        : '<div class="empty">생산중 기록 탭에서 제품을 추가하세요.</div>';
    }
    return;
  }
  if (wsPart === 'CAST') {
    const ag = castAgg();
    set('totLoss', fmt(ag.totLoss));
    const box = $('#ws-cast-summary');
    if (box) {
      const prodTbl = ag.rows.length
        ? `<table class="prod-table big"><thead><tr><th>제품명</th><th>업체명</th><th class="num">인치</th><th>색상</th><th class="num">생산량</th><th class="num">제품별 총로스량</th></tr></thead><tbody>${ag.rows.map((p) => `<tr><td><b>${esc(p.product || '-')}</b></td><td>${esc(p.customer || '')}</td><td class="num">${esc(p.size ?? '')}</td><td>${esc(p.color || '')}</td><td class="num roll">${fmt(p.prodQty)}</td><td class="num loss">${fmt(p.loss)}</td></tr>`).join('')}<tr class="prod-total"><td colspan="4"><b>합계</b></td><td class="num"><b>${fmt(ag.rows.reduce((a, p) => a + p.prodQty, 0))}</b></td><td class="num"><b>${fmt(ag.totLoss)}</b></td></tr></tbody></table>`
        : '<div class="empty">기본정보 탭에서 생산 제품을 등록하세요.</div>';
      const bc = (WS.baseChanges || []).filter((x) => x.baseType || x.time || x.note);
      const bcTbl = bc.length ? `<h4 style="margin-top:14px">기재 교체 이력</h4><table class="prod-table"><thead><tr><th>기재종류</th><th>시간</th><th>비고</th></tr></thead><tbody>${bc.map((x) => `<tr><td>${esc(x.baseType || '')}</td><td>${esc(x.time || '')}</td><td>${esc(x.note || '')}</td></tr>`).join('')}</tbody></table>` : '';
      const bl = (WS.baseLoss || []).filter((x) => x.baseType || x.joint != null || x.knot != null || x.defect != null);
      const blTbl = bl.length ? `<h4 style="margin-top:14px">기재 로스 (기재종류별)</h4><table class="prod-table"><thead><tr><th>기재종류</th><th class="num">이음매</th><th class="num">매듭</th><th class="num">불량</th></tr></thead><tbody>${bl.map((x) => `<tr><td>${esc(x.baseType || '-')}</td><td class="num">${fmt(x.joint)}</td><td class="num">${fmt(x.knot)}</td><td class="num">${fmt(x.defect)}</td></tr>`).join('')}<tr class="prod-total"><td><b>합계</b></td><td class="num"><b>${fmt(bl.reduce((a, x) => a + num(x.joint), 0))}</b></td><td class="num"><b>${fmt(bl.reduce((a, x) => a + num(x.knot), 0))}</b></td><td class="num"><b>${fmt(bl.reduce((a, x) => a + num(x.defect), 0))}</b></td></tr></tbody></table>` : '';
      const ck = (v) => v ? '✔' : '';
      const bt = (WS.bubbleTests || []).filter((x) => x.time || x.checker || x.sealTape || x.temp || x.pressure || x.heaterGap);
      const btTbl = bt.length ? `<h4 style="margin-top:14px">기포테스트 · 실링기 점검 (실링기 번호 ${esc(WS.sealerNo || '-')})</h4><table class="prod-table"><thead><tr><th>시간</th><th>확인자</th><th>실링테이프</th><th>온도</th><th>압력</th><th>히터공 간격</th></tr></thead><tbody>${bt.map((x) => `<tr><td>${esc(x.time || '')}</td><td>${esc(x.checker || '')}</td><td class="num">${ck(x.sealTape)}</td><td class="num">${ck(x.temp)}</td><td class="num">${ck(x.pressure)}</td><td class="num">${ck(x.heaterGap)}</td></tr>`).join('')}</tbody></table>` : '';
      const rs = (WS.resins || []).filter((x) => x.name || x.color || x.catalyst || x.no || x.weight);
      const resin = rs.length
        ? `<h4 style="margin-top:14px">수지 정보</h4><table class="prod-table"><thead><tr><th>수지명</th><th>컬러</th><th>합성일</th><th>배합일</th><th>촉매</th><th>번호</th><th>무게</th></tr></thead><tbody>${rs.map((x) => `<tr><td>${esc(x.name || '-')}</td><td>${esc(x.color || '')}</td><td>${esc(x.synth || '')}</td><td>${esc(x.mix || '')}</td><td>${esc(x.catalyst || '')}</td><td>${esc(x.no || '')}</td><td>${esc(x.weight || '')}</td></tr>`).join('')}</tbody></table>` : '';
      box.innerHTML = prodTbl + bcTbl + blTbl + btTbl + resin;
    }
  }
}

function renderWorkspace() {
  const sc = WS_SCHEMA[wsForm];
  $('#ws-part-badge').textContent = WS.part || wsForm;
  $('#ws-part-badge').className = 'ws-part-badge ' + wsForm.toLowerCase().replace(/[^a-z]/g, '-');
  $('#ws-formno').textContent = sc.formNo;
  $('#ws-tabs').innerHTML = sc.tabs.map((t) => `<button data-tab="${t.id}" class="${t.id === wsTab ? 'active' : ''}">${esc(t.label)}</button>`).join('');
  $('#ws-tabs').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    harvestWs(); scheduleWsSave(); wsTab = b.dataset.tab; renderWorkspace();
  }));
  updateWsChrome();
  renderWsTab();
}
function updateWsChrome() {
  let prodDisp = WS.product || '제품 미정';
  const ps = [...(WS.productInfos || []), ...(WS.pcProducts || [])].map((p) => p.product).filter(Boolean);
  if (ps.length) prodDisp = ps[0] + (ps.length > 1 ? ` 외 ${ps.length - 1}` : '');
  $('#ws-summary').innerHTML = `${esc(WS.date || '')} · ${esc(WS.machine || '호기 미정')} · ${esc(prodDisp)} <span class="muted">${esc(WS.startTime || '')}${WS.endTime ? '~' + esc(WS.endTime) : ''}</span>`;
  const st = WS.status || '작성중';
  $('#ws-status-badge').innerHTML = `<span class="badge ${st === '완료' ? 'ok' : st === '진행' ? 'warn' : 'plain'}">${st}</span>`;
}
function renderWsTab() {
  const tab = (WS_SCHEMA[wsForm].tabs.find((t) => t.id === wsTab) || WS_SCHEMA[wsForm].tabs[0]);
  wsTab = tab.id;
  const panel = $('#ws-panel');
  panel.innerHTML = tab.blocks.map(wsBlockHtml).join('');
  // 동적 행 채우기 (저장된 행이 없고 minRows면 빈 행 1개 표시)
  panel.querySelectorAll('[data-rows-store]').forEach((c) => {
    (WS[c.dataset.rowsStore] || []).forEach((d) => addDynRow(c.dataset.rowsKind, d, c));
    if (c.dataset.rowsMin && !c.children.length) addDynRow(c.dataset.rowsKind, {}, c);
  });
  // 행 추가 버튼 (시간 필드는 현재시간 자동 입력)
  panel.querySelectorAll('[data-add-rows]').forEach((btn) => btn.addEventListener('click', () => {
    const c = panel.querySelector(`[data-rows-store="${btn.dataset.store}"]`);
    const seed = (DYN_DEFS[btn.dataset.kind].fields.some((f) => f.now)) ? { time: nowTime() } : {};
    addDynRow(btn.dataset.kind, seed, c); harvestWs(); scheduleWsSave(); updateSplintLive();
  }));
  const lp = panel.querySelector('#ws-load-plan');
  if (lp) lp.addEventListener('click', wsLoadPlan);
  const startBtn = panel.querySelector('#ws-start');
  if (startBtn) startBtn.addEventListener('click', () => { harvestWs(); WS.startTime = nowTime(); if (!WS.status || WS.status === '작성중') WS.status = '진행'; saveWsNow(); renderWorkspace(); });
  const endBtn = panel.querySelector('#ws-end');
  if (endBtn) endBtn.addEventListener('click', () => { harvestWs(); WS.endTime = nowTime(); saveWsNow(); renderWsTab(); });
  const finishBtn = panel.querySelector('#ws-finish');
  if (finishBtn) { finishBtn.hidden = !wsCanEdit; finishBtn.addEventListener('click', wsFinish); }
  const endBtn2 = panel.querySelector('#ws-end');
  if (endBtn2) endBtn2.hidden = !wsCanEdit;
  const startBtn2 = panel.querySelector('#ws-start');
  if (startBtn2) startBtn2.hidden = !wsCanEdit;
  updateSplintLive();
}

/* --- 입력값 수집 (현재 탭 → WS) --- */
function harvestWs() {
  if (!WS) return;
  const panel = $('#ws-panel');
  panel.querySelectorAll('[data-grid]').forEach((el) => { WS[el.dataset.grid] = el.value || ''; });
  panel.querySelectorAll('[data-matrix]').forEach((el) => setByPath(WS, el.dataset.matrix, el.value || ''));
  panel.querySelectorAll('[data-check]').forEach((el) => { WS[el.dataset.check] = el.checked; });
  panel.querySelectorAll('[data-rows-store]').forEach((c) => { WS[c.dataset.rowsStore] = collectDynRows(c.dataset.rowsKind, c); });
  panel.querySelectorAll('table[data-linked-store]').forEach((tbl) => {
    WS[tbl.dataset.linkedStore] = [...tbl.querySelectorAll('tr[data-lp-key]')].map((tr) => {
      const o = { key: tr.dataset.lpKey };
      tr.querySelectorAll('input[data-lk]').forEach((el) => {
        o[el.dataset.lk] = el.type === 'checkbox' ? el.checked : (el.value === '' ? null : (el.type === 'number' ? Number(el.value) : el.value));
      });
      return o;
    });
  });
  if (wsForm === 'PRE-CUT') WS.writer = [WS.writer1, WS.writer2].filter(Boolean).join('/');
  else if (wsForm === 'HYBRID') WS.writer = [WS.workSupport, WS.workCover, WS.workPouch].filter(Boolean).join('/');
  else if (wsPart === 'SPLINT') WS.writer = [WS.leader, WS.assistant, WS.pack1, WS.pack2].filter(Boolean).join('/');
  else if (wsPart === 'CAST') WS.writer = [WS.writer1, WS.writer2].filter(Boolean).join('/');
}

/* --- 자동저장 --- */
function scheduleWsSave() {
  if (!wsCanEdit) return;   // 조회 전용(권한 없음)
  $('#ws-save-status').textContent = '저장 중…';
  clearTimeout(wsSaveTimer);
  wsSaveTimer = setTimeout(saveWsNow, 700);
}
async function saveWsNow() {
  if (!wsCanEdit) return;   // 조회 전용(권한 없음)
  if (!WS || !WS.id) return;
  clearTimeout(wsSaveTimer);
  try { await post('/api/sheets/' + WS.id, WS, 'PUT'); $('#ws-save-status').textContent = '저장됨 ✓'; }
  catch (e) { $('#ws-save-status').textContent = '저장 실패'; }
}

/* --- 생산계획 불러오기 --- */
function wsLoadPlan() {
  const cont = $('#ws-panel [data-rows-store="lines"]');
  if (!cont) return;
  const kind = cont.dataset.rowsKind;
  if (!WS.date || !WS.machine) return alert('기본정보에서 생산일과 호기를 먼저 입력하세요.');
  const matched = PLANS.filter((p) => (p.part || 'CAST') === wsPart && p.date === WS.date && p.machine === WS.machine);
  if (!matched.length) return alert(`${WS.date} ${WS.machine}의 ${wsPart} 생산계획이 없습니다.`);
  const existing = collectDynRows(kind, cont).map((l) => `${l.product}|${l.orderNo}`);
  let added = 0;
  matched.forEach((p) => {
    if (existing.includes(`${p.product}|${p.orderNo ?? null}`)) return;
    addDynRow(kind, kind === 'sline'
      ? { product: p.product, customer: p.customer, orderNo: p.orderNo ?? '', size: p.length ?? '' }
      : { product: p.product, customer: p.customer, orderNo: p.orderNo ?? '', color: p.color ?? '', length: p.length ?? '', planQty: p.planQty ?? '' }, cont);
    added++;
  });
  if (!added) return alert('이미 모든 계획이 라인에 추가되어 있습니다.');
  harvestWs(); scheduleWsSave();
}

/* --- 열기 / 닫기 / 완료 / 삭제 --- */
async function openWorkspace(part, id = null) {
  wsPart = partBase(part); wsForm = (part === 'PRE-CUT' || part === 'HYBRID') ? part : wsPart; wsTab = 'basic';
  if (id) {
    WS = JSON.parse(JSON.stringify(SHEETS.find((s) => s.id === id)));
    WS.part = part;
    wsIsNew = false;
    wsOrigRecordIds = (WS.lines || []).map((l) => l.recordId).filter(Boolean);
    wsCanEdit = can('update', 'sheets', WS);   // worker는 본인 작성 일지만 수정
    // 구버전 SPLINT 일지 호환: writer만 있고 호기장 비었으면 채움
    if (partBase(part) === 'SPLINT' && !WS.leader && WS.writer) WS.leader = WS.writer;
  } else {
    if (!can('create', 'sheets')) return;   // 신규 작성 권한 없음
    WS = { part, date: todayStr(), status: '작성중', lines: [] };
    const saved = await post('/api/sheets', WS);
    WS.id = saved.id; WS.createdBy = saved.createdBy; wsIsNew = true; wsOrigRecordIds = []; wsCanEdit = true;
  }
  $('#sheet-workspace').hidden = false;
  $('#ws-delete').hidden = !can('delete', 'sheets');   // 일지 삭제는 admin만
  renderWorkspace();
}
function isEmptyWs() {
  return !WS.machine && !WS.writer && !WS.leader && !WS.startTime && !WS.product
    && !(WS.productInfos && WS.productInfos.length) && !(WS.products && WS.products.length)
    && !(WS.pcProducts && WS.pcProducts.length) && !(WS.lines && WS.lines.length);
}
async function saveAndSyncWs() {
  // SPLINT은 제품별 실적 — 각 제품 행이 하나의 생산실적(레코드).
  // 제품별 ROLL/PRECUT 생산량 + 작업로스(제품명으로 매칭한 항목별 합계)
  // PRE-CUT — 생산 수량 표의 각 제품 행이 하나의 생산실적(레코드). 생산수량 → ROLL 생산량으로 반영.
  if (wsForm === 'PRE-CUT') {
    const ag = precutAgg();
    const base0 = ag.bases[0] || {};
    const oldLines = WS.lines || [];
    WS.lines = ag.prods.map((p) => {
      const old = oldLines.find((l) => l.product === (p.product || '(미지정)') && (l.lotNo || null) === (p.lotNo || null)) || {};
      return {
        recordId: old.recordId,
        product: p.product || '(미지정)', rollType: p.rollType || null,
        lotNo: p.lotNo || null, market: p.market || null,
        rollQty: p.prodQty ?? null, precutQty: null,
        baseType: base0.baseType || null,
        loss: null, note: p.note || null, isFirst: true,
      };
    });
  }
  if (wsForm === 'SPLINT') {
    const ag = splintAgg();
    const allW = WS.weights || [];
    WS.lines = ag.rows.map((r) => {
      const p = ag.prods.find((x) => (x.product || '(미지정)') === r.product) || {};
      const info = ag.infos.find((x) => (x.product || '(미지정)') === r.product) || {};
      // 제품무게: 해당 제품으로 태깅된 측정값 (없으면 빈 배열)
      const pw = allW.filter((w) => (w.product || '') === r.product);
      const wstat = weightStatsArr(pw, info.specMin, info.specMax);
      return {
        recordId: p.recordId,
        product: r.product, rollQty: r.rollQty, precutQty: r.precutQty, note: p.note,
        loss: r.loss, lossItems: ag.losses.filter((l) => (l.product || '(미지정)') === r.product),
        lotNo: info.lotNo || null, customer: info.customer || null, size: info.size ?? null,
        specMin: info.specMin ?? null, specMax: info.specMax ?? null,
        baseType: WS.baseType,
        weights: pw, avgWeight: wstat.weightAvg || null, weightCount: wstat.weightCount,
        weightMin: wstat.weightMin, weightMax: wstat.weightMax, outOfSpec: wstat.outOfSpec,
        isFirst: true,
      };
    });
  }
  // HYBRID — 단일 품목 실적. 시간대별 생산수량 합계(없으면 총수량 입력값)를 생산량으로 반영.
  if (wsForm === 'HYBRID') {
    const t = WS.htimes || {};
    const timeSum = HYBRID_TIMES.reduce((s, r) => s + num((t[r.key] || {}).qty), 0);
    const total = timeSum || num(WS.totalQty);
    const old = (WS.lines || [])[0] || {};
    WS.lines = (WS.product || total) ? [{
      recordId: old.recordId,
      product: WS.product || '(미지정)', lotNo: WS.labelLot || null,
      prodQty: total || null, weight: WS.avgWeight ?? null,
      note: WS.remarks || null, resinType: null,
    }] : [];
  }
  // CAST도 제품별 실적 — 각 제품 행이 하나의 생산실적(레코드)
  if (wsForm === 'CAST') {
    const r0 = (WS.resins || []).find((x) => x.name) || {};
    const infos = (WS.productInfos || []).filter((p) => p.product);
    const prods = WS.products || [], qc = WS.qcProducts || [];
    const oldLines = WS.lines || [];
    WS.lines = infos.map((info) => {
      const p = prods.find((x) => x.key === info.product) || {};
      const q = qc.find((x) => x.key === info.product) || {};
      const old = oldLines.find((l) => l.product === info.product) || {};
      return {
        recordId: old.recordId,
        product: info.product, lotNo: info.lotNo || null, customer: info.customer || null, size: info.size ?? null,
        length: p.length ?? null, planQty: p.planQty ?? null, prodQty: p.prodQty ?? null,
        remainQty: p.remainQty ?? null, pouchExtra: p.pouchExtra ?? null, loss: p.loss ?? null,
        coating: q.coating ?? null, weight: q.weight ?? null,
        resinType: r0.name || null, color: info.color || r0.color || null,
      };
    });
  }
  await syncSheetLines(WS, wsOrigRecordIds);
  wsOrigRecordIds = (WS.lines || []).map((l) => l.recordId).filter(Boolean);
  await post('/api/sheets/' + WS.id, WS, 'PUT');
  await Promise.all([loadSheets(), loadRecords()]);
}
async function closeWorkspace() {
  if (!WS) { $('#sheet-workspace').hidden = true; return; }
  harvestWs();
  try {
    if (wsIsNew && isEmptyWs()) await api('/api/sheets/' + WS.id, { method: 'DELETE' }).catch(() => {});
    else if ((WS.status || '') === '완료') await saveAndSyncWs();
    else await saveWsNow();
  } catch (e) { /* noop */ }
  $('#sheet-workspace').hidden = true; WS = null;
  await Promise.all([loadSheets(), loadRecords()]);
  refreshCurrentPage();
}
async function wsFinish() {
  harvestWs();
  if (!WS.machine) { alert('호기를 먼저 입력하세요.'); wsTab = 'basic'; renderWorkspace(); return; }
  WS.endTime = WS.endTime || nowTime();
  WS.status = '완료';
  try { await saveAndSyncWs(); } catch (e) { return alert('저장 실패: ' + e.message); }
  $('#sheet-workspace').hidden = true; WS = null;
  refreshCurrentPage();
  alert('공정일지가 완료되어 생산실적에 반영되었습니다.');
}
async function wsDelete() {
  if (!WS) return;
  if (!confirm('이 공정일지를 삭제하시겠습니까?\n연결된 생산실적도 함께 삭제됩니다.')) return;
  for (const id of wsOrigRecordIds) await api('/api/records/' + id, { method: 'DELETE' }).catch(() => {});
  await api('/api/sheets/' + WS.id, { method: 'DELETE' }).catch(() => {});
  $('#sheet-workspace').hidden = true; WS = null;
  await Promise.all([loadSheets(), loadRecords()]);
  refreshCurrentPage();
}

$('#ws-close').addEventListener('click', closeWorkspace);
$('#ws-delete').addEventListener('click', wsDelete);
$('#ws-panel').addEventListener('input', () => { if (WS) { harvestWs(); scheduleWsSave(); updateWsChrome(); updateSplintLive(); } });
$('#ws-panel').addEventListener('change', () => { if (WS) { harvestWs(); scheduleWsSave(); updateWsChrome(); updateSplintLive(); } });

/* 신규/행 클릭 → 워크스페이스 */
$('#btn-new-sheet').addEventListener('click', () => openWorkspace(PART));
document.addEventListener('click', (e) => {
  const ob = e.target.closest('.sheet-order-btn');
  if (ob) { openOrderForSheet(Number(ob.dataset.sheetId)); return; }
  const tr = e.target.closest('tr[data-sheet-id]');
  if (!tr) return;
  const s = SHEETS.find((x) => x.id === Number(tr.dataset.sheetId));
  if (s) openWorkspace(s.part || 'CAST', s.id);
});

/* ===================== 생산실적 목록 ===================== */
function renderLogs() {
  let recs = partRecords();
  const from = $('#f-from').value, to = $('#f-to').value;
  const mc = $('#f-machine').value, cu = $('#f-customer').value;
  const q = $('#f-search').value.trim().toLowerCase();
  if (from) recs = recs.filter((r) => r.date >= from);
  if (to) recs = recs.filter((r) => r.date <= to);
  if (mc) recs = recs.filter((r) => r.machine === mc);
  if (cu) recs = recs.filter((r) => r.customer === cu);
  if (q) recs = recs.filter((r) =>
    [r.product, r.lotNo, r.workers, r.customer, r.remarks, r.color].some((v) => String(v ?? '').toLowerCase().includes(q)));
  $('#logs-table').innerHTML = recordTable(recs, true);
}

function recordTable(recs, full = false) {
  if (!recs.length) return '<div class="empty">데이터가 없습니다.</div>';
  if (partBase(PART) === 'SPLINT') {
    const rollOf = (r) => r.rollQty != null ? num(r.rollQty) : num(r.spDom) + num(r.spOvs);
    const precutOf = (r) => r.precutQty != null ? num(r.precutQty) : num(r.prRoll);
    const lossOf = (r) => r.lossQty != null ? num(r.lossQty) : num(r.processDefect) + num(r.prodDefect);
    const rows = recs.map((r) => `
      <tr data-id="${r.id}">
        <td>${esc(r.date)}</td>
        <td>${esc(r.machine ?? '')}</td>
        <td>${esc(r.customer ?? '')}</td>
        <td><b>${esc(r.product ?? '')}</b> ${r.size ?? ''}" ${esc(r.baseType ?? '')}</td>
        <td class="num">${fmt(r.weight, 1)}${r.weightCount ? ` <span class="muted">(${r.weightCount}회·이탈${fmt(r.outOfSpec)})</span>` : ''}</td>
        <td class="num"><b>${fmt(rollOf(r), 1)}</b></td>
        <td class="num">${fmt(precutOf(r), 1)}</td>
        <td class="num">${fmt(lossOf(r), 1)}</td>
        <td class="num">${fmt(r.totalRoll, 1)}</td>
        <td>${lossBadge(r.totalLossRate)}</td>
        ${full ? `<td>${esc(r.workers ?? '')}</td><td>${esc(r.note ?? r.remarks ?? '')}</td>` : ''}
      </tr>`).join('');
    return `<table><thead><tr>
      <th>생산일</th><th>호기</th><th>업체</th><th>제품</th><th class="num">평균무게(g)</th>
      <th class="num">ROLL</th><th class="num">PRECUT</th><th class="num">로스</th><th class="num">총수량</th>
      <th>총로스율</th>
      ${full ? '<th>작업자</th><th>특이사항</th>' : ''}
    </tr></thead><tbody>${rows}</tbody></table>`;
  }
  const rows = recs.map((r) => `
    <tr data-id="${r.id}">
      <td>${esc(r.date)}</td>
      <td>${esc(r.machine ?? '')}</td>
      <td>${esc(r.customer ?? '')}</td>
      <td><b>${esc(r.product ?? '')}</b> ${esc(r.color ?? '')}</td>
      <td class="num">${fmt(r.planQty)}</td>
      <td class="num"><b>${fmt(r.prodQty)}</b></td>
      <td class="num">${fmt(r.totalProdLoss)}</td>
      <td class="num">${fmt(r.processDefect)}</td>
      <td class="num">${fmt(r.prodDefect)}</td>
      <td>${lossBadge(r.totalLossRate)}</td>
      ${full ? `<td>${esc(r.workers ?? '')}</td><td>${esc(r.note ?? r.remarks ?? '')}</td>` : ''}
    </tr>`).join('');
  return `<table><thead><tr>
    <th>생산일</th><th>호기</th><th>업체</th><th>제품</th>
    <th class="num">계획</th><th class="num">정품</th><th class="num">총생산(loss포함)</th>
    <th class="num">공정불량</th><th class="num">생산불량</th><th>총로스율</th>
    ${full ? '<th>작업자</th><th>특이사항</th>' : ''}
  </tr></thead><tbody>${rows}</tbody></table>`;
}

/* 실적 행 클릭: 원본 공정일지가 있으면 일지를 열어 수정 (실적은 일지의 산출물).
   엑셀 이관분 등 일지가 없는 실적만 직접 보완 가능 */
const sheetOfRecord = (recordId) => SHEETS.find((s) => (s.lines || []).some((l) => l.recordId === recordId));

document.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  // 설비 일상점검·설비 대장 행은 각자 전용 핸들러가 처리 (같은 data-id 사용으로 인한 오작동 방지)
  if (tr.classList.contains('ec-row') || tr.classList.contains('eq-row')) return;
  const id = Number(tr.dataset.id);
  const rec = RECORDS.find((r) => r.id === id);
  if (!rec) return;
  const sheet = sheetOfRecord(id);
  if (sheet) return openWorkspace(sheet.part || 'CAST', sheet.id);
  if (partBase(partOf(rec)) === 'SPLINT') openSplintModal(id);
  else openModal(id);
});

/* ===================== SPLINT 실적 입력 모달 ===================== */
const splintForm = $('#splint-form');

function openSplintModal(id = null) {
  editingSplintId = id;
  splintForm.reset();
  $('#weight-rows').innerHTML = '';
  $('#splint-modal-title').textContent = id ? 'SPLINT 실적 보완 (공정일지 미연결 이관분)' : 'SPLINT 실적 입력';
  $('#splint-delete').hidden = !id;
  if (id) {
    const r = RECORDS.find((x) => x.id === id);
    if (!r) return;
    [...splintForm.elements].forEach((el) => {
      if (el.name && r[el.name] != null && typeof r[el.name] !== 'object') el.value = r[el.name];
    });
    (r.weights || []).forEach((w) => addDynRow('weight', w));
  } else {
    splintForm.elements.date.value = todayStr();
    splintForm.elements.rollLen.value = 4.55;
  }
  updateSplintCalc();
  gateModal('#splint-form', id ? can('update', 'records') : can('create', 'records'), !!id && can('delete', 'records'));
  $('#splint-modal').hidden = false;
}

/* 제품무게 측정 통계 */
function weightStats() {
  const vals = collectDynRows('weight').map((w) => num(w.value)).filter((v) => v > 0);
  if (!vals.length) return { weightCount: 0, weightAvg: '', weightMin: '', weightMax: '' };
  return {
    weightCount: vals.length,
    weightAvg: +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1),
    weightMin: Math.min(...vals),
    weightMax: Math.max(...vals),
  };
}
$('#btn-apply-weight').addEventListener('click', () => {
  const st = weightStats();
  if (!st.weightCount) return alert('측정값을 먼저 입력하세요.');
  splintForm.elements.weight.value = Math.round(st.weightAvg);
  updateSplintCalc();
});
function closeSplintModal() { $('#splint-modal').hidden = true; editingSplintId = null; }
$('#splint-modal-close').addEventListener('click', closeSplintModal);
$('#splint-cancel').addEventListener('click', closeSplintModal);
$('#splint-modal').addEventListener('click', (e) => { if (e.target === $('#splint-modal')) closeSplintModal(); });

splintForm.addEventListener('input', updateSplintCalc);
function updateSplintCalc() {
  const r = formDataOf(splintForm);
  const c = splintCalc(r);
  ['prRoll', 'totalM', 'totalRoll', 'theoRoll', 'totalLossRoll', 'prodDefect', 'theoLoss', 'prodPlusLoss', 'pouchPR', 'pouchLoss'].forEach((k) => (splintForm.elements[k].value = c[k]));
  ['processLossRate', 'prodLossRate', 'totalLossRate'].forEach((k) => (splintForm.elements[k].value = c[k].toFixed(2)));
  const st = weightStats();
  ['weightCount', 'weightAvg', 'weightMin', 'weightMax'].forEach((k) => (splintForm.elements[k].value = st[k]));
}

splintForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = formDataOf(splintForm);
  Object.assign(r, splintCalc(r));
  r.weights = collectDynRows('weight');
  Object.assign(r, weightStats());
  r.part = 'SPLINT';
  try {
    if (editingSplintId) {
      const old = RECORDS.find((x) => x.id === editingSplintId) || {};
      await post('/api/records/' + editingSplintId, { ...old, ...r }, 'PUT');
    } else {
      await post('/api/records', r);
    }
    await loadRecords();
    closeSplintModal();
    refreshCurrentPage();
  } catch (err) { alert('저장 실패: ' + err.message); }
});

$('#splint-delete').addEventListener('click', async () => {
  if (!editingSplintId || !confirm('이 실적을 삭제하시겠습니까?')) return;
  await api('/api/records/' + editingSplintId, { method: 'DELETE' });
  await loadRecords();
  closeSplintModal();
  refreshCurrentPage();
});

/* ===================== 분석 ===================== */
const DIM_LABELS = { date: '일자', machine: '호기', product: '제품', customer: '업체', color: '칼라', workers: '작업조', worker: '작업자(개인)' };

/* 한 레코드가 속하는 차원 키 목록 — 작업자(개인)는 '김선희/최명춘'을 분해해 각자에게 집계 */
function dimKeys(r, dim) {
  if (dim === 'worker') {
    const ws = String(r.workers ?? '').split(/[\/,]/).map((s) => s.trim()).filter(Boolean);
    return ws.length ? ws : ['미지정'];
  }
  return [String(r[dim] ?? '미지정')];
}
const PART_METRIC_LABELS = {
  CAST: {
    totalLossRate: '총로스율(%)', processLossRate: '공정로스율(%)', prodLossRate: '생산로스율(%)',
    totalLoss: '총로스(수량)', processDefect: '공정불량(수량)', prodDefect: '생산불량(수량)', prodQty: '생산수량(정품)',
  },
  SPLINT: {
    totalLossRate: '생산총로스율(%)', processLossRate: '공정로스율(%)', prodLossRate: '생산로스율(%)',
    totalLoss: '총로스(roll)', processDefect: '공정불량(roll)', prodDefect: '생산불량(roll)', prodQty: '총수량(roll)',
  },
};
const METRIC_LABELS_OF = () => PART_METRIC_LABELS[partBase(PART)];
const RATE_METRICS = ['totalLossRate', 'processLossRate', 'prodLossRate'];
const PART_SUM_FIELDS = {
  CAST: ['planQty', 'prodQty', 'totalProdLoss', 'processDefect', 'prodDefect', 'totalLoss', 'resinTotal'],
  SPLINT: ['spDom', 'spOvs', 'prRoll', 'totalRoll', 'theoRoll', 'processDefect', 'prodDefect', 'totalLossRoll', 'resinInput'],
};

function updateMetricLabels() {
  const labels = METRIC_LABELS_OF();
  [...$('#a-metric').options].forEach((o) => { if (labels[o.value]) o.textContent = labels[o.value]; });
}

function analysisRecs() {
  let recs = partRecords();
  const from = $('#a-from').value, to = $('#a-to').value;
  const mc = $('#a-machine').value, cu = $('#a-customer').value, pr = $('#a-product').value;
  if (from) recs = recs.filter((r) => r.date >= from);
  if (to) recs = recs.filter((r) => r.date <= to);
  if (mc) recs = recs.filter((r) => r.machine === mc);
  if (cu) recs = recs.filter((r) => r.customer === cu);
  if (pr) recs = recs.filter((r) => r.product === pr);
  return recs;
}

function newAgg() {
  const g = { count: 0 };
  PART_SUM_FIELDS[PART].forEach((f) => (g[f] = 0));
  return g;
}
function accumulate(g, r) {
  g.count++;
  PART_SUM_FIELDS[PART].forEach((f) => (g[f] += num(r[f])));
}
/* 집계 그룹에서 지표값 계산 — 로스율은 합계 기준으로 재계산
   CAST: 불량 ÷ 총생산량(loss포함) / SPLINT: 불량(roll) ÷ 이론총수량(roll) */
function metricOf(g, metric) {
  const denom = partBase(PART) === 'SPLINT' ? g.theoRoll : g.totalProdLoss;
  const totalLoss = partBase(PART) === 'SPLINT' ? g.processDefect + g.prodDefect : g.totalLoss;
  const r2 = (x) => denom ? +(x / denom * 100).toFixed(2) : 0;
  if (metric === 'totalLossRate') return r2(totalLoss);
  if (metric === 'processLossRate') return r2(g.processDefect);
  if (metric === 'prodLossRate') return r2(g.prodDefect);
  if (metric === 'totalLoss') return partBase(PART) === 'SPLINT' ? +totalLoss.toFixed(2) : g.totalLoss;
  if (metric === 'prodQty') return partBase(PART) === 'SPLINT' ? +g.totalRoll.toFixed(1) : g.prodQty;
  return Math.round((g[metric] || 0) * 100) / 100;
}
const dimLabel = (key, dim) => (dim === 'date' ? key.slice(5) : key);

function renderAnalysis() {
  const recs = analysisRecs();
  const metric = $('#a-metric').value;
  const isRate = RATE_METRICS.includes(metric);
  $('#a-count').textContent = `대상 ${recs.length}건`;

  /* --- 1) 기준별 요약 --- */
  const groupKey = $('#a-group').value;
  const groups = {};
  recs.forEach((r) => {
    dimKeys(r, groupKey).forEach((k) => {
      (groups[k] = groups[k] || newAgg());
      accumulate(groups[k], r);
    });
  });
  const keys = Object.keys(groups).sort();
  $('#a-chart-title').textContent = `[${PART}] ${DIM_LABELS[groupKey]}별 ${METRIC_LABELS_OF()[metric]}`
    + (groupKey === 'worker' ? ' — 같은 조 작업은 조원 전원에게 집계됩니다' : '');
  $('#chart-analysis').innerHTML = barChart(keys.map((k) => ({
    label: dimLabel(k, groupKey), value: metricOf(groups[k], metric),
  })), { red: isRate || metric !== 'prodQty', suffix: isRate ? '%' : '' });

  let rows, headCols;
  if (partBase(PART) === 'SPLINT') {
    rows = keys.map((k) => {
      const g = groups[k];
      const rate = g.theoRoll ? ((g.processDefect + g.prodDefect) / g.theoRoll * 100) : 0;
      return `<tr class="no-click">
        <td><b>${esc(k)}</b></td><td class="num">${g.count}</td>
        <td class="num">${fmt(g.spDom)}</td><td class="num">${fmt(g.spOvs)}</td><td class="num">${fmt(g.prRoll, 1)}</td>
        <td class="num"><b>${fmt(g.totalRoll, 1)}</b></td><td class="num">${fmt(g.theoRoll, 1)}</td>
        <td class="num">${fmt(g.processDefect, 2)}</td><td class="num">${fmt(g.prodDefect, 2)}</td>
        <td class="num">${fmt(g.totalLossRoll, 2)}</td><td>${lossBadge(rate)}</td>
        <td class="num">${fmt(g.resinInput, 1)}</td>
      </tr>`;
    }).join('');
    headCols = `<th>${DIM_LABELS[groupKey]}</th><th class="num">건수</th><th class="num">SP내수</th><th class="num">SP해외</th><th class="num">PR(roll)</th>
      <th class="num">총수량(roll)</th><th class="num">이론수량</th><th class="num">공정불량</th><th class="num">생산불량</th><th class="num">총로스(roll)</th><th>총로스율</th><th class="num">수지(kg)</th>`;
  } else {
    rows = keys.map((k) => {
      const g = groups[k];
      const rate = g.totalProdLoss ? (g.totalLoss / g.totalProdLoss * 100) : 0;
      const achieve = g.planQty ? (g.prodQty / g.planQty * 100) : 0;
      return `<tr class="no-click">
        <td><b>${esc(k)}</b></td><td class="num">${g.count}</td>
        <td class="num">${fmt(g.planQty)}</td><td class="num"><b>${fmt(g.prodQty)}</b></td>
        <td class="num">${g.planQty ? achieve.toFixed(1) + '%' : '-'}</td>
        <td class="num">${fmt(g.totalProdLoss)}</td>
        <td class="num">${fmt(g.processDefect)}</td><td class="num">${fmt(g.prodDefect)}</td>
        <td class="num">${fmt(g.totalLoss)}</td><td>${lossBadge(rate)}</td>
        <td class="num">${fmt(g.resinTotal, 1)}</td>
      </tr>`;
    }).join('');
    headCols = `<th>${DIM_LABELS[groupKey]}</th><th class="num">건수</th><th class="num">계획</th><th class="num">정품</th><th class="num">달성률</th>
      <th class="num">총생산(loss포함)</th><th class="num">공정불량</th><th class="num">생산불량</th><th class="num">총로스</th><th>총로스율</th><th class="num">수지(kg)</th>`;
  }
  $('#analysis-table').innerHTML = keys.length
    ? `<table><thead><tr>${headCols}</tr></thead><tbody>${rows}</tbody></table>`
    : '<div class="empty">데이터가 없습니다.</div>';

  /* --- 2) 작업자별 불량률 비교 --- */
  renderWorkerComparison(recs);

  /* --- 3) 교차 분석 (피벗) --- */
  renderPivot(recs, metric, isRate);

  /* --- 4) 불량 구성 --- */
  renderDefectCharts(recs);
}

/* 작업자(개인)별 불량률 비교 — 공동작업은 조원 전원에게 집계, 총로스율 높은 순 정렬 */
function renderWorkerComparison(recs) {
  const groups = {};
  recs.forEach((r) => {
    dimKeys(r, 'worker').forEach((k) => {
      accumulate(groups[k] = groups[k] || newAgg(), r);
    });
  });
  const keys = Object.keys(groups);
  if (!keys.length) {
    $('#chart-worker').innerHTML = '<div class="empty">데이터가 없습니다.</div>';
    $('#worker-table').innerHTML = '';
    return;
  }
  const rateOf = (g) => metricOf(g, 'totalLossRate');
  keys.sort((a, b) => rateOf(groups[b]) - rateOf(groups[a]) || groups[b].count - groups[a].count);

  $('#chart-worker').innerHTML = lineChart(keys.map((k) => ({
    label: k, value: rateOf(groups[k]),
  })), { red: true, suffix: '%' });

  const unit = partBase(PART) === 'SPLINT' ? 'roll' : '수량';
  const dec = partBase(PART) === 'SPLINT' ? 2 : 0;
  const rows = keys.map((k, i) => {
    const g = groups[k];
    const totalLoss = partBase(PART) === 'SPLINT' ? +(g.processDefect + g.prodDefect).toFixed(2) : g.totalLoss;
    return `<tr class="no-click">
      <td class="num">${i + 1}</td>
      <td><b>${esc(k)}</b></td>
      <td class="num">${g.count}</td>
      <td class="num">${fmt(g.processDefect, dec)}</td>
      <td class="num">${fmt(g.prodDefect, dec)}</td>
      <td class="num">${fmt(totalLoss, dec)}</td>
      <td class="num">${metricOf(g, 'processLossRate').toFixed(2)}%</td>
      <td class="num">${metricOf(g, 'prodLossRate').toFixed(2)}%</td>
      <td>${lossBadge(metricOf(g, 'totalLossRate'))}</td>
    </tr>`;
  }).join('');
  const head = `<th class="num">순위</th><th>작업자</th><th class="num">작업건수</th>
    <th class="num">공정불량(${unit})</th><th class="num">생산불량(${unit})</th><th class="num">총로스(${unit})</th>
    <th class="num">공정로스율</th><th class="num">생산로스율</th><th>총로스율</th>`;
  $('#worker-table').innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

function renderPivot(recs, metric, isRate) {
  const rowDim = $('#a-pivot-row').value;
  const colDim = $('#a-pivot-col').value;
  if (rowDim === colDim) { $('#pivot-table').innerHTML = '<div class="empty">행과 열에 서로 다른 변수를 선택하세요.</div>'; return; }
  if (!recs.length) { $('#pivot-table').innerHTML = '<div class="empty">데이터가 없습니다.</div>'; return; }

  const cells = {}, rowTotals = {}, colTotals = {}, grand = newAgg();
  const rowKeys = new Set(), colKeys = new Set();
  recs.forEach((r) => {
    dimKeys(r, rowDim).forEach((rk) => dimKeys(r, colDim).forEach((ck) => {
      rowKeys.add(rk); colKeys.add(ck);
      (cells[rk] = cells[rk] || {});
      accumulate(cells[rk][ck] = cells[rk][ck] || newAgg(), r);
    }));
    dimKeys(r, rowDim).forEach((rk) => accumulate(rowTotals[rk] = rowTotals[rk] || newAgg(), r));
    dimKeys(r, colDim).forEach((ck) => accumulate(colTotals[ck] = colTotals[ck] || newAgg(), r));
    accumulate(grand, r);
  });
  const rks = [...rowKeys].sort(), cks = [...colKeys].sort();
  const values = [];
  rks.forEach((rk) => cks.forEach((ck) => { if (cells[rk][ck]) values.push(metricOf(cells[rk][ck], metric)); }));
  const maxV = Math.max(...values, 0.0001);

  const heat = (v) => {
    if (v == null) return '';
    const t = Math.min(1, v / maxV);
    return isRate || metric !== 'prodQty'
      ? `background: rgba(226,61,61,${(t * 0.55).toFixed(3)})`
      : `background: rgba(31,94,255,${(t * 0.4).toFixed(3)})`;
  };
  const cellTxt = (g) => g == null ? '<span class="muted">-</span>' : (isRate ? metricOf(g, metric).toFixed(2) + '%' : fmt(metricOf(g, metric), partBase(PART) === 'SPLINT' ? 1 : 0));

  const head = `<tr><th>${DIM_LABELS[rowDim]} ＼ ${DIM_LABELS[colDim]}</th>${cks.map((c) => `<th class="num">${esc(dimLabel(c, colDim))}</th>`).join('')}<th class="num">합계</th></tr>`;
  const body = rks.map((rk) => `<tr class="no-click">
    <td><b>${esc(dimLabel(rk, rowDim))}</b></td>
    ${cks.map((ck) => { const g = cells[rk][ck]; return `<td class="num" style="${g ? heat(metricOf(g, metric)) : ''}">${cellTxt(g)}</td>`; }).join('')}
    <td class="num"><b>${cellTxt(rowTotals[rk])}</b></td>
  </tr>`).join('');
  const foot = `<tr class="no-click pivot-foot">
    <td><b>합계</b></td>
    ${cks.map((ck) => `<td class="num"><b>${cellTxt(colTotals[ck])}</b></td>`).join('')}
    <td class="num"><b>${cellTxt(grand)}</b></td>
  </tr>`;
  $('#pivot-table').innerHTML = `<table>${head}${body}${foot}</table>`;
}

const DEFECT_DETAILS = [
  ['pdJoint', '이음매', 'process'], ['pdKnot', '중간매듭', 'process'], ['pdBase', '기재불량', 'process'],
  ['gdSet', '셋팅', 'prod'], ['gdCurl', '말림', 'prod'], ['gdRoll', '줄감', 'prod'],
  ['gdLen', '길이', 'prod'], ['gdStain', '오염', 'prod'], ['gdEtc', '기타', 'prod'],
];
function renderDefectCharts(recs) {
  const pSum = +recs.reduce((a, r) => a + num(r.processDefect), 0).toFixed(2);
  const gSum = +recs.reduce((a, r) => a + num(r.prodDefect), 0).toFixed(2);
  $('#chart-defect-split').innerHTML = barChart([
    { label: `공정불량 (${pSum + gSum ? (pSum / (pSum + gSum) * 100).toFixed(0) : 0}%)`, value: pSum },
    { label: `생산불량 (${pSum + gSum ? (gSum / (pSum + gSum) * 100).toFixed(0) : 0}%)`, value: gSum },
  ], { red: true });

  if (partBase(PART) === 'SPLINT') {
    $('#defect-detail-note').textContent = 'SPLINT 공정은 불량 세부유형(이음매/매듭 등)을 사용하지 않습니다. 공정/생산 구분은 왼쪽 차트를 참고하세요.';
    $('#chart-defect-detail').innerHTML = '<div class="empty">해당 없음 (CAST 전용)</div>';
    return;
  }

  const detail = DEFECT_DETAILS.map(([key, label]) => ({
    label, value: recs.reduce((a, r) => a + num(r[key]), 0),
  }));
  const detailSum = detail.reduce((a, d) => a + d.value, 0);
  const withDetail = recs.filter((r) => DEFECT_DETAILS.some(([k]) => num(r[k]) > 0)).length;
  const unclassified = pSum + gSum - detailSum;
  if (unclassified > 0) detail.push({ label: '미분류', value: unclassified });
  $('#defect-detail-note').textContent = withDetail
    ? `세부유형이 입력된 실적 ${withDetail}건 기준 (미분류 = 세부유형 없이 합계만 입력된 불량)`
    : '세부유형이 입력된 실적이 없습니다. 실적 입력 시 [불량 세부 유형]을 채우면 여기서 분석됩니다.';
  $('#chart-defect-detail').innerHTML = detailSum || unclassified > 0
    ? barChart(detail.filter((d) => d.value > 0), { red: true })
    : '<div class="empty">데이터가 없습니다.</div>';
}

/* ===================== SVG 막대차트 ===================== */
function barChart(data, opts = {}) {
  if (!data.length) return '<div class="empty">데이터가 없습니다.</div>';
  const W = 560, H = 220, padB = 26, padT = 18, padL = 8, padR = 8;
  const max = Math.max(...data.map((d) => d.value), 0.001);
  const bw = Math.min(48, (W - padL - padR) / data.length - 8);
  const step = (W - padL - padR) / data.length;
  const bars = data.map((d, i) => {
    const h = (d.value / max) * (H - padB - padT);
    const x = padL + step * i + (step - bw) / 2;
    const y = H - padB - h;
    const val = opts.suffix === '%' ? d.value.toFixed(2) : fmt(d.value);
    return `<rect class="bar ${opts.red ? 'red' : ''}" x="${x}" y="${y}" width="${bw}" height="${Math.max(h, 1)}" rx="3"></rect>
      <text class="bar-value" x="${x + bw / 2}" y="${y - 4}" text-anchor="middle">${val}</text>
      <text class="axis-label" x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${esc(d.label)}</text>`;
  }).join('');
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
    <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="#e3e8f0"/>${bars}</svg>`;
}

/* ===================== SVG 꺾은선 차트 (작업자별 비교 등, 컴팩트) ===================== */
function lineChart(data, opts = {}) {
  if (!data.length) return '<div class="empty">데이터가 없습니다.</div>';
  const W = 600, H = 170, padB = 28, padT = 24, padL = 16, padR = 16;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const max = Math.max(...data.map((d) => d.value), 0.001);
  const n = data.length;
  const xOf = (i) => padL + (n === 1 ? innerW / 2 : innerW * i / (n - 1));
  const yOf = (v) => padT + innerH - (v / max) * innerH;
  const color = opts.red ? '#ff6b6b' : 'var(--brand)';
  const pts = data.map((d, i) => [xOf(i), yOf(d.value)]);
  const poly = pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const dots = data.map((d, i) => {
    const [x, y] = pts[i];
    const val = opts.suffix === '%' ? d.value.toFixed(2) : fmt(d.value);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="${color}"></circle>
      <text class="bar-value" x="${x.toFixed(1)}" y="${(y - 7).toFixed(1)}" text-anchor="middle">${val}${opts.suffix || ''}</text>
      <text class="axis-label" x="${x.toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(d.label)}</text>`;
  }).join('');
  return `<svg class="chart-svg" style="max-width:760px" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
    <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="#e3e8f0"/>
    <polyline fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" points="${poly}"/>${dots}</svg>`;
}

/* ===================== 생산실적 입력 모달 ===================== */
const form = $('#log-form');

function openModal(id = null) {
  editingId = id;
  form.reset();
  $('#modal-title').textContent = id ? '실적 보완 (공정일지 미연결 이관분)' : '생산실적 입력';
  $('#btn-delete').hidden = !id;
  if (id) {
    const r = RECORDS.find((x) => x.id === id);
    if (!r) return;
    [...form.elements].forEach((el) => {
      if (el.name && r[el.name] != null) el.value = r[el.name];
    });
  } else {
    form.elements.date.value = todayStr();
  }
  updateCalcFields();
  gateModal('#log-form', id ? can('update', 'records') : can('create', 'records'), !!id && can('delete', 'records'));
  $('#modal').hidden = false;
}
function closeModal() { $('#modal').hidden = true; editingId = null; }

// 실적 직접 입력 버튼은 제거됨 — 실적은 일일 공정일지 저장 시 자동 생성.
// openModal/openSplintModal은 일지가 없는 이관 실적 보완용으로만 사용된다.
$('#modal-close').addEventListener('click', closeModal);
$('#btn-cancel').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeModal(); });

form.addEventListener('input', (e) => {
  // 불량 세부 유형 입력 시 공정/생산불량 합계 자동 반영
  if (e.target.classList && e.target.classList.contains('defect-detail')) {
    const sumOf = (kind) => $$('#log-form .defect-detail[data-sum="' + kind + '"]').reduce((a, el) => a + num(el.value), 0);
    const pSum = sumOf('process'), gSum = sumOf('prod');
    const anyDetail = $$('#log-form .defect-detail').some((el) => el.value !== '');
    if (anyDetail) {
      form.elements.processDefect.value = pSum;
      form.elements.prodDefect.value = gSum;
    }
  }
  updateCalcFields();
});
function updateCalcFields() {
  const r = formDataOf(form);
  const c = calc(r);
  ['totalProd', 'totalLoss', 'totalProdLoss', 'inputBase', 'rollUsage', 'resinTotal', 'pouchTotal'].forEach((k) => (form.elements[k].value = c[k]));
  ['processLossRate', 'prodLossRate', 'totalLossRate'].forEach((k) => (form.elements[k].value = c[k].toFixed(2)));
}

function formDataOf(f) {
  const r = {};
  [...f.elements].forEach((el) => {
    if (!el.name) return;
    r[el.name] = el.type === 'number' ? (el.value === '' ? null : Number(el.value)) : (el.value || null);
  });
  return r;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = formDataOf(form);
  Object.assign(r, calc(r));
  r.part = 'CAST';
  try {
    if (editingId) {
      const old = RECORDS.find((x) => x.id === editingId) || {};
      await post('/api/records/' + editingId, { ...old, ...r, part: old.part || 'CAST' }, 'PUT');
    } else {
      await post('/api/records', r);
    }
    await loadRecords();
    closeModal();
    refreshCurrentPage();
  } catch (err) { alert('저장 실패: ' + err.message); }
});

$('#btn-delete').addEventListener('click', async () => {
  if (!editingId || !confirm('이 실적을 삭제하시겠습니까?')) return;
  await api('/api/records/' + editingId, { method: 'DELETE' });
  await loadRecords();
  closeModal();
  refreshCurrentPage();
});

/* ===================== 기준정보 ===================== */
const MASTER_LABELS = {
  machines: '호기', customers: '업체명', products: '제품명', colors: '칼라',
  productCodes: '제품코드', baseTypes: '기재 타입', resins: '수지 종류',
  pouches: '파우치 종류', workers: '작업자', qcItems: '자체품질체크 품목', toners: '토너 종류', cores: '코어 종류', lossTypes: 'SPLINT 로스 항목',
};
function renderMasters() {
  const custTypes = MASTERS.customerTypes || {};
  const custRows = (MASTERS.customers || []).map((c) => `
    <div class="m-row">
      <label>${esc(c)}</label>
      <select data-custtype="${esc(c)}">
        <option value="NEAL"${(custTypes[c] || 'NEAL') === 'NEAL' ? ' selected' : ''}>기본 NEAL</option>
        <option value="OEM"${custTypes[c] === 'OEM' ? ' selected' : ''}>고객사 OEM</option>
      </select>
    </div>`).join('') || '<p class="muted">등록된 고객사가 없습니다.</p>';
  $('#masters-form').innerHTML =
    '<h3 style="margin:0 0 10px">목록 관리 <span class="muted" style="font-size:13px;font-weight:400">쉼표(,)로 구분</span></h3>' +
    Object.keys(MASTER_LABELS).map((k) => `
    <div class="m-row">
      <label>${MASTER_LABELS[k]}</label>
      <input type="text" data-key="${k}" value="${esc((MASTERS[k] || []).join(', '))}">
    </div>`).join('') +
    '<h3 style="margin:20px 0 6px">고객사 사양 구분 (NEAL / OEM)</h3>' +
    '<p class="muted" style="margin-bottom:10px">작업지시에서 이 설정에 따라 <b>기본 NEAL 사양</b> 또는 <b>고객사 OEM 사양</b>을 적용합니다.</p>' +
    custRows +
    '<div style="margin-top:16px"><button class="btn primary" id="btn-save-masters">기준정보 저장</button></div>';
  $('#btn-save-masters').addEventListener('click', async () => {
    const next = { ...MASTERS };
    $$('#masters-form input[data-key]').forEach((el) => {
      next[el.dataset.key] = el.value.split(',').map((s) => s.trim()).filter(Boolean);
    });
    const types = {};
    $$('#masters-form select[data-custtype]').forEach((el) => { if (el.value === 'OEM') types[el.dataset.custtype] = 'OEM'; });
    next.customerTypes = types;
    MASTERS = await post('/api/masters', next, 'PUT');
    fillMasterInputs();
    renderMasters();
    alert('저장되었습니다.');
  });
}

function fillMasterInputs() {
  const dl = (id, key) => { const el = $(id); if (el) el.innerHTML = (MASTERS[key] || []).map((v) => `<option value="${esc(v)}">`).join(''); };
  dl('#dl-customers', 'customers'); dl('#dl-products', 'products'); dl('#dl-colors', 'colors');
  dl('#dl-productCodes', 'productCodes'); dl('#dl-baseTypes', 'baseTypes');
  dl('#dl-resins', 'resins'); dl('#dl-pouches', 'pouches'); dl('#dl-workers', 'workers'); dl('#dl-toners', 'toners'); dl('#dl-cores', 'cores'); dl('#dl-lossTypes', 'lossTypes'); dl('#dl-qcItems', 'qcItems');
  const mcOpts = (first) => first + (MASTERS.machines || []).map((m) => `<option>${esc(m)}</option>`).join('');
  form.elements.machine.innerHTML = mcOpts('<option value="">선택</option>');
  planForm.elements.machine.innerHTML = mcOpts('<option value="">선택</option>');
  splintForm.elements.machine.innerHTML = mcOpts('<option value="">선택</option>');
  // 워크스페이스(공정일지)의 호기/품목 select는 렌더 시 MASTERS에서 직접 생성됨
  ['#f-machine', '#p-machine', '#s-machine', '#a-machine', '#ec-machine'].forEach((sel) => { $(sel).innerHTML = mcOpts($(sel).querySelector('option').outerHTML); });
  const custOpts = '<option value="">전체</option>' + (MASTERS.customers || []).map((c) => `<option>${esc(c)}</option>`).join('');
  $('#f-customer').innerHTML = custOpts;
  $('#a-customer').innerHTML = custOpts;
  $('#a-product').innerHTML = '<option value="">전체</option>' + (MASTERS.products || []).map((p) => `<option>${esc(p)}</option>`).join('');
}

/* ===================== CSV 내보내기 ===================== */
const CSV_COLS = [
  ['date', '생산일'], ['lotNo', 'Lot No'], ['exp', 'EXP'], ['machine', '호기'], ['sealer', '실링기'], ['bandDate', '밴드교체일'],
  ['customer', '업체명'], ['orderNo', '주문차수'], ['product', '제품명'], ['color', '칼라'], ['length', '길이'],
  ['coating', '코팅량'], ['weight', '무게'], ['planQty', '계획수량'], ['repouch', '재파우치'], ['prodQty', '생산수량(정품)'],
  ['remainQty', '잔량'], ['totalProd', '총생산량'], ['totalProdLoss', '총생산량(loss포함)'], ['totalLoss', '총로스'],
  ['processDefect', '공정불량'], ['prodDefect', '생산불량'], ['processLossRate', '공정로스율(%)'], ['prodLossRate', '생산로스율(%)'],
  ['totalLossRate', '총로스율(%)'], ['pdJoint', '이음매'], ['pdKnot', '중간매듭'], ['pdBase', '기재불량'],
  ['gdSet', '셋팅'], ['gdCurl', '말림'], ['gdRoll', '줄감'], ['gdLen', '길이불량'], ['gdStain', '오염'], ['gdEtc', '기타불량'],
  ['productCode', '제품코드'], ['baseType', '기재타입'], ['size', '사이즈'],
  ['baseLength', '기재길이'], ['baseTypeLen', '기재타입/길이'], ['rollProd', '1롤생산량'], ['inputBase', '투입기재(m)'],
  ['rollUsage', '총사용량(롤)'], ['resinType', '수지종류'], ['resinPerEa', '투입량1ea(g)'], ['resinTotal', '총투입량(kg)'],
  ['pouchType', '파우치종류'], ['pouchExtra', '파우치추가'], ['pouchTotal', '파우치총수량'], ['inBox', 'In Box'],
  ['outBox', 'Out Box'], ['workers', '작업자'], ['earlyQty', '조출수량'], ['earlyWorker', '조출자'], ['remarks', '특이사항'],
];
const SPLINT_CSV_COLS = [
  ['date', '생산일'], ['machine', '호기'], ['customer', '업체명'], ['orderNo', '주문차수'], ['product', '제품명'],
  ['size', '인치'], ['baseType', '기재타입'],
  ['rollQty', 'ROLL생산량'], ['precutQty', 'PRECUT생산량'], ['lossQty', '로스량'], ['totalRoll', '총수량'],
  ['weight', '평균무게(g)'], ['weightCount', '무게측정횟수'], ['weightMin', '무게최소(g)'], ['weightMax', '무게최대(g)'],
  ['specMin', '기준하한(g)'], ['specMax', '기준상한(g)'], ['outOfSpec', '기준이탈수량'],
  ['theoRoll', '이론총수량'], ['totalLossRate', '생산총로스율(%)'],
  ['baseMid', '중피(m)'], ['baseUp', '상지(m)'], ['baseDown', '하지(m)'],
  ['resinType', '수지종류'], ['rawMaterial', '원료'], ['resinInput', '투입량(kg)'],
  ['pouchType', '파우치종류'], ['pouchSP', '파우치SP'], ['pouchPR', '파우치PR'], ['pouchLoss', '파우치LOSS'], ['pouchTotal', '파우치총수량'],
  ['inBox', 'In Box'], ['outBox', 'Out Box'], ['brown', 'Brown'], ['workers', '작업자'], ['remarks', '특이사항'],
];
$('#btn-csv').addEventListener('click', () => {
  const COLS = partBase(PART) === 'SPLINT' ? SPLINT_CSV_COLS : CSV_COLS;
  const header = COLS.map(([, label]) => label).join(',');
  const lines = partRecords().map((r) =>
    COLS.map(([k]) => {
      const v = r[k] ?? '';
      return /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
    }).join(','));
  const blob = new Blob(['﻿' + [header, ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${PART}_생산실적_${todayStr()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});
/* ===================== 필터 이벤트 ===================== */
['f-from', 'f-to', 'f-machine', 'f-customer', 'f-search'].forEach((id) =>
  $('#' + id).addEventListener('input', renderLogs));
$('#btn-filter-reset').addEventListener('click', () => {
  ['f-from', 'f-to', 'f-search', 'f-machine', 'f-customer'].forEach((id) => ($('#' + id).value = ''));
  renderLogs();
});
$('#dash-month').addEventListener('input', renderDashboard);
['a-from', 'a-to', 'a-machine', 'a-customer', 'a-product', 'a-metric', 'a-group', 'a-pivot-row', 'a-pivot-col']
  .forEach((id) => $('#' + id).addEventListener('input', renderAnalysis));
$('#a-reset').addEventListener('click', () => {
  ['a-from', 'a-to', 'a-machine', 'a-customer', 'a-product'].forEach((id) => ($('#' + id).value = ''));
  renderAnalysis();
});
['p-from', 'p-to', 'p-machine', 'p-status'].forEach((id) => $('#' + id).addEventListener('input', renderPlans));
['s-month', 's-machine'].forEach((id) => $('#' + id).addEventListener('input', renderSheets));

/* ===================== 초기화 (Firebase 로그인 후 부팅) ===================== */
let __booted = false;
async function bootApp() {
  if (__booted) return; __booted = true;
  await Promise.all([loadRecords(), loadSheets(), loadPlans(), loadStandards(), loadCustSpecs(), loadEquipChecks(), loadEquipment(), loadMasters()]);
  fillMasterInputs();
  updateMetricLabels();
  applyRolePerms();
  const latest = RECORDS.length ? RECORDS[0].date : todayStr();
  $('#dash-month').value = latest.slice(0, 7);
  $('#s-month').value = latest.slice(0, 7);
  showPage('home');
}

/* --- 로그인 게이트: 인증 성공 시에만 앱 부팅 (미인증 = 업무화면·데이터 접근 불가) --- */
(function initAuthGate() {
  if (!window.dataService || !dataService.auth) {
    const err = $('#login-error');
    if (err) err.textContent = 'Firebase 초기화 실패 — firebase-config.js 설정을 확인하세요.';
    return;
  }
  const auth = dataService.auth;
  const loginScreen = $('#login-screen');
  const form = $('#login-form');
  const errBox = $('#login-error');
  const submitBtn = $('#login-submit');
  const logoutBtn = $('#logout-btn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.textContent = '';
    submitBtn.disabled = true;
    try {
      await auth.signInWithEmailAndPassword(form.email.value.trim(), form.password.value);
    } catch (err) {
      errBox.textContent = '로그인 실패: 이메일 또는 비밀번호를 확인하세요.';
    } finally { submitBtn.disabled = false; }
  });
  if (logoutBtn) logoutBtn.addEventListener('click', async () => { ME = null; try { await auth.signOut(); } catch (e) {} location.reload(); });

  // 로그인 후: users/{uid}의 role·active 확인 → 통과해야만 데이터 로드/부팅
  async function block(msg) {
    errBox.textContent = msg;
    loginScreen.hidden = false;
    if (logoutBtn) logoutBtn.hidden = true;
    ME = null;
    try { await auth.signOut(); } catch (e) {}
  }
  auth.onAuthStateChanged(async (user) => {
    if (!user) { loginScreen.hidden = false; if (logoutBtn) logoutBtn.hidden = true; return; }
    let udoc;
    try { udoc = await dataService.getUser(user.uid); }
    catch (e) { return block('권한 정보를 불러오지 못했습니다. 잠시 후 다시 시도하세요.'); }
    if (!udoc) return block('등록되지 않은 사용자입니다. 관리자에게 users 문서 등록을 요청하세요.');
    if (udoc.active === false) return block('비활성화된 계정입니다. 관리자에게 문의하세요.');
    if (!['admin', 'manager', 'worker'].includes(udoc.role)) return block('권한(role)이 올바르지 않습니다. 관리자에게 문의하세요.');
    ME = { uid: user.uid, email: user.email, name: udoc.name || '', role: udoc.role, active: true };
    loginScreen.hidden = true;
    if (logoutBtn) { logoutBtn.hidden = false; const u = $('#logout-user'); if (u) u.textContent = `${ME.name || user.email} · ${ME.role}`; }
    await bootApp();   // 권한 확인 후에만 업무 데이터 로드
  });
})();
