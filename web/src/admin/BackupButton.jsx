import { useState } from 'react';
import { Alert, Button, Stack, Text } from '@mantine/core';

// 학교 자료 내려받기(백업) — 파일 하나(JSON). 훅은 early return 이 없지만 늘 맨 위에 둔다.
export default function BackupButton({ orgId }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try {
      const res = await fetch(`/api/orgs/${orgId}/backup`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('내려받지 못했습니다');
      const m = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '');
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url; a.download = m?.[1] || 'backup.json';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Stack mt="xl" gap={4} maw={420}>
      {err && <Alert color="red">{err}</Alert>}
      <Button variant="default" onClick={go} loading={busy} style={{ minHeight: 44 }} fullWidth>학교 자료 내려받기(백업)</Button>
      <Text size="xs" c="dimmed">비밀번호는 담기지 않습니다.</Text>
    </Stack>
  );
}
