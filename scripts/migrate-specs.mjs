/* 1회 마이그레이션: 기존 standards(제품표준서)에서 고객사별 생산사양(custspecs)을 파생.
 *
 *   실행: node scripts/migrate-specs.mjs   (여러 번 실행해도 custspecs를 매번 새로 빌드 = idempotent)
 *
 *   - 비파괴(additive): standards는 그대로 두고 custspecs를 standards로부터 재생성.
 *     (새 작업지시서는 자재기준만 standards에서, 코팅/토너/포장은 custspecs에서 읽음)
 *   - OEM 판정: 기존 데이터는 OEM을 "제품명(고객)" 형태로 인코딩함
 *       예) NPC-F(시그맥스), NAC-F(크로실-전용). 괄호 안 텍스트 = OEM 고객사.
 *     또는 customer 필드가 '내수'/공백이 아닌 실제 고객사면 OEM.
 *   - NEAL: 괄호 없고 customer가 비었거나 '내수'/'공용' → 제품 공통(customer=null).
 *   - OEM 고객사는 masters.customers에 추가하고 masters.customerTypes[고객]='OEM'.
 *   실행 후 관리자 화면에서 NEAL/OEM 지정을 확인/수정할 수 있음.
 */
import fs from 'node:fs';
import path from 'node:path';

const DB = path.join(process.cwd(), 'test1', 'data', 'db.json');
const db = JSON.parse(fs.readFileSync(DB, 'utf8'));

db.seqs = db.seqs || {};
db.masters = db.masters || {};
db.masters.customers = db.masters.customers || [];
db.masters.customerTypes = db.masters.customerTypes || {};

// 매 실행마다 custspecs 재생성 (standards로부터 파생이므로 안전)
db.custspecs = [];
db.seqs.custspecs = 1;

const NEAL_CUSTOMERS = ['', '내수', '공용', 'NEAL', 'neal'];
const isNeal = (c) => c == null || NEAL_CUSTOMERS.includes(String(c).trim());
const parseVariant = (product) => {
  const m = /^(.+?)\s*\((.+)\)\s*$/.exec(String(product || '').trim());
  return m ? { base: m[1].trim(), variant: m[2].trim() } : { base: String(product || '').trim(), variant: null };
};

const oemCustomers = new Set();
for (const s of db.standards || []) {
  const { base, variant } = parseVariant(s.product);
  let specType, customer, product;
  if (variant) {                       // "제품(고객)" → OEM
    specType = 'OEM'; customer = variant; product = base;
  } else if (!isNeal(s.customer)) {    // customer 필드가 실제 고객사 → OEM
    specType = 'OEM'; customer = String(s.customer).trim(); product = base;
  } else {                             // NEAL 공통
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
    coatingMin: s.coatingMin ?? null,
    coatingMid: s.coatingMid ?? null,
    coatingMax: s.coatingMax ?? null,
    toner: s.toner ?? null,
    labelSpec: s.labelSpec ?? null,
    pouchType: s.pouchType ?? null,
    inBoxSpec: s.inBoxSpec ?? null,
    outBoxSpec: s.outBoxSpec ?? null,
    manualSpec: null,   // 설명서 (신규)
    enclosures: null,   // 동봉품 (신규)
    packingNote: null,  // 포장 주의사항 (신규)
    images: s.images && typeof s.images === 'object' ? s.images : { pouch: '', inBox: '', outBox: '' },
    note: s.note ?? null,
  });
}

// OEM 고객사를 masters에 반영
for (const c of oemCustomers) {
  if (!db.masters.customers.includes(c)) db.masters.customers.push(c);
  db.masters.customerTypes[c] = 'OEM';
}

fs.writeFileSync(DB, JSON.stringify(db, null, 2), 'utf8');
const oem = db.custspecs.filter((x) => x.specType === 'OEM');
console.log('마이그레이션 완료: custspecs=%d (NEAL=%d, OEM=%d)',
  db.custspecs.length, db.custspecs.length - oem.length, oem.length);
console.log('OEM 고객사:', [...oemCustomers].join(', ') || '(없음)');
console.log('customerTypes:', JSON.stringify(db.masters.customerTypes));
