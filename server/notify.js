// 알림 보내기 공용 함수(T-1320b) — 앱 안 「소식」 한 줄을 넣는다. 읽음은 사람별 표(notification_read)라 여기선 안 건드린다.
// 받는 쪽(설계 「알림」 절):
//   { orgId }            → 학교 소식: 그 학교 기관 관리자 전원(audience org_admins)
//   { userId }           → 개인 소식: 당사자(audience user · orgId 를 같이 주면 어느 학교 일인지 적어 둠)
//   { sysadmin: true }   → 총괄관리자(audience sysadmin)
// 할 일(가입 승인 대기·받은 전출 요청)은 알림 줄이 아니라 건수다 — 여기로 보내지 않는다.
// text 는 부른 쪽이 t('<영역>.<키>', vars) 로 만든 문장. kind 는 영어 코드(종류 거르기·정리용).

import { registerCleanup } from './cleanup.js';

export const AUDIENCE =Object.freeze({ ORG_ADMINS: 'org_admins', USER: 'user', SYSADMIN: 'sysadmin' });

// 반환 { id, audience }
export async function notify(db, { orgId = null, userId = null, sysadmin = false, kind, text, link = null }) {
  if (!kind || !text) throw new Error('notify: kind and text required');
  let audience;
  if (sysadmin) audience = AUDIENCE.SYSADMIN;
  else if (userId != null) audience = AUDIENCE.USER;
  else if (orgId != null) audience = AUDIENCE.ORG_ADMINS;
  else throw new Error('notify: one of orgId, userId, sysadmin required');
  const r = await db.query(
    `INSERT INTO notification (audience, org_id, user_id, kind, text, link) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [audience, orgId, audience === AUDIENCE.SYSADMIN ? null : userId, kind, text, link],
  );
  return { id: Number(r.rows[0].id), audience };
}

// 읽는 쪽(T-1323) — 사람 하나가 볼 수 있는 소식의 조건. $1 = 사용자 id · $2 = 총괄관리자인가(세션 역할) · $3 = 기관 관리자 역할값 · $4 = 재직 중 값(코드 상수를 넘긴다).
//   학교 소식 = 내가 기관 관리자로 있는 학교(겸임이면 여러 학교) · 개인 소식 = 내 것 · 총괄관리자 소식 = 총괄관리자만
export const VISIBLE_SQL = `(
  (n.audience = 'user' AND n.user_id = $1)
  OR (n.audience = 'org_admins' AND n.org_id IN (SELECT org_id FROM membership WHERE user_id = $1 AND role = $3 AND status = $4 AND deleted_at IS NULL))
  OR (n.audience = 'sysadmin' AND $2::boolean)
)`;

// 소식은 90일이 지나면 지운다(읽음 표는 ON DELETE CASCADE 로 같이 간다). now 를 받아 시험이 시계를 옮길 수 있다.
export const NEWS_KEEP_DAYS = 90;
registerCleanup('notification-90d', async (db, now) => {
  const r = await db.query(`DELETE FROM notification WHERE created_at < $1::timestamptz - ($2::int * interval '1 day')`, [now, NEWS_KEEP_DAYS]);
  return r.rowCount;
});
