/* AI 어시스턴트 (Firebase Cloud Functions v2, OpenAI 프록시).
 *
 *   chat  : 생산데이터·사내규정 질의응답 (+ 사용자가 첨부한 이미지 인식)
 *   image : 이미지 생성 (gpt-image-2, /v1/images/generations)
 *
 * 보안:
 *   - OPENAI_API_KEY는 Secret Manager에서만 읽음 (코드/깃/클라이언트에 노출 안 됨).
 *       최초 1회: firebase functions:secrets:set OPENAI_API_KEY
 *   - 두 함수 모두 "로그인한 활성 사용자"만 호출 가능:
 *       Authorization: Bearer <Firebase ID토큰> 검증 + users/{uid}.active !== false
 *       (서비스계정 키 파일 불필요 — 함수 실행환경의 기본 권한 사용)
 *   - Hosting rewrite: /api/chat → chat, /api/image → image
 */
const { onRequest } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');

admin.initializeApp();
setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

const CHAT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
const DATA_URL_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;
// 클라이언트가 보낼 수 있는 크기 (비율 × 크기 프리셋) — 그 외는 거부
const ALLOWED_SIZES = new Set([
  'auto', '1024x1024', '1536x1536', '2048x2048',
  '1536x1024', '1920x1280', '2496x1664',
  '1024x1536', '1280x1920', '1664x2496',
  '1280x720', '1920x1088', '3840x2160',
  '720x1280', '1088x1920', '2160x3840',
]);

/** 로그인 + 활성 사용자 확인. 통과하면 uid, 아니면 응답을 보내고 null 반환 */
async function requireActiveUser(req, res) {
  const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m) { res.status(401).json({ error: '로그인이 필요합니다.' }); return null; }
  let uid;
  try { uid = (await admin.auth().verifyIdToken(m[1])).uid; }
  catch (e) { res.status(401).json({ error: '인증 토큰이 유효하지 않습니다.' }); return null; }
  try {
    const snap = await admin.firestore().collection('users').doc(uid).get();
    if (!snap.exists || snap.data().active === false) {
      res.status(403).json({ error: '접근 권한이 없습니다. (비활성 또는 미등록 사용자)' });
      return null;
    }
  } catch (e) { res.status(500).json({ error: '권한 확인 실패: ' + (e.message || e) }); return null; }
  return uid;
}

/* ─────────────── 질의응답 (이미지 인식 지원) ─────────────── */
exports.chat = onRequest({ secrets: ['OPENAI_API_KEY'], cors: false, timeoutSeconds: 120 }, async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  if (!(await requireActiveUser(req, res))) return;

  const key = process.env.OPENAI_API_KEY;
  if (!key) { res.status(500).json({ error: 'OPENAI_API_KEY 미설정 (Secret Manager)' }); return; }
  try {
    const body = req.body || {};
    const question = String(body.question || '').slice(0, 4000);
    const context = body.context ? JSON.stringify(body.context).slice(0, 60000) : '';
    const images = Array.isArray(body.images) ? body.images.filter((u) => DATA_URL_RE.test(u)).slice(0, 4) : [];
    if (!question && !images.length) { res.status(400).json({ error: 'question 필요' }); return; }

    const sys = `당신은 BL-TECH 생산1팀의 생산데이터 분석 도우미입니다. 아래 JSON 데이터(생산실적·불량·사양·설비·사내규정 등)를 근거로 한국어로 간결하고 정확하게 답합니다. 숫자는 데이터에서 계산해 제시하고, 근거가 없으면 모른다고 하세요.
답변은 **마크다운**으로 작성하세요: 비교·집계는 표(|---|)로, 목록은 -, 핵심 수치는 **굵게**, 필요하면 ## 소제목을 쓰고 적절한 이모지로 가독성을 높이세요. 사용자가 이미지를 첨부하면 그 이미지를 함께 해석해 답하세요.

[데이터]
${context}`;

    const userContent = images.length
      ? [{ type: 'text', text: question || '이 이미지를 설명해줘.' }, ...images.map((u) => ({ type: 'image_url', image_url: { url: u } }))]
      : question;

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CHAT_MODEL, temperature: 0.2,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: userContent }],
      }),
    });
    const data = await r.json();
    if (!r.ok) { res.status(502).json({ error: 'OpenAI 오류: ' + ((data.error && data.error.message) || r.status) }); return; }
    res.status(200).json({ answer: (data.choices && data.choices[0] && data.choices[0].message.content) || '(응답 없음)' });
  } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
});

/* ─────────────── 이미지 생성 (gpt-image-2) ─────────────── */
exports.image = onRequest({ secrets: ['OPENAI_API_KEY'], cors: false, timeoutSeconds: 300, memory: '512MiB' }, async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  if (!(await requireActiveUser(req, res))) return;

  const key = process.env.OPENAI_API_KEY;
  if (!key) { res.status(500).json({ error: 'OPENAI_API_KEY 미설정 (Secret Manager)' }); return; }
  try {
    const body = req.body || {};
    const prompt = String(body.prompt || '').slice(0, 4000).trim();
    const size = ALLOWED_SIZES.has(body.size) ? body.size : '1024x1024';
    const quality = ['low', 'medium', 'high', 'auto'].includes(body.quality) ? body.quality : 'high';
    if (!prompt) { res.status(400).json({ error: '생성할 이미지 설명(prompt)이 필요합니다.' }); return; }

    const r = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: IMAGE_MODEL, prompt, size, quality, n: 1 }),
    });
    const data = await r.json();
    if (!r.ok) { res.status(502).json({ error: 'OpenAI 오류: ' + ((data.error && data.error.message) || r.status) }); return; }
    const b64 = data.data && data.data[0] && data.data[0].b64_json;
    if (!b64) { res.status(502).json({ error: '이미지를 받지 못했습니다.' }); return; }
    res.status(200).json({ image: 'data:image/png;base64,' + b64, size, quality });
  } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
});
