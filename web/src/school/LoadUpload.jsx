import { useState } from 'react';
import { Alert, Badge, Button, Checkbox, Group, Stack, Table, Text } from '@mantine/core';
import { api } from '../api.js';

// 시수표 엑셀 올리기 — 양식 받기 → 올리기 → 미리보기(읽음 초록 · 못 읽음 빨강) → 읽힌 줄만 반영.
// 교사를 못 찾은 줄은 버리지 않고 사유를 보이고, 「교사 빈 줄로 받기」(기본 꺼짐)를 켜면 교사 칸만 비운 채 받는다.
async function download(path, fallback) {
  const res = await fetch(`/api${path}`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '내려받지 못했습니다');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = fallback;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function LoadUpload({ P, onDone }) {
  const [pv, setPv] = useState(null);
  const [blank, setBlank] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  async function pick(e) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setErr(''); setMsg(''); setPv(null); setBlank(false);
    try { setPv(await api('POST', `${P}/loads/preview`, f)); } catch (x) { setErr(x.message); }
  }
  const take = pv ? pv.rows.filter((x) => x.ok || (blank && x.blank_teacher_ok)) : [];
  async function apply() {
    try {
      const r = await api('POST', `${P}/loads/apply`, { rows: take.map((x) => ({ membership_id: x.ok ? x.membership_id : null, subject_id: x.subject_id, classroom_ids: x.classroom_ids, hours: x.hours, block: x.block, ...(x.second_membership_id ? { second_membership_id: x.second_membership_id, second_hours: x.second_hours ?? null } : {}) })) });
      setMsg(`${r.applied}줄을 시수표에 넣었습니다(새로 ${r.created} · 고침 ${r.updated}${r.skipped ? ` · 건너뜀 ${r.skipped}` : ''})${(r.warnings || []).map((w) => ` · 주의: ${w.detail}`).join('')}`);
      setPv(null); onDone?.();
    } catch (x) { setErr(x.message); }
  }
  return (
    <Stack gap="xs">
      <Text size="sm">엑셀(.xlsx)이나 한글(.hwpx) 표를 올리면 교사·교과·학년·반·시수·연강(·선택 열인 둘째 교사·함께 시수)을 읽어 미리 보여 줍니다. 아직 아무것도 저장하지 않습니다. 반 칸은 비우면 그 학년 전체, <b>1,3,5</b> 나 <b>1~4</b> 도 됩니다. 같은 교사·교과·반이 이미 있으면 시수·연강만 고칩니다.</Text>
      <Group>
        <Button component="label" variant="default">시수표 파일 고르기<input type="file" hidden accept=".xlsx,.hwpx" onChange={pick} /></Button>
        <Button variant="subtle" onClick={() => download(`${P}/loads/template`, 'loads-template.xlsx').catch((e) => setErr(e.message))}>엑셀 양식 받기</Button>
      </Group>
      {err && <Alert color="red">{err}</Alert>}
      {msg && <Alert color="green">{msg}</Alert>}
      {pv && (
        <>
          <Group><Badge color="green">읽음 {pv.ok}</Badge><Badge color="red">못 읽음 {pv.unread}</Badge></Group>
          <Table withTableBorder>
            <Table.Thead><Table.Tr><Table.Th>줄</Table.Th><Table.Th>교사</Table.Th><Table.Th>교과</Table.Th><Table.Th>반</Table.Th><Table.Th>시수</Table.Th><Table.Th>연강</Table.Th><Table.Th>둘째 교사</Table.Th><Table.Th>비고</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>
              {pv.rows.map((x) => (
                <Table.Tr key={x.line} style={x.ok ? undefined : { color: 'var(--mantine-color-red-7)', background: 'var(--mantine-color-red-0)' }}>
                  <Table.Td>{x.line}</Table.Td><Table.Td>{x.teacher || '?'}</Table.Td><Table.Td>{x.subject || '?'}</Table.Td><Table.Td>{x.target}</Table.Td><Table.Td>{x.hours ?? '?'}</Table.Td><Table.Td>{x.block > 1 ? `${x.block}시수` : ''}</Table.Td><Table.Td>{x.second_teacher ? `${x.second_teacher}${x.second_hours != null ? ` · 함께 ${x.second_hours}시수` : ''}` : ''}</Table.Td><Table.Td>{x.reason}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          {pv.blankTeacher > 0 && <Checkbox checked={blank} onChange={(e) => setBlank(e.currentTarget.checked)} label={`교사 빈 줄로 받기 — 교사만 못 찾은 ${pv.blankTeacher}줄을 교사 칸을 비운 채 넣습니다(나중에 시수표에서 교사를 고릅니다)`} />}
          <Group><Button disabled={!take.length} onClick={apply}>읽은 {take.length}줄을 시수표에 넣기</Button>{pv.unread - (blank ? pv.blankTeacher : 0) > 0 && <Text size="sm" c="red">빨강 줄은 넣지 않습니다. 고쳐서 다시 올려 주세요.</Text>}</Group>
        </>
      )}
    </Stack>
  );
}
