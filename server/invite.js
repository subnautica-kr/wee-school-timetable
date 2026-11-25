// 초대 코드(T-1302b①) — 명단 줄 하나에 코드 하나. 기관 관리자가 발급·재발급하고, 연결이 되면 무효가 된다(link.js).
// 코드 「쓰는 쪽」(확인·사용 = used_at)은 가입 서버(server/routes/signup.js applyCode · T-1321①b) 몫 — 여기는 발급·재발급(앞 코드 revoked_at)만.
// 꼴: 헷갈리는 글자(0·O·1·I·L)를 뺀 대문자·숫자 8자(예 「K7QXM3HP」). 가입 쪽은 code 를 글자 그대로 맞춘다.
import { randomInt } from 'node:crypto';
import { INVITE_KIND } from '../shared/codes.js';

export const INVITE_DAYS = 7;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const INVITE_RE = /^[A-HJKMNP-Z2-9]{8}$/;

export function newInviteCode() {
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

// 발급·재발급 — 그 줄의 살아 있는 코드를 무효로 하고 새 코드 하나(7일). db 는 거래 안 클라이언트여도 된다.
// 반환 { code, expiresAt, first } (first: 이 학교에서 처음 낸 코드 — 화면의 「연락처 적기 권유」 한 번) 또는 { error }
export async function issueInvite(db, { orgId, membershipId, byUserId = null, kind = INVITE_KIND.MOVE_IN }) {
  const line = (await db.query(
    `SELECT user_id FROM membership WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [membershipId, orgId],
  )).rows[0];
  if (!line) return { error: 'roster.err.line_not_found' };
  if (line.user_id != null) return { error: 'roster.err.invite_linked' };
  const first = !(await db.query(`SELECT 1 FROM invite_code WHERE org_id = $1 LIMIT 1`, [orgId])).rows[0];
  await db.query(
    `UPDATE invite_code SET revoked_at = now() WHERE membership_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [membershipId],
  );
  for (let i = 0; i < 5; i++) {
    const r = (await db.query(
      `INSERT INTO invite_code (org_id, membership_id, kind, code, expires_at, created_by)
       VALUES ($1,$2,$3,$4, now() + make_interval(days => $5), $6)
       ON CONFLICT (code) DO NOTHING RETURNING code, expires_at`,
      [orgId, membershipId, kind, newInviteCode(), INVITE_DAYS, byUserId],
    )).rows[0];
    if (r) return { code: r.code, expiresAt: r.expires_at, first };
  }
  throw new Error('issueInvite: code collision');
}
