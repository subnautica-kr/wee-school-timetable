import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Checkbox, Collapse, Group, Modal, Radio, Select, Stack, Tabs, Text, TextInput, Textarea, UnstyledButton } from '@mantine/core';
import { api } from '../api.js';
import { t } from '../T.jsx';
import { LABELS, makeValueName } from '../../../shared/text/index.js';

const valueName = makeValueName(LABELS);
// 도움·요청 창(T-1324a②) — 글 목록 · 글쓰기 · 사용 설명·자주 묻는 질문·공지. 서버: /api/board (T-1324a①)
const KINDS = ['bug', 'usability', 'feature', 'question'];
const VIS = ['org_admins', 'sysadmin', 'org_and_sysadmin', 'public'];
const STAGES = ['received', 'reviewing', 'working', 'done', 'hold'];
const GROUPS = [['active', ['reviewing', 'working']], ['waiting', ['received', 'hold']], ['done', ['done']]];
const kindName = (v) => valueName('board_post.kind', v);
const visName = (v) => valueName('board_post.visibility', v);
const stageName = (v) => valueName('board_post.stage', v);
const when = (s) => new Date(s).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
// 서버 거절은 {error} 가 이미 사람이 읽을 문장이다
const countText = (key, n) => t(key, { 개수: n }); // 문구-예외: 문구 변수 이름
const msg = (e) => e?.message || t('board.err.bad_input');

function List({ onOpen }) {
  const [items, setItems] = useState(null);
  const [mine, setMine] = useState(false);
  const [kind, setKind] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    const q = new URLSearchParams();
    if (mine) q.set('mine', '1');
    if (kind) q.set('kind', kind);
    api('GET', `/board/posts?${q}`).then((r) => { setItems(r.items); setErr(''); }).catch(() => setErr(t('board.list.load_failed')));
  }, [mine, kind]);
  return (
    <Stack gap="sm" data-testid="board-list">
      <Group>
        <Select aria-label={t('board.list.kind_all')} placeholder={t('board.list.kind_all')} clearable value={kind || null} onChange={(v) => setKind(v || '')} data={KINDS.map((k) => ({ value: k, label: kindName(k) }))} w={180} />
        <Checkbox label={t('board.list.mine')} checked={mine} onChange={(e) => setMine(e.currentTarget.checked)} />
      </Group>
      {err && <Alert color="red">{err}</Alert>}
      {!items && !err && <Text size="sm" c="dimmed">{t('board.list.loading')}</Text>}
      {items && items.length === 0 && <Text size="sm" c="dimmed">{t('board.list.empty')}</Text>}
      {items && GROUPS.map(([g, stages]) => {
        const rows = items.filter((x) => stages.includes(x.stage)); // 서버가 이미 세로 순서로 줌 — 묶음 머리글만 단다
        if (!rows.length) return null;
        return (
          <Stack key={g} gap={4} data-group={g}>
            <Text size="sm" fw={700}>{t(`board.stage_group.${g}`)}</Text>
            {rows.map((x) => (
              <UnstyledButton key={x.id} onClick={() => onOpen(x.id)} data-testid="board-row" style={{ border: '1px solid var(--mantine-color-gray-3)', borderRadius: 6, padding: '6px 10px' }}>
                <Group gap="xs" wrap="nowrap">
                  <Badge variant="light">{stageName(x.stage)}</Badge>
                  <Badge variant="outline" color="gray">{kindName(x.kind)}</Badge>
                  <Text size="sm" fw={600} style={{ flex: 1 }} lineClamp={1}>{x.title}</Text>
                  {x.mine && <Badge color="teal" variant="light">{t('board.list.mine_badge')}</Badge>}
                </Group>
                <Text size="xs" c="dimmed">{x.school} · {when(x.updatedAt)} · {countText('board.list.comments', x.commentCount)}{x.groupCount > 0 ? ` · ${countText('board.list.grouped', x.groupCount)}` : ''}</Text>
              </UnstyledButton>
            ))}
          </Stack>
        );
      })}
    </Stack>
  );
}

function Write({ onDone }) {
  const [kind, setKind] = useState('');
  const [vis, setVis] = useState(null); // 기본값 없음 — 꼭 고르게
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [sendCtx, setSendCtx] = useState(true);
  const [ctxOpen, setCtxOpen] = useState(false);
  const [similar, setSimilar] = useState([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (title.trim().length < 2) { setSimilar([]); return undefined; }
    const id = setTimeout(() => api('GET', `/board/similar?title=${encodeURIComponent(title.trim())}`).then((r) => setSimilar(r.items || [])).catch(() => setSimilar([])), 400);
    return () => clearTimeout(id);
  }, [title]);
  const context = sendCtx ? { screen: window.location.pathname, hash: window.location.hash, browser: navigator.userAgent, version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '' } : {};
  const submit = async () => {
    if (!kind) return setErr(t('board.err.bad_input'));
    if (!vis) return setErr(t('board.write.visibility_missing'));
    if (!title.trim()) return setErr(t('board.write.need_title'));
    if (!body.trim()) return setErr(t('board.write.need_body'));
    setBusy(true);
    try { const r = await api('POST', '/board/posts', { kind, visibility: vis, title: title.trim(), body: body.trim(), context }); onDone(r.id); } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
    return undefined;
  };
  return (
    <Stack gap="sm" data-testid="board-write">
      <Radio.Group label={t('board.write.kind')} value={kind} onChange={setKind}>
        <Group mt={4}>{KINDS.map((k) => <Radio key={k} value={k} label={kindName(k)} />)}</Group>
      </Radio.Group>
      <Radio.Group label={t('board.write.visibility')} description={t('board.write.visibility_hint')} value={vis} onChange={setVis} data-testid="board-vis">
        <Stack gap={4} mt={4}>
          {VIS.map((v) => <Radio key={v} value={v} label={v === 'sysadmin' ? t('board.write.visibility_sysadmin') : v === 'public' ? t('board.write.visibility_public') : visName(v)} />)}
        </Stack>
        <Text size="xs" c="dimmed" mt={4}>{t('board.write.visibility_org_admins')}</Text>
      </Radio.Group>
      <TextInput label={t('board.write.title')} value={title} onChange={(e) => setTitle(e.currentTarget.value)} maxLength={200} />
      {similar.length > 0 && (
        <Alert color="yellow" title={t('board.write.similar_head')}>
          {similar.slice(0, 5).map((s) => <Text key={s.id} size="sm">· {s.title} ({stageName(s.stage)})</Text>)}
        </Alert>
      )}
      <Textarea label={t('board.write.body')} value={body} onChange={(e) => setBody(e.currentTarget.value)} autosize minRows={4} />
      <Stack gap={2}>
        <Group gap="xs">
          <Checkbox label={t('board.write.context_check')} checked={sendCtx} onChange={(e) => setSendCtx(e.currentTarget.checked)} />
          <Button variant="subtle" size="compact-xs" onClick={() => setCtxOpen(!ctxOpen)}>{t('board.write.context_head')} {ctxOpen ? '▲' : '▼'}</Button>
        </Group>
        <Collapse in={ctxOpen}><Text size="xs" c="dimmed">{t('board.write.context_text')}</Text></Collapse>
      </Stack>
      <Text size="xs" c="dimmed">{t('board.write.attach_later')}</Text>
      {err && <Alert color="red">{err}</Alert>}
      <Group><Button onClick={submit} loading={busy}>{t('board.write.submit')}</Button></Group>
    </Stack>
  );
}

function Detail({ id, onBack }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [reply, setReply] = useState('');
  const [tags, setTags] = useState('');
  const load = useCallback(() => api('GET', `/board/posts/${id}`).then((r) => { setD(r); setTags((r.post.tags || []).join(', ')); }).catch((e) => setErr(msg(e))), [id]);
  useEffect(() => { load(); }, [load]);
  const act = (method, path, body) => api(method, `/board/posts/${id}${path}`, body).then(() => { setErr(''); return load(); }).catch((e) => setErr(msg(e)));
  if (!d) return <Stack><Button variant="subtle" onClick={onBack} w="fit-content">{t('board.detail.back')}</Button>{err ? <Alert color="red">{err}</Alert> : <Text size="sm" c="dimmed">{t('board.detail.loading')}</Text>}</Stack>;
  const { post, comments } = d;
  return (
    <Stack gap="sm" data-testid="board-detail">
      <Button variant="subtle" onClick={onBack} w="fit-content">{t('board.detail.back')}</Button>
      <Group gap="xs"><Badge variant="light">{stageName(post.stage)}</Badge><Badge variant="outline" color="gray">{kindName(post.kind)}</Badge><Badge variant="outline" color="gray">{visName(post.visibility)}</Badge></Group>
      <Text fw={700}>{post.title}</Text>
      <Text size="xs" c="dimmed">{t('board.detail.school')} {post.school}{post.mine ? ` · ${t('board.detail.mine')}` : ''} · {when(post.createdAt)}</Text>
      <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{post.body}</Text>
      {post.groupCount > 0 && <Text size="xs" c="dimmed">{countText('board.detail.group_in', post.groupCount)}</Text>}
      {post.canStage && <Select label={t('board.detail.stage')} value={post.stage} onChange={(v) => v && act('PATCH', '/stage', { stage: v })} allowDeselect={false} data={STAGES.map((s) => ({ value: s, label: stageName(s) }))} w={200} />}
      {post.canManage && (
        <Stack gap="xs">
          <Select label={t('board.detail.kind')} value={post.kind} onChange={(v) => v && act('PATCH', '/kind', { kind: v })} allowDeselect={false} data={KINDS.map((k) => ({ value: k, label: kindName(k) }))} w={200} />
          <Group align="end"><TextInput label={t('board.detail.tags')} value={tags} onChange={(e) => setTags(e.currentTarget.value)} w={260} /><Button variant="default" onClick={() => act('PUT', '/tags', { tags: tags.split(',').map((x) => x.trim()).filter(Boolean) })}>{t('board.detail.tags_save')}</Button></Group>
          {post.visibility === 'org_admins' && <Group><Button variant="default" onClick={() => act('POST', '/raise')}>{t('board.detail.raise')}</Button></Group>}
        </Stack>
      )}
      <Text size="sm" fw={700}>{t('board.detail.comments')}</Text>
      {comments.length === 0 && <Text size="sm" c="dimmed">{t('board.detail.no_comments')}</Text>}
      {comments.map((c) => (
        <Stack key={c.id} gap={0}>
          <Text size="xs" c="dimmed">{c.bySysadmin ? t('board.detail.by_sysadmin') : c.mine ? t('board.detail.mine') : ''} {when(c.createdAt)}</Text>
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{c.body}</Text>
        </Stack>
      ))}
      {post.canReply && (
        <Stack gap="xs">
          <Textarea placeholder={t('board.detail.reply_ph')} value={reply} onChange={(e) => setReply(e.currentTarget.value)} autosize minRows={2} />
          <Group><Button disabled={!reply.trim()} onClick={() => act('POST', '/comments', { body: reply.trim() }).then(() => setReply(''))}>{t('board.detail.reply_submit')}</Button></Group>
        </Stack>
      )}
      {err && <Alert color="red">{err}</Alert>}
    </Stack>
  );
}

function Guide() {
  return (
    <Stack gap="sm" data-testid="board-guide">
      <Text fw={700}>{t('board.guide.usage_head')}</Text>
      {[1, 2, 3].map((n) => <Text key={n} size="sm">· {t(`board.guide.usage_${n}`)}</Text>)}
      <Text fw={700} mt="sm">{t('board.guide.faq_head')}</Text>
      {[1, 2, 3].map((n) => <Stack key={n} gap={0}><Text size="sm" fw={600}>{t(`board.guide.faq_q${n}`)}</Text><Text size="sm">{t(`board.guide.faq_a${n}`)}</Text></Stack>)}
      <Text fw={700} mt="sm">{t('board.guide.notice_head')}</Text>
      <Text size="sm" c="dimmed">{t('board.guide.notice_empty')}</Text>
    </Stack>
  );
}

// openId: 종 소식(board:<번호>)이 시킨 글 {id} — 바뀔 때마다 그 글을 연다
export default function BoardModal({ opened, onClose, openId }) {
  const [tab, setTab] = useState('list');
  const [postId, setPostId] = useState(null);
  const [rev, setRev] = useState(0);
  useEffect(() => { if (openId) { setPostId(openId.id); setTab('list'); } }, [openId]);
  const open = (id) => { setPostId(id); setTab('list'); };
  return (
    <Modal opened={opened} onClose={onClose} title={t('board.win.title')} size="lg" centered>
      <Tabs value={tab} onChange={(v) => { setTab(v); setPostId(null); }} keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="list">{t('board.win.tab_list')}</Tabs.Tab>
          <Tabs.Tab value="write">{t('board.win.tab_write')}</Tabs.Tab>
          <Tabs.Tab value="guide">{t('board.win.tab_guide')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="list">{postId ? <Detail id={postId} onBack={() => { setPostId(null); setRev((r) => r + 1); }} /> : <List key={rev} onOpen={setPostId} />}</Tabs.Panel>
        <Tabs.Panel value="write"><Write onDone={open} /></Tabs.Panel>
        <Tabs.Panel value="guide"><Guide /></Tabs.Panel>
      </Tabs>
    </Modal>
  );
}
