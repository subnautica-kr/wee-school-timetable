import { useState } from 'react';
import { Alert, Badge, Button, Checkbox, Group, Modal, Paper, ScrollArea, Stack, Text, TextInput } from '@mantine/core';
import { api } from '../api.js';
import { t } from '../T.jsx';
import { dateText } from './linkView.js';
import { bulkGroups, bulkRowsOf } from './forceView.js';

const countV = (n) => ({ 수: n }); // 문구-예외: 문구 변수 이름
const dateV = (iso) => ({ 날짜: dateText(iso) }); // 문구-예외: 문구 변수 이름

// 계정 일괄 연결 창(T-1322b③ 3) — 계정 없는 명단 줄마다 아이디 칸 → 한 번에 보내고 결과를 세 묶음으로 보여 준다
// base = /orgs/<번호>/roster · lines: 명단 줄(계정 없는 줄만 쓴다) · onChanged: 명단을 다시 읽는다
export default function BulkLink({ base, lines, onClose, onChanged }) {
  const free = lines.filter((m) => !m.hasAccount);
  const [ids, setIds] = useState({}); // 줄 번호 → 아이디
  const [concurrent, setConcurrent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [out, setOut] = useState(null); // { results, counts }
  const rows = bulkRowsOf(ids);
  const run = async () => {
    if (!rows.length) { setErr(t('roster.bulk_link.none_filled')); return; }
    setErr(''); setBusy(true);
    try {
      const r = await api('POST', `${base}/bulk-link`, { rows, ...(concurrent ? { concurrent: true } : {}) });
      setOut(r);
      const left = { ...ids }; // 연결된 줄의 칸은 비운다 — 다시 적을 때 남은 줄만 보인다
      for (const x of r.results) if (x.group === 'linked') delete left[x.membershipId];
      setIds(left);
      await onChanged();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const g = bulkGroups(out?.results);
  const showName = (x) => x.name || x.loginId;
  return (
    <Modal opened onClose={() => !busy && onClose()} title={t('roster.bulk_link.title')} size="lg" centered>
      <Stack data-testid="bulk-link">
        {err && <Alert color="red" withCloseButton onClose={() => setErr('')}>{err}</Alert>}
        {!out && (
          <>
            <Text size="sm">{t('roster.bulk_link.lead')}</Text>
            {free.length === 0 && <Text size="sm" c="dimmed">{t('roster.bulk_link.no_line')}</Text>}
            <ScrollArea.Autosize mah={360}>
              <Stack gap="xs">
                {free.map((m) => (
                  <Group key={m.id} wrap="nowrap" align="center">
                    <Text size="sm" w={120} truncate>{m.name}</Text>
                    <TextInput size="xs" style={{ flex: 1 }} aria-label={t('roster.bulk_link.id_label')} placeholder={t('roster.bulk_link.id_label')}
                      value={ids[m.id] ?? ''} onChange={(e) => setIds({ ...ids, [m.id]: e.currentTarget.value })} />
                  </Group>
                ))}
              </Stack>
            </ScrollArea.Autosize>
            <Checkbox label={t('roster.bulk_link.concurrent')} checked={concurrent} onChange={(e) => setConcurrent(e.currentTarget.checked)} />
            <Group justify="flex-end">
              <Button variant="default" disabled={busy} onClick={onClose}>{t('roster.bulk_link.close')}</Button>
              <Button loading={busy} disabled={!rows.length} onClick={run}>{t('roster.bulk_link.run', countV(rows.length))}</Button>
            </Group>
          </>
        )}
        {out && (
          <>
            <Group gap="xs">
              <Badge color="green" variant="light" size="lg" tt="none">{t('roster.bulk_link.group_linked', countV(g.linked.length))}</Badge>
              <Badge color="blue" variant="light" size="lg" tt="none">{t('roster.bulk_link.group_pending', countV(g.pending.length))}</Badge>
              <Badge color="orange" variant="light" size="lg" tt="none">{t('roster.bulk_link.group_check', countV(g.check.length))}</Badge>
            </Group>
            <ScrollArea.Autosize mah={380}>
              <Stack gap="xs">
                {g.linked.map((x) => (
                  <Paper key={x.index} withBorder p="xs" data-testid="bulk-linked"><Text size="sm">{showName(x)} <Text span size="xs" c="dimmed">({x.loginId}) · {x.msg}</Text></Text></Paper>
                ))}
                {g.pending.map((x) => (
                  <Paper key={x.index} withBorder p="xs" data-testid="bulk-pending">
                    <Text size="sm">{showName(x)} <Text span size="xs" c="dimmed">({x.loginId})</Text></Text>
                    <Text size="xs" c="dimmed">{x.msg}{x.expiresAt ? ` · ${t('roster.bulk_link.expires', dateV(x.expiresAt))}` : ''}</Text>
                  </Paper>
                ))}
                {g.check.map((x) => (
                  <Paper key={x.index} withBorder p="xs" data-testid="bulk-check">
                    <Text size="sm">{showName(x)} <Text span size="xs" c="dimmed">({x.loginId})</Text></Text>
                    <Text size="xs" c="orange.8">{x.msg}</Text>
                  </Paper>
                ))}
              </Stack>
            </ScrollArea.Autosize>
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setOut(null)}>{t('roster.bulk_link.again')}</Button>
              <Button onClick={onClose}>{t('roster.bulk_link.close')}</Button>
            </Group>
          </>
        )}
      </Stack>
    </Modal>
  );
}
