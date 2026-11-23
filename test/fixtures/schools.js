// 가짜 학교 두 벌 — 이름·ID 는 전부 지어낸 것(실명 ⛔). 순수 자료 + DB 에 심는 도우미.
//   bigSchool()   6학년 × 8~9반 = 51반 · 담임 51 · 전담 11 · 비교과 5 · 전담 시수표 102줄
//   smallSchool() 학년마다 1반 = 6반 · 담임 6 · 전담 2 (교사 8)
// 자료 모양: { classes:[{grade,class_no}], teachers:[{key,name,duty}], subjects:[이름], loads:[{teacher,subject,grade,class_no,hours,block?}],
//             homerooms:{'학년-반':교사키}, periods:{학년:{periods,lunch?,lunchAfter?}} }
// 시험이 쓰는 도우미: seedPeople(교사만) · seedStructure(학기·반·교과·시수표·교시 설정까지) — 기존 시험처럼 SQL 로 심는다.
import argon2 from 'argon2';

const pad = (n) => String(n).padStart(2, '0');

// 학년 → 반 수(배경 자료와 같은 8·8·9·8·9·9)
const BIG_CLASSES = { 1: 8, 2: 8, 3: 9, 4: 8, 5: 9, 6: 9 };
// 전담 11명이 맡는 교과(번호 순서대로)
const SPECIALIST_SUBJECTS = ['영어', '영어', '과학', '과학', '체육', '체육', '음악', '음악', '미술', '실과', '도덕'];

export function bigSchool() {
  const classes = [];
  for (const [g, n] of Object.entries(BIG_CLASSES)) for (let k = 1; k <= n; k++) classes.push({ grade: Number(g), class_no: k });
  const teachers = [];
  const homerooms = {};
  classes.forEach((c, i) => {
    const key = `h${pad(i + 1)}`;
    teachers.push({ key, name: `가교사${pad(i + 1)}`, duty: '담임' });
    homerooms[`${c.grade}-${c.class_no}`] = key;
  });
  for (let i = 0; i < 11; i++) teachers.push({ key: `s${pad(i + 1)}`, name: `나전담${pad(i + 1)}`, duty: '전담' });
  for (let i = 0; i < 5; i++) teachers.push({ key: `x${pad(i + 1)}`, name: `다비교${pad(i + 1)}`, duty: '비교과' });
  // 전담 시수표: 반마다 두 줄(51 × 2 = 102줄) — 반 순번으로 전담 둘을 돌려 붙인다
  const loads = [];
  classes.forEach((c, i) => {
    const a = i % 11;
    let b = (i * 3 + 5) % 11;
    if (b === a) b = (b + 1) % 11;
    for (const [idx, hours] of [[a, 2], [b, 1]]) {
      loads.push({ teacher: `s${pad(idx + 1)}`, subject: SPECIALIST_SUBJECTS[idx], grade: c.grade, class_no: c.class_no, hours });
    }
  });
  // 화면으로 넣은 자료의 꼴 — 점심 시각만 있고 점심 자리(lunchAfter)는 없다
  const periods = {
    1: { periods: 5, lunch: '12:10' }, 2: { periods: 5, lunch: '12:10' },
    3: { periods: 5, lunch: '11:20' }, 4: { periods: 5, lunch: '11:20' },
    5: { periods: 6, lunch: '12:50' }, 6: { periods: 6, lunch: '12:50' },
  };
  return { name: '큰학교', classes, teachers, subjects: [...new Set(SPECIALIST_SUBJECTS)], loads, homerooms, periods };
}

export function smallSchool() {
  const classes = [1, 2, 3, 4, 5, 6].map((g) => ({ grade: g, class_no: 1 }));
  const teachers = classes.map((c, i) => ({ key: `h${i + 1}`, name: `소담임${i + 1}`, duty: '담임' }));
  teachers.push({ key: 's1', name: '소전담1', duty: '전담' }, { key: 's2', name: '소전담2', duty: '전담' });
  const homerooms = Object.fromEntries(classes.map((c, i) => [`${c.grade}-${c.class_no}`, `h${i + 1}`]));
  const loads = [];
  classes.forEach((c, i) => {
    loads.push({ teacher: 's1', subject: '영어', grade: c.grade, class_no: 1, hours: 2 });
    loads.push({ teacher: 's2', subject: '체육', grade: c.grade, class_no: 1, hours: 2 });
    loads.push({ teacher: `h${i + 1}`, subject: '국어', grade: c.grade, class_no: 1, hours: 4 });
    loads.push({ teacher: `h${i + 1}`, subject: '수학', grade: c.grade, class_no: 1, hours: 3 });
  });
  const periods = Object.fromEntries(classes.map((c) => [c.grade, { periods: c.grade <= 2 ? 5 : 6, lunch: '12:00', lunchAfter: 4 }]));
  return { name: '작은학교', classes, teachers, subjects: ['영어', '체육', '국어', '수학'], loads, homerooms, periods };
}

let hashCache;
export const fixturePassword = 'pw-test-1234';

// 교사 계정·소속을 심는다. 로그인 ID 는 `${tag}-${key}`(시험 끝에 cleanupOrgs 가 tag 접두사로 지운다). 돌려주는 값: {키: 소속 id(숫자)}
export async function seedPeople(pool, orgId, tag, school) {
  hashCache ??= await argon2.hash(fixturePassword);
  const mids = {};
  for (const t of school.teachers) {
    const u = (await pool.query(`INSERT INTO app_user (name, login_id, password_hash, must_change_password) VALUES ($1,$2,$3,FALSE) RETURNING id`, [t.name, `${tag}-${t.key}`, hashCache])).rows[0].id;
    const m = (await pool.query(`INSERT INTO membership (org_id, user_id, role, duty) VALUES ($1,$2,'교직원',$3) RETURNING id`, [orgId, u, t.duty])).rows[0].id;
    mids[t.key] = Number(m);
  }
  return mids;
}

// 학기(2026-2)·교시 설정·반·교과·시수표를 SQL 로 한 번에. withHomerooms=false 면 반에 담임을 붙이지 않는다.
export async function seedStructure(pool, orgId, school, mids, { withHomerooms = true, withLoads = true } = {}) {
  const q = async (sql, a) => (await pool.query(sql, a)).rows[0]?.id;
  const term = await q(`INSERT INTO term (org_id, year, semester) VALUES ($1, 2026, 2) RETURNING id`, [orgId]);
  await pool.query(`UPDATE org SET period_config = $2 WHERE id = $1`, [orgId, JSON.stringify({ grades: school.periods })]);
  const cls = {};
  for (const c of school.classes) {
    const hm = withHomerooms ? mids[school.homerooms[`${c.grade}-${c.class_no}`]] ?? null : null;
    cls[`${c.grade}-${c.class_no}`] = Number(await q(`INSERT INTO classroom (org_id, term_id, grade, class_no, homeroom_membership_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [orgId, term, c.grade, c.class_no, hm]));
  }
  const subj = {};
  for (const name of school.subjects) subj[name] = Number(await q(`INSERT INTO subject (org_id, name) VALUES ($1,$2) RETURNING id`, [orgId, name]));
  let loadCount = 0;
  if (withLoads) {
    for (const l of school.loads) {
      await pool.query(`INSERT INTO teaching_load (org_id, term_id, membership_id, subject_id, classroom_id, weekly_hours, block) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [orgId, term, mids[l.teacher], subj[l.subject], cls[`${l.grade}-${l.class_no}`], l.hours, l.block ?? 1]);
      loadCount++;
    }
  }
  return { term: Number(term), classrooms: cls, subjects: subj, loadCount };
}
