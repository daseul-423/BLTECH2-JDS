/* AI 분석 챗봇 (Vercel 서버리스, OpenAI 프록시).
 *   키는 서버 env(OPENAI_API_KEY)에서만 읽음 — 클라이언트/깃에 절대 노출 안 됨.
 *   Vercel 프로젝트 Settings → Environment Variables 에 OPENAI_API_KEY 등록 필요.
 */
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  const key = process.env.OPENAI_API_KEY;
  if (!key) { res.status(500).json({ error: 'OPENAI_API_KEY 미설정 (Vercel 환경변수에 등록하세요)' }); return; }
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
};
