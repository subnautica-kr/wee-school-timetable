// 명단 「계정 연결」 화면의 순수 계산 — 시험: test/roster-link-view.test.js
const DAY = 86400000;

// 계정 열: 이 학교에 연결된 계정이 둘 이상일 때만 보인다(기관 관리자 본인 하나뿐이면 「—」 줄만 늘어선 열을 안 본다)
export const accountColumnShown = (rows) => rows.filter((r) => r.hasAccount).length > 1;

// 「연결 안 된 계정」 묶음에서 다시 연결할 줄 — 아직 계정이 없는 줄만
export const freeLineOptions = (rows) => rows.filter((r) => !r.hasAccount).map((r) => ({ value: String(r.id), label: r.name }));

// 서버 409 needConfirm 본문 → 보여 줄 경고 글 목록(서버가 문구를 이미 채워 보낸다)
export const warningLines = (body) => (body?.warnings || []).map((w) => w.text).filter(Boolean);
export const needsConfirm = (e) => e?.status === 409 && !!e?.body?.needConfirm;

// 자동으로 내보내기까지 남은 날(올림) · 내보낼 날 글자(YYYY-MM-DD, 이 기기 시각대)
export const daysLeft = (expiresAt, now = Date.now()) => Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / DAY));
export const dateText = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
