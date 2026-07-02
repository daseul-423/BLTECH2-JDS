/* 고객사명 통일: '시그맥스' 계열 → 'SIGMAX' 로 db.json 전체에서 일괄 변경.
 *   실행: node scripts/unify-customer.mjs
 *   대상: records/plans/sheets/custspecs/standards 의 customer, sheets의 productInfos·lines,
 *         제품명에 박힌 "(시그맥스)", masters.customers/customerTypes.
 */
import fs from 'node:fs';
import path from 'node:path';

const DB = path.join(process.cwd(), 'test1', 'data', 'db.json');
const db = JSON.parse(fs.readFileSync(DB, 'utf8'));

const CANON = 'SIGMAX';
const ALIASES = new Set(['시그맥스(Sigmax)', '시그맥스', 'Sigmax', 'sigmax']);
const canon = (c) => (c != null && ALIASES.has(String(c).trim())) ? CANON : c;

let n = 0;
const fix = (obj, key) => { if (obj && ALIASES.has(String(obj[key] ?? '').trim())) { obj[key] = CANON; n++; } };

(db.records || []).forEach((r) => fix(r, 'customer'));
(db.plans || []).forEach((p) => fix(p, 'customer'));
(db.custspecs || []).forEach((s) => fix(s, 'customer'));
(db.standards || []).forEach((s) => {
  fix(s, 'customer');
  if (typeof s.product === 'string' && s.product.includes('(시그맥스)')) { s.product = s.product.replace('(시그맥스)', '(' + CANON + ')'); n++; }
});
(db.sheets || []).forEach((sh) => {
  (sh.productInfos || []).forEach((pi) => fix(pi, 'customer'));
  (sh.lines || []).forEach((l) => fix(l, 'customer'));
});

if (db.masters) {
  db.masters.customers = [...new Set((db.masters.customers || []).map(canon))];
  const next = {};
  for (const [k, v] of Object.entries(db.masters.customerTypes || {})) next[canon(k)] = v;
  db.masters.customerTypes = next;
}

fs.writeFileSync(DB, JSON.stringify(db, null, 2), 'utf8');
console.log('통일 완료: %d개 값 변경 → %s', n, CANON);
console.log('customers:', JSON.stringify(db.masters.customers));
console.log('customerTypes:', JSON.stringify(db.masters.customerTypes));
