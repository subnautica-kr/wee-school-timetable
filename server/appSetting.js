// 앱 설정 칸(app_setting) 읽고 쓰기 — 키는 코드 상수 둘뿐이다.
export const SETTING = Object.freeze({ CAPTCHA: 'signup_captcha', CONTACT_SUPER: 'contact_super' });

export async function getSetting(db, key) {
  const row = (await db.query(`SELECT value FROM app_setting WHERE key = $1`, [key])).rows[0];
  return row ? row.value : null;
}

export async function setSetting(db, key, value) {
  if (value === null) { await db.query(`DELETE FROM app_setting WHERE key = $1`, [key]); return; }
  await db.query(
    `INSERT INTO app_setting (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

// 가입 캡차가 켜졌나 — 시험·배포가 준 값(opt) > 총괄관리자 스위치 > 환경변수(기본 끔)
export async function captchaOn(db, opt) {
  if (opt !== undefined && opt !== null) return !!opt;
  const v = await getSetting(db, SETTING.CAPTCHA);
  if (typeof v === 'boolean') return v;
  return process.env.SIGNUP_CAPTCHA === 'on';
}

// 가입 화면이 보여 줄 연락처 — 값만({ super } · 비었으면 키를 뺀다)
export async function publicContacts(db) {
  const v = await getSetting(db, SETTING.CONTACT_SUPER);
  return typeof v === 'string' && v.trim() ? { super: v } : {};
}
