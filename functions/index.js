/* AI 분석 챗봇 (Firebase Cloud Functions v2, OpenAI 프록시).
 *
 * 보안:
 *   - OPENAI_API_KEY는 Secret Manager에서만 읽음 (코드/깃/클라이언트에 노출 안 됨).
 *       최초 1회: firebase functions:secrets:set OPENAI_API_KEY
 *   - 호출은 "로그인한 활성 사용자"만 가능:
 *       클라이언트가 Authorization: Bearer <Firebase ID토큰> 전송 →
 *       admin.auth().verifyIdToken() 검증 + users/{uid}.active !== false 확인.
 *       (서비스계정 키 파일 불필요 — 함수 실행환경의 기본 권한(ADC) 사용)
 *   - Hosting rewrite로 /api/chat → 이 함수에 연결 (프론트 코드 변경 최소화)
 */
const { onRequest } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');

admin.initializeApp();
setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

exports.chat = onRequest({ secrets: ['OPENAI_API_KEY'], cors: false }, async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  // ── 로그인 사용자 인증 (없으면 401) ──
  const authHeader = req.headers.authorization || '';
  const m = authHeader.match(/^Bearer (.+)$/);
  if (!m) { res.status(401).json({ error: '로그인이 필요합니다.' }); return; }
  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(m[1]);
    uid = decoded.uid;
  } catch (e) { res.status(401).json({ error: '인증 토큰이 유효하지 않습니다.' }); return; }
  try {
    const snap = await admin.firestore().collection('users').doc(uid).get();
    if (!snap.exists || snap.data().active === false) {
      res.status(403).json({ error: '접근 권한이 없습니다. (비활성 또는 미등록 사용자)' });
      return;
    }
  } catch (e) { res.status(500).json({ error: '권한 확인 실패: ' + (e.message || e) }); return; }

  // ── OpenAI 프록시 (키는 서버에서만 사용) ──
  const key = process.env.OPENAI_API_KEY;
  if (!key) { res.status(500).json({ error: 'OPENAI_API_KEY 미설정 (Secret Manager)' }); return; }
  try {
    const body = req.body || {};
    const question = String(body.question || '').slice(0, 4000);
    const context = body.context ? JSON.stringify(body.context).slice(0, 60000) : '';
    if (!question) { res.status(400).json({ error: 'question 필요' }); return; }
    const sys = `당신은 BL-TECH 생산1팀의 생산데이터 분석 도우미입니다. 아래 JSON 데이터(생산실적·불량·사양·설비 등)를 근거로 한국어로 간결하고 정확하게 답합니다. 숫자는 데이터에서 계산해 제시하고, 근거가 없으면 모른다고 하세요. 표/목록으로 보기 좋게 정리하세요.\n\n[데이터]\n${context}`;
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OPENAI_MODEL, temperature: 0.2, messages: [{ role: 'system', content: sys }, { role: 'user', content: question }] }),
    });
    const data = await r.json();
    if (!r.ok) { res.status(502).json({ error: 'OpenAI 오류: ' + ((data.error && data.error.message) || r.status) }); return; }
    res.status(200).json({ answer: (data.choices && data.choices[0] && data.choices[0].message.content) || '(응답 없음)' });
  } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
});
