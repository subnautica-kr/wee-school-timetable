import { useState } from 'react';
import { Box, Code, Stack, Text, UnstyledButton } from '@mantine/core';
import changelogRaw from '../../../CHANGELOG.md?raw';
import { parseChangelog, splitInline } from '../changelog.js';

const VERSIONS = parseChangelog(changelogRaw);

function Inline({ s }) {
  return splitInline(s).map((p, i) => (p.t === 'b' ? <b key={i}>{p.s}</b> : p.t === 'code' ? <Code key={i}>{p.s}</Code> : <span key={i}>{p.s}</span>));
}

function Entry({ v, first }) {
  const [open, setOpen] = useState(first);
  return (
    <Box>
      <UnstyledButton onClick={() => setOpen(!open)} aria-expanded={open} style={{ minHeight: 44, width: '100%', display: 'flex', alignItems: 'center', gap: 8 }}>
        <Text size="sm" w={12}>{open ? '▾' : '▸'}</Text>
        <Text size="sm" fw={600}>v{v.version}</Text>
        <Text size="xs" c="dimmed">{v.date}</Text>
      </UnstyledButton>
      {open && (
        <Stack gap={6} pl="md" pb="xs">
          {v.groups.map((g, gi) => (
            <Box key={gi}>
              {g.title && <Text size="xs" fw={600} c="dimmed">{g.title}</Text>}
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {g.items.map((it, ii) => <li key={ii}><Text size="sm" style={{ overflowWrap: 'anywhere' }}><Inline s={it} /></Text></li>)}
              </ul>
            </Box>
          ))}
        </Stack>
      )}
    </Box>
  );
}

// 「내 정보」 탭의 업데이트 내역 — 지금 버전 한 줄 + 누르면 펼침. 원본은 CHANGELOG.md(빌드 때 읽음).
export default function VersionHistory({ isNew, onSeen }) {
  const [open, setOpen] = useState(false);
  return (
    <Stack mt="xl" gap={0} maw={420} data-testid="version-history">
      <UnstyledButton onClick={() => { if (!open) onSeen(); setOpen(!open); }} aria-expanded={open} style={{ minHeight: 44, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text size="sm" fw={600}>업데이트 내역{isNew && <Text span size="xs" c="red" ml={8}>새 기능이 있어요</Text>}</Text>
        <Text size="sm" c="dimmed">v{__APP_VERSION__} {open ? '▾' : '▸'}</Text>
      </UnstyledButton>
      {open && VERSIONS.map((v, i) => <Entry key={v.version} v={v} first={i === 0} />)}
    </Stack>
  );
}
