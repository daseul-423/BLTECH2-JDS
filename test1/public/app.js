/* CAST 생산공정일지 관리 시스템 - 프론트엔드 (v2: 일일 공정일지 + 생산계획표) */
'use strict';

let RECORDS = [];
let SHEETS = [];
let PLANS = [];
let STANDARDS = [];
let MASTERS = {};
let editingStandardId = null;
let PART = 'CAST';          // 공정 구분 (CAST / SPLINT)
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

/* ===================== 데이터 계층 (서버 API 우선, 없으면 localStorage) =====================
   - 로컬에서 `node server.js`로 실행: 파일 DB(/api/*) 사용
   - 정적 배포(Vercel 등 API 없음): 자동으로 브라우저 localStorage 사용, seed.json으로 최초 시드 */
let LOCAL_MODE = false, LDB = null, _localInit = null;
const LKEY = 'cast-mes-db-v1';
const COLLECTIONS = ['records', 'sheets', 'plans', 'standards'];
const saveLocal = () => { try { localStorage.setItem(LKEY, JSON.stringify(LDB)); } catch (e) { /* quota */ } };
async function initLocal() {
  const cached = localStorage.getItem(LKEY);
  if (cached) { LDB = JSON.parse(cached); }
  else { LDB = await (await fetch('seed.json')).json(); }
  LDB.seqs = LDB.seqs || { records: 1, sheets: 1, plans: 1, standards: 1 };
  COLLECTIONS.forEach((c) => { if (!LDB[c]) LDB[c] = []; });
  LDB.masters = LDB.masters || {};
  if (cached) await healStandardImages();  // 옛 /uploads 경로 → 내장 사진(dataURL) 자동 교체
  if (!cached) saveLocal();
  LOCAL_MODE = true;
}
/* 배포 환경에서 서빙 불가한 /uploads 이미지 경로를 seed.json의 내장 dataURL로 치환 */
async function healStandardImages() {
  const stds = LDB.standards || [];
  const hasStale = stds.some((s) => Object.values(s.images || {}).some((v) => typeof v === 'string' && v.startsWith('/uploads/')));
  if (!hasStale) return;
  let seedById = {};
  try { (await (await fetch('seed.json')).json()).standards.forEach((s) => (seedById[s.id] = s)); } catch (e) { return; }
  let changed = false;
  stds.forEach((s) => {
    const im = s.images || (s.images = {});
    ['pouch', 'inBox', 'outBox'].forEach((k) => {
      if (typeof im[k] === 'string' && im[k].startsWith('/uploads/')) {
        const seeded = seedById[s.id] && seedById[s.id].images ? seedById[s.id].images[k] : '';
        im[k] = (typeof seeded === 'string' && seeded.startsWith('data:')) ? seeded : '';
        changed = true;
      }
    });
  });
  if (changed) saveLocal();
}
function localApi(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : null;
  const url = new URL(path, location.origin);
  const p = url.pathname;
  if (p === '/api/upload' && method === 'POST') return { url: body.dataUrl }; // 이미지=dataURL 직접 사용
  if (p === '/api/masters') {
    if (method === 'GET') return LDB.masters;
    if (method === 'PUT') { LDB.masters = body; saveLocal(); return LDB.masters; }
  }
  const m = p.match(/^\/api\/(\w+)(?:\/(\d+))?$/);
  if (m && COLLECTIONS.includes(m[1])) {
    const col = m[1], id = m[2] ? Number(m[2]) : null, items = LDB[col];
    if (id == null && method === 'GET') {
      let out = items.slice();
      const from = url.searchParams.get('from'), to = url.searchParams.get('to');
      if (from) out = out.filter((r) => r.date >= from);
      if (to) out = out.filter((r) => r.date <= to);
      out.sort((a, b) => (a.date === b.date ? String(a.machine ?? '').localeCompare(String(b.machine ?? '')) : a.date < b.date ? 1 : -1));
      return out;
    }
    if (id == null && method === 'POST') { body.id = LDB.seqs[col]++; items.push(body); saveLocal(); return body; }
    if (id != null) {
      const idx = items.findIndex((r) => r.id === id);
      if (idx === -1) throw new Error('not found');
      if (method === 'PUT') { body.id = id; items[idx] = body; saveLocal(); return body; }
      if (method === 'DELETE') { items.splice(idx, 1); saveLocal(); return { ok: true }; }
    }
  }
  throw new Error('unknown route: ' + p);
}
async function api(path, opts) {
  if (LOCAL_MODE) return localApi(path, opts);
  try {
    const res = await fetch(path, opts);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  } catch (e) {
    if (!_localInit) _localInit = initLocal();   // 서버 API 없음 → localStorage 모드 1회 전환
    await _localInit;
    return localApi(path, opts);
  }
}
const post = (path, body, method = 'POST') => api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const loadRecords = async () => { RECORDS = await api('/api/records'); };
const loadSheets = async () => { SHEETS = await api('/api/sheets'); };
const loadPlans = async () => { PLANS = await api('/api/plans'); };
const loadStandards = async () => { STANDARDS = await api('/api/standards'); };
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
function showPage(page) {
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach((p) => (p.hidden = p.id !== 'page-' + page));
  const render = { dashboard: renderDashboard, plans: renderPlans, sheets: renderSheets, logs: renderLogs, analysis: renderAnalysis, standards: renderStandards, masters: renderMasters }[page];
  if (render) render();
}
function refreshCurrentPage() {
  showPage($('.nav-btn.active').dataset.page);
}

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
  if (PART === 'CAST') {
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
  return +matched.reduce((a, r) => a + num(part === 'SPLINT' ? r.totalRoll : r.prodQty), 0).toFixed(1);
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
/* 작업지시서 문서 렌더 — p는 계획 또는 제품정보 기반 plan-like 객체 */
function openOrderDoc(p, docNo) {
  const s = findStandard(p) || {};
  const img = s.images || {};
  const row = (label, v) => `<tr><th>${label}</th><td>${esc(v ?? '') || '-'}</td></tr>`;

  $('#order-body').innerHTML = `
    <div class="order-doc">
      <div class="order-head">
        <div class="order-title">작 업 지 시 서</div>
        <table class="order-sign"><tr><th>작성</th><th>검토</th><th>승인</th></tr><tr><td></td><td></td><td></td></tr></table>
      </div>
      <div class="order-meta">발행일: ${todayStr()} · 문서번호: ${esc(docNo || '')}</div>
      <h4>1. 생산 계획</h4>
      <table class="order-table">
        ${row('생산일', p.date)}${row('호기', p.machine)}${row('업체명', p.customer)}${row('주문 차수', p.orderNo)}
        ${row('제품명', `${p.product ?? ''} ${p.color ?? ''}`)}${row('제품코드', s.productCode)}${row('브랜드', s.brand)}
        ${row('규격', s.sizeSpec || (p.length ? p.length + 'm' : ''))}${row('계획수량', p.planQty != null ? fmt(p.planQty) + ' EA' : '')}${row('비고', p.note)}
      </table>
      <h4>2. 자재 기준 ${s.id ? `<span class="muted" style="font-weight:400">— 표준서: ${esc(s.product)}${s.note ? ' (' + esc(s.note) + ')' : ''}</span>` : '<span class="badge bad">제품표준서 미등록 — 제품표준서 탭에서 등록하세요</span>'}</h4>
      <table class="order-table">
        ${row('기재 종류', s.baseType)}${row('수지 종류', s.resinType)}${row('촉매', s.catalyst)}
        ${row('코팅량 규격', coatingSpec(s))}${row('코어 종류', s.core)}
        ${row('토너 종류', s.toner)}${row('파우치 종류', s.pouchType)}
      </table>
      <h4>3. 포장 기준 (제품표준서)</h4>
      <table class="order-table">
        ${row('라벨 표기', s.labelSpec)}${row('In Box', s.inBoxSpec)}${row('Out Box', s.outBoxSpec)}
      </table>
      <div class="order-photos">
        ${orderPhoto('라벨 · 파우치', img.pouch)}
        ${orderPhoto('In Box (내박스)', img.inBox)}
        ${orderPhoto('Out Box (외박스)', img.outBox)}
      </div>
      ${s.note ? `<h4>4. 표준서 비고</h4><p class="order-note">${esc(s.note)}</p>` : ''}
    </div>`;
  $('#order-modal').hidden = false;
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
$$('#standard-form .photo-slot').forEach((slot) => {
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
});

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

/* ===================== 일일 공정일지 ===================== */
function renderSheets() {
  let sheets = SHEETS.filter((s) => (s.part || 'CAST') === PART);
  const month = $('#s-month').value, mc = $('#s-machine').value;
  if (month) sheets = sheets.filter((s) => s.date && s.date.startsWith(month));
  if (mc) sheets = sheets.filter((s) => s.machine === mc);

  if (!sheets.length) { $('#sheets-table').innerHTML = '<div class="empty">작성된 일지가 없습니다. [＋ 일지 작성]으로 추가하세요.</div>'; return; }

  const rows = sheets.map((s) => {
    const lines = s.lines || [];
    const prodSum = (s.part || 'CAST') === 'SPLINT'
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
    </tr>`;
  }).join('');
  $('#sheets-table').innerHTML = `<table><thead><tr>
    <th>생산일</th><th>호기</th><th>작업자</th><th>생산 품목</th><th class="num">라인</th><th class="num">생산합계</th><th>작업시간</th><th>상태</th><th>특이사항</th>
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
  row.className = 'dyn-row' + (kind === 'line' || kind === 'sline' ? ' line-row' : '');
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
  const isSplint = s.part === 'SPLINT';
    for (const line of s.lines) {
      const base = isSplint
        ? {
          part: 'SPLINT',
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
          part: 'CAST',
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
};

let WS = null, wsPart = 'CAST', wsTab = 'basic', wsIsNew = false, wsSaveTimer = null, wsOrigRecordIds = [];

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
      : b.kind === 'cbaseloss' ? '＋ 기재 추가'
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

function updateSplintLive() {
  updateOrderLinks();
  const set = (k, v) => { const el = $(`#ws-panel [data-live="${k}"]`); if (el) el.textContent = v; };
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
  const sc = WS_SCHEMA[wsPart];
  $('#ws-part-badge').textContent = wsPart;
  $('#ws-part-badge').className = 'ws-part-badge ' + wsPart.toLowerCase();
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
  const ps = (WS.productInfos || []).map((p) => p.product).filter(Boolean);
  if (ps.length) prodDisp = ps[0] + (ps.length > 1 ? ` 외 ${ps.length - 1}` : '');
  $('#ws-summary').innerHTML = `${esc(WS.date || '')} · ${esc(WS.machine || '호기 미정')} · ${esc(prodDisp)} <span class="muted">${esc(WS.startTime || '')}${WS.endTime ? '~' + esc(WS.endTime) : ''}</span>`;
  const st = WS.status || '작성중';
  $('#ws-status-badge').innerHTML = `<span class="badge ${st === '완료' ? 'ok' : st === '진행' ? 'warn' : 'plain'}">${st}</span>`;
}
function renderWsTab() {
  const tab = WS_SCHEMA[wsPart].tabs.find((t) => t.id === wsTab);
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
  if (finishBtn) finishBtn.addEventListener('click', wsFinish);
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
  if (wsPart === 'SPLINT') WS.writer = [WS.leader, WS.assistant, WS.pack1, WS.pack2].filter(Boolean).join('/');
  if (wsPart === 'CAST') WS.writer = [WS.writer1, WS.writer2].filter(Boolean).join('/');
}

/* --- 자동저장 --- */
function scheduleWsSave() {
  $('#ws-save-status').textContent = '저장 중…';
  clearTimeout(wsSaveTimer);
  wsSaveTimer = setTimeout(saveWsNow, 700);
}
async function saveWsNow() {
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
  wsPart = part; wsTab = 'basic';
  if (id) {
    WS = JSON.parse(JSON.stringify(SHEETS.find((s) => s.id === id)));
    WS.part = part;
    wsIsNew = false;
    wsOrigRecordIds = (WS.lines || []).map((l) => l.recordId).filter(Boolean);
    // 구버전 SPLINT 일지 호환: writer만 있고 호기장 비었으면 채움
    if (part === 'SPLINT' && !WS.leader && WS.writer) WS.leader = WS.writer;
  } else {
    WS = { part, date: todayStr(), status: '작성중', lines: [] };
    const saved = await post('/api/sheets', WS);
    WS.id = saved.id; wsIsNew = true; wsOrigRecordIds = [];
  }
  $('#sheet-workspace').hidden = false;
  renderWorkspace();
}
function isEmptyWs() {
  return !WS.machine && !WS.writer && !WS.leader && !WS.startTime && !WS.product
    && !(WS.productInfos && WS.productInfos.length) && !(WS.products && WS.products.length)
    && !(WS.lines && WS.lines.length);
}
async function saveAndSyncWs() {
  // SPLINT은 제품별 실적 — 각 제품 행이 하나의 생산실적(레코드).
  // 제품별 ROLL/PRECUT 생산량 + 작업로스(제품명으로 매칭한 항목별 합계)
  if (wsPart === 'SPLINT') {
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
  // CAST도 제품별 실적 — 각 제품 행이 하나의 생산실적(레코드)
  if (wsPart === 'CAST') {
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
  if (PART === 'SPLINT') {
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
  const id = Number(tr.dataset.id);
  const rec = RECORDS.find((r) => r.id === id);
  if (!rec) return;
  const sheet = sheetOfRecord(id);
  if (sheet) return openWorkspace(sheet.part || 'CAST', sheet.id);
  if (partOf(rec) === 'SPLINT') openSplintModal(id);
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
const METRIC_LABELS_OF = () => PART_METRIC_LABELS[PART];
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
  const denom = PART === 'SPLINT' ? g.theoRoll : g.totalProdLoss;
  const totalLoss = PART === 'SPLINT' ? g.processDefect + g.prodDefect : g.totalLoss;
  const r2 = (x) => denom ? +(x / denom * 100).toFixed(2) : 0;
  if (metric === 'totalLossRate') return r2(totalLoss);
  if (metric === 'processLossRate') return r2(g.processDefect);
  if (metric === 'prodLossRate') return r2(g.prodDefect);
  if (metric === 'totalLoss') return PART === 'SPLINT' ? +totalLoss.toFixed(2) : g.totalLoss;
  if (metric === 'prodQty') return PART === 'SPLINT' ? +g.totalRoll.toFixed(1) : g.prodQty;
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
  if (PART === 'SPLINT') {
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

  /* --- 2) 교차 분석 (피벗) --- */
  renderPivot(recs, metric, isRate);

  /* --- 3) 불량 구성 --- */
  renderDefectCharts(recs);
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
  const cellTxt = (g) => g == null ? '<span class="muted">-</span>' : (isRate ? metricOf(g, metric).toFixed(2) + '%' : fmt(metricOf(g, metric), PART === 'SPLINT' ? 1 : 0));

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

  if (PART === 'SPLINT') {
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
  $('#masters-form').innerHTML = Object.keys(MASTER_LABELS).map((k) => `
    <div class="m-row">
      <label>${MASTER_LABELS[k]}</label>
      <input type="text" data-key="${k}" value="${esc((MASTERS[k] || []).join(', '))}">
    </div>`).join('') + '<button class="btn primary" id="btn-save-masters">기준정보 저장</button>';
  $('#btn-save-masters').addEventListener('click', async () => {
    const next = { ...MASTERS };
    $$('#masters-form input[data-key]').forEach((el) => {
      next[el.dataset.key] = el.value.split(',').map((s) => s.trim()).filter(Boolean);
    });
    MASTERS = await post('/api/masters', next, 'PUT');
    fillMasterInputs();
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
  ['#f-machine', '#p-machine', '#s-machine', '#a-machine'].forEach((sel) => { $(sel).innerHTML = mcOpts($(sel).querySelector('option').outerHTML); });
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
  const COLS = PART === 'SPLINT' ? SPLINT_CSV_COLS : CSV_COLS;
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

/* ===================== 초기화 ===================== */
(async function init() {
  await Promise.all([loadRecords(), loadSheets(), loadPlans(), loadStandards(), loadMasters()]);
  fillMasterInputs();
  updateMetricLabels();
  const latest = RECORDS.length ? RECORDS[0].date : todayStr();
  $('#dash-month').value = latest.slice(0, 7);
  $('#s-month').value = latest.slice(0, 7);
  renderDashboard();
})();
