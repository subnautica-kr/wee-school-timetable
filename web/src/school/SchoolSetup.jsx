import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Group, Stack, Text } from '@mantine/core';
import { api } from '../api.js';
import T, { t } from '../T.jsx';

// 학교 자료 넣기 7단계 — 1~5 양식 받기+올리기(올리면 바로 저장) · 6 확인 · 7 생성. 서버: /school-setup/*
const STEPS = ['school', 'rooms', 'roster', 'loads', 'pins'];

function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
const b64Blob = (b64) => new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'application/octet-stream' });

// 점검 항목 한 줄 — 서버가 주는 꼴(이름 · 학년-반 · 시수/한도)을 그대로 읽는다
const itemText = (i) => {
  const tag = i.group ? t('school.room.group_tag', { 이름: i.name }) : null; // 문구-예외: 문구 변수 이름
  const who = tag ?? i.name ?? (i.grade != null ? `${i.grade}-${i.class_no}` : `#${i.id}`);
  return i.cap != null ? `${who}(${i.hours}/${i.cap})` : who;
};

function StepCard({ S, step, onChanged, goOld }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [hold, setHold] = useState(null); // 못 읽은 줄이 있어 저장 전에 묻는 중: {file, readable, errors, marked, markedName}
  const [batch, setBatch] = useState(null);
  const key = step.key;

  async function down() {
    setErr('');
    try {
      const res = await fetch(`/api${S}/${key}/file`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '');
      saveBlob(await res.blob(), t('school.setup_file.name', { 단계: step.label })); // 문구-예외: 문구 변수 이름
    } catch (e) { setErr(t('school.wizard_msg.fail', { 사유: e.message })); } // 문구-예외: 문구 변수 이름
  }
  async function send(file, partial) {
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await api('POST', `${S}/${key}/apply${partial ? '?partial=1' : ''}`, file);
      setHold(null); setBatch(r.batchId || null);
      const n = (r.added || 0) + (r.changed || 0) + (r.removed || 0);
      setMsg(n ? t('school.wizard_msg.saved', { 추가: r.added || 0, 고침: r.changed || 0, 지움: r.removed || 0 }) : t('school.wizard_msg.same_only')); // 문구-예외: 문구 변수 이름
      if (r.failed?.length) setErr(t('school.wizard_msg.failed', { 개수: r.failed.length })); // 문구-예외: 문구 변수 이름
      onChanged();
    } catch (e) {
      if (e.status === 409 && e.body?.needConfirm) setHold({ file, ...e.body });
      else if (e.body?.errors?.length) { setHold({ file, readable: 0, ...e.body }); setErr(e.message); }
      else setErr(t('school.wizard_msg.fail', { 사유: e.message })); // 문구-예외: 문구 변수 이름
    } finally { setBusy(false); }
  }
  async function pick(ev) {
    const f = ev.target.files?.[0];
    ev.target.value = '';
    if (!f || busy) return;
    setHold(null); setBatch(null);
    await send(f, false);
  }
  async function undo() {
    setBusy(true); setErr('');
    try { await api('POST', `${S}/undo`, { batchId: batch }); setBatch(null); setMsg(t('school.wizard_msg.undone')); onChanged(); } catch (e) { setErr(t('school.wizard_msg.fail', { 사유: e.message })); } finally { setBusy(false); } // 문구-예외: 문구 변수 이름
  }
  const errs = hold?.errors || [];
  const filledText = step.empty ? t('school.wizard.empty') : t('school.wizard.filled', { 개수: step.count }); // 문구-예외: 문구 변수 이름
  const askText = hold?.readable ? t('school.wizard_msg.ask_partial', { 읽은: hold.readable, 못읽은: errs.length }) : t('school.setup_err.unreadable'); // 문구-예외: 문구 변수 이름
  const lineText = (x) => t('school.wizard_msg.error_line', { 줄: x.line, 칸: x.col ?? '', 사유: x.msg ?? '' }); // 문구-예외: 문구 변수 이름
  const moreText = t('school.wizard_msg.more_errors', { 개수: errs.length - 8 }); // 문구-예외: 문구 변수 이름
  return (
    <Card withBorder padding="sm" data-testid={`setup-step-${key}`}>
      <Stack gap="xs">
        <Group justify="space-between">
          <Group gap="xs">
            <Text fw={600}>{step.no}. {step.label}</Text>
            <Badge color={step.done ? 'green' : 'gray'} variant={step.done ? 'filled' : 'light'}>{t(step.done ? 'school.wizard.done' : 'school.wizard.todo')}</Badge>
            {step.optional && <Badge variant="outline" color="gray">{t('school.wizard.optional')}</Badge>}
          </Group>
          <Text size="sm" c="dimmed">{filledText}</Text>
        </Group>
        <Text size="sm" c="dimmed"><T k={`school.wizard_step.${key}`} /></Text>
        <Group>
          <Button variant="default" size="xs" onClick={down}>{t('school.wizard_btn.download')}</Button>
          <Button component="label" size="xs" loading={busy} disabled={busy}>{t('school.wizard_btn.upload')}<input type="file" hidden accept=".xlsx" onChange={pick} /></Button>
          <Button variant="subtle" size="xs" onClick={() => goOld(key)}>{t('school.wizard_btn.old')}</Button>
        </Group>
        {err && <Alert color="red">{err}</Alert>}
        {msg && <Alert color="green">{msg}{batch && <> <Button variant="subtle" size="compact-xs" disabled={busy} onClick={undo}>{t('school.wizard_btn.undo')}</Button></>}</Alert>}
        {hold && (
          <Alert color="orange">
            <Stack gap={4}>
              <Text size="sm">{askText}</Text>
              {errs.slice(0, 8).map((x, i) => <Text key={i} size="xs" c="red">{lineText(x)}</Text>)}
              {errs.length > 8 && <Text size="xs" c="dimmed">{moreText}</Text>}
              <Group>
                {hold.readable > 0 && <Button size="xs" loading={busy} onClick={() => send(hold.file, true)}>{t('school.wizard_btn.save')}</Button>}
                {hold.marked && <Button size="xs" variant="default" onClick={() => saveBlob(b64Blob(hold.marked), hold.markedName || 'marked.xlsx')}>{t('school.wizard_btn.marked')}</Button>}
                <Button size="xs" variant="subtle" onClick={() => setHold(null)}>{t('school.wizard_btn.cancel')}</Button>
              </Group>
            </Stack>
          </Alert>
        )}
      </Stack>
    </Card>
  );
}

export default function SchoolSetup({ P, goOld, go }) {
  const S = `${P}/school-setup`;
  const [st, setSt] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => api('GET', `${S}/status`).then((r) => { setSt(r); setErr(''); }).catch((e) => setErr(e.message)), [S]);
  useEffect(() => { load(); }, [load]);
  const ready = !!st;
  useEffect(() => { if (go?.k && ready) document.querySelector(`[data-testid="setup-step-${go.k}"]`)?.scrollIntoView({ block: 'start' }); }, [go, ready]); // 옛 올리기 자리의 링크가 오면 그 단계 카드로
  if (err && !st) return <Alert color="red">{err}</Alert>;
  if (!st) return <Text size="sm" c="dimmed">{t('school.wizard.loading')}</Text>;
  const byKey = Object.fromEntries(st.steps.map((s) => [s.key, s]));
  const termText = t('school.wizard.term', { 연도: st.term.year, 학기: st.term.semester }); // 문구-예외: 문구 변수 이름
  const issuesText = t('school.wizard_check.issues', { 개수: st.issueTotal }); // 문구-예외: 문구 변수 이름
  const countText = (c) => t('school.wizard_check.count', { 개수: c.count }); // 문구-예외: 문구 변수 이름
  const moreItems = (c) => ` ${t('school.wizard_check.more', { 개수: c.count - c.items.length })}`; // 문구-예외: 문구 변수 이름
  const gen = byKey.generate;
  const chk = byKey.check;
  return (
    <Stack gap="sm" data-testid="school-setup">
      <Text size="sm"><T k="school.wizard.lead" /></Text>
      <Text size="xs" c="dimmed">{termText}</Text>
      {STEPS.map((k) => byKey[k] && <StepCard key={k} S={S} step={byKey[k]} onChanged={load} goOld={goOld} />)}
      <Card withBorder padding="sm" data-testid="setup-step-check">
        <Stack gap="xs">
          <Group justify="space-between">
            <Group gap="xs">
              <Text fw={600}>{chk.no}. {chk.label}</Text>
              <Badge color={chk.done ? 'green' : 'gray'} variant={chk.done ? 'filled' : 'light'}>{t(chk.done ? 'school.wizard.done' : 'school.wizard.todo')}</Badge>
            </Group>
            <Button variant="subtle" size="xs" onClick={load}>{t('school.wizard_btn.recheck')}</Button>
          </Group>
          <Text size="sm" c="dimmed"><T k="school.wizard_step.check" /></Text>
          {st.issueTotal === 0 ? <Text size="sm" c="green">{t('school.wizard_check.all_ok')}</Text> : <Text size="sm" c="orange">{issuesText}</Text>}
          {st.checks.filter((c) => c.count > 0).map((c) => (
            <div key={c.key}>
              <Text size="sm" fw={500}>{t(`school.setup_issue.${c.key}`)} · {countText(c)}</Text>
              <Text size="xs" c="dimmed">{c.items.map(itemText).join(' · ')}{c.count > c.items.length ? moreItems(c) : ''}</Text>
            </div>
          ))}
        </Stack>
      </Card>
      <Card withBorder padding="sm" data-testid="setup-step-generate">
        <Stack gap="xs">
          <Group gap="xs">
            <Text fw={600}>{gen.no}. {gen.label}</Text>
            <Badge color={gen.done ? 'green' : 'gray'} variant={gen.done ? 'filled' : 'light'}>{t(gen.done ? 'school.wizard.done' : 'school.wizard.todo')}</Badge>
          </Group>
          <Text size="sm" c="dimmed"><T k="school.wizard_step.generate" /></Text>
          {!st.ready && <Text size="sm" c="dimmed">{t('school.wizard_check.not_ready')}</Text>}
          <Group><Button size="xs" disabled={!st.ready} onClick={() => goOld('generate')}>{t('school.wizard_btn.go_generate')}</Button></Group>
        </Stack>
      </Card>
    </Stack>
  );
}
