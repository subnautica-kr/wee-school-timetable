import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Checkbox, FileButton, Group, Modal, Paper, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { api } from '../api.js';
import { downloadTemp } from './csv.js';
import { t } from '../T.jsx';
import SetupLink from '../school/SetupLink.jsx';
import { 값이름 } from '../../../shared/text/index.js';
import { cascadeOpts, useDelete } from '../DeleteDialog.jsx';
import { LinkModal, UnlinkedBox } from './AccountLink.jsx';
import BulkLink from './BulkLink.jsx';
import { TransferNote } from './Transfers.jsx';
import { useLastAdmin } from './LastAdminAsk.jsx';
import { flaggedRows, forcePath, mergeBulkStatus, transferNote } from './forceView.js';
import { accountColumnShown } from './linkView.js';
import { dutyOptions, roleLabel, useOrgConfig } from '../orgConfig.js';

const ROLES = ['기관관리자', '교직원', '보기만'];
import { homeroomView, toggleId, vacatedCounts } from './homeroomView.js';
const STATUS_KEYS = ['사용', '휴직', '전출', '숨김']; // 저장 값 — 화면 낱말은 값이름 으로
const FIELDS = [['name', '이름'], ['loginId', '아이디'], ['role', '역할'], ['duty', '담임/전담']];

const download = downloadTemp;

export default function Roster({ orgId, onGoSetup }) {
  const base = `/orgs/${orgId}/roster`;
  const cfg = useOrgConfig(`/orgs/${orgId}`);
  const roleData = ROLES.map((r) => ({ value: r, label: roleLabel(cfg, r) })); // 권한 키는 그대로, 보이는 글자만
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState('');
  const [form, setForm] = useState({ name: '', birthDate: '', loginId: '', role: '교직원', duty: null });
  const [temp, setTemp] = useState(null); // { loginId, temp }
  const [imp, setImp] = useState(null); // 열 맞추기 상태
  const [result, setResult] = useState(null);

  const [classes, setClasses] = useState([]);
  const [unlinked, setUnlinked] = useState([]); // 「연결 안 된 계정」 묶음
  const [linkLine, setLinkLine] = useState(null); // 「계정 연결」 창 대상 줄
  const [unlinkAsk, setUnlinkAsk] = useState(null); // 「연결 해제」 확인 대상 줄
  const [moved, setMoved] = useState(null); // 줄 지우기로 계정이 묶음에 간 사람 이름
  const load = () => {
    api('GET', `${base}/unlinked`).then(setUnlinked).catch(() => setUnlinked([]));
    api('GET', `/orgs/${orgId}/classrooms`).then(setClasses).catch(() => setClasses([])); // 반 열·담임 빠짐 상자용 — 못 받아도 명단은 그린다
    return api('GET', base).then(setRows).catch((e) => setErr(e.message));
  };
  useEffect(() => { load(); }, [orgId]);
  const showAccount = accountColumnShown(rows);
  const hv = homeroomView(rows, classes);
  const noClassText = hv.noClass.join(', ');
  const noTeacherText = hv.noTeacher.join(', ');
  const [del, delBox] = useDelete();
  const [busy, setBusy] = useState(false); // 서버에 보내는 동안 단추를 잠근다(두 번 눌림 막기)
  const [note, setNote] = useState(null); // { 담임, 수업 } 담당이 빈 안내
  const [sel, setSel] = useState(() => new Set()); // 여러 줄 고르기
  const [bulkStatus, setBulkStatus] = useState(null);
  const [bulkRes, setBulkRes] = useState(null);
  const [ask, askBox, guarded] = useLastAdmin(); // 마지막 기관 관리자 경고 → 확인하면 force 로 다시
  const [bulkLink, setBulkLink] = useState(false); // 계정 일괄 연결 창
  const [moveNote, setMoveNote] = useState(null); // 학교 옮기기 안내(전출 요청이 나갔거나 그 자리에서 옮겨짐)
  const statusData = STATUS_KEYS.map((v) => ({ value: v, label: 값이름('membership.status', v) }));
  const run = async (fn) => {
    if (busy) return;
    setErr(''); setBusy(true);
    try { await fn(); await load(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  // 앵커 링크는 이 화면에서 내려받기가 안 돼(같은 주소 fetch 는 됨) 받아서 직접 저장한다
  const getTemplate = () => run(async () => {
    const res = await fetch(`/api${base}/template`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('양식을 받지 못했습니다');
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url; a.download = '명단 양식.xlsx'; a.click();
    URL.revokeObjectURL(url);
  });
  const [idErr, setIdErr] = useState(''); // 중복 아이디 안내는 아이디 칸 바로 아래에
  const add = (e) => {
    e.preventDefault();
    setIdErr('');
    run(async () => {
      let r;
      const body = { name: form.name, role: form.role, duty: form.duty, ...(form.birthDate.trim() ? { birthDate: form.birthDate.trim() } : {}), ...(form.loginId.trim() ? { loginId: form.loginId.trim() } : {}) };
      try { r = await api('POST', base, body); } catch (x) {
        if (x.status === 409 && form.loginId.trim()) { setIdErr(x.message); return; }
        throw x;
      }
      if (r.temp) setTemp({ name: form.name, loginId: r.loginId, temp: r.temp }); // 계정 없는 줄은 임시 비밀번호가 없다
      setForm({ name: '', birthDate: '', loginId: '', role: '교직원', duty: null });
    });
  };
  const patch = (m, body) => run(async () => {
    const r = await guarded((force) => api('PATCH', `${base}/${m.id}`, force ? { ...body, force: true } : body));
    if (r) setNote(vacatedCounts(r));
  });
  const bulkApply = () => run(async () => {
    let r = await api('POST', `${base}/status`, { ids: [...sel], status: bulkStatus });
    const flagged = flaggedRows(r.results); // 마지막 기관 관리자가 든 줄은 멈춰 있다 — 한 번 묻고 그 줄만 force 로 다시
    if (flagged.length) {
      const names = flagged.map((x) => rows.find((m) => m.id === x.id)?.name ?? '').filter(Boolean).join(', ');
      if (await ask(flagged[0].text, names)) r = mergeBulkStatus(r, await api('POST', `${base}/status`, { ids: flagged.map((x) => x.id), status: bulkStatus, force: true }));
    }
    setNote(vacatedCounts(r));
    setBulkRes({ changed: r.changed, failed: (r.results || []).filter((x) => !x.ok) });
    setSel(new Set()); setBulkStatus(null);
  });
  const doUnlink = () => run(async () => {
    const r = await guarded((force) => api('DELETE', forcePath(`${base}/${unlinkAsk.id}/link`, force)));
    if (r) setUnlinkAsk(null);
  });
  const post = (m, what) => run(async () => {
    const r = await api('POST', `${base}/${m.id}/${what}`);
    if (r.temp) setTemp({ name: m.name, loginId: r.loginId, temp: r.temp });
  });

  async function pick(file) {
    if (!file) return;
    setErr('');
    try {
      const r = await api('POST', `${base}/import/preview`, file);
      setImp({ headers: r.headers, rows: r.rows, truncated: r.truncated, map: r.mapping });
    } catch (e) {
      setErr(e.message);
    }
  }
  const mapped = () => imp.rows.map((cells) => Object.fromEntries(FIELDS.map(([k]) => [k, imp.map[k] >= 0 ? cells[imp.map[k]] ?? '' : ''])));
  const [odd, setOdd] = useState(null); // 목록 밖 담당 구분 줄 — 「그래도 올리기」 한 번 묻기(재확인 수위)
  const doImport = (confirm) => run(async () => {
    try {
      const r = await api('POST', `${base}/import`, { rows: mapped(), ...(confirm === true ? { confirm: true } : {}) });
      setResult(r);
      setImp(null);
      setOdd(null);
    } catch (e) {
      if (e.body?.needConfirm) setOdd(e.body); else throw e;
    }
  });
  // 못 읽은 줄 빨강: 올리기 전에 화면에서도 같은 기준으로 미리 표시한다(서버가 최종 판정)
  const preBad = (r) => !r.name.trim() ? '이름 없음' : r.role && !ROLES.includes(r.role.trim()) ? '역할 모름' : '';
  const preOdd = (r) => { const t = (r.duty || '').trim(); return t && !cfg.duties.includes(t) && !/담임|전담|비교과/.test(t) ? '담당 구분 목록 밖' : ''; };

  const actions = (m) => (
    <Group gap="xs" wrap="nowrap">
      {m.hasAccount
        ? <Button size="xs" variant="default" disabled={busy} onClick={() => setUnlinkAsk(m)}>{t('roster.unlink.menu')}</Button>
        : <Button size="xs" variant="default" disabled={busy} onClick={() => setLinkLine(m)}>{t('roster.link.menu')}</Button>}
      {m.hasAccount && <Button size="xs" variant="default" disabled={busy} onClick={() => post(m, 'reset-password')}>{t('roster.row.reset')}</Button>}
      <Button size="xs" variant="subtle" color="red" disabled={busy} onClick={() => del(cascadeOpts(`/orgs/${orgId}`, 'membership', m.id, m.name, `${base}/${m.id}`, {
        run: async () => { const r = await guarded((force) => api('DELETE', forcePath(`${base}/${m.id}`, force))); if (r) setMoved(r.unlinked ? m.name : null); }, title: t('roster.del.title', { 이름: m.name }), yes: t('roster.del.yes'), onDone: load,
        lead: t('roster.del.lead') + (hv.byMember[m.id] ? ` ${t('roster.del.has_duty')}` : '') }))}>{t('roster.row.delete')}</Button>
    </Group>
  );
  const statusSel = (m) => <Select aria-label={t('roster.row.status_pick')} data={statusData} value={m.listStatus} onChange={(v) => v && v !== m.listStatus && patch(m, { status: v })} allowDeselect={false} disabled={busy} size="xs" w={100} />;
  const pickBox = (m) => <Checkbox aria-label={m.name} checked={sel.has(m.id)} onChange={() => setSel(toggleId(sel, m.id))} />;
  const roleSel = (m) => <Select data={roleData} value={m.role} onChange={(v) => v && patch(m, { role: v })} allowDeselect={false} disabled={busy} size="xs" w={120} />;
  const stateBadge = (m) => <Badge color={m.state === '잠김' ? 'red' : m.state === '사용 중' ? 'green' : m.hasAccount ? 'yellow' : 'gray'}>{m.state}</Badge>;
  const loginCell = (m) => (m.hasAccount ? m.loginId : t('roster.col.no_account'));
  const off = (m) => m.listStatus !== '사용';

  return (
    <Stack>
      {delBox}
      {askBox}
      <TransferNote note={moveNote} onClose={() => setMoveNote(null)} />
      <Title order={4}>{t('roster.head.title', { 수: rows.length })}</Title>
      {err && <Alert color="red">{err}</Alert>}
      {note && <Alert color="yellow" withCloseButton onClose={() => setNote(null)}>{t('roster.bulk.vacated', note)}</Alert>}
      {moved && <Alert color="blue" withCloseButton onClose={() => setMoved(null)}>{t('roster.moved.unlinked', { 이름: moved })}</Alert>}
      {bulkRes && (
        <Alert color={bulkRes.failed.length ? 'orange' : 'green'} withCloseButton onClose={() => setBulkRes(null)}>
          <Text size="sm">{t('roster.bulk.done', { 수: bulkRes.changed })}{bulkRes.failed.length > 0 && ` · ${t('roster.bulk.failed', { 수: bulkRes.failed.length })}`}</Text>
          {bulkRes.failed.map((x) => <Text key={x.id} size="xs">{x.error}</Text>)}
        </Alert>
      )}
      <form onSubmit={add}>
        <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
          <Group align="flex-end">
            <TextInput label={t('roster.add.name')} value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} required />
            <TextInput label={t('roster.add.birth')} placeholder="2001-03-05" value={form.birthDate} onChange={(e) => setForm({ ...form, birthDate: e.currentTarget.value })} w={190} />
            <TextInput label={t('roster.add.login_id')} value={form.loginId} error={idErr || undefined} onChange={(e) => { setIdErr(''); setForm({ ...form, loginId: e.currentTarget.value }); }} />
            <Select label={t('roster.add.role')} data={roleData} value={form.role} onChange={(v) => setForm({ ...form, role: v })} allowDeselect={false} w={130} />
            <Select label={t('roster.add.duty')} data={dutyOptions(cfg, form.duty)} value={form.duty} onChange={(v) => setForm({ ...form, duty: v })} clearable w={130} />
            <Button type="submit" loading={busy}>{t('roster.add.submit')}</Button>
          </Group>
        </fieldset>
      </form>
      <Group>
        <Button variant="default" onClick={getTemplate}>엑셀 양식 내려받기</Button>
        <FileButton onChange={pick} accept=".xlsx">{(p) => <Button variant="default" {...p}>엑셀 올리기</Button>}</FileButton>
        <Button variant="default" onClick={() => setBulkLink(true)}>{t('roster.bulk_link.open')}</Button>
        <SetupLink step="roster" onGo={onGoSetup} />
      </Group>

      {(hv.noClass.length > 0 || hv.noTeacher.length > 0) && (
        <Alert color="yellow" title={t('roster.head.gap')}>
          {hv.noClass.length > 0 && <Text size="sm">{t('roster.head.no_class', { 이름: noClassText })}</Text>}
          {hv.noTeacher.length > 0 && <Text size="sm">{t('roster.head.no_teacher', { 반: noTeacherText })}</Text>}
        </Alert>
      )}
      {sel.size > 0 && (
        <Group>
          <Text size="sm">{t('roster.bulk.picked', { 수: sel.size })}</Text>
          <Select aria-label={t('roster.bulk.status')} placeholder={t('roster.bulk.status')} data={statusData} value={bulkStatus} onChange={setBulkStatus} size="xs" w={140} disabled={busy} />
          <Button size="xs" disabled={!bulkStatus} loading={busy} onClick={bulkApply}>{t('roster.bulk.apply')}</Button>
          <Button size="xs" variant="subtle" disabled={busy} onClick={() => { setSel(new Set()); setBulkStatus(null); }}>{t('roster.bulk.clear')}</Button>
        </Group>
      )}
      <Stack gap="xs" hiddenFrom="sm">
        {rows.map((m) => (
          <Paper key={m.id} withBorder p="sm" opacity={off(m) ? 0.5 : 1}>
            <Group justify="space-between" wrap="nowrap">
              <Group gap="xs" wrap="nowrap">{pickBox(m)}<Text fw={600}>{m.name}{m.duty && <Text span size="xs" c="dimmed"> {m.duty}</Text>}</Text></Group>
              <div>{stateBadge(m)}</div>
            </Group>
            <Text size="xs" c="dimmed" mb={4}>{showAccount && `${t('roster.account.col')} ${loginCell(m)} · `}{m.birthDate && `${m.birthDate} · `}{t('roster.col.classes')} {hv.byMember[m.id] || '-'} · {t('roster.col.last')} {m.lastLogin ? new Date(m.lastLogin).toLocaleString('ko-KR') : '-'}</Text>
            <Stack gap={6}>{roleSel(m)}{statusSel(m)}<Group gap="xs">{actions(m)}</Group></Stack>
          </Paper>
        ))}
      </Stack>
      <Table.ScrollContainer minWidth={700} visibleFrom="sm">
        <Table striped>
          <Table.Thead><Table.Tr><Table.Th w={36}><Checkbox aria-label={t('roster.bulk.pick_all')} checked={rows.length > 0 && sel.size === rows.length} indeterminate={sel.size > 0 && sel.size < rows.length} onChange={() => setSel(sel.size === rows.length ? new Set() : new Set(rows.map((m) => m.id)))} /></Table.Th><Table.Th>{t('roster.col.name')}</Table.Th><Table.Th>{t('roster.col.birth')}</Table.Th>{showAccount && <Table.Th>{t('roster.account.col')}</Table.Th>}<Table.Th>{t('roster.col.classes')}</Table.Th><Table.Th>{t('roster.col.role')}</Table.Th><Table.Th>{t('roster.col.status')}</Table.Th><Table.Th /><Table.Th>{t('roster.col.last')}</Table.Th><Table.Th /></Table.Tr></Table.Thead>
          <Table.Tbody>
            {rows.map((m) => (
              <Table.Tr key={m.id} opacity={off(m) ? 0.5 : 1}>
                <Table.Td>{pickBox(m)}</Table.Td>
                <Table.Td>{m.name}{m.duty && <Text span size="xs" c="dimmed"> {m.duty}</Text>}</Table.Td>
                <Table.Td>{m.birthDate || t('roster.col.no_account')}</Table.Td>
                {showAccount && <Table.Td>{loginCell(m)}</Table.Td>}
                <Table.Td>{hv.byMember[m.id] || '-'}</Table.Td>
                <Table.Td>{roleSel(m)}</Table.Td>
                <Table.Td>{statusSel(m)}</Table.Td>
                <Table.Td>{stateBadge(m)}</Table.Td>
                <Table.Td>{m.lastLogin ? new Date(m.lastLogin).toLocaleString('ko-KR') : '-'}</Table.Td>
                <Table.Td>{actions(m)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>

      <UnlinkedBox base={base} items={unlinked} rows={rows} onChanged={load} onError={setErr} />
      {linkLine && <LinkModal line={linkLine} base={base} onClose={() => setLinkLine(null)} onChanged={load} onTemp={setTemp} onError={setErr} onTransfer={(r) => setMoveNote(transferNote(r))} />}
      {bulkLink && <BulkLink base={base} lines={rows} onClose={() => setBulkLink(false)} onChanged={load} />}
      <Modal opened={!!unlinkAsk} onClose={() => setUnlinkAsk(null)} title={t('roster.unlink.title', { 이름: unlinkAsk?.name ?? '' })} centered>
        {unlinkAsk && (
          <Stack>
            <Text size="sm">{t('roster.unlink.lead', { 이름: unlinkAsk.name })}</Text>
            <Group justify="flex-end">
              <Button variant="default" disabled={busy} onClick={() => setUnlinkAsk(null)}>{t('roster.unlink.no')}</Button>
              <Button color="red" loading={busy} onClick={doUnlink}>{t('roster.unlink.yes')}</Button>
            </Group>
          </Stack>
        )}
      </Modal>

      <Modal opened={!!temp} onClose={() => setTemp(null)} title={t('roster.temp.title')}>
        <Stack>
          <Text>{t('roster.temp.login', { 아이디: temp?.loginId ?? '' })}</Text>
          <Text>{t('roster.temp.pw', { 비밀번호: temp?.temp ?? '' })}</Text>
          <Alert color="yellow">{t('roster.temp.warn')}</Alert>
          <Button variant="default" onClick={() => download(t('roster.temp.file'), [{ ok: true, name: temp.name, loginId: temp.loginId, temp: temp.temp }])}>{t('roster.temp.download')}</Button>
          <Button onClick={() => setTemp(null)}>{t('roster.temp.close')}</Button>
        </Stack>
      </Modal>

      <Modal opened={!!imp} onClose={() => setImp(null)} title="열 맞추기" size="xl">
        {imp && (
          <Stack>
            <Text size="sm">엑셀의 어느 열이 무엇인지 맞춰 주세요. 못 읽은 줄은 빨갛게 표시되고, 나머지는 그대로 만들어집니다.{imp.truncated && ' (1000줄까지만 읽었습니다)'}</Text>
            <Group>
              {FIELDS.map(([k, label]) => (
                <Select key={k} label={label} data={[{ value: '-1', label: '(없음)' }, ...imp.headers.map((h, i) => ({ value: String(i), label: h || `열 ${i + 1}` }))]} value={String(imp.map[k])} onChange={(v) => setImp({ ...imp, map: { ...imp.map, [k]: Number(v) } })} allowDeselect={false} w={150} />
              ))}
            </Group>
            <Table.ScrollContainer minWidth={500} mah={320}>
              <Table>
                <Table.Thead><Table.Tr><Table.Th>줄</Table.Th>{FIELDS.map(([, l]) => <Table.Th key={l}>{l}</Table.Th>)}<Table.Th /></Table.Tr></Table.Thead>
                <Table.Tbody>
                  {mapped().map((r, i) => (
                    <Table.Tr key={i} bg={preBad(r) ? 'red.1' : preOdd(r) ? 'orange.1' : undefined} c={preBad(r) ? 'red.9' : preOdd(r) ? 'orange.9' : undefined}>
                      <Table.Td>{i + 1}</Table.Td>{FIELDS.map(([k]) => <Table.Td key={k}>{r[k]}</Table.Td>)}<Table.Td>{preBad(r) || preOdd(r)}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            {odd && (
              <Alert color="orange" title="담당 구분이 기관 목록 밖인 줄이 있습니다 — 그래도 올릴까요?">
                {odd.odd.map((x) => <Text key={x.line} size="sm">{x.line}줄 {x.name} — 「{x.duty}」</Text>)}
                <Text size="xs" c="dimmed">기관 목록: {odd.duties.join('·')}</Text>
                <Button mt="xs" color="orange" onClick={() => doImport(true)}>그래도 올리기</Button>
              </Alert>
            )}
            <Button onClick={() => doImport()} disabled={imp.map.name < 0}>{imp.rows.length}줄 올리기</Button>
          </Stack>
        )}
      </Modal>

      <Modal opened={!!result} onClose={() => setResult(null)} title={`올린 결과 — 만듦 ${result?.made} · 못 읽음 ${result?.failed}`} size="xl">
        {result && (
          <Stack>
            <Alert color="yellow">임시 비밀번호는 저장되지 않습니다. 지금 「아이디·임시 비밀번호 목록」을 내려받으세요. 창을 닫으면 다시 볼 수 없습니다.</Alert>
            <Button onClick={() => download(t('roster.temp.file'), result.results)} disabled={!result.made}>이번 목록 내려받기(엑셀/CSV)</Button>
            <Table.ScrollContainer minWidth={500} mah={320}>
              <Table>
                <Table.Tbody>
                  {result.results.map((r) => (
                    <Table.Tr key={r.line} bg={r.ok ? undefined : 'red.1'} c={r.ok ? undefined : 'red.9'}>
                      <Table.Td>{r.line}</Table.Td><Table.Td>{r.name}</Table.Td><Table.Td>{r.loginId}</Table.Td><Table.Td>{r.ok ? `만듦${r.warnings?.length ? ` — ${r.warnings.map((w) => w.msg).join(' ')}` : ''}` : r.error}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
