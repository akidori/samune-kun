import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, createSign } from 'node:crypto';
import worker from '../src/index.js';
import { fromValue, toValue } from '../src/google.js';
import { totals } from '../src/invoice.js';

/* ───────── fakes ───────── */

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PROJECT = 'birdstraike';
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64u = b => Buffer.from(b).toString('base64url');

function idToken(uid, email) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1' }));
  const p = b64u(JSON.stringify({ aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`, sub: uid, email, name: uid, exp: now + 600, iat: now }));
  const s = createSign('RSA-SHA256').update(`${h}.${p}`).sign(privateKey).toString('base64url');
  return `${h}.${p}.${s}`;
}

let docs, calls, claudeReply, lineSeq;

function firestoreFetch(url, init) {
  const u = new URL(url);
  const path = decodeURIComponent(u.pathname.split('/documents')[1] || '');
  const nowTs = () => new Date(Date.now() + Math.random()).toISOString();
  if (path === ':runQuery') {
    const q = JSON.parse(init.body).structuredQuery;
    const col = q.from[0].collectionId;
    const filters = q.where.compositeFilter ? q.where.compositeFilter.filters : [q.where];
    const rows = [...docs.entries()].filter(([k]) => k.startsWith(col + '/')).filter(([, d]) =>
      filters.every(f => JSON.stringify(fromValue(d.fields[f.fieldFilter.field.fieldPath] || { nullValue: null })) === JSON.stringify(fromValue(f.fieldFilter.value))));
    return Response.json(rows.map(([k, d]) => ({ document: { name: `projects/x/databases/(default)/documents/${k}`, ...d } })));
  }
  const key = path.slice(1);
  const cur = docs.get(key);
  if (!init.method || init.method === 'GET') {
    return cur ? Response.json({ name: key, ...cur }) : new Response('{}', { status: 404 });
  }
  if (init.method === 'PATCH') {
    const ut = u.searchParams.get('currentDocument.updateTime');
    const ex = u.searchParams.get('currentDocument.exists');
    if (ut && (!cur || cur.updateTime !== ut)) return new Response('precondition', { status: 400 + 12 });
    if (ex === 'false' && cur) return new Response('exists', { status: 409 });
    const incoming = JSON.parse(init.body).fields;
    const mask = u.searchParams.getAll('updateMask.fieldPaths');
    const fields = mask.length ? { ...(cur?.fields || {}), ...incoming } : incoming;
    const doc = { fields, updateTime: nowTs() };
    docs.set(key, doc);
    return Response.json({ name: key, ...doc });
  }
  throw new Error('unexpected firestore ' + init.method + ' ' + url);
}

function installFetch() {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    let body = init.body;
    if (input instanceof Request) { body = await input.text(); init = { method: input.method, headers: Object.fromEntries(input.headers), body }; }
    calls.push({ url, method: init.method || 'GET', body });
    if (url.includes('securetoken@system')) return Response.json({ keys: [jwk] }, { headers: { 'cache-control': 'max-age=3600' } });
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'at', expires_in: 3600 });
    if (url.startsWith('https://firestore.googleapis.com')) return firestoreFetch(url, init);
    if (url.startsWith('https://api.anthropic.com')) {
      return Response.json({ id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: claudeReply.stop || 'end_turn',
        content: claudeReply.stop === 'refusal' ? [] : [{ type: 'text', text: JSON.stringify(claudeReply.body) }], usage: { input_tokens: 1, output_tokens: 1 } });
    }
    if (url.startsWith('https://api.line.me/v2/bot/message/')) return Response.json({ sentMessages: JSON.parse(body).messages.map(() => ({ id: 'L' + (++lineSeq) })) });
    if (url.includes('/upload/drive/v3/files')) return Response.json({ id: 'F' + calls.length, webViewLink: 'https://drive/F' });
    if (url.includes('/drive/v3/files') && url.includes('/export')) return new Response(new Uint8Array([37, 80, 68, 70]));
    if (url.includes('/drive/v3/files?q=')) return Response.json({ files: [] });
    if (url.includes('/drive/v3/files')) return Response.json({ id: 'FOLDER' });
    throw new Error('unexpected fetch ' + url);
  };
}

const env = () => ({
  FIREBASE_PROJECT_ID: PROJECT,
  GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'sa@x', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }),
  ANTHROPIC_API_KEY: 'sk', LINE_CHANNEL_ACCESS_TOKEN: 'tok', LINE_CHANNEL_SECRET: 'secret', DIRECTOR_LINE_USER_ID: 'Udir',
  DIRECTOR_EMAILS: 'boss@example.com', GOOGLE_OAUTH_REFRESH_TOKEN: 'rt', GOOGLE_OAUTH_CLIENT_ID: 'c', GOOGLE_OAUTH_CLIENT_SECRET: 's',
  BILL_TO_NAME: '株式会社テスト',
});

const seed = (col, id, data) => docs.set(`${col}/${id}`, { fields: toValue(data).mapValue.fields, updateTime: new Date().toISOString() });
const read = (col, id) => { const d = docs.get(`${col}/${id}`); return d && fromValue({ mapValue: { fields: d.fields } }); };

async function api(path, { body, token = idToken('ed1', 'ed@example.com'), method = 'POST' } = {}) {
  const res = await worker.fetch(new Request('https://w' + path, {
    method, headers: { Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined,
  }), env());
  return { status: res.status, data: await res.json() };
}

async function lineHook(events) {
  const raw = JSON.stringify({ events });
  const sig = createHmac('sha256', 'secret').update(raw).digest('base64');
  return worker.fetch(new Request('https://w/line/webhook', { method: 'POST', body: raw, headers: { 'x-line-signature': sig } }), env());
}

beforeEach(() => {
  docs = new Map(); calls = []; lineSeq = 0; claudeReply = { body: {} };
  installFetch();
  seed('mt_editors', 'ed1', { name: '佐藤', invoiceProfile: { name: '佐藤 花子', address: '東京都', invoiceNo: 'T1234567890123', bank: '〇〇銀行' } });
  seed('mt_projects', 'p1', { name: '福岡ロケ', editorId: 'ed1', editorName: '佐藤', phase: '編集', status: 'active', fee: 30000, deadline: '2026-10-10' });
  seed('mt_projects', 'p2', { name: '他人の案件', editorId: 'ed2', phase: '編集', status: 'active', fee: 10000 });
});

/* ───────── tests ───────── */

test('auth: missing / forged tokens are rejected', async () => {
  assert.equal((await api('/me', { method: 'GET', token: '' })).status, 401);
  const forged = idToken('ed1', 'ed@example.com').replace(/\.[^.]+$/, '.AAAA');
  assert.equal((await api('/me', { method: 'GET', token: forged })).status, 401);
  const me = await api('/me', { method: 'GET' });
  assert.deepEqual([me.status, me.data.uid, me.data.role], [200, 'ed1', 'editor']);
  const boss = await api('/me', { method: 'GET', token: idToken('d1', 'Boss@example.com') });
  assert.equal(boss.data.role, 'director');
});

test('/plan sends only own projects and uses structured output', async () => {
  claudeReply = { body: { progress: { status: 'on_track', summary: 's', gap: 'g', bottleneck: 'b' }, todos: [], focusMessage: 'f' } };
  const r = await api('/plan', { body: { workHours: { start: '10:00', end: '19:00' } } });
  assert.equal(r.status, 200);
  assert.equal(r.data.focusMessage, 'f');
  const req = JSON.parse(calls.find(c => c.url.startsWith('https://api.anthropic.com')).body);
  assert.equal(req.model, 'claude-opus-5-5');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.match(req.messages[0].content, /福岡ロケ/);
  assert.doesNotMatch(req.messages[0].content, /他人の案件/);
});

test('/ask refusal → 422', async () => {
  claudeReply = { stop: 'refusal' };
  assert.equal((await api('/ask', { body: { stuckPoint: 'x' } })).status, 422);
});

test('ask → escalate → director quoted reply → answered', async () => {
  claudeReply = { body: { diagnosis: 'd', answer: 'a', nextSteps: [], confidence: 'low', shouldEscalate: true, escalateReason: 'r', directorMessage: '尺は10分で良い？' } };
  const ask = await api('/ask', { body: { todo: { title: '構成', projectId: 'p1', minutes: 45, elapsedMin: 70 }, stuckPoint: '尺' } });
  assert.equal(ask.status, 200);
  assert.equal(read('mt_questions', ask.data.id).status, 'ai');

  // 他人は送れない
  assert.equal((await api('/escalate', { body: { questionId: ask.data.id }, token: idToken('ed2', 'x@y') })).status, 404);

  const esc = await api('/escalate', { body: { questionId: ask.data.id } });
  assert.equal(esc.status, 200);
  const push = JSON.parse(calls.find(c => c.url.endsWith('/push')).body);
  assert.equal(push.to, 'Udir');
  assert.match(push.messages[0].text, /佐藤さんから相談/);
  assert.match(push.messages[0].text, /尺は10分で良い？/);
  assert.equal(read('mt_questions', ask.data.id).status, 'sent');

  // ディレクター以外の返信は無視
  await lineHook([{ type: 'message', replyToken: 'r', source: { userId: 'Uother' }, message: { type: 'text', text: 'hi', quotedMessageId: 'L1' } }]);
  assert.equal(read('mt_questions', ask.data.id).status, 'sent');

  await lineHook([{ type: 'message', replyToken: 'r', source: { userId: 'Udir' }, message: { type: 'text', text: '10分でOK', quotedMessageId: 'L1' } }]);
  const q = read('mt_questions', ask.data.id);
  assert.equal(q.status, 'answered');
  assert.equal(q.answer, '10分でOK');
});

test('bad LINE signature → 401', async () => {
  const res = await worker.fetch(new Request('https://w/line/webhook', { method: 'POST', body: '{}', headers: { 'x-line-signature': 'nope' } }), env());
  assert.equal(res.status, 401);
});

test('"ID" returns the sender userId', async () => {
  await lineHook([{ type: 'message', replyToken: 'r', source: { userId: 'Unew' }, message: { type: 'text', text: 'ID' } }]);
  assert.match(JSON.parse(calls.find(c => c.url.endsWith('/reply')).body).messages[0].text, /Unew/);
});

test('delivery → reject with reason → re-delivery → approve → invoice line (no duplicates)', async () => {
  assert.equal((await api('/delivery', { body: { projectId: 'p2' } })).status, 404);
  const d = await api('/delivery', { body: { projectId: 'p1', url: 'https://drive/x', note: '初稿です' } });
  assert.equal(d.status, 200);
  assert.equal(read('mt_projects', 'p1').status, 'delivered');
  const push = JSON.parse(calls.find(c => c.url.endsWith('/push')).body);
  assert.equal(push.messages[1].template.actions[0].data, 'approve:p1');

  await lineHook([{ type: 'postback', replyToken: 'r1', source: { userId: 'Udir' }, postback: { data: 'reject:p1' } }]);
  assert.equal(read('mt_projects', 'p1').status, 'rejected');
  const replyId = 'L' + lineSeq; // 差し戻し案内メッセージ
  await lineHook([{ type: 'message', replyToken: 'r2', source: { userId: 'Udir' }, message: { type: 'text', text: 'テロップ修正', quotedMessageId: replyId } }]);
  assert.equal(read('mt_projects', 'p1').rejectReason, 'テロップ修正');

  await api('/delivery', { body: { projectId: 'p1' } });
  assert.equal(read('mt_projects', 'p1').rejectReason, '');
  await lineHook([{ type: 'postback', replyToken: 'r3', source: { userId: 'Udir' }, postback: { data: 'approve:p1' } }]);
  await lineHook([{ type: 'postback', replyToken: 'r4', source: { userId: 'Udir' }, postback: { data: 'approve:p1' } }]);
  assert.equal(read('mt_projects', 'p1').status, 'approved');
  const invKey = [...docs.keys()].find(k => k.startsWith('mt_invoices/ed1_'));
  const inv = read('mt_invoices', invKey.split('/')[1]);
  assert.equal(inv.lines.length, 1);
  assert.deepEqual([inv.subtotal, inv.tax, inv.total, inv.status], [30000, 3000, 33000, 'draft']);
  assert.equal((await api('/delivery', { body: { projectId: 'p1' } })).status, 409);
});

test('invoice issue: director only, renders PDF to Drive, marks issued', async () => {
  seed('mt_invoices', 'ed1_2026-10', { editorId: 'ed1', editorName: '佐藤', month: '2026-10', status: 'draft',
    lines: [{ projectId: 'p1', name: '福岡ロケ', fee: 30000, approvedAt: '2026-10-05T03:00:00Z' }] });
  assert.equal((await api('/invoices/issue', { body: { month: '2026-10' } })).status, 403);
  const r = await api('/invoices/issue', { body: { month: '2026-10' }, token: idToken('d1', 'boss@example.com') });
  assert.equal(r.status, 200);
  assert.equal(r.data.issued.length, 1);
  const inv = read('mt_invoices', 'ed1_2026-10');
  assert.equal(inv.status, 'issued');
  assert.equal(inv.total, 33000);
  assert.ok(inv.driveFileId);
  const htmlUpload = calls.find(c => c.url.includes('/upload/drive/v3/files'));
  const html = Buffer.from(htmlUpload.body).toString('utf8');
  assert.match(html, /株式会社テスト 御中/);
  assert.match(html, /T1234567890123/);
  assert.match(html, /¥33,000/);
  // 発行済みの月に承認された案件は翌月に回る
  seed('mt_projects', 'p3', { name: '追加', editorId: 'ed1', status: 'delivered', fee: 5000 });
  const { addInvoiceLine } = await import('../src/invoice.js');
  const { Firestore } = await import('../src/google.js');
  const next = await addInvoiceLine(new Firestore(env()), { id: 'p3', name: '追加', editorId: 'ed1', fee: 5000 }, new Date('2026-10-31T10:00:00Z'));
  assert.equal(next.month, '2026-11');
});

test('totals: 10% tax floored', () => {
  assert.deepEqual(totals([{ fee: 12345 }, { fee: 1 }]), { subtotal: 12346, tax: 1234, total: 13580 });
});

test('/replan passes delayed todo with progress and returns schedule', async () => {
  claudeReply = { body: { assessment: 'a', remainingMinutes: 40, message: 'm', askDirector: false, todos: [], deferred: [] } };
  const r = await api('/replan', { body: { progressPct: 140, todo: { id: 't1', title: '粗カット', minutes: 30, elapsedMin: 45,
    steps: [{ title: 'インポート', seconds: 10, done: true }, { title: '粗カット', seconds: 1800, done: false }] }, remaining: [{ id: 't2', title: '次' }] } });
  assert.equal(r.status, 200);
  assert.equal(r.data.remainingMinutes, 40);
  const req = JSON.parse(calls.find(c => c.url.startsWith('https://api.anthropic.com')).body);
  assert.match(req.system, /巻き返し/);
  const data = JSON.parse(req.messages[0].content.match(/<data>\n([\s\S]*)\n<\/data>/)[1]);
  assert.equal(data.delayed.progressPct, 100);
  assert.equal(data.delayed.steps[0].done, true);
  assert.equal(data.remainingToday[0].id, 't2');
  assert.ok(req.output_config.format.schema.properties.todos.items.properties.steps);
});

async function pluginApi(path, token, { body, method = 'POST' } = {}) {
  const res = await worker.fetch(new Request('https://w' + path, {
    method, headers: { 'X-Plugin-Token': token }, body: body ? JSON.stringify(body) : undefined,
  }), env());
  return { status: res.status, data: await res.json() };
}

test('plugin token: issue, use, rotate', async () => {
  assert.equal((await pluginApi('/plugin/today', 'BAD', { method: 'GET' })).status, 401);
  const { data: { token } } = await api('/plugin/token');
  assert.match(token, /^[A-Z2-9]{6}-[A-Z2-9]{6}-[A-Z2-9]{6}$/);
  seed('mt_plans', `ed1_${jstYmd()}`, { date: jstYmd(), todos: [{ id: 't1', title: '粗カット', projectId: 'p1', phaseKey: '粗カット', minutes: 30, elapsedSec: 60, steps: [{ title: 'インポート', seconds: 10 }] }] });
  const today = await pluginApi('/plugin/today', token, { method: 'GET' });
  assert.equal(today.status, 200);
  assert.equal(today.data.todos[0].steps[0].title, 'インポート');
  assert.equal(today.data.projects.find(p => p.id === 'p1').name, '福岡ロケ');
  // plugin cannot mint tokens
  assert.equal((await pluginApi('/plugin/token', token)).status, 403);
  // rotating invalidates the old one
  await api('/plugin/token');
  assert.equal((await pluginApi('/plugin/today', token, { method: 'GET' })).status, 401);
});

function jstYmd() { return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); }

test('worklog: accumulates per phase, records overrun, feeds plugin time + progress into plan', async () => {
  seed('mt_projects', 'p1', { name: '密着', editorId: 'ed1', status: 'active', fee: 1, budgetsH: { '粗カット': 0.02 } }); // 72秒
  seed('mt_plans', `ed1_${jstYmd()}`, { date: jstYmd(), progress: { status: 'on_track' }, todos: [{ id: 't1', title: 'x', elapsedSec: 30 }] });
  const { data: { token } } = await api('/plugin/token');
  await pluginApi('/worklog', token, { body: { projectId: 'p1', todoId: 't1', phaseKey: '粗カット', seconds: 60, source: 'premiere' } });
  let p = read('mt_projects', 'p1');
  assert.equal(p.actualSec['粗カット'], 60);
  assert.deepEqual(p.overruns, {});
  const r = await pluginApi('/worklog', token, { body: { projectId: 'p1', todoId: 't1', phaseKey: '粗カット', seconds: 60, source: 'premiere', progressPct: 40, note: '00まで' } });
  assert.equal(r.data.overrun, true);
  p = read('mt_projects', 'p1');
  assert.equal(p.overruns['粗カット'].budgetH, 0.02);
  const plan = read('mt_plans', `ed1_${jstYmd()}`);
  assert.equal(plan.pluginSec.t1, 120);
  assert.equal(plan.todoProgress.t1.pct, 40);
  assert.equal(plan.progress.status, 'on_track'); // AI の現在地は壊さない
  const today = await pluginApi('/plugin/today', token, { method: 'GET' });
  assert.equal(today.data.todos[0].elapsedSec, 150);
  assert.equal(today.data.todos[0].progressPct, 40);
  await pluginApi('/worklog', token, { body: { todoId: 't1', stepIndex: 0, source: 'premiere' } });
  assert.deepEqual(read('mt_plans', `ed1_${jstYmd()}`).pluginStepsDone, { t1: [0] });
  // 他人の案件には記録できない
  assert.equal((await api('/worklog', { body: { projectId: 'p2', seconds: 10 } })).status, 404);
  assert.equal([...docs.keys()].filter(k => k.startsWith('mt_worklogs/')).length, 2);
});

test('calibration: completed todos and approved budgets feed /plan', async () => {
  for (const [est, act] of [[1800, 2700], [1800, 2100]]) {
    await api('/worklog', { body: { phaseKey: '粗カット', completed: { estimateSec: est, actualSec: act } } });
  }
  seed('mt_projects', 'p1', { name: '密着', editorId: 'ed1', status: 'delivered', fee: 1000, budgetsH: { '粗カット': 30 }, actualSec: { '粗カット': 36 * 3600 } });
  await lineHook([{ type: 'postback', replyToken: 'r', source: { userId: 'Udir' }, postback: { data: 'approve:p1' } }]);
  const ed = read('mt_editors', 'ed1');
  assert.deepEqual(ed.stats.budgets['粗カット'], { budgetSec: 108000, actualSec: 129600, n: 1 });
  claudeReply = { body: { progress: { status: 'on_track', summary: '', gap: '', bottleneck: '' }, todos: [], focusMessage: '' } };
  await api('/plan', { body: {} });
  const req = JSON.parse(calls.filter(c => c.url.startsWith('https://api.anthropic.com')).pop().body);
  const data = JSON.parse(req.messages[0].content.match(/<data>\n([\s\S]*)\n<\/data>/)[1]);
  assert.deepEqual(data.estimateCalibration['粗カット'], { todoRatio: 1.33, samples: 2, budgetRatio: 1.2, projects: 1 });
});

/* ───────── Addness（MCP）───────── */

function installAddness({ sse = false } = {}) {
  const goals = new Map([['11111111-1111-1111-1111-111111111111', { title: '9月：担当案件をすべて締切内に納品', done: false }]]);
  const today = [];
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('https://addness.test/mcp')) return inner(input, init);
    const msg = JSON.parse(init.body);
    calls.push({ url, body: init.body, auth: init.headers.Authorization, session: init.headers['Mcp-Session-Id'] });
    if (init.headers.Authorization !== 'Bearer adt') return new Response('no', { status: 401 });
    if (msg.id === undefined) return new Response(null, { status: 202 });
    let result;
    if (msg.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: {} };
    else if (msg.method === 'tools/call') {
      const { name, arguments: a } = msg.params;
      if (name === 'get_goal') {
        const g = goals.get(a.goal_id);
        result = g ? { content: [{ type: 'text', text: `# [${a.goal_id}] ${g.title}\n理想: 締切を1本も落とさない\n期限: 2026-09-30` }] } : { isError: true, content: [{ type: 'text', text: 'not found' }] };
      } else if (name === 'create_goal') {
        const id = crypto.randomUUID();
        goals.set(id, { title: a.title, parent: a.parent_id, done: false });
        result = { content: [{ type: 'text', text: `作成しました: [${id}] ${a.title}（親 ${a.parent_id}）` }] };
      } else if (name === 'create_today_todo') { today.push(a.objective_id); result = { content: [{ type: 'text', text: 'ok' }] }; }
      else if (name === 'complete_goal') { goals.get(a.goal_id).done = true; result = { content: [{ type: 'text', text: 'ok' }] }; }
    }
    const payload = { jsonrpc: '2.0', id: msg.id, result };
    const headers = { 'mcp-session-id': 'S1' };
    return sse
      ? new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, { headers: { ...headers, 'content-type': 'text/event-stream' } })
      : Response.json(payload, { headers });
  };
  return { goals, today };
}
const envA = () => ({ ...env(), ADDNESS_MCP_URL: 'https://addness.test/mcp' });
async function apiA(path, body) {
  const res = await worker.fetch(new Request('https://w' + path, { method: 'POST', headers: { Authorization: `Bearer ${idToken('ed1', 'ed@example.com')}` }, body: JSON.stringify(body || {}) }), envA());
  return { status: res.status, data: await res.json() };
}

test('addness: connect reads the month goal, token never stored on editor doc', async () => {
  installAddness({ sse: true });
  assert.equal((await apiA('/addness/connect', { goal: 'nope', token: 'adt' })).status, 400);
  assert.equal((await apiA('/addness/connect', { goal: '11111111-1111-1111-1111-111111111111', token: 'bad' })).status, 401);
  const r = await apiA('/addness/connect', { goal: 'https://app.addness.com/goals/11111111-1111-1111-1111-111111111111', token: 'adt' });
  assert.equal(r.status, 200);
  assert.equal(r.data.goal.title, '9月：担当案件をすべて締切内に納品');
  assert.equal(r.data.goal.ideal, '締切を1本も落とさない');
  assert.equal(r.data.goal.due, '2026-09-30');
  assert.equal(read('mt_secrets', 'ed1').addnessToken, 'adt');
  assert.equal(JSON.stringify(read('mt_editors', 'ed1')).includes('adt'), false);
  assert.ok(calls.some(c => c.session === 'S1'));
});

test('addness: sync builds 月ゴール › 案件 › TODO › 手順, adds today todo, completes incrementally', async () => {
  const { goals, today } = installAddness();
  await apiA('/addness/connect', { goal: '11111111-1111-1111-1111-111111111111', token: 'adt' });
  const planId = `ed1_${jstYmd()}`;
  seed('mt_plans', planId, { date: jstYmd(), todos: [
    { id: 't1', title: '福岡ロケ：粗カット', projectId: 'p1', doneWhen: '00が繋がっている', done: false,
      steps: [{ title: 'インポート', seconds: 10, done: true }, { title: '音声同期', seconds: 300, done: false }] },
  ] });
  const r = await apiA('/addness/sync');
  assert.equal(r.status, 200);
  const titles = [...goals.values()].map(g => g.title);
  assert.ok(titles.includes('福岡ロケ'));
  assert.ok(titles.includes('福岡ロケ：粗カット'));
  assert.ok(titles.includes('インポート（10秒）'));
  assert.ok(titles.includes('音声同期（5分）'));
  const ids = read('mt_plans', planId).addnessIds.t1;
  assert.equal(goals.get(ids.goalId).parent, read('mt_projects', 'p1').addnessGoalId);
  assert.equal(goals.get(read('mt_projects', 'p1').addnessGoalId).parent, '11111111-1111-1111-1111-111111111111');
  assert.deepEqual(today, [ids.goalId]);
  assert.equal(goals.get(ids.steps[0]).done, true);
  assert.equal(goals.get(ids.steps[1]).done, false);

  // 2回目：新規作成せず、完了だけ反映
  const before = goals.size;
  const plan = read('mt_plans', planId);
  plan.todos[0].done = true;
  seed('mt_plans', planId, plan);
  await apiA('/addness/sync');
  assert.equal(goals.size, before);
  assert.equal(goals.get(ids.steps[1]).done, true);
  assert.equal(goals.get(ids.goalId).done, true);
});
