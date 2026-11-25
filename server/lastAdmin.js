import { ROLE, MEMBER_STATUS_LOGIN } from '../shared/codes.js';

// 마지막 기관 관리자 판정(T-1322b②b) — 막지 않고 「경고 뒤 허용」: 이 일을 하면 로그인할 수 있는 기관 관리자가 0 명이 되는가.
// 관리자로 세는 줄 = 계정이 연결된 재직·휴직 기관 관리자(계정 없는 줄·숨김·전출은 안 센다 — noAdminSchools 와 같은 조건).
// 대상은 줄 번호(mid)나 계정 번호(userId)로 가리킨다. 대상이 관리자로 안 세어지는 줄이면 내려도 달라지는 게 없어 false.
export async function isLastAdmin(db, orgId, { mid = -1, userId = -1 } = {}) {
  const { rows: [r] } = await db.query(
    `SELECT count(*) FILTER (WHERE m.id = $2 OR m.user_id = $3)::int AS mine,
            count(*) FILTER (WHERE NOT (m.id = $2 OR m.user_id = $3))::int AS others
       FROM membership m
      WHERE m.org_id = $1 AND m.role = $4 AND m.user_id IS NOT NULL AND m.status = ANY($5::text[]) AND m.deleted_at IS NULL`,
    [orgId, mid, userId, ROLE.ORG_ADMIN, MEMBER_STATUS_LOGIN]);
  return r.mine > 0 && r.others === 0;
}

// 「그래도 하겠다」 확인 — 본문 force: true 나 ?force=1
export const forced = (req) => req.body?.force === true || req.query?.force === '1';
