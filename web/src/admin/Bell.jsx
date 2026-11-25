import { useCallback, useEffect, useState } from 'react';
import { ActionIcon, Badge, Button, Divider, Group, Indicator, Popover, Stack, Text, UnstyledButton } from '@mantine/core';
import { api } from '../api.js';
import { t } from '../T.jsx';
import { hasNewVersion } from '../changelog.js';
import { readSeenVersion } from '../seenVersion.js';

// 알림 종(T-1323) — 안 읽은 수 배지 · 할 일(건수) / 소식(사람별 읽음) 두 묶음 · 「새 기능」 점도 소식 안 한 줄로.
const POLL_MS = 60_000;
const when = (s) => new Date(s).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export default function Bell({ onGoTab, onGoMe, onOpenBoard }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => api('GET', '/notifications').then((d) => { setData(d); setFailed(false); }).catch(() => setFailed(true)), []);
  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);
  const isNew = hasNewVersion(readSeenVersion(), __APP_VERSION__);
  const badge = (data?.badge ?? 0) + (isNew ? 1 : 0);
  const readAll = () => api('POST', '/notifications/read', { all: true }).then(load).catch(() => setFailed(true));
  const readOne = (n) => (n.read ? null : api('POST', '/notifications/read', { ids: [n.id] }).then(load).catch(() => {}));
  const toggle = () => { if (!open) load(); setOpen(!open); };
  const todos = data?.todos ?? [];
  const items = data?.items ?? [];
  return (
    <Popover opened={open} onChange={setOpen} position="bottom-end" width={320} withArrow shadow="md">
      <Popover.Target>
        <Indicator label={badge > 99 ? '99+' : badge} disabled={!badge} size={16} color="red" offset={4}>
          <ActionIcon variant="default" size="lg" onClick={toggle} aria-label={badge ? `${t('notify.bell.label')} ${badge}` : t('notify.bell.label')} data-testid="bell">🔔</ActionIcon>
        </Indicator>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs" data-testid="bell-panel">
          {failed && <Text size="sm" c="red">{t('notify.panel.load_failed')}</Text>}
          <Text size="sm" fw={700}>{t('notify.panel.todo_title')}</Text>
          {todos.length === 0 && <Text size="sm" c="dimmed">{t('notify.panel.todo_empty')}</Text>}
          {todos.map((x) => (
            <UnstyledButton key={x.kind} onClick={() => { setOpen(false); onGoTab?.(x.tab); }}>
              <Group gap="xs"><Badge color="orange" variant="light">{x.count}</Badge><Text size="sm">{x.text}</Text></Group>
            </UnstyledButton>
          ))}
          <Divider />
          <Group justify="space-between">
            <Text size="sm" fw={700}>{t('notify.panel.news_title')}</Text>
            {data?.unread > 0 && <Button variant="subtle" size="compact-xs" onClick={readAll}>{t('notify.panel.read_all')}</Button>}
          </Group>
          {isNew && (
            <UnstyledButton onClick={() => { setOpen(false); onGoMe?.(); }}>
              <Text size="sm" fw={600}>{t('notify.feature.new')}</Text>
            </UnstyledButton>
          )}
          {items.length === 0 && !isNew && <Text size="sm" c="dimmed">{t('notify.panel.news_empty')}</Text>}
          {items.map((n) => (
            <UnstyledButton key={n.id} onClick={() => { readOne(n); const m = /^board:(\d+)$/.exec(n.link || ''); if (m && onOpenBoard) { setOpen(false); onOpenBoard(Number(m[1])); } }} data-read={n.read ? '1' : '0'}>
              <Text size="sm" fw={n.read ? 400 : 700} c={n.read ? 'dimmed' : undefined}>{n.text}</Text>
              <Text size="xs" c="dimmed">{when(n.createdAt)}</Text>
            </UnstyledButton>
          ))}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

// 종 옆 「도움·요청」 단추 — onClick 이 도움·요청 창(board/BoardModal)을 연다.
export function HelpRequestButton({ onClick }) {
  return <Button variant="default" onClick={onClick} data-testid="help-request-btn">{t('notify.help.button')}</Button>;
}
