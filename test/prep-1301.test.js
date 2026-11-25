// T-1301 준비 — 바퀴 3 이 기대는 사실을 시험으로 박아 둔다(지어낸 이름만).
// ① 계정(app_user)을 가리키는 외래키는 정확히 셋 — 학교 쪽 표(반·시수표·칸 …)에서 계정으로 가는 외래키 0건.
// ② 51반 가명 명단 67줄을 같은 요청 네 번으로 올려도 사람은 한 번씩만 만들어지고, 올린 뒤 명단 읽기가 200 이다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bigSchool } from './fixtures/schools.js';
import { setupSchoolEnv, HAS_DB } from './fixtures/school-env.js';

const skip = !HAS_DB && 'DB 없음 — 건너뜀';

// 계정을 가리켜도 되는 표: 소속(줄) · 감사 기록 · 지운 묶음. 학교 쪽 표는 줄(membership)만 거쳐 계정에 닿는다.
// 014(T-1320b) 계정 쪽 새 표 — 계정에 딸린 기록(초대·알림·글·이동 요청)이라 허용. 학교 자료 표(시간표·시수·명단 값)는 여전히 0건.
const ALLOWED = ['audit_log.user_id', 'board_comment.author_user_id', 'board_post.author_user_id', 'delete_batch.created_by', 'error_report.user_id', 'invite_code.created_by', 'invite_code.used_by', 'membership.user_id', 'notification.user_id', 'notification_read.user_id', 'transfer_request.created_by', 'transfer_request.decided_by', 'transfer_request.user_id', 'unlinked_account.user_id'];

test('외래키 지킴: app_user 를 가리키는 외래키는 허용 셋뿐(학교 쪽 표 → 계정 0건)', { skip }, async (t) => {
  const { pool } = await setupSchoolEnv(t, 'fk');
  const { rows } = await pool.query(
    `SELECT conrelid::regclass::text AS tb, a.attname AS col
       FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.contype = 'f' AND c.confrelid = 'app_user'::regclass ORDER BY 1, 2`,
  );
  assert.deepEqual(rows.map((x) => `${x.tb}.${x.col}`), ALLOWED);
});

test('51반 가명 재현: 같은 명단 67줄을 네 번 겹쳐 올려도 67명 한 번씩 · 명단 읽기 200', { skip }, async (t) => {
  const { pool, orgId, tag, call, P } = await setupSchoolEnv(t, 'p51');
  const s = bigSchool();
  assert.equal(s.classes.length, 51);
  const rows = s.teachers.map((x) => ({ name: x.name, loginId: `${tag}-${x.key}`, role: '교직원', duty: x.duty }));
  assert.equal(rows.length, 67);
  let peak = 0; const base = process.memoryUsage().rss; // 503 원인 어림: 해시 동시 수 × 메모리 비용(accounts.js ARGON memoryCost 19456 KiB)
  const tick = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
  const outs = await Promise.all([1, 2, 3, 4].map(() => call('POST', `${P}/roster/import`, { rows }, { expect: 200 })));
  clearInterval(tick);
  const made = outs.reduce((a, o) => a + (o.json?.made ?? 0), 0);
  const failedMsgs = new Set(outs.flatMap((o) => (o.json?.results ?? []).filter((r) => !r.ok).map((r) => r.error)));
  const list = await call('GET', `${P}/roster`, undefined, { expect: 503 });
  const n = (await pool.query(`SELECT count(*)::int AS n FROM membership WHERE org_id = $1 AND role = '교직원'`, [orgId])).rows[0].n;
  console.log('51반 재현:', JSON.stringify({ statuses: outs.map((o) => o.status), made, failedMsgs: [...failedMsgs], rosterStatus: list.status, rssMBBefore: Math.round(base / 1048576), rssMBPeak: Math.round(peak / 1048576), rosterRows: list.json?.length, members: n }));
  assert.equal(made, 67);
  assert.equal(n, 67);
  assert.ok([...failedMsgs].every((m) => m === '이미 쓰고 있는 ID 입니다'));
  assert.equal(list.status, 200);
});
