// 명단 엑셀로 고치기(T-1306b) — 받기 → 올리기 → 반영 미리 보기 → 반영 → 방금 올린 것 되돌리기. 서버: /orgs/:id/roster/excel*
import { useState } from 'react';
import { Alert, Button, Checkbox, FileButton, Group, List, Modal, Stack, Text } from '@mantine/core';
import { api } from '../api.js';
import { t } from '../T.jsx';

function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
const b64Blob = (b64) => new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'application/octet-stream' });

export default function RosterExcel({ base, onDone }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState(null);
  const [pv, setPv] = useState(null);
  const [rm, setRm] = useState(false);
  const [batch, setBatch] = useState(null);
  const [note, setNote] = useState([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn) => {
    setBusy(true); setErr('');
    try { await fn(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const sum = (k) => (pv ? pv.sheets.reduce((n, s) => n + (Array.isArray(s[k]) ? s[k].length : Number(s[k]) || 0), 0) : 0);
  const todo = sum('add') + sum('change') + (rm ? sum('remove') : 0);

  const download = () => run(async () => {
    const res = await fetch(`/api${base}/excel`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || String(res.status));
    saveBlob(await res.blob(), t('roster.excel.file'));
  });
  const pick = (f) => f && run(async () => {
    setFile(f); setPv(null); setNote([]); setRm(false);
    setPv(await api('POST', `${base}/excel/preview`, f));
  });
  const apply = () => run(async () => {
    const out = await api('POST', `${base}/excel/apply${rm ? '?remove=all' : ''}`, file);
    setBatch(out.batchId); setPv(null); setFile(null);
    const lines = [t('roster.excel_ui.applied', { 더함: out.added, 바뀜: out.changed, 뺌: out.removed })]; // 문구-예외: 문구 변수 이름
    if (out.failed?.length) lines.push(t('roster.excel_ui.failed', { 수: out.failed.length })); // 문구-예외: 문구 변수 이름
    const linked = (out.links || []).filter((x) => x.done).length;
    if (linked) lines.push(t('roster.excel_ui.linked_done', { 수: linked })); // 문구-예외: 문구 변수 이름
    lines.push(t('roster.excel.undo_note'));
    setNote(lines);
    await onDone?.();
  });
  const undo = () => run(async () => {
    const out = await api('POST', `${base}/excel/undo`, { batchId: batch });
    setBatch(null);
    setNote([t('roster.excel_ui.undone', { 수: out.undone }), out.skipped.length ? t('roster.excel_ui.undo_skipped', { 수: out.skipped.length }) : ''].filter(Boolean)); // 문구-예외: 문구 변수 이름
    await onDone?.();
  });
  const close = () => { setOpen(false); setPv(null); setFile(null); setErr(''); setNote([]); };
  const count = (s) => t('roster.excel_ui.sheet_count', { 시트: s.name, 더함: s.add.length, 바뀜: s.change.length, 뺌: s.remove.length, 같음: s.same, 못읽음: s.errors.length }); // 문구-예외: 문구 변수 이름
  const errors = pv ? pv.sheets.flatMap((s) => s.errors.map((e) => ({ ...e, name: s.name }))) : [];
  const checks = pv ? pv.links.filter((l) => l.group === 'check') : [];
  const removeN = sum('remove');
  const removeText = () => t('roster.excel_ui.remove_ask', { 수: removeN }); // 문구-예외: 문구 변수 이름
  const groupText = (g, n) => t(`roster.bulk_link.group_${g}`, { 수: n }); // 문구-예외: 문구 변수 이름
  const linkText = (l) => t('roster.excel_ui.link_line', { 줄: l.line, 아이디: l.loginId, 사유: l.msg }); // 문구-예외: 문구 변수 이름
  const errText = (e) => t('roster.excel_ui.error_line', { 시트: e.name, 줄: e.line, 사유: e.msg }); // 문구-예외: 문구 변수 이름

  return (
    <>
      <Button variant="default" onClick={() => setOpen(true)} data-testid="roster-excel-open">{t('roster.excel_ui.button')}</Button>
      <Modal opened={open} onClose={close} title={t('roster.excel_ui.title')} size="lg">
        <Stack>
          <Text size="sm">{t('roster.excel_ui.intro')}</Text>
          {err && <Alert color="red">{err}</Alert>}
          {note.length > 0 && <Alert color="green">{note.map((n) => <Text key={n} size="sm">{n}</Text>)}</Alert>}
          <Group>
            <Button variant="default" onClick={download} loading={busy} data-testid="roster-excel-download">{t('roster.excel_ui.download')}</Button>
            <FileButton onChange={pick} accept=".xlsx">{(p) => <Button variant="default" {...p} loading={busy} data-testid="roster-excel-upload">{t('roster.excel_ui.upload')}</Button>}</FileButton>
            {batch && <Button variant="light" color="orange" onClick={undo} loading={busy} data-testid="roster-excel-undo">{t('roster.excel_ui.undo')}</Button>}
          </Group>
          {pv && (
            <Stack gap="xs" data-testid="roster-excel-preview">
              <Text fw={700}>{t('roster.excel_ui.preview_title')}</Text>
              {pv.sheets.map((s) => <Text key={s.sheet} size="sm">{count(s)}</Text>)}
              {!todo && !errors.length && <Text c="dimmed">{t('roster.excel_ui.none')}</Text>}
              {pv.links.length > 0 && (
                <Stack gap={2}>
                  <Text size="sm" fw={600}>{t('roster.excel_ui.link_head')}</Text>
                  {['linked', 'pending', 'check'].map((g) => { const n = pv.links.filter((l) => l.group === g).length; return n ? <Text key={g} size="sm">{groupText(g, n)}</Text> : null; })}
                  {checks.map((l) => <Text key={l.line} size="xs" c="dimmed">{linkText(l)}</Text>)}
                </Stack>
              )}
              {errors.length > 0 && (
                <Alert color="yellow" title={t('roster.excel_ui.error_head')}>
                  <List size="sm">
                    {errors.map((e, i) => <List.Item key={i}>{errText(e)}</List.Item>)}
                  </List>
                  {pv.marked && <Button mt="xs" size="xs" variant="default" onClick={() => saveBlob(b64Blob(pv.marked), pv.markedName)}>{t('roster.excel_ui.marked')}</Button>}
                </Alert>
              )}
              {removeN > 0 && <Checkbox checked={rm} onChange={(e) => setRm(e.currentTarget.checked)} label={removeText()} />}
              <Group>
                <Button color="green" disabled={!todo} onClick={apply} loading={busy} data-testid="roster-excel-apply">{t('roster.excel_ui.apply')}</Button>
                <Button variant="default" onClick={close}>{t('roster.excel_ui.close')}</Button>
              </Group>
            </Stack>
          )}
        </Stack>
      </Modal>
    </>
  );
}
