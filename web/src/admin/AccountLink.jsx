import { useState } from 'react';
import { Accordion, Alert, Button, Checkbox, Group, Modal, Paper, SegmentedControl, Select, Stack, Text, TextInput } from '@mantine/core';
import { api } from '../api.js';
import { t } from '../T.jsx';
import { dateText, daysLeft, freeLineOptions, needsConfirm, warningLines } from './linkView.js';
import ContactNudge from './ContactNudge.jsx';

const fromV = (u) => ({ 이름: u.fromLineName }); // 문구-예외: 문구 변수 이름
const expireV = (u) => ({ 날짜: dateText(u.expiresAt), 일: daysLeft(u.expiresAt) }); // 문구-예외: 문구 변수 이름
const SEP = ' · ';
const relV = (u) => ({ 이름: u?.name ?? '', 아이디: u?.loginId ?? '' }); // 문구-예외: 문구 변수 이름
const codeV = (i) => ({ 코드: i.code, 날짜: dateText(i.expiresAt) }); // 문구-예외: 문구 변수 이름

const orgIdOf = (base) => base.split('/')[2]; // base = /orgs/<번호>/roster

// 연결 요청 하나 — 409 needConfirm 이면 경고 목록을 보여 주고 「그래도 연결」로 force:true 다시 보낸다
// 쓰는 법: const [link, linkBox, busy] = useLinker({ onLinked, onError }) · link(path, body, 이름) · 화면에 {linkBox}
export function useLinker({ onLinked, onError }) {
  const [ask, setAsk] = useState(null); // { path, body, name, warnings }
  const [busy, setBusy] = useState(false);
  const send = async (path, body, name) => {
    setBusy(true);
    try {
      const r = await api('POST', path, body);
      setAsk(null);
      await onLinked(r, name);
    } catch (e) {
      if (needsConfirm(e) && !body.force) setAsk({ path, body, name, warnings: warningLines(e.body) });
      else { setAsk(null); onError(e.message); }
    } finally { setBusy(false); }
  };
  const box = (
    <Modal opened={!!ask} onClose={() => !busy && setAsk(null)} title={t('roster.link.warn_title')} centered>
      {ask && (
        <Stack>
          <Alert color="orange" title={t('roster.err.need_confirm')}>
            {ask.warnings.map((w) => <Text key={w} size="sm">{w}</Text>)}
          </Alert>
          <Group justify="flex-end">
            <Button variant="default" disabled={busy} onClick={() => setAsk(null)}>{t('roster.link.cancel')}</Button>
            <Button color="orange" loading={busy} onClick={() => send(ask.path, { ...ask.body, force: true }, ask.name)}>{t('roster.link.force')}</Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
  return [send, box, busy];
}

// 줄 하나의 「계정 연결」 창 — 초대 코드 · 아이디로 연결 · 계정 만들어 주기
export function LinkModal({ line, base, onClose, onChanged, onTemp, onError, onTransfer, onDone }) {
  const [tab, setTab] = useState('invite');
  const [loginId, setLoginId] = useState('');
  const [makeId, setMakeId] = useState('');
  const [conc, setConc] = useState(false); // 「겸임으로 연결」
  const [until, setUntil] = useState(''); // 겸임 기한 — 비면 서버가 그 학년도 2월 말일
  const [invite, setInvite] = useState(null); // { code, expiresAt }
  const [again, setAgain] = useState(false);
  const [copied, setCopied] = useState(false);
  const [working, setWorking] = useState(false);
  const [nudge, setNudge] = useState(false);
  const [link, linkBox, linkBusy] = useLinker({
    onLinked: async (r, name) => {
      await onChanged(); onTransfer?.(r);
      if (r.concurrentUntil) onDone?.(t('roster.link.done_concurrent', { 이름: name, 기한: r.concurrentUntil })); // 문구-예외: 문구 변수 이름
      onClose();
    }, // 전출 요청이 나갔거나 그 자리에서 옮겨졌으면 안내 창
    onError,
  });
  if (!line) return null;
  const guard = async (fn) => { setWorking(true); try { await fn(); } catch (e) { onError(e.message); } finally { setWorking(false); } };
  const issue = () => guard(async () => {
    const r = await api('POST', `${base}/${line.id}/invite`);
    setInvite({ code: r.code, expiresAt: r.expiresAt }); setAgain(false); setCopied(false);
    if (r.nudge) setNudge(true); // 서버가 「이 학교 첫 코드 · 연락처 빔 · 아직 안 보임」 일 때만 true — 한 번뿐
    await onChanged(); // 연결되면 코드는 무효라 명단은 그대로지만, 서버 쪽 변화를 한 번 맞춘다
  });
  const make = () => guard(async () => {
    const r = await api('POST', `${base}/${line.id}/account`, { loginId: makeId.trim() });
    onTemp({ name: line.name, loginId: r.loginId || makeId.trim(), temp: r.temp });
    await onChanged(); onClose();
  });
  const copy = async () => {
    try { await navigator.clipboard.writeText(invite.code); setCopied(true); } catch { onError(invite.code); }
  };
  const busy = working || linkBusy;
  const nameV = { 이름: line.name }; // 문구-예외: 문구 변수 이름
  return (
    <Modal opened onClose={onClose} title={t('roster.link.title', nameV)} centered>
      {linkBox}
      <Stack>
        <Text size="sm">{t('roster.link.lead', nameV)}</Text>
        <SegmentedControl fullWidth value={tab} onChange={setTab} data={[
          { value: 'invite', label: t('roster.link.tab_invite') },
          { value: 'id', label: t('roster.link.tab_id') },
          { value: 'make', label: t('roster.link.tab_make') },
        ]} />
        {tab === 'invite' && (
          <Stack gap="xs">
            <Text size="sm" c="dimmed">{t('roster.link.invite_hint')}</Text>
            {invite && (
              <Alert color="green">
                <Text size="sm">{t('roster.link.invite_done', { ...nameV, ...codeV(invite) })}</Text>
                <Group mt="xs" gap="xs">
                  <Button size="xs" variant="default" onClick={copy}>{copied ? t('roster.link.copied') : t('roster.link.copy')}</Button>
                </Group>
              </Alert>
            )}
            {nudge && <ContactNudge orgId={orgIdOf(base)} onClose={() => setNudge(false)} />}
            {!invite && <Button loading={busy} onClick={issue}>{t('roster.link.invite_submit')}</Button>}
            {invite && !again && <Button variant="default" disabled={busy} onClick={() => setAgain(true)}>{t('roster.link.invite_again')}</Button>}
            {invite && again && (
              <Group>
                <Text size="sm" c="orange">{t('roster.link.invite_again_warn')}</Text>
                <Button size="xs" color="orange" loading={busy} onClick={issue}>{t('roster.link.invite_again')}</Button>
              </Group>
            )}
          </Stack>
        )}
        {tab === 'id' && (
          <form onSubmit={(e) => { e.preventDefault(); link(`${base}/${line.id}/link`, { loginId: loginId.trim(), ...(conc ? { concurrent: true, ...(until ? { until } : {}) } : {}) }, line.name); }}>
            <Stack gap="xs">
              <Text size="sm" c="dimmed">{t('roster.link.id_hint')}</Text>
              <TextInput label={t('roster.link.id_label')} value={loginId} onChange={(e) => setLoginId(e.currentTarget.value)} required />
              <Checkbox label={t('roster.link.concurrent')} description={t('roster.link.concurrent_hint')} checked={conc} onChange={(e) => setConc(e.currentTarget.checked)} />
              {conc && <TextInput type="date" label={t('roster.link.until_label')} description={t('roster.link.until_hint')} value={until} onChange={(e) => setUntil(e.currentTarget.value)} />}
              <Button type="submit" loading={busy} disabled={!loginId.trim()}>{t('roster.link.id_submit')}</Button>
            </Stack>
          </form>
        )}
        {tab === 'make' && (
          <form onSubmit={(e) => { e.preventDefault(); make(); }}>
            <Stack gap="xs">
              <Text size="sm" c="dimmed">{t('roster.link.make_hint')}</Text>
              <TextInput label={t('roster.link.id_label')} value={makeId} onChange={(e) => setMakeId(e.currentTarget.value)} required />
              <Button type="submit" loading={busy} disabled={!makeId.trim()}>{t('roster.link.make_submit')}</Button>
            </Stack>
          </form>
        )}
      </Stack>
    </Modal>
  );
}

// 「연결 안 된 계정」 묶음 — 명단 아래 접힌 한 줄(있을 때만)
export function UnlinkedBox({ base, items, rows, onChanged, onError }) {
  const [pick, setPick] = useState({}); // userId → 줄 번호
  const [rel, setRel] = useState(null); // 내보내기 확인 대상
  const [busy, setBusy] = useState(false);
  const [link, linkBox] = useLinker({ onLinked: onChanged, onError });
  if (!items.length) return null;
  const options = freeLineOptions(rows);
  const countV = { 수: items.length }; // 문구-예외: 문구 변수 이름
  const release = async () => {
    setBusy(true);
    try { await api('POST', `${base}/unlinked/${rel.userId}/release`); setRel(null); await onChanged(); } catch (e) { setRel(null); onError(e.message); } finally { setBusy(false); }
  };
  return (
    <>
      {linkBox}
      <Accordion variant="contained">
        <Accordion.Item value="unlinked">
          <Accordion.Control>{t('roster.pool.head', countV)}</Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              <Text size="sm" c="dimmed">{t('roster.pool.lead')}</Text>
              {items.map((u) => (
                <Paper key={u.userId} withBorder p="sm">
                  <Text fw={600}>{u.name} <Text span size="sm" c="dimmed">({t('roster.col.login_id')} {u.loginId})</Text></Text>
                  <Text size="xs" c="dimmed">
                    {[u.fromLineName && t('roster.pool.from', fromV(u)), t('roster.pool.expire', expireV(u))].filter(Boolean).join(SEP)}
                  </Text>
                  <Group mt="xs" gap="xs">
                    <Select size="xs" w={170} placeholder={options.length ? t('roster.pool.pick_line') : t('roster.pool.no_line')} aria-label={t('roster.pool.pick_line')}
                      data={options} value={pick[u.userId] ?? null} onChange={(v) => setPick({ ...pick, [u.userId]: v })} searchable disabled={!options.length} />
                    <Button size="xs" disabled={!pick[u.userId]} onClick={() => link(`${base}/unlinked/${u.userId}/link`, { membershipId: Number(pick[u.userId]) }, u.name)}>{t('roster.pool.link')}</Button>
                    <Button size="xs" variant="default" color="red" onClick={() => setRel(u)}>{t('roster.pool.release')}</Button>
                  </Group>
                </Paper>
              ))}
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
      <Modal opened={!!rel} onClose={() => !busy && setRel(null)} title={t('roster.pool.release_title', relV(rel))} centered>
        {rel && (
          <Stack>
            <Text size="sm">{t('roster.pool.release_lead', relV(rel))}</Text>
            <Group justify="flex-end">
              <Button variant="default" disabled={busy} onClick={() => setRel(null)}>{t('roster.pool.release_no')}</Button>
              <Button color="red" loading={busy} onClick={release}>{t('roster.pool.release_yes')}</Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </>
  );
}

// 겸임 줄의 「기한 바꾸기」 창 — PUT /:mid/concurrent { until } → { ok, membershipId, concurrentUntil }
export function ConcurrentUntilModal({ line, base, onClose, onChanged, onDone, onError }) {
  const [until, setUntil] = useState(line?.concurrentUntil ?? '');
  const [busy, setBusy] = useState(false);
  if (!line) return null;
  const titleV = { 이름: line.name }; // 문구-예외: 문구 변수 이름
  const save = async () => {
    setBusy(true);
    try {
      const r = await api('PUT', `${base}/${line.id}/concurrent`, { until });
      await onChanged();
      onDone?.(t('roster.concurrent_ui.done', { 이름: line.name, 기한: r.concurrentUntil })); // 문구-예외: 문구 변수 이름
      onClose();
    } catch (e) { onError(e.message); onClose(); } finally { setBusy(false); }
  };
  return (
    <Modal opened onClose={() => !busy && onClose()} title={t('roster.concurrent_ui.title', titleV)} centered>
      <Stack>
        <Text size="sm">{t('roster.concurrent_ui.lead')}</Text>
        <TextInput type="date" label={t('roster.concurrent_ui.label')} value={until} onChange={(e) => setUntil(e.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" disabled={busy} onClick={onClose}>{t('roster.concurrent_ui.cancel')}</Button>
          <Button loading={busy} disabled={!until} onClick={save}>{t('roster.concurrent_ui.save')}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
