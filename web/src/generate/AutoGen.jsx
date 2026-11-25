import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Group, NumberInput, Progress, Select, Stack, Switch, Table, Text, TextInput } from '@mantine/core';
import { api } from '../api.js';
import { currentConflicts, moveConflicts } from '../gen/core.js';
import { dropPartial, genKey, loadPartial, savePartial } from '../gen/store.js';
import { combinedOf } from '../gen/overlap.js';
import { overHours, periodsMax, periodsOn } from '../../../shared/periods.js';
import { DEFAULTS, useOrgConfig } from '../orgConfig.js';
import Term from '../Term.jsx';
import { featureOn } from '../features.js';
import { genNoteTexts } from './genNotes.js';
import { teacherNames } from '../grid/secondTeacher.js';
import { markedName, vacantText } from '../grid/vacant.js';
import { hasTeacher } from '../../../shared/cellTeachers.js';
import { buildSheets, SHEET_DEFAULTS } from '../../../shared/sheetCalc.js';
import { t } from '../T.jsx';
import { useConfirm } from '../Confirm.jsx';
import { cascadeOpts, useDelete } from '../DeleteDialog.jsx';

const K = 8; // 후보 수 기본값(화면 입력칸이 덮고 localStorage 에 기억)
const PER_MS = 3000; // 후보 하나당 시간 기본값(ms)
// 안내문 — 권장 17 규칙이 아직 없다는 것을 먼저 말한다
export const SOFT_TAB_SENTENCE = '가중은 「생성 설정」 탭에서 바꿉니다.';
export const NOTICE = '필수(겹침 · 시수 · 급식 · 불가 시간)를 먼저 맞추고, 만든 후보 중 권장 규칙(공강 · 연속수업 등) 점수가 낮은 것을 위로 올립니다. 가중은 「생성 설정」 탭에서 바꿉니다. 마음에 안 드는 칸은 수정 모드에서 옮기세요.';
const LEVEL_COLOR = { 경고: 'red', 알림: 'yellow', 재확인: 'orange', 끔: 'green' };
const BG = { green: 'var(--mantine-color-green-1)', yellow: 'var(--mantine-color-yellow-1)', red: 'var(--mantine-color-red-1)', orange: 'var(--mantine-color-orange-1)' };

// 자동 생성 · 시안 관리 · 수정 모드(관리자만)
export default function AutoGen({ P, onGoVacant }) {
  const [input, setInput] = useState(null);
  const [error, setError] = useState('');
  const [list, setList] = useState([]);
  const [tid, setTid] = useState(null);
  const loadList = useCallback(() => api('GET', `${P}/timetables`).then(setList).catch((e) => setError(e.message)), [P]);
  useEffect(() => {
    api('GET', `${P}/gen/input`).then(setInput).catch((e) => setError(e.message));
    loadList();
  }, [P, loadList]);
  const cfg = useOrgConfig(P);
  const gin = useMemo(() => (input ? { ...input, weekdays: cfg.weekdays, days: cfg.weekdays.length, maxPeriods: cfg.limits.periods } : null), [input, cfg]);
  if (!input) return error ? <Alert color="red">{error}</Alert> : null;
  return (
    <Stack>
      {error && <Alert color="red" withCloseButton onClose={() => setError('')}>{error}</Alert>}
      <Generator P={P} input={gin} onGoVacant={onGoVacant} onSaved={(t) => { loadList(); setTid(t.id); }} />
      <Drafts P={P} input={gin} list={list} tid={tid} setTid={setTid} reload={loadList} />
    </Stack>
  );
}

const storeKey = (P, termId) => `gen:${P}:${termId ?? ''}`; // 학기가 바뀌면 지난 학기 결과가 안 보이게
const slow = () => (typeof window !== 'undefined' && (window.innerWidth < 600 || (navigator.hardwareConcurrency || 8) <= 4));

const optKey = (P) => `genopt:${P}`;
const readOpt = (P) => { try { return JSON.parse(localStorage.getItem(optKey(P)) || '{}') || {}; } catch { return {}; } };
// 후보 수·후보당 시간(초) 범위 — 밖이면 기본값
export const clampOpt = (o) => ({
  k: Number.isInteger(o?.k) && o.k >= 1 && o.k <= 40 ? o.k : K,
  sec: Number.isFinite(o?.sec) && o.sec >= 0.5 && o.sec <= 60 ? o.sec : PER_MS / 1000,
  mealGap: o?.mealGap !== false,
});

function Generator({ P, input, onSaved, onGoVacant }) {
  const softOn = featureOn(useOrgConfig(P).features, 'soft'); // 4단계(생성 설정)가 꺼져 있으면 가중을 바꿀 곳이 없다
  const [opt, setOptState] = useState(() => clampOpt(readOpt(P)));
  const setOpt = (o) => { const c = clampOpt({ ...opt, ...o }); setOptState(c); try { localStorage.setItem(optKey(P), JSON.stringify(c)); } catch { /* 기억 못 해도 이번 화면엔 쓴다 */ } };
  const [run, setRun] = useState(null); // {done, k}
  const [res, setRes] = useState(() => { try { return JSON.parse(localStorage.getItem(storeKey(P, input.term?.id)) || 'null'); } catch { return null; } });
  const [rank, setRank] = useState(0);
  const [name, setName] = useState('');
  const [msg, setMsg] = useState(null);
  const worker = useRef(null);
  const pkey = genKey(P.split('/')[2], input.term?.id);
  const [saved, setSaved] = useState(null);
  useEffect(() => { loadPartial(pkey).then(setSaved); }, [pkey]);
  useEffect(() => () => worker.current?.terminate(), []);

  const start = (resume) => {
    setMsg(null);
    const prev = resume ? saved.candidates : [];
    const k = resume ? Math.max(1, saved.k - saved.done) : opt.k;
    if (!resume) { setSaved(null); dropPartial(pkey); }
    worker.current?.terminate();
    const w = new Worker(new URL('../gen/worker.js', import.meta.url), { type: 'module' });
    worker.current = w;
    setRun({ done: 0, k });
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        setRun({ done: m.done, k: m.k });
        const cs = prev.length ? [...prev, ...m.candidates].sort((a, b) => a.hard - b.hard || a.rr - b.rr || a.soft - b.soft).map((c, rank) => ({ ...c, rank })) : m.candidates;
        savePartial(pkey, { done: (resume ? saved.done : 0) + m.done, k: resume ? saved.k : m.k, candidates: cs });
      }
      if (m.type === 'error') { setRun(null); setMsg({ color: 'red', text: m.message }); }
      if (m.type === 'done') {
        const out = { at: new Date().toISOString(), skipped: m.skipped, ms: m.ms, candidates: [...prev, ...m.candidates].sort((a, b) => a.hard - b.hard || a.rr - b.rr || a.soft - b.soft).map((c, rank) => ({ ...c, rank }))
          .map((c) => ({ rank: c.rank, hard: c.hard, rr: c.rr, soft: c.soft, cells: c.cells, unplaced: c.unplaced, warnings: c.warnings })) };
        setRes(out); setRank(0); setRun(null); setSaved(null); dropPartial(pkey);
        try { localStorage.setItem(storeKey(P, input.term?.id), JSON.stringify(out)); } catch { /* 저장 공간이 모자라면 이번 화면에만 둔다 */ }
        w.terminate();
      }
    };
    w.postMessage({ input: { ...input, hardOff: opt.mealGap ? [] : ['teacherMealGap'] }, k, perMs: Math.round(opt.sec * 1000), init: resume ? saved.candidates[0]?.cells : null });
  };
  const cand = res?.candidates?.[rank];
  const save = async () => {
    try {
      const t = await api('POST', `${P}/timetables/generated`, { name: name.trim(), cells: cand.cells, gen_info: { rank, hard: cand.hard, rr: cand.rr, soft: cand.soft, unplaced: cand.unplaced } });
      setName('');
      setMsg({ color: t.violations?.length ? 'yellow' : 'green', text: `「${t.name}」 시안으로 저장했습니다${t.violations?.length ? ` · 알림 ${t.violations.length}건` : ''}` });
      onSaved(t);
    } catch (e) { setMsg({ color: 'red', text: e.message }); }
  };

  const over = overHours(input.classrooms, input.lines, input.periods, input.weekdays || 5); // 시수 합 > 요일별 교시 합 — 알림만, 막지 않는다(T-1205)
  const noLunch = [...new Set(input.classrooms.map((c) => c.grade))].sort((x, y) => x - y).filter((g) => !(input.periods?.grades?.[g]?.lunchAfter > 0)); // 알림만, 막지 않는다
  return (
    <Stack>
      <Alert color="blue" title={<>명단과 <Term k="시수표">시수표</Term>를 다 넣었으면 <Term k="시안">시안</Term>을 만듭니다</>}>{softOn ? NOTICE : NOTICE.replace(SOFT_TAB_SENTENCE, '4단계(생성 설정)를 켜면 가중을 바꿀 수 있습니다.')}</Alert>
      {slow() && <Text size="sm" c="dimmed">PC 에서 하시면 빠릅니다. 폰에서도 그대로 됩니다.</Text>}
      <Group align="end">
        <NumberInput label="후보 수" min={1} max={40} w={90} value={opt.k} onChange={(v) => setOpt({ k: Number(v) })} />
        <NumberInput label="후보당 초" min={0.5} max={60} step={0.5} decimalScale={1} w={100} value={opt.sec} onChange={(v) => setOpt({ sec: Number(v) })} />
        <Switch label="전담 식사 빈 칸 필수" description="전담 선생님이 점심때 쉴 칸을 꼭 비워 둡니다. 끄면 그 칸에도 수업이 들어갈 수 있습니다." checked={opt.mealGap} onChange={(e) => setOpt({ mealGap: e.currentTarget.checked })} />
      </Group>
      {input.vacant?.count > 0 && (
        <Group gap="xs" data-testid="vacant-line">
          <Text size="sm" c="yellow.8">{vacantText.genLine(input.vacant.count)}</Text>
          {onGoVacant && <Button size="compact-xs" variant="light" onClick={onGoVacant}>{t('generate.vacant.go')}</Button>}
        </Group>
      )}
      {noLunch.length > 0 && <Text size="sm" c="yellow.8">{noLunch.map((g) => `${g}학년`).join('·')}은 점심 자리가 비어 점심 규칙을 건너뜁니다. 「학교」 화면 학년별 교시·점심에서 「점심은 몇 교시 뒤」를 넣으면 적용됩니다.</Text>}
      {over.length > 0 && <Text size="sm" c="yellow.8" data-testid="over-hours">{over.map((o) => `${o.grade}-${o.class_no} 시수 ${o.hours} > 한 주 교시 ${o.cap}`).join(' · ')} — 다 못 놓을 수 있습니다. 시수표나 「학교」 화면 교시 수(요일마다 다르게)를 확인하세요.</Text>}
      {!opt.mealGap && <Text size="sm" c="yellow.8">식사 빈 칸을 필수에서 뺐습니다. 대신 권장 점수의 「교사 점심시간 확보」가 세어 줍니다.</Text>}
      <Group align="end">
        <Button onClick={() => start(false)} loading={!!run} disabled={!input.classrooms.length}>자동 생성 (후보 {opt.k}개 · 최대 {opt.k * opt.sec}초)</Button>
        {res && <Button variant="default" disabled={!!run || rank + 1 >= res.candidates.length} onClick={() => setRank(rank + 1)}>다음 시안</Button>}
      </Group>
      {saved && !run && (
        <Alert color="yellow" title="중단된 생성이 있습니다">
          <Text size="sm">{new Date(saved.at).toLocaleString('ko-KR')} · 후보 {saved.done}/{saved.k}개까지 만들었습니다.</Text>
          <Group mt="xs"><Button size="xs" onClick={() => start(true)}>이어서 하기</Button><Button size="xs" variant="default" onClick={() => { setSaved(null); dropPartial(pkey); }}>버리기</Button></Group>
        </Alert>
      )}
      {!input.classrooms.length && <Text size="sm" c="dimmed">「학교 기본」에서 반을 먼저 만드세요.</Text>}
      {run && <Progress value={(run.done / run.k) * 100} animated />}
      {msg && <Alert color={msg.color} withCloseButton onClose={() => setMsg(null)}>{msg.text}</Alert>}
      {cand && (
        <Stack gap="xs">
          <Group>
            <Badge size="lg">{rank + 1}순위 / {res.candidates.length}</Badge>
            <Badge size="lg" color={cand.hard ? 'red' : 'green'}>못 놓은 시수 {cand.hard}</Badge>
            <Badge size="lg" color={cand.rr ? 'yellow' : 'green'}>진도 맞춤 어긋남 {cand.rr}</Badge>
            <Badge size="lg" color="gray">권장 점수 {cand.soft} (낮을수록 좋음)</Badge>
            <Text size="xs" c="dimmed">{(res.ms / 1000).toFixed(1)}초 · {new Date(res.at).toLocaleString('ko-KR')}</Text>
          </Group>
          {cand.unplaced?.length > 0 && <Text size="sm" c="red">못 놓은 수업 {cand.unplaced.length}개 — 저장한 뒤 수정 모드에서 손으로 넣으세요.</Text>}
          {genNoteTexts(cand).map((t) => <Text key={t} size="sm" c="yellow.8">{t}</Text>)}
          {res.skipped > 0 && <Text size="sm" c="yellow.8">시수표에서 덜 채운 줄 {res.skipped}개는 빼고 만들었습니다.</Text>}
          <Group align="end">
            <TextInput label="시안 이름" placeholder="예: 2학기 자동 1" value={name} onChange={(e) => setName(e.currentTarget.value)} />
            <Button disabled={!name.trim()} onClick={save}>이 시안 저장</Button>
          </Group>
          <ResultView input={input} cells={cand.cells} />
        </Stack>
      )}
    </Stack>
  );
}

function Drafts({ P, input, list, tid, setTid, reload }) {
  const [d, setD] = useState(null);
  const [date, setDate] = useState('');
  const [copyName, setCopyName] = useState('');
  const [msg, setMsg] = useState(null);
  const [ask, confirmBox] = useConfirm();
  const [del, delBox] = useDelete();
  const load = useCallback(() => (tid ? api('GET', `${P}/timetables/${tid}`).then(setD).catch((e) => setMsg({ color: 'red', text: e.message })) : setD(null)), [P, tid]);
  useEffect(() => { load(); }, [load]);
  const act = (fn) => async (...a) => { setMsg(null); try { await fn(...a); } catch (e) { setMsg({ color: 'red', text: e.message }); } };
  const tt = d?.timetable;
  const levelOf = (rule) => d?.levels?.[rule];

  // 수정 모드: 같은 반 안 두 칸 맞바꾸기(맞바꾸기 한 번 호출)
  const swap = act(async (from, to) => {
    if (tt.status === '확정' && levelOf('edit_confirmed') === '재확인' && !(await ask('확정된 시간표입니다. 그래도 옮길까요?', { yes: '옮기기' }))) return;
    const r = await api('POST', `${P}/timetables/${tid}/cells/swap`, { from: { classroom_id: from.classroom_id, weekday: from.weekday, period: from.period }, to: { classroom_id: to.classroom_id, weekday: to.weekday, period: to.period } });
    setMsg(r.violations?.length ? { color: r.violations.some((v) => v.color === 'red') ? 'red' : 'yellow', text: `옮겼습니다. ${r.violations.map((v) => v.detail || v.label).join(' · ')}` } : { color: 'green', text: '옮겼습니다.' });
    await load();
  });

  if (!list.length) return null;
  return (
    <Stack mt="lg">
      {confirmBox}{delBox}
      <Group align="end">
        <Select label="저장한 시간표 (수정 모드)" placeholder="고르세요" data={list.map((t) => ({ value: String(t.id), label: `${t.name} (${t.status}${t.starts_on ? ` · ${String(t.starts_on).slice(0, 10)}부터` : ''})` }))} value={tid ? String(tid) : null} onChange={(v) => setTid(v ? Number(v) : null)} />
      </Group>
      {msg && <Alert color={msg.color} withCloseButton onClose={() => setMsg(null)}>{msg.text}</Alert>}
      {tt && (
        <>
          <Group align="end">
            {tt.status === '시안' ? (
              <>
                <TextInput type="date" label="적용 시작일" value={date} onChange={(e) => setDate(e.currentTarget.value)} />
                <Button color="green" disabled={!date} onClick={act(async () => {
                  if (!(await ask(`「${tt.name}」을 ${date}부터 확정합니다. 확정하면 교직원 화면에 뜹니다.`, { yes: '확정' }))) return;
                  const r = await api('POST', `${P}/timetables/${tid}/confirm`, { starts_on: date });
                  setMsg({ color: r.notes?.length ? 'yellow' : 'green', text: `확정했습니다.${r.notes?.length ? ` ${r.notes.map((n) => n.detail).join(' · ')}` : ''}` });
                  reload(); load();
                })}>확정</Button>
              </>
            ) : (
              <Button variant="default" onClick={act(async () => { if (!(await ask('확정을 풀고 시안으로 돌릴까요?', { yes: '확정 풀기' }))) return; await api('POST', `${P}/timetables/${tid}/unconfirm`); reload(); load(); })}>확정 풀기</Button>
            )}
            <TextInput label="복제 이름" placeholder={`${tt.name} 사본`} value={copyName} onChange={(e) => setCopyName(e.currentTarget.value)} />
            <Button variant="default" onClick={act(async () => { const t = await api('POST', `${P}/timetables/${tid}/copy`, { name: copyName.trim() || `${tt.name} 사본` }); setCopyName(''); reload(); setTid(t.id); })}>복제</Button>
            <Button color="red" variant="light" onClick={() => del(cascadeOpts(P, 'timetable', tid, tt.name, `${P}/timetables/${tid}`, {
              lead: `이 시간표(${tt.status})를 지웁니다.${tt.status === '확정' ? ' 확정된 시간표라 교직원 화면에서도 사라집니다.' : ''}`, onDone: () => { setTid(null); reload(); } }))}>지우기</Button>
          </Group>
          <ModeGrid input={input} cells={d.cells} levels={d.levels} onSwap={swap} />
        </>
      )}
    </Stack>
  );
}

// 자동 생성 결과 보기 — 엑셀 출력과 같은 계산(shared/sheetCalc.js)으로 교사별·특별실별·반별 표를 그린다.
// 상태를 여기 두어 「다음 시안」으로 넘겨도 보던 보기·대상이 남는다.
const VIEWS = ['teacher', 'room', 'class'];
export function ResultView({ input, cells }) {
  const [view, setView] = useState('teacher');
  const [pick, setPick] = useState({});
  const d = useMemo(() => ({ cells, classrooms: input.classrooms, subjects: input.subjects, teachers: input.teachers, rooms: input.rooms, weekdays: input.weekdays, periodConfig: input.periods }), [input, cells]);
  const sd = useMemo(() => ({ ...d, teachers: [...d.teachers, ...(input.inactive_teachers || []).map((x) => ({ id: x.id, name: markedName(x.name) }))] }), [d, input]); // 칸에 이름은 보이되 고르는 목록엔 안 넣는다
  const all = useMemo(() => buildSheets(sd, SHEET_DEFAULTS, { view }), [sd, view]);
  // 고르기 목록: 시트 제목과 같은 순서 · 값은 대상 id (반별은 input.classrooms 순서)
  const owners = view === 'teacher' ? d.teachers.filter((x) => cells.some((c) => hasTeacher(c, x.id))).sort((a, b) => a.name.localeCompare(b.name, 'ko'))
    : view === 'room' ? (d.rooms || []).filter((x) => cells.some((c) => Number(c.special_room_id) === Number(x.id))).sort((a, b) => a.name.localeCompare(b.name, 'ko'))
      : d.classrooms;
  const label = (x) => (view === 'class' ? `${x.grade}학년 ${x.class_no}반` : x.name); // 문구-예외: 반 이름 꼴(출력 시트와 같은 글자)
  const cur = owners.find((x) => String(x.id) === String(pick[view])) || owners[0];
  const sheet = cur ? buildSheets(sd, SHEET_DEFAULTS, { view, id: cur.id })[0] : null;
  return (
    <Stack gap="xs">
      <Group>
        <Select label={t('generate.result.view_label')} data={VIEWS.map((v) => ({ value: v, label: t(`generate.result.view_${v}`) }))} value={view} onChange={(v) => v && setView(v)} allowDeselect={false} w={130} data-testid="result-view" />
        <Select label={t(`generate.result.pick_${view}`)} data={owners.map((x) => ({ value: String(x.id), label: label(x) }))} value={cur ? String(cur.id) : null} onChange={(v) => setPick({ ...pick, [view]: v })} allowDeselect={false} w={170} disabled={!cur} data-testid="result-pick" />
      </Group>
      {!sheet || !all.length ? <Text size="sm" c="dimmed">{view === 'class' ? '' : t(`generate.result.empty_${view}`)}</Text> : (
        <div className="grid-scroll">
          <Table withTableBorder withColumnBorders className="tt-grid" data-testid="result-table">
            <Table.Thead><Table.Tr>{sheet.header.map((h, i) => <Table.Th key={i} ta="center">{h.text}</Table.Th>)}</Table.Tr></Table.Thead>
            <Table.Tbody>
              {sheet.rows.map((row, ri) => (
                <Table.Tr key={ri}>
                  {row.map((c, ci) => <Table.Td key={ci} ta="center" fw={ci === 0 ? 600 : undefined} style={{ whiteSpace: 'pre-line', minWidth: ci ? 74 : undefined }}><Text size="sm">{c.text}</Text></Table.Td>)}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
    </Stack>
  );
}

// 수정 모드 격자 — 칸을 끌어 옮기거나(PC) 눌러 고른 뒤 눌러 옮긴다(폰).
// 고른 칸이 있으면 같은 반 칸마다 색: 초록=옮겨도 안전 · 노랑/빨강=옮기면 위반(규칙 수위 따라) · 빗금 빨강=지금 위반
export function ModeGrid({ input, cells, levels = input.levels || {}, onSwap }) {
  const DAYS = input.weekdays || DEFAULTS.weekdays;
  const [classId, setClassId] = useState(input.classrooms[0]?.id ?? null);
  const [src, setSrc] = useState(null);
  const classInfo = useMemo(() => {
    const g = input.periods?.grades || {};
    // P = 가장 긴 날(격자 줄 수) · PW = 요일별 교시 수(그 밖은 「수업 없음」 · 옮기면 범위 밖)
    return Object.fromEntries(input.classrooms.map((c) => [c.id, { L: g[c.grade]?.lunchAfter || 0, P: periodsMax(input.periods, c.grade), PW: Object.fromEntries(DAYS.map((_x, wi) => [wi + 1, periodsOn(input.periods, c.grade, wi + 1)])) }]));
  }, [input, DAYS]);
  // 복식 묶음·교시 시각을 아는 겹침 규칙(서버 violations.js 와 같은 규칙)
  const ctx = useMemo(() => ({ periods: input.periods || {}, gradeOf: Object.fromEntries(input.classrooms.map((c) => [c.id, c.grade])), combined: combinedOf(input.small) }), [input]);
  const now = useMemo(() => currentConflicts(cells, classInfo, ctx), [cells, classInfo, ctx]);
  const cellMap = useMemo(() => new Map(cells.map((c) => [`${c.classroom_id}:${c.weekday}:${c.period}`, c])), [cells]);
  const cls = input.classrooms.find((c) => c.id === classId) || input.classrooms[0];
  if (!cls) return null;
  const nm = (list, v) => list?.find((x) => String(x.id) === String(v));
  const subj = (v) => nm(input.subjects, v)?.short_name || nm(input.subjects, v)?.name || '';
  const colorOf = (rules) => {
    let worst = 'green';
    for (const r of rules) {
      const c = LEVEL_COLOR[levels[r.rule]] || 'red';
      if (c === 'red') return 'red';
      if (c === 'orange' || (c === 'yellow' && worst === 'green')) worst = c;
    }
    return worst;
  };
  const pcount = classInfo[cls.id].P;
  const slot = (w, p) => ({ classroom_id: cls.id, weekday: w, period: p });
  const drop = (w, p) => {
    if (!src || !onSwap) return;
    if (src.weekday === w && src.period === p) { setSrc(null); return; }
    const from = src;
    setSrc(null);
    onSwap(from, slot(w, p));
  };
  const tap = (w, p) => {
    if (!onSwap) return;
    if (!src) { if (cellMap.get(`${cls.id}:${w}:${p}`)) setSrc(slot(w, p)); return; }
    drop(w, p);
  };
  return (
    <Stack gap="xs">
      <Group>
        <Select label="반" data={input.classrooms.map((c) => ({ value: String(c.id), label: `${c.grade}학년 ${c.class_no}반` }))} value={String(cls.id)} onChange={(v) => { setClassId(Number(v)); setSrc(null); }} allowDeselect={false} w={150} />
        {onSwap && <Text size="sm" c="dimmed">{src ? '옮길 칸을 누르세요(초록이 안전합니다)' : '칸을 끌어 옮기거나, 눌러 고른 뒤 옮길 칸을 누르세요'}</Text>}
      </Group>
      <div className="grid-scroll">
        <Table withTableBorder withColumnBorders className="tt-grid">
          <Table.Thead><Table.Tr><Table.Th w={50}>교시</Table.Th>{DAYS.map((x) => <Table.Th key={x} ta="center">{x}</Table.Th>)}</Table.Tr></Table.Thead>
          <Table.Tbody>
            {Array.from({ length: pcount }, (_, i) => i + 1).map((p) => (
              <Table.Tr key={p}>
                <Table.Td ta="center" fw={600}>{p}</Table.Td>
                {DAYS.map((_x, wi) => {
                  const w = wi + 1;
                  const k = `${cls.id}:${w}:${p}`;
                  const c = cellMap.get(k);
                  const bad = now.get(k);
                  const isSrc = src && src.weekday === w && src.period === p;
                  const hint = src && !isSrc ? colorOf(moveConflicts(cells, classInfo, src, slot(w, p), ctx)) : null;
                  const style = {
                    cursor: onSwap ? 'pointer' : 'default', minWidth: 74,
                    background: hint ? BG[hint] : bad ? `repeating-linear-gradient(45deg, ${BG.red}, ${BG.red} 6px, transparent 6px, transparent 12px)` : undefined,
                    outline: isSrc ? '2px solid var(--mantine-color-blue-6)' : undefined,
                  };
                  return (
                    <Table.Td key={w} style={style} draggable={!!onSwap && !!c} onDragStart={() => setSrc(slot(w, p))} onDragOver={(e) => e.preventDefault()} onDrop={() => drop(w, p)} onClick={() => tap(w, p)}>
                      {c ? (
                        <>
                          <Text size="sm" fw={600}>{subj(c.subject_id) || '·'}</Text>
                          <Text size="xs" c="dimmed">{teacherNames(c, input.teachers, input.inactive_teachers, t('grid.vacant.mark')).join(' · ')}{c.special_room_id ? ` @${nm(input.rooms, c.special_room_id)?.name || ''}` : ''}</Text>
                          {bad && <Text size="xs" c="red" fw={700}>{bad.some((b) => b.rule === 'teacher_overlap') ? '교사 겹침' : '특별실 겹침'}</Text>}
                          {p > classInfo[cls.id].PW[w] && <Text size="xs" c="orange" fw={700}>교시 수 밖</Text>}
                        </>
                      ) : <Text size="xs" c="dimmed">{p > classInfo[cls.id].PW[w] ? '수업 없음' : ' '}</Text>}
                    </Table.Td>
                  );
                })}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
    </Stack>
  );
}
