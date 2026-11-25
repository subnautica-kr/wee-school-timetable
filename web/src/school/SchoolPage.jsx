import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Group, MultiSelect, NumberInput, Select, Stack, Switch, Table, Tabs, Text, TextInput } from '@mantine/core';
import { api } from '../api.js';
import { buildTimes, rowsOf } from './periodTimes.js';
import { numOfText } from './numberText.js';
import { periodsMax } from '../../../shared/periods.js';

// 학교 기본 · 전담·비교과 · 시수표 · 고정·금지 · 규칙 수위 거부 없이 저장하고 알림만 띄운다.
import { useOrgConfig } from '../orgConfig.js';
import Term from '../Term.jsx';
import { SCHOOL_TAB_FEATURE, visibleTabs } from '../features.js';
import { ClearTermButton } from '../settings/DangerZone.jsx';
import { MenuIntro } from '../grid/Guide.jsx';
import { useConfirm } from '../Confirm.jsx';
import { cascadeOpts, useDelete } from '../DeleteDialog.jsx';
import LoadUpload from './LoadUpload.jsx';
import SpecialRooms, { warnTexts } from './SpecialRooms.jsx';
import SchoolSetup from './SchoolSetup.jsx';
import { t } from '../../../shared/text/index.js';

function useLoad(path) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const reload = () => api('GET', path).then(setData).catch((e) => setErr(e.message));
  useEffect(() => { reload(); }, [path]); // eslint-disable-line
  return [data, reload, err];
}
// 점심 칸 — blur 때나 잠깐(0.8초) 쉬면 저장한다. 형식은 HH:MM
function LunchInput({ value, disabled, onSave, label }) {
  const [v, setV] = useState(value ?? '');
  const last = useRef(value ?? '');
  useEffect(() => {
    if (!/^\d\d:\d\d$/.test(v) || v === last.current) return undefined;
    const t = setTimeout(() => { last.current = v; onSave(v); }, 800);
    return () => clearTimeout(t);
  }, [v]); // eslint-disable-line
  const flush = () => { if (/^\d\d:\d\d$/.test(v) && v !== last.current) { last.current = v; onSave(v); } };
  return <TextInput aria-label={label} disabled={disabled} placeholder="점심 12:10" value={v} onChange={(e) => setV(e.currentTarget.value)} onBlur={flush} w={110} />;
}
// 교시 시각 표 — 두 칸이 다 09:00 꼴이면 0.8초 쉴 때나 blur 때 저장한다(점심 칸과 같은 꼴). 틀린 칸은 이유를 적는다.
function TimesTable({ n, times, disabled, onSave }) {
  const [rows, setRows] = useState(() => rowsOf(times, n));
  const last = useRef(JSON.stringify(buildTimes(rowsOf(times, n)).times ?? []));
  const res = buildTimes(rows);
  const sig = res.ok ? JSON.stringify(res.times) : null;
  const doSave = () => { if (sig && sig !== last.current) { last.current = sig; onSave(res.times); } };
  useEffect(() => {
    if (!sig || sig === last.current) return undefined;
    const t = setTimeout(doSave, 800);
    return () => clearTimeout(t);
  }, [sig]); // eslint-disable-line
  const set = (i, k, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <Stack gap="xs">
      <Table><Table.Tbody>
        {rows.map((r, i) => (
          <Table.Tr key={i}>
            <Table.Td>{i + 1}교시</Table.Td>
            <Table.Td><TextInput aria-label={`${i + 1}교시 시작`} disabled={disabled} placeholder="시작 09:00" value={r.start} onChange={(e) => set(i, 'start', e.currentTarget.value)} onBlur={doSave} w={110} /></Table.Td>
            <Table.Td><TextInput aria-label={`${i + 1}교시 끝`} disabled={disabled} placeholder="끝 09:40" value={r.end} onChange={(e) => set(i, 'end', e.currentTarget.value)} onBlur={doSave} w={110} /></Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody></Table>
      {!res.ok && <Text size="sm" c="red">{res.msg}(저장하지 않았습니다)</Text>}
    </Stack>
  );
}
// 학년별 교시 시각 — 접어 둔다. 안 펴면 학교 공통 시각을 쓴다(지금과 같다).
function GradeTimes({ label, n, times, disabled, onSave }) {
  const [open, setOpen] = useState(false);
  return (
    <Stack gap={4}>
      <Button size="compact-xs" variant="subtle" aria-label={`${label} 교시 시각 넣기`} onClick={() => setOpen(!open)}>{open ? '교시 시각 접기' : `교시 시각 넣기${times?.length ? ' (넣음)' : ''}`}</Button>
      {open && <TimesTable n={n} times={times} disabled={disabled} onSave={onSave} />}
    </Stack>
  );
}
// 요일별 교시 수 — 접어 둔다(T-1205). 비운 요일은 학년 교시 수를 쓴다. 안 펴는 학교는 지금과 같다.
// 숫자 칸은 numOfText 로 읽는다(「4교시」처럼 글자가 붙어도 4 — T-1204f 결함 되풀이 금지)
function ByDay({ label, days, base, byDay, disabled, onSave }) {
  const has = Object.keys(byDay ?? {}).length > 0;
  const [open, setOpen] = useState(has);
  const save = (w, raw) => {
    const n = numOfText(raw);
    const cur = byDay?.[String(w)];
    if ((n ?? undefined) === cur) return;
    const next = { ...(byDay ?? {}) };
    if (n && n > 0) next[String(w)] = n; else delete next[String(w)];
    onSave(Object.keys(next).length ? next : undefined);
  };
  return (
    <Stack gap={4}>
      <Button size="compact-xs" variant="subtle" aria-label={`${label} 요일마다 다르게`} onClick={() => setOpen(!open)}>{open ? '요일별 접기' : `요일마다 다르게${has ? ' (넣음)' : ''}`}</Button>
      {open && (
        <Group gap={4} wrap="nowrap">
          {days.map((d, i) => (
            <NumberInput key={`${d}:${byDay?.[String(i + 1)] ?? ''}`} aria-label={`${label} ${d}요일 교시 수`} disabled={disabled} min={1} allowDecimal={false} label={d} placeholder={String(base)} defaultValue={byDay?.[String(i + 1)] ?? ''} onBlur={(e) => save(i + 1, e.currentTarget.value)} w={56} hideControls />
          ))}
        </Group>
      )}
    </Stack>
  );
}
const Err = ({ e }) => (e ? <Alert color="red">{e}</Alert> : null);

// 교과 — 기본 14 는 프리셋일 뿐. 기관이 추가·이름·줄임말 고치기·숨김(되살리기)·프리셋 다시 불러오기(없는 것만)
function Subjects({ P, admin }) {
  const [rows, reload] = useLoad(`${P}/subjects?hidden=1`);
  const [nw, setNw] = useState({ name: '', short_name: '' });
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const run = (fn) => async () => { setError(''); setNote(''); try { await fn(); reload(); } catch (e) { setError(e.message); } };
  const shown = (rows || []).filter((s) => !s.hidden);
  const hidden = (rows || []).filter((s) => s.hidden);
  const patch = (s, body) => run(() => api('PATCH', `${P}/subjects/${s.id}`, body))();
  const [del, delBox] = useDelete();
  return (
    <Stack>
      {delBox}
      <Err e={error} />
      <Text fw={600}>교과 ({shown.length})</Text>
      {!admin && <Text size="sm">{shown.map((s) => s.name).join(' · ')}</Text>}
      {admin && (
        <Table.ScrollContainer minWidth={0} type="native"><Table><Table.Tbody>
          {shown.map((s) => (
            <Table.Tr key={s.id}>
              <Table.Td><TextInput defaultValue={s.name} onBlur={(e) => e.currentTarget.value.trim() && e.currentTarget.value !== s.name && patch(s, { name: e.currentTarget.value })} w={{ base: 140, sm: 190 }} /></Table.Td>
              <Table.Td><TextInput defaultValue={s.short_name ?? ''} placeholder="줄임말" onBlur={(e) => e.currentTarget.value !== (s.short_name ?? '') && patch(s, { short_name: e.currentTarget.value })} w={80} /></Table.Td>
              <Table.Td><Group gap={4} wrap="nowrap"><Button size="xs" variant="default" onClick={() => patch(s, { hidden: true })}>숨김</Button><Button size="xs" variant="subtle" color="red" onClick={() => del(cascadeOpts(P, 'subject', s.id, s.name, `${P}/subjects/${s.id}`, { lead: '이 교과를 목록에서 없앱니다. 숨김과 달리 시수표·시간표에서도 빠집니다.', onDone: reload }))}>지우기</Button></Group></Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody></Table></Table.ScrollContainer>
      )}
      {admin && (
        <Group>
          <TextInput placeholder="새 교과 이름" value={nw.name} onChange={(e) => setNw({ ...nw, name: e.currentTarget.value })} />
          <TextInput placeholder="줄임말" value={nw.short_name} onChange={(e) => setNw({ ...nw, short_name: e.currentTarget.value })} w={80} />
          <Button onClick={run(async () => { await api('POST', `${P}/subjects`, { name: nw.name, short_name: nw.short_name || null }); setNw({ name: '', short_name: '' }); })}>교과 추가</Button>
          <Button variant="default" onClick={run(async () => {
            const r = await api('POST', `${P}/subjects/preset-reload`);
            setNote(r.added.length ? `더했습니다: ${r.added.join(' · ')}` : '더할 것이 없습니다(프리셋 교과가 모두 있거나 숨겨져 있습니다)');
          })}>프리셋 다시 불러오기(없는 것만 더함)</Button>
        </Group>
      )}
      {note && <Text size="sm" c="dimmed">{note}</Text>}
      {admin && hidden.length > 0 && (
        <>
          <Text size="sm" fw={600}>숨긴 교과</Text>
          {hidden.map((s) => (
            <Group key={s.id} gap="xs"><Text size="sm">{s.name}</Text><Button size="xs" variant="default" onClick={() => patch(s, { hidden: false })}>다시 보이기</Button></Group>
          ))}
        </>
      )}
    </Stack>
  );
}

// 새 학기 시작(되돌릴 수 없음 — 한 번 더 묻는다) · 보관 학기 보기(읽기 전용)
function Semester({ P, admin, term, classes, onDone }) {
  const [terms] = useLoad(`${P}/terms`);
  const [ov, setOv] = useState(null);
  const [err, setErr] = useState('');
  const [ask, confirmBox] = useConfirm();
  const start = async () => {
    setErr('');
    try {
      await api('POST', `${P}/terms/new-semester`, {});
    } catch (e) {
      if (e.status !== 409 || !e.body?.needConfirm) return setErr(e.message);
      if (!(await ask(`${e.message}

계속할까요?`, { yes: '새 학기 시작' }))) return;
      try { await api('POST', `${P}/terms/new-semester`, { confirm: true }); onDone(); } catch (e2) { setErr(e2.message); }
    }
  };
  const view = (v) => { setErr(''); setOv(null); if (v) api('GET', `${P}/terms/${v}/overview`).then(setOv).catch((e) => setErr(e.message)); };
  return (
    <Stack gap="xs">
      {confirmBox}
      <Err e={err} />
      <Group>
        {admin && <Button color="red" variant="light" onClick={start}>새 학기 시작</Button>}
        {admin && !classes?.length && (terms || []).length > 1 && <Button variant="default" onClick={async () => { setErr(''); try { await api('POST', `${P}/terms/import-previous`, {}); onDone(); } catch (e) { setErr(e.message); } }}>지난 학기 반·과목 가져오기</Button>}
        {admin && classes?.length > 0 && (terms || []).length > 1 && (
          <Text component="div" size="sm" c="dimmed" data-testid="import-blocked">지난 학기 반·과목 가져오기는 이번 학기에 반이 없을 때만 됩니다(지금 {classes.length}개). 가져오려면 이번 학기를 먼저 비우세요.{' '}<ClearTermButton P={P} level="classes" label="이번 학기 비우고 다시 하기…" variant="light" onDone={onDone} /></Text>
        )}
        <Select placeholder="보관 학기 보기" clearable w={200} onChange={view}
          data={(terms || []).filter((t) => t.id !== term?.id).map((t) => ({ value: String(t.id), label: `${t.year}년 ${t.semester}학기 (${t.status})` }))} />
      </Group>
      {ov && (
        <Alert color="gray" title={`${ov.term.year}년 ${ov.term.semester}학기 — 읽기 전용`}>
          <Text size="sm">반 {ov.classrooms.map((c) => `${c.grade}-${c.class_no}`).join(' · ') || '없음'} · 시수 줄 {ov.loadCount}개 · 시간표 {ov.timetables.map((t) => `${t.name}(${t.status})`).join(', ') || '없음'}</Text>
        </Alert>
      )}
    </Stack>
  );
}

// 반 표 — 반마다 담임 고르기(선택 항목). 담당 구분 「담임」인 분을 위에, 나머지 분도 아래에 둔다(작은 학교는 교감·전담이 담임을 겸한다).
// 한 분이 두 반 이상이어도 막지 않고 노란 알림만. 붙일 때 그 반 시수표에 교사 빈 줄이 있으면 담임으로 채울지 묻는다.
function ClassTable({ P, admin, classes, reload, setError }) {
  const [people] = useLoad(`${P}/specialists`);
  const [ask, box] = useConfirm();
  const [del, delBox] = useDelete();
  const list = classes || [];
  const nameOf = (mid) => (people || []).find((x) => x.membership_id === mid)?.name;
  const data = [
    { group: '담임', items: (people || []).filter((x) => x.duty === '담임').map((x) => ({ value: String(x.membership_id), label: x.name })) },
    { group: '그 밖의 분', items: (people || []).filter((x) => x.duty !== '담임').map((x) => ({ value: String(x.membership_id), label: `${x.name}${x.duty ? ` (${x.duty})` : ''}` })) },
  ].filter((g) => g.items.length);
  const byHome = {};
  for (const c of list) if (c.homeroom_membership_id) (byHome[c.homeroom_membership_id] ||= []).push(`${c.grade}-${c.class_no}`);
  const dup = Object.entries(byHome).filter(([, v]) => v.length > 1);
  const pick = async (c, v) => {
    setError('');
    try {
      const mid = v ? Number(v) : null;
      await api('PATCH', `${P}/classrooms/${c.id}`, { homeroom_membership_id: mid });
      await reload();
      if (!mid) return;
      const blank = ((await api('GET', `${P}/loads`)).lines || []).filter((l) => l.classroom_id === c.id && !l.membership_id);
      if (blank.length && (await ask(`${c.grade}-${c.class_no}반 시수표에 교사가 빈 줄이 ${blank.length}개 있습니다.
이 반의 교사 빈 줄 ${blank.length}개를 ${nameOf(mid) ?? '담임'} 선생님으로 채울까요?`, { yes: '채우기', no: '그대로 두기' }))) {
        for (const l of blank) await api('PATCH', `${P}/loads/${l.id}`, { membership_id: mid });
      }
    } catch (e) { setError(e.message); }
  };
  return (
    <Stack gap="xs">
      {box}{delBox}
      {dup.map(([mid, v]) => <Alert key={mid} color="yellow">{nameOf(Number(mid)) ?? '한 분'} 선생님이 {v.join('·')} 두 반 이상의 담임입니다(막지는 않습니다).</Alert>)}
      {list.length === 0 ? <Text size="sm">아직 없음</Text> : (
        <Table w="auto"><Table.Tbody>
          {list.map((c) => (
            <Table.Tr key={c.id}>
              <Table.Td>{c.grade}-{c.class_no}</Table.Td>
              <Table.Td><Select aria-label={`${c.grade}-${c.class_no} 담임`} placeholder="담임 없음" clearable searchable disabled={!admin} data={data} value={c.homeroom_membership_id ? String(c.homeroom_membership_id) : null} onChange={(v) => pick(c, v)} w={200} /></Table.Td>
              {admin && <Table.Td><Button size="xs" variant="subtle" color="red" onClick={() => del(cascadeOpts(P, 'classroom', c.id, `${c.grade}-${c.class_no}반`, `${P}/classrooms/${c.id}`, { lead: '이 반을 없앱니다. 이 반의 시수표 줄과 시간표 칸도 함께 사라집니다.', onDone: reload }))}>지우기</Button></Table.Td>}
            </Table.Tr>
          ))}
        </Table.Tbody></Table>
      )}
    </Stack>
  );
}

function Basics({ P, admin }) {
  const org = useOrgConfig(P); // 기관 설정: 학기 시작 달·상한(넘으면 경고만 — 입력은 막지 않음)
  const [term, reloadTerm] = useLoad(`${P}/term`);
  const [classes, reloadC] = useLoad(`${P}/classrooms`);
  const [cfg, reloadCfg] = useLoad(`${P}/school/periods`);
  const [del, delBox] = useDelete();
  const [grade, setGrade] = useState(1);
  const [count, setCount] = useState(3);
  const [error, setError] = useState('');
  // 반 줄이기 — 고른 학년의 맨 뒤 반(반 번호가 가장 큰 반) 하나를 지우기 창(딸린 것 미리보기)으로 지운다
  const gradeVar = { 학년: grade }; // 문구-예외: 문구 변수 이름
  const shrink = () => {
    const mine = (classes || []).filter((c) => c.grade === Number(grade));
    if (!mine.length) { setError(t('school.class.shrink_none', gradeVar)); return; }
    const last = mine.reduce((a, b) => (b.class_no > a.class_no ? b : a));
    del(cascadeOpts(P, 'classroom', last.id, `${last.grade}-${last.class_no}반`, `${P}/classrooms/${last.id}`, { lead: t('school.class.shrink_lead'), onDone: reloadC })); // 문구-예외: 반 이름 꼴(236줄과 같다)
  };
  const run = (fn) => async () => { setError(''); try { await fn(); } catch (e) { setError(e.message); } };
  const grades = cfg?.grades || {};
  const [saved, setSaved] = useState('');
  const setG = (g, patch) => { setSaved('저장 중…'); return api('PUT', `${P}/school/periods`, { ...(cfg?.times ? { times: cfg.times } : {}), grades: { ...grades, [g]: { periods: 5, ...grades[g], ...patch } } }).then(() => { setSaved('저장됨'); return reloadCfg(); }).catch((e) => { setSaved(''); throw e; }); };
  const saveTimes = (times) => { setSaved('저장 중…'); return api('PUT', `${P}/school/periods`, { grades, times }).then(() => { setSaved('저장됨'); return reloadCfg(); }).catch((e) => { setSaved(''); throw e; }); };
  const maxP = Math.max(1, ...Object.keys(grades).map((g) => periodsMax(cfg, g, 0)));
  return (
    <Stack>
      <Err e={error} />
      {term && <Text size="sm" c="dimmed">지금 {term.year}년 {term.semester}학기 · 학기 시작 달 {org.semesterStarts.join('·')}월(기관 설정)</Text>}
      <Semester P={P} admin={admin} term={term} classes={classes} onDone={() => { reloadTerm(); reloadC(); }} />
      <Text fw={600}>반</Text>
      <ClassTable P={P} admin={admin} classes={classes} reload={reloadC} setError={setError} />
      {admin && (
        <Group>
          <NumberInput label="학년" description={`기관 기준 ${org.limits.grades}`} min={1} value={grade} onChange={setGrade} w={80} />
          <NumberInput label="반 수" description={`반 번호 ${org.limits.classNo}까지`} min={1} value={count} onChange={setCount} w={80} />
          <Button mt={24} onClick={run(async () => { await api('POST', `${P}/classrooms/bulk`, { grade, count }); reloadC(); })}>반 만들기</Button>
          <Button mt={24} variant="default" color="red" onClick={shrink}>{t('school.class.shrink_button', gradeVar)}</Button>
        </Group>
      )}
      <Group gap="xs"><Text fw={600}>학년별 교시 · 점심</Text>{saved && <Badge variant="light" color={saved === '저장됨' ? 'green' : 'gray'}>{saved}</Badge>}</Group>
      <Table className="card-table"><Table.Tbody>
        {[1, 2, 3, 4, 5, 6].map((g) => (
          <Table.Tr key={g}>
            <Table.Td>{g}학년</Table.Td>
            <Table.Td><NumberInput aria-label={`${g}학년 교시 수`} disabled={!admin} min={1} description={`기관 기준 ${org.limits.periods}`} value={grades[g]?.periods ?? ''} onChange={(v) => v && run(() => setG(g, { periods: v }))()} w={80} suffix="교시" /></Table.Td>
            <Table.Td><LunchInput key={`${g}:${grades[g]?.lunch ?? ''}`} label={`${g}학년 점심 시각`} disabled={!admin} value={grades[g]?.lunch ?? ''} onSave={(v) => run(() => setG(g, { lunch: v }))()} /></Table.Td>
            <Table.Td><NumberInput aria-label={`${g}학년 점심은 몇 교시 뒤`} disabled={!admin} min={0} max={org.limits.periods} allowDecimal={false} placeholder="점심" key={`${g}:la:${grades[g]?.lunchAfter ?? ''}`} defaultValue={grades[g]?.lunchAfter ?? ''} onBlur={(e) => { const n = numOfText(e.currentTarget.value); const v = n === null ? undefined : n; if (v !== grades[g]?.lunchAfter) run(() => setG(g, { lunchAfter: v }))(); }} w={110} suffix="교시 뒤" /></Table.Td>
            <Table.Td><ByDay label={`${g}학년`} days={org.weekdays} base={grades[g]?.periods || 5} byDay={grades[g]?.byDay} disabled={!admin} onSave={(b) => run(() => setG(g, { byDay: b }))()} /></Table.Td>
            <Table.Td><GradeTimes label={`${g}학년`} n={periodsMax(cfg, g)} times={grades[g]?.times} disabled={!admin} onSave={(t) => run(() => setG(g, { times: t }))()} /></Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody></Table>
      <Text fw={600}>교시 시작·끝 시각</Text>
      <Text size="sm" c="dimmed">전 학년 공통입니다. 적어 두면 학년마다 점심 자리가 달라도 교사·특별실 겹침을 시각으로 셉니다. 비우면 교시 번호로 셉니다. 09:00 꼴로 적습니다.</Text>
      <TimesTable key={cfg ? 'ready' : 'wait'} n={maxP} times={cfg?.times} disabled={!admin} onSave={(t) => run(() => saveTimes(t))()} />
      {delBox}
      <SpecialRooms P={P} admin={admin} />
      <Subjects P={P} admin={admin} />
    </Stack>
  );
}

function Specialists({ P, admin }) {
  const cfg = useOrgConfig(P);
  const [rows, reload, err] = useLoad(`${P}/specialists`);
  return (
    <Stack>
      <Err e={err} />
      <Table><Table.Tbody>
        {(rows || []).map((r) => (
          <Table.Tr key={r.membership_id}>
            <Table.Td>{r.name}</Table.Td>
            <Table.Td>
              <Switch disabled={!admin} label="전담·비교과" checked={!!r.duty && r.duty !== '담임'}
                onChange={(e) => api('PATCH', `${P}/specialists/${r.membership_id}`, { duty: e.currentTarget.checked ? (cfg.duties.find((d) => d !== '담임') ?? '전담') : '담임' }).then(reload)} />
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody></Table>
    </Stack>
  );
}

// 알림 한 상자 — 「시수표에 빠진 교사 ○명」 + 펼치면 이름 목록. 사람 목록이 없는 알림은 지금처럼 한 줄.
function MissingBox({ a }) {
  const [open, setOpen] = useState(false);
  const people = a.detail?.people;
  if (!people) return <Alert color={a.color}>{a.label}: {a.detail?.name}</Alert>;
  return (
    <Alert color={a.color} title={`${a.label} ${a.detail.count}명`}>
      <Button size="compact-xs" variant="subtle" onClick={() => setOpen(!open)}>{open ? '접기' : '이름 펼치기'}</Button>
      {open && <Text size="sm">{people.map((x) => x.name).join(' · ')}</Text>}
    </Alert>
  );
}

function Loads({ P, admin }) {
  const org = useOrgConfig(P);
  const [d, reload, err] = useLoad(`${P}/loads`);
  const [people] = useLoad(`${P}/specialists`);
  const [subjects] = useLoad(`${P}/subjects`);
  const [classes] = useLoad(`${P}/classrooms`);
  const [rooms] = useLoad(`${P}/special-rooms`);
  const [roomGroups] = useLoad(`${P}/special-room-groups`);
  const [row, setRow] = useState({});
  const [ask, box] = useConfirm();
  const [fail, setFail] = useState('');
  const [notes, setNotes] = useState([]); // 저장하며 서버가 돌려준 알림(노랑)
  // 특별실 고르기 — 방은 r번호, 묶음은 g번호. 묶음은 맨 위 「묶음」 모음에 둔다
  const roomData = [
    ...((roomGroups || []).length ? [{ group: t('school.room.load_group_head'), items: roomGroups.map((g) => ({ value: `g${g.id}`, label: g.name })) }] : []),
    { group: t('school.room.load_room_head'), items: (rooms || []).map((r) => ({ value: `r${r.id}`, label: r.name })) },
  ];
  const roomVal = (l) => (l.special_room_id ? `r${l.special_room_id}` : l.room_group_id ? `g${l.room_group_id}` : null);
  const roomBody = (v) => ({ special_room_id: v?.startsWith('r') ? Number(v.slice(1)) : null, room_group_id: v?.startsWith('g') ? Number(v.slice(1)) : null, ...(v ? {} : { room_hours: null }) });
  const roomShow = (l) => {
    const n = l.special_room_id ? nm(rooms, 'id', l.special_room_id)?.name : l.room_group_id ? nm(roomGroups, 'id', l.room_group_id)?.name : null;
    return n ? t('school.room.load_show_room', { 이름: n }) + (l.room_hours != null ? t('school.room.load_show_hours', { 시수: l.room_hours }) : t('school.room.load_show_all')) : null;
  };
  const opt = (a, f) => (a || []).map((x) => ({ value: String(f.v(x)), label: f.l(x) }));
  const nm = (arr, k, id) => (arr || []).find((x) => String(x[k]) === String(id));
  const guard = (fn) => () => { setFail(''); setNotes([]); return Promise.resolve().then(fn).then((r) => { setNotes(warnTexts(r)); return reload(); }).catch((e) => setFail(e.message)); };
  // 반 고르기: 「○학년 전체」(g○)와 낱개 반을 섞어 고른다. 겹치면 한 번만 센다. 비우면 모든 반(반 지정 없음).
  const grades = [...new Set((classes || []).map((c) => c.grade))].sort((a, b) => a - b);
  const classData = [
    { group: '학년 전체', items: grades.map((g) => ({ value: `g${g}`, label: `${g}학년 전체` })) },
    ...grades.map((g) => ({ group: `${g}학년`, items: classes.filter((c) => c.grade === g).map((c) => ({ value: String(c.id), label: `${c.grade}-${c.class_no}` })) })),
  ];
  const pickedIds = (vals) => [...new Set((vals || []).flatMap((v) => (v.startsWith('g') ? classes.filter((c) => c.grade === Number(v.slice(1))).map((c) => c.id) : [Number(v)])))];
  const add = guard(async () => {
    const ids = pickedIds(row.c);
    const base = { membership_id: row.m ? Number(row.m) : null, subject_id: row.s ? Number(row.s) : null, weekly_hours: row.h || 0, sync_progress: !!row.p, block: row.b ? 2 : 1, ...(row.m2 ? { second_membership_id: Number(row.m2), second_hours: row.h2 === '' || row.h2 == null ? null : Number(row.h2) } : {}), ...(row.r ? { ...roomBody(row.r), room_hours: row.rh === '' || row.rh == null ? null : Number(row.rh) } : {}) };
    const got = [];
    for (const c of ids.length ? ids : [null]) got.push(...warnTexts(await api('POST', `${P}/loads`, { ...base, classroom_id: c })));
    setRow({});
    return { warnings: [...new Set(got)].map((msg) => ({ msg })) };
  });
  const patch = (l, body) => guard(() => api('PATCH', `${P}/loads/${l.id}`, body))();
  const remove = async (l) => {
    const who = nm(people, 'membership_id', l.membership_id)?.name ?? '교사 비어 있음';
    const c = nm(classes, 'id', l.classroom_id);
    if (!(await ask(`이 줄을 지울까요?\n${who} · ${nm(subjects, 'id', l.subject_id)?.name ?? '교과 비어 있음'} · ${c ? `${c.grade}-${c.class_no}` : '모든 반'} · ${l.weekly_hours}시수`, { yes: '지우기' }))) return;
    guard(() => api('DELETE', `${P}/loads/${l.id}`))();
  };
  return (
    <Stack>
      {box}
      <Err e={err || fail} />
      {notes.map((m, i) => <Alert key={i} color="yellow">{m}</Alert>)}
      {(d?.alerts || []).map((a, i) => <MissingBox key={i} a={a} />)}
      {admin && <LoadUpload P={P} onDone={reload} />}
      <Table className="card-table"><Table.Tbody>
        {(d?.lines || []).map((l) => (
          <Table.Tr key={l.id} bg={l.incomplete ? 'yellow.0' : undefined}>
            {admin ? (
              <>
                <Table.Td><Select aria-label="교사" placeholder="(교사 비어 있음)" clearable searchable data={opt(people, { v: (x) => x.membership_id, l: (x) => x.name })} value={l.membership_id ? String(l.membership_id) : null} onChange={(v) => patch(l, { membership_id: v ? Number(v) : null })} w={140} /></Table.Td>
                <Table.Td><Select aria-label="교과" placeholder="(교과 비어 있음)" clearable data={opt(subjects, { v: (x) => x.id, l: (x) => x.name })} value={l.subject_id ? String(l.subject_id) : null} onChange={(v) => patch(l, { subject_id: v ? Number(v) : null })} w={130} /></Table.Td>
              </>
            ) : (
              <>
                <Table.Td>{nm(people, 'membership_id', l.membership_id)?.name ?? '(교사 비어 있음)'}</Table.Td>
                <Table.Td>{nm(subjects, 'id', l.subject_id)?.name ?? '(교과 비어 있음)'}</Table.Td>
              </>
            )}
            <Table.Td>{l.classroom_id ? (() => { const c = nm(classes, 'id', l.classroom_id); return c ? `${c.grade}-${c.class_no}` : ''; })() : '모든 반(반 지정 없음)'}</Table.Td>
            <Table.Td>
              {admin ? (
                <Group gap="xs" wrap="nowrap">
                  <Select aria-label="둘째 교사" placeholder="둘째 교사(선택)" clearable searchable data={opt(people, { v: (x) => x.membership_id, l: (x) => x.name }).filter((o) => o.value !== String(l.membership_id))} value={l.second_membership_id ? String(l.second_membership_id) : null} onChange={(v) => patch(l, v ? { second_membership_id: Number(v) } : { second_membership_id: null, second_hours: null })} w={130} />
                  {l.second_membership_id && <NumberInput aria-label="함께 시수" placeholder="전부" min={0} allowDecimal={false} key={`${l.id}:h2:${l.second_hours}`} defaultValue={l.second_hours ?? ''} onBlur={(e) => { const v = numOfText(e.currentTarget.value); if (v !== (l.second_hours ?? null)) patch(l, { second_hours: v }); }} w={90} suffix="시수" />}
                </Group>
              ) : (l.second_membership_id ? <>둘째 {nm(people, 'membership_id', l.second_membership_id)?.name ?? ''}{l.second_hours != null ? ` · 함께 ${l.second_hours}시수` : ' · 함께 전부'}</> : null)}
            </Table.Td>
            <Table.Td>
              {admin ? (
                <Group gap="xs" wrap="nowrap">
                  <NumberInput aria-label="시수" min={0} allowDecimal={false} key={`${l.id}:${l.weekly_hours}`} defaultValue={l.weekly_hours} onBlur={(e) => { const v = numOfText(e.currentTarget.value); if (v !== null && v !== l.weekly_hours) patch(l, { weekly_hours: v }); }} w={70} suffix="시수" />
                  <Switch size="xs" label="연강" checked={l.block === 2} onChange={(e) => patch(l, { block: e.currentTarget.checked ? 2 : 1 })} />
                  {l.sync_progress && <Text size="xs" c="dimmed">진도 맞춤</Text>}
                </Group>
              ) : <>{l.weekly_hours}시수{l.sync_progress ? ' · 진도 맞춤' : ''}{l.block === 2 ? ' · 2시수 연강' : ''}</>}
            </Table.Td>
            <Table.Td>
              {admin ? (
                <Group gap="xs" wrap="nowrap">
                  <Select aria-label={t('school.room.load_room_label')} placeholder={t('school.room.load_room_ph')} clearable searchable data={roomData} value={roomVal(l)} onChange={(v) => patch(l, roomBody(v))} w={150} />
                  {roomVal(l) && <NumberInput aria-label={t('school.room.load_hours_label')} placeholder={t('school.room.load_hours_ph')} min={0} allowDecimal={false} key={`${l.id}:rh:${l.room_hours}`} defaultValue={l.room_hours ?? ''} onBlur={(e) => { const v = numOfText(e.currentTarget.value); if (v !== (l.room_hours ?? null)) patch(l, { room_hours: v }); }} w={110} suffix={t('school.room.load_hours_suffix')} />}
                </Group>
              ) : roomShow(l)}
            </Table.Td>
            <Table.Td>{admin && <Button size="xs" variant="subtle" color="red" onClick={() => remove(l)}>지우기</Button>}</Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody></Table>
      {admin && (
        <Group align="end">
          <Select placeholder="교사" clearable searchable data={opt(people, { v: (x) => x.membership_id, l: (x) => x.name })} value={row.m ?? null} onChange={(v) => setRow({ ...row, m: v })} w={130} />
          <Select placeholder="교과" clearable data={opt(subjects, { v: (x) => x.id, l: (x) => x.name })} value={row.s ?? null} onChange={(v) => setRow({ ...row, s: v })} w={130} />
          <MultiSelect placeholder="모든 반(비우면)" description="반 여러 개나 「○학년 전체」를 골라 한 번에 줄을 만듭니다" clearable searchable data={classData} value={row.c ?? []} onChange={(v) => setRow({ ...row, c: v })} w={260} />
          <NumberInput placeholder="시수" description={`기관 기준 주 ${org.limits.loadPerWeek}`} min={0} value={row.h ?? ''} onChange={(v) => setRow({ ...row, h: v })} w={80} />
          <Select placeholder="둘째 교사(선택)" clearable searchable data={opt(people, { v: (x) => x.membership_id, l: (x) => x.name }).filter((o) => o.value !== row.m)} value={row.m2 ?? null} onChange={(v) => setRow({ ...row, m2: v })} w={150} />
          {row.m2 && <NumberInput placeholder="함께 시수" description="비우면 전부" min={0} allowDecimal={false} value={row.h2 ?? ''} onChange={(v) => setRow({ ...row, h2: v })} w={100} />}
          <Select placeholder={t('school.room.load_room_ph')} clearable searchable data={roomData} value={row.r ?? null} onChange={(v) => setRow({ ...row, r: v })} w={150} />
          {row.r && <NumberInput placeholder={t('school.room.load_hours_ph')} description={t('school.room.load_hours_hint')} min={0} allowDecimal={false} value={row.rh ?? ''} onChange={(v) => setRow({ ...row, rh: v })} w={130} />}
          <Switch label="진도 맞춤" checked={!!row.p} onChange={(e) => setRow({ ...row, p: e.currentTarget.checked })} />
          <Switch label="2시수 연강" checked={!!row.b} onChange={(e) => setRow({ ...row, b: e.currentTarget.checked })} />
          <Button onClick={add}>줄 추가</Button>
        </Group>
      )}
      <Text size="xs" c="dimmed">비어 있는 칸이 있어도 저장됩니다. 노랑 줄은 아직 덜 채운 줄입니다. 교사·교과·시수는 줄에서 바로 고칠 수 있습니다.</Text>
    </Stack>
  );
}

function Pins({ P, admin, kind }) {
  const org = useOrgConfig(P);
  const DAYS = org.weekdays;
  const [pins, reload, err] = useLoad(`${P}/pins?target_kind=${encodeURIComponent(kind)}`);
  const [people] = useLoad(`${P}/specialists`);
  const [classes] = useLoad(`${P}/classrooms`);
  const [rooms] = useLoad(`${P}/special-rooms`);
  const targets = kind === '교사' ? (people || []).map((x) => ({ value: String(x.membership_id), label: x.name }))
    : kind === '반' ? (classes || []).map((x) => ({ value: String(x.id), label: `${x.grade}-${x.class_no}` }))
    : (rooms || []).map((x) => ({ value: String(x.id), label: x.name }));
  const [subjects] = useLoad(`${P}/subjects`);
  const [f, setF] = useState({ kind: '금지', weekday: '1', period: 1 });
  const [error, setError] = useState('');
  const [ask, box] = useConfirm();
  const add = () => api('POST', `${P}/pins`, { target_kind: kind, target_id: Number(f.t), weekday: Number(f.weekday), period: f.period, kind: f.kind, subject_id: kind === '반' && f.kind === '고정' && f.s ? Number(f.s) : null }).then(reload).catch((e) => setError(e.message));
  const label = (id) => targets.find((x) => x.value === String(id))?.label ?? id;
  const delAsk = (p) => t('school.pin.delete_ask', { 종류: p.kind, 대상: label(p.target_id), 요일: DAYS[p.weekday - 1], 교시: p.period }); // 문구-예외: 문구 변수 이름
  return (
    <Stack>
      {box}
      <Err e={err || error} />
      {(pins || []).map((p) => (
        <Group key={p.id}>
          <Badge color={p.kind === '고정' ? 'blue' : 'gray'}>{p.kind}</Badge>
          <Text size="sm">{label(p.target_id)} · {DAYS[p.weekday - 1]} {p.period}교시{p.subject_id ? ` · ${(subjects || []).find((x) => x.id === p.subject_id)?.name ?? ''}` : (kind === '반' && p.kind === '고정' ? ' · 교과 없음(그 칸은 비워 둠)' : '')}</Text>
          {admin && <Button size="xs" variant="subtle" color="red" onClick={async () => { if (!(await ask(delAsk(p), { yes: t('school.pin.delete_yes') }))) return; api('DELETE', `${P}/pins/${p.id}`).then(reload).catch((e) => setError(e.message)); }}>지우기</Button>}
        </Group>
      ))}
      {admin && (
        <Group align="end">
          <Select placeholder={kind} data={targets} value={f.t ?? null} onChange={(v) => setF({ ...f, t: v })} w={130} />
          <Select data={DAYS.map((d, i) => ({ value: String(i + 1), label: d }))} value={f.weekday} onChange={(v) => setF({ ...f, weekday: v })} w={80} />
          <NumberInput min={1} description={`기관 기준 ${org.limits.periods}교시`} value={f.period} onChange={(v) => setF({ ...f, period: v })} w={80} suffix="교시" />
          <Select data={['고정', '금지']} value={f.kind} onChange={(v) => setF({ ...f, kind: v })} w={90} />
          {kind === '반' && f.kind === '고정' && <Select placeholder="교과(선택)" description="비워도 됩니다" clearable data={(subjects || []).map((x) => ({ value: String(x.id), label: x.name }))} value={f.s ?? null} onChange={(v) => setF({ ...f, s: v })} w={130} />}
          <Button disabled={!f.t} onClick={add}>추가</Button>
        </Group>
      )}
      {admin && kind === '반' && <Text size="xs" c="dimmed">「고정」에 교과를 고르면 자동 생성이 그 반 그 칸에 그 교과를 놓습니다. 교과를 비우면 그 칸은 수업 없이 비워 둡니다. 「금지」는 그 칸을 늘 비웁니다.</Text>}
    </Stack>
  );
}

function Rules({ P, admin }) {
  const [d, reload, err] = useLoad(`${P}/rules`);
  const [error, setError] = useState('');
  if (!d) return <Err e={err} />;
  return (
    <Stack>
      <Err e={err || error} />
      <Text size="sm" c="dimmed">알림: 노랑 · 저장됨 / 경고: 빨강 · 되돌리기 / 재확인: 한 번 묻고 저장 / 끔</Text>
      {Object.entries(d.rules).map(([k, r]) => (
        <Group key={k} justify="space-between">
          <Text size="sm">{r.label}</Text>
          <Select disabled={!admin} data={d.choices} value={d.levels[k]} allowDeselect={false} w={110}
            onChange={(v) => api('PUT', `${P}/rules`, { levels: { [k]: v } }).then(reload).catch((e) => setError(e.message))} />
        </Group>
      ))}
    </Stack>
  );
}

// 하위 탭 첫 방문 카드 — 그 탭 기능(loads·pins·levels) 소개. 메뉴 안내와 따로 한 번씩
const TabIntro = ({ tab, user, features }) => <MenuIntro menu={`school:${tab}`} pitchKey={SCHOOL_TAB_FEATURE[tab]} user={user} features={features} />;

export default function SchoolPage({ user, goTab }) {
  const P = `/orgs/${user.orgId}`;
  const admin = user.role === '기관관리자';
  // 기관 스위치로 꺼진 탭은 숨기고, 첫 탭은 켜진 것 중 첫째(Tabs 가 defaultValue 를 처음에만 읽어 key 로 다시 세운다)
  const features = useOrgConfig(P).features;
  const on = visibleTabs(SCHOOL_TAB_FEATURE, features, ['basic', 'spec', 'loads', 'pins', ...(admin ? ['rules'] : [])]);
  const has = (t) => on.includes(t);
  const [tab, setTab] = useState(admin ? 'setup' : null);
  const cur = tab && (tab === 'setup' || has(tab)) ? tab : on[0];
  // 7단계 화면의 「직접 고치는 화면」 링크 — 학교 자료 안 탭은 여기서 옮기고, 바깥 탭(명단·특별실·자동 생성)은 윗줄 탭을 바꾸는 goTab 으로 옮긴다
  const INNER = { school: 'basic', loads: 'loads', pins: 'pins' };
  const OUTER = { roster: 'roster', rooms: 'rooms', generate: 'gen' };
  const goOld = (k) => {
    if (INNER[k]) return setTab(INNER[k]);
    goTab?.(OUTER[k]);
  };
  return (
    <Tabs key={cur === 'setup' ? 'setup' : on[0]} value={cur} onChange={setTab} keepMounted={false}>
      <Tabs.List>
        {admin && <Tabs.Tab value="setup">{t('school.wizard.tab')}</Tabs.Tab>}
        {has('basic') && <Tabs.Tab value="basic">학교 기본</Tabs.Tab>}
        {has('spec') && <Tabs.Tab value="spec">전담·비교과</Tabs.Tab>}
        {has('loads') && <Tabs.Tab value="loads">시수표</Tabs.Tab>}
        {has('pins') && <Tabs.Tab value="pins">고정·금지</Tabs.Tab>}
        {has('rules') && <Tabs.Tab value="rules">규칙 수위</Tabs.Tab>}
      </Tabs.List>
      {admin && <Tabs.Panel value="setup" pt="md"><SchoolSetup P={P} goOld={goOld} /></Tabs.Panel>}
      {has('basic') && <Tabs.Panel value="basic" pt="md"><Basics P={P} admin={admin} /></Tabs.Panel>}
      {has('spec') && <Tabs.Panel value="spec" pt="md"><Specialists P={P} admin={admin} /></Tabs.Panel>}
      {has('loads') && <Tabs.Panel value="loads" pt="md"><TabIntro tab="loads" user={user} features={features} /><Text size="sm" c="dimmed" mb="sm"><Term k="시수표">시수표</Term>: 누가·어느 반에·무슨 과목을·주 몇 시간 가르치는지 적은 표입니다(낱말을 누르면 풀이).</Text><Loads P={P} admin={admin} /></Tabs.Panel>}
      {has('pins') && <Tabs.Panel value="pins" pt="md">
        <TabIntro tab="pins" user={user} features={features} />
        <Tabs defaultValue="교사" keepMounted={false}>
          <Tabs.List>{['교사', '반', '특별실'].map((k) => <Tabs.Tab key={k} value={k}>{k}</Tabs.Tab>)}</Tabs.List>
          {['교사', '반', '특별실'].map((k) => <Tabs.Panel key={k} value={k} pt="md"><Pins P={P} admin={admin} kind={k} /></Tabs.Panel>)}
        </Tabs>
      </Tabs.Panel>}
      {has('rules') && <Tabs.Panel value="rules" pt="md"><TabIntro tab="rules" user={user} features={features} /><Rules P={P} admin={admin} /></Tabs.Panel>}
    </Tabs>
  );
}
