// 시간표 엑셀로 고치기(T-1304b) — 내려받기 → 올리기 → 미리 보기(바뀐 칸 수·못 읽은 칸 목록) → 반영(확정본이면 확인 한 번) → 방금 반영 되돌리기
import { useState } from 'react';
import { Alert, Button, FileButton, Group, List, Modal, Stack, Text } from '@mantine/core';
import { api } from '../api.js';
import { useConfirm } from '../Confirm.jsx';
import { t } from '../T.jsx';

export default function GridExcel({ P, tid, name, onDone }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState(null);
  const [pv, setPv] = useState(null);
  const [batch, setBatch] = useState(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, confirmBox] = useConfirm();
  const base = `${P}/timetables/${tid}/grid-excel`;
  const run = async (fn) => {
    setBusy(true); setErr('');
    try { await fn(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const download = () => run(async () => {
    const res = await fetch(`/api${base}`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(t('grid.excel_err.no_timetable'));
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url; a.download = t('grid.excel.file', { 이름: name }); a.click(); // 문구-예외: 문구 변수 이름
    URL.revokeObjectURL(url);
  });
  const pick = (f) => f && run(async () => {
    setFile(f); setPv(null); setNote('');
    setPv(await api('POST', `${base}/preview`, f));
  });
  const apply = () => run(async () => {
    let out;
    try {
      out = await api('POST', `${base}/apply`, file);
    } catch (e) {
      if (!e.body?.needConfirm) throw e;
      if (!(await confirm(t('grid.excel.confirm_ask', { 바뀜: pv.change })))) return; // 문구-예외: 문구 변수 이름
      out = await api('POST', `${base}/apply?confirm=1`, file);
    }
    setBatch(out.batchId); setPv(null); setFile(null);
    setNote(t('grid.excel.applied', { 바뀜: out.changed })); // 문구-예외: 문구 변수 이름
    await onDone?.();
  });
  const undo = () => run(async () => {
    const out = await api('POST', `${base}/undo`, { batchId: batch });
    setBatch(null);
    setNote([t('grid.excel.undone', { 칸: out.undone }), out.skipped.length ? t('grid.excel.undo_skipped', { 칸: out.skipped.length }) : ''].filter(Boolean).join(' ')); // 문구-예외: 문구 변수 이름
    await onDone?.();
  });
  const counts = (x) => t('grid.excel.preview_count', { 바뀜: x.change, 같음: x.same, 못읽음: x.errors.length }); // 문구-예외: 문구 변수 이름
  const errLine = (e) => t('grid.excel.error_line', { 줄: e.line, 반: e.cls, 교시: e.period, 요일: e.day, 글자: e.text, 사유: e.why }); // 문구-예외: 문구 변수 이름
  const close = () => { setOpen(false); setPv(null); setFile(null); setErr(''); setNote(''); };

  return (
    <>
      <Button variant="default" onClick={() => setOpen(true)} data-testid="grid-excel-open">{t('grid.excel.button')}</Button>
      {confirmBox}
      <Modal opened={open} onClose={close} title={t('grid.excel.title')} size="lg">
        <Stack>
          <Text size="sm">{t('grid.excel.intro')}</Text>
          {err && <Alert color="red">{err}</Alert>}
          {note && <Alert color="green">{note}</Alert>}
          <Group>
            <Button variant="default" onClick={download} loading={busy}>{t('grid.excel.download')}</Button>
            <FileButton onChange={pick} accept=".xlsx">{(p) => <Button variant="default" {...p} loading={busy} data-testid="grid-excel-upload">{t('grid.excel.upload')}</Button>}</FileButton>
            {batch && <Button variant="light" color="orange" onClick={undo} loading={busy} data-testid="grid-excel-undo">{t('grid.excel.undo')}</Button>}
          </Group>
          {pv && (
            <Stack gap="xs" data-testid="grid-excel-preview">
              <Text fw={700}>{t('grid.excel.preview_title')}</Text>
              <Text>{counts(pv)}</Text>
              {!pv.change && <Text c="dimmed">{t('grid.excel.preview_none')}</Text>}
              {pv.errors.length > 0 && (
                <Alert color="yellow" title={t('grid.excel.error_head')}>
                  <List size="sm">
                    {pv.errors.map((e, i) => <List.Item key={i}>{errLine(e)}</List.Item>)}
                  </List>
                </Alert>
              )}
              <Group>
                <Button color="green" disabled={!pv.change} onClick={apply} loading={busy} data-testid="grid-excel-apply">{t('grid.excel.apply')}</Button>
                <Button variant="default" onClick={close}>{t('grid.excel.close')}</Button>
              </Group>
            </Stack>
          )}
        </Stack>
      </Modal>
    </>
  );
}
