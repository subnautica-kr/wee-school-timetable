import { useEffect, useState } from 'react';
import { Alert, Button, Group, List, Modal, Stack, Text, TextInput } from '@mantine/core';
import { api } from './api.js';
import { confirmReady, effectLines } from './deleteDialog.js';

// 공통 지우기 창 — 미리보기로 「함께 사라지는 것」을 보여 주고, 위험 단계(danger)에서만 이름을 글자로 쳐야 단추가 켜진다.
// 서버가 돌려주는 409/400 이유는 그대로 보여 준다. 브라우저 confirm()/alert() 는 쓰지 않는다.
// 쓰는 법: const [del, delBox] = useDelete(); del({ title, lead, previewPath, run, … }) · 화면에 {delBox}
// opts: title · lead(무엇을 하는지 한 줄) · previewPath(GET) · run(typed)=>Promise(DELETE/POST) · danger · expect(미리보기에 확인 글자가 없을 때) · typeLabel
//       restorable(보관함에서 되살릴 수 있나) · keeps(남는 것) · yes(단추 글자) · onDone
const KEEP = '변경 기록(감사 기록)과 지난 학기 보관본은 지워지지 않습니다.';

export function DeleteDialog({ opts, onClose }) {
  const [p, setP] = useState(null);
  const [err, setErr] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const path = opts?.previewPath;
  useEffect(() => {
    setP(null); setErr(''); setTyped('');
    if (!opts || !path) return undefined;
    let live = true;
    api('GET', path).then((r) => live && setP(r)).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [opts, path]);
  if (!opts) return null;
  const lines = effectLines(p);
  const expect = opts.expect ?? p?.confirmText;
  const blocked = (p?.canDelete === false) || (path && !p) || (opts.danger && !confirmReady(typed, expect));
  const go = async () => {
    setBusy(true); setErr('');
    try { await opts.run(typed.trim()); onClose(); opts.onDone?.(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal opened onClose={onClose} title={opts.title} centered>
      <Stack gap="sm">
        {opts.lead && <Text size="sm">{opts.lead}</Text>}
        {path && !p && !err && <Text size="sm" c="dimmed">딸린 것을 세는 중…</Text>}
        {p && (lines.length ? (
          <div>
            <Text size="sm" fw={600}>이걸 지우면 함께 사라지는 것</Text>
            <List size="sm" data-testid="delete-effects">{lines.map((l) => <List.Item key={l}>{l}</List.Item>)}</List>
          </div>
        ) : <Text size="sm" c="dimmed">함께 사라지는 딸린 것은 없습니다.</Text>)}
        {(p?.warnings || []).map((w) => <Alert key={w} color="yellow" p="xs">{w}</Alert>)}
        <Text size="xs" c="dimmed">그대로 남는 것: {opts.keeps ? `${opts.keeps} ` : ''}{KEEP}</Text>
        {opts.restorable && <Text size="sm" c="teal">보관함에서 되살릴 수 있어요. (기관 관리자 → 내 정보 → 지운 것 보관함)</Text>}
        {opts.danger && (
          <TextInput data-autofocus label={opts.typeLabel || '확인 글자'} description={expect ? `아래 칸에 「${expect}」을 그대로 입력하면 「${opts.yes || '지우기'}」 단추가 켜집니다` : undefined}
            value={typed} onChange={(e) => setTyped(e.currentTarget.value)} data-testid="delete-type" />
        )}
        {err && <Alert color="red" p="xs" data-testid="delete-error">{err}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>취소</Button>
          <Button color="red" disabled={blocked} loading={busy} onClick={go} data-testid="delete-yes">{opts.yes || '지우기'}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function useDelete() {
  const [opts, setOpts] = useState(null);
  return [setOpts, <DeleteDialog key="delete-dialog" opts={opts} onClose={() => setOpts(null)} />];
}

// 반·교사·교과·특별실·시간표 한 개 지우기 — 미리보기 kind 와 지우는 경로만 다르다
export const cascadeOpts = (P, kind, id, name, path, extra = {}) => ({
  title: `「${name}」 지우기`, previewPath: `${P}/delete-preview?kind=${kind}&id=${id}`, run: () => api('DELETE', path), restorable: true, ...extra,
});
