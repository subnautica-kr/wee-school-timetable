// 겸임 기간(T-1322b②c) — 기한 계산 · 소식 · 「끝나기 30일 전 알림 → 기한이 지나면 연결 풀기」 정리 작업.
// 날짜는 전부 한국 시간(KST) 기준 'YYYY-MM-DD' 글자로 다룬다(DATE 칸은 SQL 에서 to_char 로 읽는다 — 시간대 어긋남 방지).
import { registerCleanup } from './cleanup.js';
import { notify } from './notify.js';
import { unlinkAccount } from './link.js';
import { t } from '../shared/text/index.js';
import { DORMANT_REASON } from '../shared/codes.js';

export const WARN_DAYS = 30;
const KST_MS = 9 * 60 * 60 * 1000;
const pad = (n) => String(n).padStart(2, '0');

// 한국 시간의 오늘 'YYYY-MM-DD'
export function kstToday(now = new Date()) {
  const k = new Date(now.getTime() + KST_MS);
  return `${k.getUTCFullYear()}-${pad(k.getUTCMonth() + 1)}-${pad(k.getUTCDate())}`;
}

// 그 학년도(3월~다음 해 2월)의 2월 말일 — 3~12월이면 다음 해 2월, 1~2월이면 올해 2월. 윤년이면 29일.
export function defaultConcurrentUntil(now = new Date()) {
  const k = new Date(now.getTime() + KST_MS);
  const y = k.getUTCMonth() + 1 >= 3 ? k.getUTCFullYear() + 1 : k.getUTCFullYear();
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return `${y}-02-${leap ? 29 : 28}`;
}

// 'YYYY-MM-DD' 가 실제 있는 날인가
export function isRealDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '');
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

// 기한 입력 풀이 — 안 줬으면 기본값, 준 것은 실제 있는 날이고 오늘 이후여야 한다. 반환 { until } | { error }
export function resolveUntil(input, now = new Date()) {
  if (input == null || input === '') return { until: defaultConcurrentUntil(now) };
  if (!isRealDate(input) || input < kstToday(now)) return { error: 'roster.err.concurrent_until_bad' };
  return { until: input };
}

const orgName = async (db, id) => (await db.query(`SELECT name FROM org WHERE id = $1`, [id])).rows[0]?.name ?? '';
const homeOrgs = async (db, userId, exceptOrg) => (await db.query(
  `SELECT DISTINCT org_id FROM membership WHERE user_id = $1 AND org_id <> $2 AND deleted_at IS NULL AND NOT is_concurrent`,
  [userId, exceptOrg])).rows.map((x) => Number(x.org_id));

// 겸임 소식 — 겸임 학교(orgId)와 본 소속 학교 양쪽 관리자에게. key = linked|extended|warn|ended · 문장의 「학교」는 상대 학교 이름
// homes — 본 소속 학교들(연결을 풀기 전에 읽어 넘길 때만 준다)
export async function notifyConcurrent(db, { key, orgId, userId, name, until, homes = null }) {
  const hs = homes ?? await homeOrgs(db, userId, orgId);
  const here = await orgName(db, orgId);
  const home = hs.length ? await orgName(db, hs[0]) : here;
  const kind = `concurrent.${key}`;
  const vars = { 이름: name ?? '', 기한: until };
  for (const h of hs) await notify(db, { orgId: h, kind, text: t(`roster.concurrent_notice.${key}`, { ...vars, 학교: here }) });
  await notify(db, { orgId, kind, text: t(`roster.concurrent_notice.${key}`, { ...vars, 학교: home }) });
}

// 정리 작업 — ① 끝나기 30일 안으로 들어온 겸임에 소식 한 번(concurrent_warned_until 이 기한과 같으면 이미 낸 것)
//             ② 기한이 지난 겸임은 연결을 풀고(「연결 안 된 계정」 묶음엔 안 세움) 종료 소식
export async function concurrentEnd(db, now) {
  const today = kstToday(now);
  const warnRows = (await db.query(
    `SELECT id, org_id, user_id, name, to_char(concurrent_until, 'YYYY-MM-DD') AS until FROM membership
      WHERE is_concurrent AND user_id IS NOT NULL AND deleted_at IS NULL AND concurrent_until IS NOT NULL
        AND concurrent_until >= $1::date AND concurrent_until - $1::date <= $2::int
        AND concurrent_warned_until IS DISTINCT FROM concurrent_until
      ORDER BY id`, [today, WARN_DAYS])).rows;
  let n = 0;
  for (const w of warnRows) {
    await notifyConcurrent(db, { key: 'warn', orgId: w.org_id, userId: w.user_id, name: w.name, until: w.until });
    await db.query(`UPDATE membership SET concurrent_warned_until = concurrent_until WHERE id = $1`, [w.id]);
    n++;
  }
  const endRows = (await db.query(
    `SELECT id, org_id, user_id, name, to_char(concurrent_until, 'YYYY-MM-DD') AS until FROM membership
      WHERE is_concurrent AND user_id IS NOT NULL AND deleted_at IS NULL AND concurrent_until IS NOT NULL
        AND concurrent_until < $1::date ORDER BY id`, [today])).rows;
  for (const e of endRows) {
    const homes = await homeOrgs(db, e.user_id, e.org_id); // 풀기 전에 읽는다
    const u = await unlinkAccount(db, { membershipId: e.id, byUserId: null, reason: DORMANT_REASON.REMOVED });
    if (u.error) continue;
    await db.query(`UPDATE membership SET concurrent_until = NULL, concurrent_warned_until = NULL WHERE id = $1`, [e.id]);
    await notifyConcurrent(db, { key: 'ended', orgId: e.org_id, userId: e.user_id, name: e.name, until: e.until, homes });
    n++;
  }
  return n;
}
registerCleanup('concurrent-end', concurrentEnd);
