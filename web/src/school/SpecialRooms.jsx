import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Group, MultiSelect, NumberInput, Select, Stack, Text, TextInput } from '@mantine/core';
import { api } from '../api.js';
import { numOfText } from './numberText.js';
import { cascadeOpts, useDelete } from '../DeleteDialog.jsx';
import { useConfirm } from '../Confirm.jsx';
import { t } from '../../../shared/text/index.js';

const PURPOSES = ['수업용', '예약용']; // 문구-예외: 저장 값

// 서버가 저장하면서 돌려준 알림({key,msg}) 글만 뽑는다
export const warnTexts = (r) => (r?.warnings || []).map((w) => w.msg);

// 학교 기본 › 특별실(정원 고치기) · 특별실 묶음(만들기·이름·방 고르기·지우기)
export default function SpecialRooms({ P, admin }) {
  const [rooms, setRooms] = useState(null);
  const [groups, setGroups] = useState(null);
  const [room, setRoom] = useState({ name: '', purpose: PURPOSES[0] });
  const [grp, setGrp] = useState({ name: '', room_ids: [] });
  const [notes, setNotes] = useState([]);
  const [error, setError] = useState('');
  const [del, delBox] = useDelete();
  const [ask, askBox] = useConfirm();
  const load = () => Promise.all([api('GET', `${P}/special-rooms`).then(setRooms), api('GET', `${P}/special-room-groups`).then(setGroups)]).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [P]); // eslint-disable-line
  // 호출 하나 — 오류는 빨강, 서버 알림(warnings)은 노랑으로 보여 주고 다시 읽는다
  const run = (fn) => async () => { setError(''); setNotes([]); try { setNotes(warnTexts(await fn())); await load(); } catch (e) { setError(e.message); } };
  const capLabel = (r) => t('school.room.capacity_label', { 이름: r.name }); // 문구-예외: 문구 변수 이름
  const capShow = (r) => t('school.room.capacity_show', { 정원: r.capacity }); // 문구-예외: 문구 변수 이름
  const delAsk = (g) => t('school.room.group_delete_ask', { 이름: g.name }); // 문구-예외: 문구 변수 이름
  const roomOpts = (rooms || []).map((r) => ({ value: String(r.id), label: r.name }));
  const roomName = (id) => (rooms || []).find((r) => r.id === id)?.name ?? `#${id}`;
  return (
    <Stack gap="xs" data-testid="special-rooms">
      {delBox}
      {askBox}
      <Text fw={600}>{t('school.room.title')}</Text>
      {error && <Alert color="red">{error}</Alert>}
      {notes.map((m, i) => <Alert key={i} color="yellow">{m}</Alert>)}
      {(rooms || []).map((r) => (
        <Group key={r.id} gap="xs">
          <Text size="sm">{r.name}</Text>
          <Badge variant="light">{r.purpose}</Badge>
          {admin ? (
            <NumberInput aria-label={capLabel(r)} placeholder={t('school.room.capacity_ph')} min={1} allowDecimal={false} key={`${r.id}:cap:${r.capacity ?? ''}`} defaultValue={r.capacity ?? ''}
              onBlur={(e) => { const v = numOfText(e.currentTarget.value); if (v !== (r.capacity ?? null)) run(() => api('PATCH', `${P}/special-rooms/${r.id}`, { capacity: v }))(); }} w={150} prefix={t('school.room.capacity_prefix')} />
          ) : (r.capacity ? <Text size="sm">{capShow(r)}</Text> : null)}
          {admin && <Button size="compact-xs" variant="subtle" color="red" onClick={() => del(cascadeOpts(P, 'special_room', r.id, r.name, `${P}/special-rooms/${r.id}`, { lead: t('school.room.delete_lead'), onDone: load }))}>{t('school.room.delete_button')}</Button>}
        </Group>
      ))}
      {admin && (
        <Group>
          <TextInput placeholder={t('school.room.name_ph')} value={room.name} onChange={(e) => setRoom({ ...room, name: e.currentTarget.value })} />
          <Select data={PURPOSES} value={room.purpose} onChange={(v) => setRoom({ ...room, purpose: v })} w={110} />
          <Button onClick={run(async () => { const r = await api('POST', `${P}/special-rooms`, room); setRoom({ ...room, name: '' }); return r; })}>{t('school.room.add_button')}</Button>
        </Group>
      )}
      <Text size="xs" c="dimmed">{t('school.room.capacity_hint')}</Text>

      <Text fw={600} mt="sm">{t('school.room.group_title')}</Text>
      <Text size="xs" c="dimmed">{t('school.room.group_lead')}</Text>
      {groups && !groups.length && <Text size="sm" c="dimmed">{t('school.room.group_none')}</Text>}
      {(groups || []).map((g) => (
        <Group key={g.id} gap="xs" align="end" data-testid={`room-group-${g.id}`}>
          {admin ? (
            <>
              <TextInput aria-label={t('school.room.group_name_label')} key={`${g.id}:n:${g.name}`} defaultValue={g.name} maxLength={40} w={150}
                onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v && v !== g.name) run(() => api('PATCH', `${P}/special-room-groups/${g.id}`, { name: v }))(); }} />
              <MultiSelect aria-label={t('school.room.group_rooms_label')} placeholder={t('school.room.group_rooms_ph')} data={roomOpts} key={`${g.id}:r:${g.room_ids.join(',')}`} defaultValue={g.room_ids.map(String)} w={280}
                onChange={(v) => run(() => api('PATCH', `${P}/special-room-groups/${g.id}`, { room_ids: v.map(Number) }))()} />
              <Button size="compact-xs" variant="subtle" color="red" onClick={async () => { if (await ask(delAsk(g), { yes: t('school.room.group_delete_yes') })) run(() => api('DELETE', `${P}/special-room-groups/${g.id}`))(); }}>{t('school.room.group_delete')}</Button>
            </>
          ) : <Text size="sm">{g.name} · {g.room_ids.map(roomName).join(', ')}</Text>}
        </Group>
      ))}
      {admin && (
        <Group>
          <TextInput placeholder={t('school.room.group_name_ph')} maxLength={40} value={grp.name} onChange={(e) => setGrp({ ...grp, name: e.currentTarget.value })} w={150} />
          <MultiSelect placeholder={t('school.room.group_rooms_ph')} data={roomOpts} value={grp.room_ids} onChange={(v) => setGrp({ ...grp, room_ids: v })} w={280} />
          <Button disabled={!grp.name.trim()} onClick={run(async () => { const r = await api('POST', `${P}/special-room-groups`, { name: grp.name.trim(), room_ids: grp.room_ids.map(Number) }); setGrp({ name: '', room_ids: [] }); return r; })}>{t('school.room.group_add')}</Button>
        </Group>
      )}
    </Stack>
  );
}
