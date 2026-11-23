import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Paper, Stack, Table, Text, Title } from '@mantine/core';
import { api } from '../api.js';
import { KIND_NAME, effectLines } from '../deleteDialog.js';

// 지운 것 보관함 — 기관 관리자가 지운 묶음을 언제·무엇·딸린 수로 보고 되살린다. 되살릴 수 없으면 서버가 이유(409)를 준다.
export default function TrashBox({ orgId }) {
  const P = `/orgs/${orgId}`;
  const [rows, setRows] = useState(null);
  const [msg, setMsg] = useState(null);
  const load = () => api('GET', `${P}/trash`).then(setRows).catch((e) => { setRows([]); setMsg({ color: 'red', text: e.message }); });
  useEffect(() => { load(); }, [orgId]); // eslint-disable-line
  const restore = async (b) => {
    setMsg(null);
    try { await api('POST', `${P}/trash/${b.id}/restore`); setMsg({ color: 'green', text: `「${b.label}」을 되살렸습니다. 열려 있는 다른 화면은 다시 열면 반영됩니다.` }); } catch (e) { setMsg({ color: 'red', text: e.message }); }
    load();
  };
  return (
    <Paper withBorder p="md" mt="md" data-testid="trash-box">
      <Stack gap="xs">
        <Title order={5}>지운 것 보관함</Title>
        <Text size="sm" c="dimmed">반·교사 소속·교과·특별실·시간표를 지우거나 학기를 비우면 여기에 한 묶음으로 남습니다. 「되살리기」를 누르면 딸려 사라졌던 것까지 함께 돌아옵니다. 같은 이름이 이미 다시 생겼으면 되살릴 수 없고, 이유가 나옵니다.</Text>
        {msg && <Alert color={msg.color} p="xs" withCloseButton onClose={() => setMsg(null)}>{msg.text}</Alert>}
        {rows && rows.length === 0 && <Text size="sm">지운 것이 없습니다.</Text>}
        {rows && rows.length > 0 && (
          <Table.ScrollContainer minWidth={500}>
            <Table>
              <Table.Thead><Table.Tr><Table.Th>언제</Table.Th><Table.Th>무엇</Table.Th><Table.Th>함께 사라진 것</Table.Th><Table.Th /></Table.Tr></Table.Thead>
              <Table.Tbody>
                {rows.map((b) => (
                  <Table.Tr key={b.id}>
                    <Table.Td>{new Date(b.created_at).toLocaleString('ko-KR')}{b.created_by_name && <Text size="xs" c="dimmed">{b.created_by_name}</Text>}</Table.Td>
                    <Table.Td>{b.label} <Text span size="xs" c="dimmed">{KIND_NAME[b.kind] ?? b.kind}</Text></Table.Td>
                    <Table.Td><Text size="xs">{effectLines({ effects: b.effects || [] }).join(' · ') || '-'}</Text></Table.Td>
                    <Table.Td>{b.restored_at ? <Badge color="gray">되살림</Badge> : <Button size="xs" variant="default" onClick={() => restore(b)}>되살리기</Button>}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Stack>
    </Paper>
  );
}
