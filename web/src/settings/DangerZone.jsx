import { useEffect, useState } from 'react';
import { Alert, Button, Group, Paper, Radio, Stack, Text, Title } from '@mantine/core';
import { api } from '../api.js';
import { useDelete } from '../DeleteDialog.jsx';

const LEVELS = [
  ['timetable', '시간표만', '이번 학기의 시간표(시안·확정)와 그 칸이 지워집니다. 시수표·고정·금지·반·명단은 그대로입니다. 시간표만 처음부터 다시 짜고 싶을 때 고릅니다.'],
  ['hours', '시간표 + 시수표·고정', '위에 더해 시수표(누가 어느 반에 무엇을 가르치는지)와 고정·금지 칸, 보결·근태 기록이 지워집니다. 반과 명단은 그대로입니다. 시수 입력부터 다시 하고 싶을 때 고릅니다.'],
  ['classes', '반까지 전부', '위에 더해 이번 학기의 반(과 담임 지정)까지 지워집니다. 명단·교과·특별실은 그대로입니다. 학기를 거의 빈 채로 되돌릴 때 고릅니다.'],
];

// 「이번 학기 비우기」 단추 — 위험 구역 말고도 「이미 자료가 있어 막힘」 자리가 같은 확인 창을 연다(term 을 안 주면 스스로 읽는다)
export function ClearTermButton({ P, term: given, level = 'timetable', onDone, label = '이번 학기 비우기…', variant = 'outline' }) {
  const [own, setOwn] = useState(null);
  const [del, delBox] = useDelete();
  useEffect(() => { if (!given) api('GET', `${P}/term`).then(setOwn).catch(() => setOwn(null)); }, [P, given]);
  const term = given ?? own;
  const name = term ? `${term.year}년 ${term.semester}학기` : '';
  return (
    <>
      {delBox}
      <Button color="red" variant={variant} disabled={!term} onClick={() => del({
        title: `${name} 비우기 — ${LEVELS.find((l) => l[0] === level)[1]}`, danger: true, restorable: true, typeLabel: '학기 이름', yes: '비우기',
        lead: `「${name}」에서 아래 단계까지 비웁니다. 학기 자체는 남습니다.`,
        previewPath: `${P}/terms/${term.id}/clear-preview?level=${level}`,
        run: (typed) => api('POST', `${P}/terms/${term.id}/clear`, { level, confirm: typed }), onDone,
      })}>{label}</Button>
    </>
  );
}

// 기관 설정 맨 아래 「위험 구역」 — 이번 학기 비우기(이름 글자로 확인) · 방금 연 학기 되돌리기
export default function DangerZone({ P }) {
  const [term, setTerm] = useState(null);
  const [undo, setUndo] = useState(null);
  const [level, setLevel] = useState('timetable');
  const [msg, setMsg] = useState(null);
  const [del, delBox] = useDelete();
  const load = () => { api('GET', `${P}/term`).then(setTerm).catch(() => setTerm(null)); api('GET', `${P}/terms/undo-new-semester`).then(setUndo).catch((e) => setUndo({ ok: false, reason: [403, 404].includes(e.status) ? '이 학교의 관리 권한이 있는 계정만 되돌릴 수 있습니다' : e.message })); };
  useEffect(load, [P]); // eslint-disable-line
  const done = (text) => () => { setMsg(text); load(); };
  const name = term ? `${term.year}년 ${term.semester}학기` : '';
  return (
    <Paper withBorder p="md" mt="xl" style={{ borderColor: 'var(--mantine-color-red-6)' }} data-testid="danger-zone">
      {delBox}
      <Stack gap="sm">
        <Title order={5} c="red">위험 구역</Title>
        <Text size="sm" c="dimmed">한꺼번에 많이 지우는 일입니다. 지운 것은 「내 정보 → 지운 것 보관함」에서 되살릴 수 있고, 변경 기록(감사 기록)과 지난 학기 보관본은 어느 쪽도 지워지지 않습니다.</Text>
        {msg && <Alert color="green" p="xs" withCloseButton onClose={() => setMsg(null)}>{msg}</Alert>}
        <Text fw={600}>이번 학기 비우기{name && ` — ${name}`}</Text>
        <Radio.Group value={level} onChange={setLevel}>
          <Stack gap="xs">{LEVELS.map(([v, t, d]) => <Radio key={v} value={v} label={t} description={d} />)}</Stack>
        </Radio.Group>
        <Group>
          <ClearTermButton P={P} term={term} level={level} onDone={done(`${name}을 비웠습니다.`)} />
        </Group>
        <Text fw={600} mt="sm">방금 연 학기 되돌리기</Text>
        <Text size="sm" c="dimmed">「새 학기 시작」을 누른 직후 잘못 열었을 때, 새 학기를 없애고 지난 학기를 다시 진행 중으로 돌립니다. 새 학기에 시간표를 확정했거나 보결·근태를 적었다면 되돌릴 수 없습니다.</Text>
        {undo && !undo.ok && <Text size="sm" c="dimmed" data-testid="undo-reason">지금은 안 됩니다: {undo.reason}</Text>}
        <Group>
          <Button color="red" variant="outline" disabled={!undo?.ok} onClick={() => del({
            title: '방금 연 학기 되돌리기', restorable: true, yes: '되돌리기',
            lead: `새로 연 ${undo.current.year}년 ${undo.current.semester}학기를 없애고, ${undo.previous.year}년 ${undo.previous.semester}학기를 다시 진행 중으로 돌립니다.`,
            run: () => api('POST', `${P}/terms/undo-new-semester`), onDone: done('방금 연 학기를 되돌렸습니다.'),
          })}>방금 연 학기 되돌리기…</Button>
        </Group>
      </Stack>
    </Paper>
  );
}
