/* 1회 마이그레이션: 기존 standards(제품표준서)에서 고객사별 생산사양(custspecs)을 파생.
 *
 *   실행: node scripts/migrate-specs.mjs   (custspecs를 매번 새로 빌드 = idempotent)
 *
 *   모델: 사양의 '적용 대상'은 [기본 NEAL(제품 공통)] 또는 [특정 고객사]. 고객사마다 자기 사양을 가진다.
 *   - OEM 판정: 기존 데이터는 "제품명(고객사)" 형태로 인코딩. 예) NPC-F(시그맥스), NAC-F(크로실-백).
 *       괄호 안이 고객사. "크로실-백"처럼 하이픈이 있으면 고객사=크로실, 변형=백 으로 분리(같은 고객사로 합침).
 *   - NEAL: 괄호 없고 customer가 비었거나 '내수'/'공용' → 제품 공통(customer=null).
 *   - masters.customerTypes 를 새로 계산(고객사→'OEM'), 잘못 나뉜 고객사명은 정리.
 */
import fs from 'node:fs';
import path from 'node:path';

const DB = path.join(process.cwd(), 'test1', 'data', 'db.json');
const db = JSON.parse(fs.readFileSync(DB, 'utf8'));

db.seqs = db.seqs || {};
db.masters = db.masters || {};
db.masters.customers = db.masters.customers || [];
db.custspecs = [];
db.seqs.custspecs = 1;
db.masters.customerTypes = {}; // 새로 계산

const NEAL_CUSTOMERS = ['', '내수', '공용', 'NEAL', 'neal'];
const isNeal = (c) => c == null || NEAL_CUSTOMERS.includes(String(c).trim());
const parseVariant = (product) => {
  const m = /^(.+?)\s*\((.+)\)\s*$/.exec(String(product || '').trim());
  return m ? { base: m[1].trim(), variant: m[2].trim() } : { base: String(product || '').trim(), variant: null };
};

const oemCustomers = new Set();
const splitAway = new Set(); // 하이픈으로 분리되어 사라질 원래 명칭(크로실-백 등)
for (const s of db.standards || []) {
  const { base, variant } = parseVariant(s.product);
  let specType, customer, product, variantQual = null;
  if (variant) {
    // "크로실-백" → 고객사=크로실, 변형=백 (같은 고객사로 합침)
    const i = variant.indexOf('-');
    if (i > 0) { customer = variant.slice(0, i).trim(); variantQual = variant.slice(i + 1).trim(); splitAway.add(variant); }
    else { customer = variant; }
    specType = 'OEM'; product = base;
  } else if (!isNeal(s.customer)) {
    specType = 'OEM'; customer = String(s.customer).trim(); product = base;
  } else {
    specType = 'NEAL'; customer = null; product = base;
  }
  if (customer) oemCustomers.add(customer);
  db.custspecs.push({
    id: db.seqs.custspecs++,
    part: s.part || 'CAST',
    product,
    color: s.color || null,
    specType,
    customer,
    variant: variantQual,   // 같은 고객사·제품 내 구분(예: 백/전용)
    coatingMin: s.coatingMin ?? null,
    coatingMid: s.coatingMid ?? null,
    coatingMax: s.coatingMax ?? null,
    toner: s.toner ?? null,
    labelSpec: s.labelSpec ?? null,
    pouchType: s.pouchType ?? null,
    inBoxSpec: s.inBoxSpec ?? null,
    outBoxSpec: s.outBoxSpec ?? null,
    manualSpec: null,
    enclosures: null,
    packingNote: null,
    images: s.images && typeof s.images === 'object' ? s.images : { pouch: '', inBox: '', outBox: '' },
    note: s.note ?? null,
  });
}

// 고객사 목록 정리: 분리로 사라진 원래명 제거, 실제 OEM 고객사 추가, 타입 지정
db.masters.customers = db.masters.customers.filter((c) => !splitAway.has(c));
for (const c of oemCustomers) {
  if (!db.masters.customers.includes(c)) db.masters.customers.push(c);
  db.masters.customerTypes[c] = 'OEM';
}

fs.writeFileSync(DB, JSON.stringify(db, null, 2), 'utf8');
const oem = db.custspecs.filter((x) => x.specType === 'OEM');
console.log('마이그레이션 완료: custspecs=%d (NEAL=%d, OEM=%d)', db.custspecs.length, db.custspecs.length - oem.length, oem.length);
console.log('OEM 고객사:', [...oemCustomers].join(', ') || '(없음)');
console.log('변형 분리 정리:', [...splitAway].join(', ') || '(없음)');
console.log('customers:', JSON.stringify(db.masters.customers));
