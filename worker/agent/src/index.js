/**
 * ものがたりっち AIエージェント Worker
 *
 * 編集者向け（Authorization: Bearer <Firebase IDトークン>）
 *   GET  /me              ログイン中のユーザーと役割
 *   POST /addness/connect Addness の月ゴールとトークンを登録（月ゴールは Addness で設定する）
 *   POST /addness/sync    今日のTODO・手順を Addness に反映（案件ゴール › TODO › 手順）
 *   POST /plan            現在地の整理＋今日のTODO＋時間割
 *   POST /replan          見積もり超過時：進捗%から巻き返しの時間割を引き直す
 *   POST /ask             詰まりを言語化した相談 → AIの一次回答（相談として保存）
 *   POST /escalate        相談をディレクターのLINEへ送る
 *   POST /delivery        納品報告 → ディレクターのLINEに［OK］［差し戻し］
 *   POST /worklog         作業時間・進捗の記録（Web のタイマー／Premiere パネル共通）
 *   POST /plugin/token    Premiere パネル用の連携コードを発行
 * Premiere パネル（X-Plugin-Token: <連携コード>）
 *   GET  /plugin/today    今日のTODO・手順・砂時計の情報
 *   POST /worklog         （同上）
 * ディレクター向け
 *   POST /invoices/issue  指定月の請求書を確定してドライブに保存（通常は月末のcronで自動）
 * LINE
 *   POST /line/webhook    リプライ＝相談への回答・差し戻し理由／postback＝納品の承認・差し戻し
 *
 * 設定は README.md を参照。
 */
import { AddnessClient, parseGoalId, syncPlanToAddness } from './addness.js';
import { answerQuestion, planToday, replanFromDelay } from './claude.js';
import { Firestore, verifyFirebaseIdToken } from './google.js';
import { HttpError, clip, corsHeaders, jst, json, newId } from './http.js';
import { addInvoiceLine, issueMonth } from './invoice.js';
import { approvalButtons, pushToDirector, reply, text, verifySignature } from './line.js';

const C = {
  editors: 'mt_editors',
  projects: 'mt_projects',
  goals: 'mt_goals',
  plans: 'mt_plans',
  questions: 'mt_questions',
  lineMessages: 'mt_line_messages',
  meta: 'mt_meta',
  worklogs: 'mt_worklogs',
  secrets: 'mt_secrets',
  pluginTokens: 'mt_plugin_tokens',
};

/** 工程タグ：時間予算・実績・補正係数はこの単位で持つ */
export const PHASE_KEYS = ['素材準備', '粗カット', '本編集', 'テロップ', '修正', '書き出し', 'その他'];
const phaseKeyOf = k => (PHASE_KEYS.includes(k) ? k : 'その他');

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/line/webhook' && request.method === 'POST') return await lineWebhook(request, env);
      if (pathname === '/health') return json(health(env), 200, cors);

      const route = ROUTES[`${request.method} ${pathname}`];
      if (!route) return json({ error: 'not found' }, 404, cors);
      const user = await authenticate(request, env);
      const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
      return json(await route({ user, body, env, fs: new Firestore(env) }), 200, cors);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      return json({ error: e.message || String(e) }, e instanceof HttpError ? e.status : 500, cors);
    }
  },

  // 毎月最終日の夜（JST 23:00 頃）に請求書を確定する。wrangler.toml の crons で 28〜31日に起動し、最終日だけ実行
  async scheduled(event, env, ctx) {
    const now = jst(new Date(event.scheduledTime));
    if (now.day !== now.lastDay) return;
    ctx.waitUntil(issueMonth(new Firestore(env), env, now.ym));
  },
};

function health(env) {
  return {
    ok: true,
    claude: Boolean(env.ANTHROPIC_API_KEY),
    firestore: Boolean(env.GOOGLE_SERVICE_ACCOUNT_JSON && env.FIREBASE_PROJECT_ID),
    line: Boolean(env.LINE_CHANNEL_ACCESS_TOKEN && env.DIRECTOR_LINE_USER_ID),
    drive: Boolean(env.GOOGLE_OAUTH_REFRESH_TOKEN),
    addness: Boolean(env.ADDNESS_MCP_URL),
  };
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function authenticate(request, env) {
  const pluginToken = request.headers.get('x-plugin-token');
  if (pluginToken) {
    const fs = new Firestore(env);
    const hash = await sha256(pluginToken.trim());
    const rec = await fs.get(C.pluginTokens, hash);
    const editor = rec && await fs.get(C.editors, rec.data.uid);
    if (!rec || editor?.data.pluginTokenHash !== hash) throw new HttpError(401, '連携コードが無効です。ホームの設定から新しいコードを発行してください');
    return { uid: rec.data.uid, email: editor.data.email || '', name: editor.data.name || '', role: 'editor', via: 'plugin' };
  }
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const user = await verifyFirebaseIdToken(token, env.FIREBASE_PROJECT_ID);
  const directors = (env.DIRECTOR_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return { ...user, role: directors.includes(user.email.toLowerCase()) ? 'director' : 'editor' };
}

const requireDirector = user => { if (user.role !== 'director') throw new HttpError(403, 'ディレクターのみ実行できます'); };

async function editorContext(fs, uid) {
  const now = jst();
  const [editor, goal, projects] = await Promise.all([
    fs.get(C.editors, uid),
    fs.get(C.goals, `${uid}_${now.ym}`),
    fs.where(C.projects, { editorId: uid }),
  ]);
  return {
    now,
    editor: editor?.data || {},
    // 月ゴールは Addness で設定したものを使う（未連携なら mt_goals）
    goal: editor?.data.addnessGoal || goal?.data || null,
    projects: projects
      .map(p => ({ id: p.id, ...p.data }))
      .filter(p => p.status !== 'archived')
      .map(p => ({
        id: p.id, name: p.name, channel: p.channelName || '', phase: p.phase, status: p.status,
        deadline: p.deadline, fee: p.fee, nextAction: p.nextAction || '', rejectReason: p.rejectReason || '',
        approvedAt: p.approvedAt || '',
        budgetsH: p.budgetsH || {}, actualSec: p.actualSec || {},
      })),
  };
}

/** 編集者の過去実績から、工程ごとの「見積もり→実績」の補正係数を出す */
function calibration(editor) {
  const out = {};
  for (const [k, v] of Object.entries(editor.stats?.todos || {})) {
    if (v.n >= 2 && v.estSec > 0) out[k] = { todoRatio: Math.round(v.actSec / v.estSec * 100) / 100, samples: v.n };
  }
  for (const [k, v] of Object.entries(editor.stats?.budgets || {})) {
    if (v.n >= 1 && v.budgetSec > 0) out[k] = { ...(out[k] || {}), budgetRatio: Math.round(v.actualSec / v.budgetSec * 100) / 100, projects: v.n };
  }
  return out;
}

const ROUTES = {
  'GET /me': async ({ user }) => user,

  'POST /plan': async ({ user, body, fs, env }) => {
    const ctx = await editorContext(fs, user.uid);
    const monthProjects = ctx.projects;
    const approvedThisMonth = monthProjects.filter(p => p.status === 'approved' && (p.approvedAt || '').startsWith(ctx.now.ym));
    return planToday(env, {
      now: `${ctx.now.ymd} ${ctx.now.hm}`,
      daysLeftInMonth: ctx.now.lastDay - ctx.now.day + 1,
      workHours: body.workHours || ctx.editor.workHours || { start: '10:00', end: '19:00' },
      fixedEvents: (body.fixedEvents || []).slice(0, 20),
      goal: ctx.goal,
      progress: {
        deliveredApproved: approvedThisMonth.length,
        approvedRevenue: approvedThisMonth.reduce((s, p) => s + (Number(p.fee) || 0), 0),
      },
      projects: monthProjects.filter(p => p.status !== 'approved'),
      phaseKeys: PHASE_KEYS,
      estimateCalibration: calibration(ctx.editor),
      leftoversFromYesterday: (body.leftovers || []).slice(0, 20).map(t => clip(t, 200)),
    });
  },

  'POST /replan': async ({ user, body, fs, env }) => {
    const ctx = await editorContext(fs, user.uid);
    const cleanTodo = t => ({
      id: clip(t?.id, 60), title: clip(t?.title, 200), projectId: clip(t?.projectId, 100), phaseKey: phaseKeyOf(t?.phaseKey),
      minutes: Number(t?.minutes) || 0, start: clip(t?.start, 5), end: clip(t?.end, 5),
      why: clip(t?.why, 300), doneWhen: clip(t?.doneWhen, 300),
      steps: (Array.isArray(t?.steps) ? t.steps : []).slice(0, 40).map(s => ({ title: clip(s.title, 200), seconds: Number(s.seconds) || 0, done: Boolean(s.done) })),
    });
    return replanFromDelay(env, {
      now: `${ctx.now.ymd} ${ctx.now.hm}`,
      workEnd: clip(body.workEnd || ctx.editor.workHours?.end || '19:00', 5),
      goal: ctx.goal,
      delayed: {
        ...cleanTodo(body.todo),
        elapsedMin: Number(body.todo?.elapsedMin) || 0,
        progressPct: Math.max(0, Math.min(100, Number(body.progressPct) || 0)),
        note: clip(body.note, 500),
      },
      estimateCalibration: calibration(ctx.editor),
      remainingToday: (Array.isArray(body.remaining) ? body.remaining : []).slice(0, 20).map(cleanTodo),
      projects: ctx.projects.filter(p => p.status !== 'approved'),
    });
  },

  'POST /addness/connect': async ({ user, body, fs, env }) => {
    const goalId = parseGoalId(body.goal);
    if (!goalId) throw new HttpError(400, 'Addness の月ゴールのURLかIDを入力してください');
    const token = clip(body.token, 500).trim();
    const secret = (await fs.get(C.secrets, user.uid))?.data || {};
    const client = new AddnessClient(env.ADDNESS_MCP_URL, token || secret.addnessToken);
    const g = await client.getGoal(goalId);
    if (token) await fs.set(C.secrets, user.uid, { ...secret, addnessToken: token, updatedAt: new Date().toISOString() }, { merge: false });
    const addnessGoal = { goalId, title: g.title, ideal: g.ideal, due: g.due, detail: g.raw, url: /^https?:/.test(body.goal) ? clip(body.goal, 300) : '', syncedAt: new Date().toISOString() };
    await fs.update(C.editors, user.uid, cur => ({ ...(cur || { name: user.name, email: user.email }), addnessGoal }));
    return { goal: addnessGoal };
  },

  'POST /addness/sync': async ({ user, fs, env }) => {
    const now = jst();
    const editor = (await fs.get(C.editors, user.uid))?.data || {};
    const token = (await fs.get(C.secrets, user.uid))?.data?.addnessToken;
    if (!editor.addnessGoal?.goalId || !token) return { skipped: 'Addness 未連携' };
    const planId = `${user.uid}_${now.ymd}`;
    const planDoc = await fs.get(C.plans, planId);
    if (!planDoc) return { skipped: '今日のプランがありません' };
    const client = new AddnessClient(env.ADDNESS_MCP_URL, token);
    const projects = (await fs.where(C.projects, { editorId: user.uid })).map(p => ({ id: p.id, ...p.data }));
    const ensureProjectGoal = async project => {
      if (project.addnessGoalId) return project.addnessGoalId;
      const id = await client.createGoal({
        title: project.name, parentId: editor.addnessGoal.goalId, due: project.deadline,
        dod: `「${project.name}」をディレクターのOKまで持っていき、納品完了している`, status: 'IN_PROGRESS',
      });
      await fs.update(C.projects, project.id, cur => ({ ...cur, addnessGoalId: id }));
      project.addnessGoalId = id;
      return id;
    };
    const ids = await syncPlanToAddness({
      client, monthGoalId: editor.addnessGoal.goalId, plan: planDoc.data, projects,
      ids: planDoc.data.addnessIds || {}, today: now.ymd, ensureProjectGoal,
    });
    await fs.update(C.plans, planId, cur => cur && { ...cur, addnessIds: ids, addnessSyncedAt: new Date().toISOString() });
    return { synced: Object.keys(ids).length };
  },

  'POST /plugin/token': async ({ user, fs }) => {
    if (user.via === 'plugin') throw new HttpError(403, 'ホーム画面から発行してください');
    const token = [...crypto.getRandomValues(new Uint8Array(18))].map(b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('').replace(/(.{6})(?!$)/g, '$1-');
    const hash = await sha256(token);
    await fs.set(C.pluginTokens, hash, { uid: user.uid, createdAt: new Date().toISOString() }, { merge: false });
    await fs.update(C.editors, user.uid, cur => ({ ...(cur || { name: user.name, email: user.email }), pluginTokenHash: hash }));
    return { token };
  },

  'GET /plugin/today': async ({ user, fs }) => {
    const ctx = await editorContext(fs, user.uid);
    const plan = (await fs.get(C.plans, `${user.uid}_${ctx.now.ymd}`))?.data || null;
    return {
      now: ctx.now.hm,
      date: ctx.now.ymd,
      editorName: ctx.editor.name || user.name,
      workHours: ctx.editor.workHours || { start: '10:00', end: '19:00' },
      goal: ctx.goal ? { title: ctx.goal.title || '', ideal: ctx.goal.ideal || '' } : null,
      todos: (plan?.todos || []).map(t => ({
        id: t.id, title: t.title, projectId: t.projectId, phaseKey: t.phaseKey || 'その他', minutes: t.minutes,
        start: t.start, end: t.end, done: Boolean(t.done),
        steps: (t.steps || []).map((st, i) => ({ ...st, done: Boolean(st.done) || (plan.pluginStepsDone?.[t.id] || []).includes(i) })),
        elapsedSec: Math.round((t.elapsedSec || 0) + (plan.pluginSec?.[t.id] || 0)),
        progressPct: plan.todoProgress?.[t.id]?.pct ?? null,
      })),
      projects: ctx.projects.filter(p => p.status !== 'approved').map(p => ({ id: p.id, name: p.name, phase: p.phase, budgetsH: p.budgetsH, actualSec: p.actualSec })),
    };
  },

  'POST /worklog': async ({ user, body, fs }) => {
    const now = jst();
    const seconds = Math.max(0, Math.min(Number(body.seconds) || 0, 900));
    const phaseKey = phaseKeyOf(body.phaseKey);
    const source = body.source === 'premiere' ? 'premiere' : 'web';
    const todoId = clip(body.todoId, 60);
    const result = {};

    if (body.projectId && seconds) {
      const pid = clip(body.projectId, 100);
      const p = await fs.get(C.projects, pid);
      if (!p || p.data.editorId !== user.uid) throw new HttpError(404, '案件が見つかりません');
      const saved = await fs.update(C.projects, pid, cur => {
        const actualSec = { ...(cur.actualSec || {}) };
        actualSec[phaseKey] = (actualSec[phaseKey] || 0) + seconds;
        const budgetSec = (Number(cur.budgetsH?.[phaseKey]) || 0) * 3600;
        const overruns = { ...(cur.overruns || {}) };
        // 予算を超えた瞬間を記録（次回の見積もりに使う）
        if (budgetSec && actualSec[phaseKey] > budgetSec && !overruns[phaseKey]) {
          overruns[phaseKey] = { budgetH: cur.budgetsH[phaseKey], exceededAt: new Date().toISOString() };
        }
        return { ...cur, actualSec, overruns, lastWorkedAt: new Date().toISOString() };
      });
      result.actualSec = saved.data.actualSec;
      result.overrun = Boolean(saved.data.overruns?.[phaseKey]);
      await fs.set(C.worklogs, newId('w'), {
        editorId: user.uid, projectId: pid, todoId, phaseKey, seconds, source, date: now.ymd, at: new Date().toISOString(),
      }, { merge: false });
    }

    // Premiere パネルで計測した時間・進捗は、今日のプランに別フィールドで積む（Web 側の保存と衝突しない）
    const stepDone = Number.isInteger(body.stepIndex) ? body.stepIndex : null;
    if (todoId && (source === 'premiere' || body.progressPct !== undefined || stepDone !== null)) {
      await fs.update(C.plans, `${user.uid}_${now.ymd}`, cur => {
        if (!cur) return null;
        const next = { ...cur };
        if (source === 'premiere' && seconds) {
          next.pluginSec = { ...(cur.pluginSec || {}), [todoId]: (cur.pluginSec?.[todoId] || 0) + seconds };
          next.lastPluginAt = new Date().toISOString();
        }
        if (stepDone !== null && stepDone >= 0 && stepDone < 100) {
          const done = new Set(cur.pluginStepsDone?.[todoId] || []);
          done.add(stepDone);
          next.pluginStepsDone = { ...(cur.pluginStepsDone || {}), [todoId]: [...done].sort((a, b) => a - b) };
        }
        if (body.progressPct !== undefined) {
          next.todoProgress = { ...(cur.todoProgress || {}), [todoId]: { pct: Math.max(0, Math.min(100, Number(body.progressPct) || 0)), note: clip(body.note, 300), at: new Date().toISOString(), source } };
        }
        return next;
      });
    }

    // TODO完了時：見積もりと実績の差を編集者の実績データに積む（補正係数の学習）
    if (body.completed && Number(body.completed.estimateSec) > 0) {
      await fs.update(C.editors, user.uid, cur => {
        const base = cur || { name: user.name, email: user.email };
        const todos = { ...(base.stats?.todos || {}) };
        const s = todos[phaseKey] || { estSec: 0, actSec: 0, n: 0 };
        todos[phaseKey] = { estSec: s.estSec + Number(body.completed.estimateSec), actSec: s.actSec + Math.max(0, Number(body.completed.actualSec) || 0), n: s.n + 1 };
        return { ...base, stats: { ...(base.stats || {}), todos } };
      });
    }
    return { ok: true, ...result };
  },

  'POST /ask': async ({ user, body, fs, env }) => {
    const ctx = await editorContext(fs, user.uid);
    const q = {
      editorId: user.uid,
      editorName: ctx.editor.name || user.name,
      todo: clip(body.todo?.title, 200),
      projectId: clip(body.todo?.projectId, 100),
      estimateMin: Number(body.todo?.minutes) || 0,
      elapsedMin: Number(body.todo?.elapsedMin) || 0,
      stuckPoint: clip(body.stuckPoint),
      tried: clip(body.tried),
      needToKnow: clip(body.needToKnow),
    };
    const project = ctx.projects.find(p => p.id === q.projectId) || null;
    const ai = await answerQuestion(env, { goal: [ctx.goal?.title, ctx.goal?.ideal].filter(Boolean).join(' / '), project, question: q });
    const id = newId('q');
    await fs.set(C.questions, id, { ...q, ai, status: 'ai', createdAt: new Date().toISOString() }, { merge: false, exists: false });
    return { id, ...ai };
  },

  'POST /escalate': async ({ user, body, fs, env }) => {
    const doc = await fs.get(C.questions, clip(body.questionId, 100));
    if (!doc || doc.data.editorId !== user.uid) throw new HttpError(404, '相談が見つかりません');
    const q = doc.data;
    const message = clip(body.message || q.ai?.directorMessage, 1500);
    const goal = (await editorContext(fs, user.uid)).goal;
    const lines = [
      `🙋 ${q.editorName || '編集者'}さんから相談`,
      (goal?.title || goal?.ideal) && `🎯 今月：${goal.title || goal.ideal}`,
      q.todo && `📝 ${q.todo}${q.estimateMin ? `（見積${q.estimateMin}分→経過${q.elapsedMin}分）` : ''}`,
      '',
      message,
      q.ai?.answer && `\n🤖 AIの一次回答（参考）\n${clip(q.ai.answer, 400)}`,
      '',
      '↩️ このメッセージを長押し→「リプライ」で返信すると、編集者のホームに回答が届きます。',
      env.APP_URL && `🔗 ${env.APP_URL}`,
      `#${doc.id}`,
    ].filter(v => typeof v === 'string');
    const ids = await pushToDirector(env, [text(lines.join('\n').replace(/\n{3,}/g, '\n\n'))]);
    await Promise.all([
      ...ids.map(mid => fs.set(C.lineMessages, mid, { kind: 'question', id: doc.id }, { merge: false })),
      fs.set(C.meta, 'latestQuestion', { id: doc.id }, { merge: false }),
      fs.set(C.questions, doc.id, { status: 'sent', message, sentAt: new Date().toISOString() }),
    ]);
    return { id: doc.id, status: 'sent' };
  },

  'POST /delivery': async ({ user, body, fs, env }) => {
    const pid = clip(body.projectId, 100);
    const doc = await fs.get(C.projects, pid);
    if (!doc || doc.data.editorId !== user.uid) throw new HttpError(404, '案件が見つかりません');
    if (doc.data.status === 'approved') throw new HttpError(409, 'この案件はすでに納品完了です');
    const p = doc.data;
    const note = clip(body.note, 800);
    const url = clip(body.url, 500);
    const editorName = (await fs.get(C.editors, user.uid))?.data.name || user.name;
    const summary = `📦 ${editorName}さんが納品報告\n「${p.name}」\n編集費 ¥${Number(p.fee || 0).toLocaleString('ja-JP')}（税抜）`;
    const detail = [
      `📦 納品報告：${p.name}`,
      p.channelName && `チャンネル：${p.channelName}`,
      url && `🔗 ${url}`,
      note && `\n${note}`,
      '\n↩️ 修正点はこのメッセージにリプライすると編集者に届きます。',
      `#${pid}`,
    ].filter(Boolean).join('\n');
    const ids = await pushToDirector(env, [text(detail), approvalButtons(pid, summary)]);
    await Promise.all([
      ...ids.map(mid => fs.set(C.lineMessages, mid, { kind: 'delivery', id: pid }, { merge: false })),
      fs.set(C.projects, pid, { status: 'delivered', deliveredAt: new Date().toISOString(), deliveryNote: note, deliveryUrl: url, rejectReason: '' }),
    ]);
    return { projectId: pid, status: 'delivered' };
  },

  'POST /invoices/issue': async ({ user, body, fs, env }) => {
    requireDirector(user);
    const ym = /^\d{4}-\d{2}$/.test(body.month || '') ? body.month : jst().ym;
    return { issued: await issueMonth(fs, env, ym, { editorId: body.editorId }) };
  },
};

/* ═════════════ LINE Webhook ═════════════ */

async function lineWebhook(request, env) {
  const raw = await request.text();
  if (!(await verifySignature(raw, request.headers.get('x-line-signature'), env.LINE_CHANNEL_SECRET))) {
    return new Response('invalid signature', { status: 401 });
  }
  const fs = new Firestore(env);
  const events = JSON.parse(raw || '{}').events || [];
  for (const ev of events) {
    try {
      await handleLineEvent(ev, fs, env);
    } catch (e) {
      console.error('line event failed', e);
      await reply(env, ev.replyToken, `⚠️ 処理に失敗しました：${e.message}`).catch(() => {});
    }
  }
  return new Response('ok');
}

async function handleLineEvent(ev, fs, env) {
  const userId = ev.source?.userId;

  // 初期設定用：「ID」と送ると自分の userId を返す（DIRECTOR_LINE_USER_ID に設定する）
  if (ev.type === 'message' && ev.message?.type === 'text' && /^\s*(id|ＩＤ|ｉｄ)\s*$/i.test(ev.message.text)) {
    await reply(env, ev.replyToken, `あなたのLINE userId：\n${userId}\n\nWorkerの DIRECTOR_LINE_USER_ID に設定してください。`);
    return;
  }
  if (!userId || userId !== env.DIRECTOR_LINE_USER_ID) return;

  if (ev.type === 'postback') {
    const [action, pid] = String(ev.postback?.data || '').split(':');
    if (action === 'approve') return approveDelivery(fs, env, pid, ev.replyToken);
    if (action === 'reject') return rejectDelivery(fs, env, pid, ev.replyToken);
    return;
  }
  if (ev.type !== 'message' || ev.message?.type !== 'text') return;

  const bodyText = ev.message.text.trim();
  let target = null;
  if (ev.message.quotedMessageId) target = (await fs.get(C.lineMessages, ev.message.quotedMessageId))?.data || null;
  if (!target) {
    const tag = bodyText.match(/#(q_[a-z0-9]+)/)?.[1];
    if (tag) target = { kind: 'question', id: tag };
  }
  if (!target) {
    const latest = (await fs.get(C.meta, 'latestQuestion'))?.data?.id;
    if (latest) target = { kind: 'question', id: latest };
  }
  if (!target) {
    await reply(env, ev.replyToken, '返信先が分かりませんでした。相談や納品のメッセージを長押し→「リプライ」で返信してください。');
    return;
  }
  const answer = bodyText.replace(/#[A-Za-z0-9_-]+/g, '').trim();
  const now = new Date().toISOString();

  if (target.kind === 'question') {
    const q = await fs.update(C.questions, target.id, cur => cur && {
      ...cur,
      status: 'answered',
      answer: cur.answer ? `${cur.answer}\n\n${answer}` : answer,
      answeredAt: now,
    });
    if (!q) return reply(env, ev.replyToken, '相談が見つかりませんでした。');
    return reply(env, ev.replyToken, `✅ ${q.data.editorName || '編集者'}さんに回答を届けました`);
  }
  if (target.kind === 'reject' || target.kind === 'delivery') {
    const field = target.kind === 'reject' ? { rejectReason: answer, status: 'rejected' } : { directorComment: answer };
    const p = await fs.get(C.projects, target.id);
    if (!p) return reply(env, ev.replyToken, '案件が見つかりませんでした。');
    await fs.set(C.projects, target.id, { ...field, directorCommentAt: now });
    return reply(env, ev.replyToken, `✅ 「${p.data.name}」へのコメントを編集者に届けました`);
  }
}

async function approveDelivery(fs, env, pid, replyToken) {
  const doc = await fs.get(C.projects, pid);
  if (!doc) return reply(env, replyToken, '案件が見つかりませんでした。');
  if (doc.data.status === 'approved') return reply(env, replyToken, `「${doc.data.name}」はすでに納品完了です。`);
  const approvedAt = new Date();
  await fs.set(C.projects, pid, { status: 'approved', phase: '公開', approvedAt: approvedAt.toISOString(), rejectReason: '' });
  const inv = await addInvoiceLine(fs, { id: pid, ...doc.data }, approvedAt);
  await recordBudgetResult(fs, doc.data);
  // Addness の案件ゴールも完了にする（未完了の子が残っていれば Addness 側で弾かれるので、その時はそのまま）
  const token = doc.data.addnessGoalId && (await fs.get(C.secrets, doc.data.editorId))?.data?.addnessToken;
  if (token) await new AddnessClient(env.ADDNESS_MCP_URL, token).complete(doc.data.addnessGoalId).catch(() => {});
  const total = Number(inv.total || 0).toLocaleString('ja-JP');
  return reply(env, replyToken, `✅ 「${doc.data.name}」を納品完了にしました。\n${inv.month} の請求明細に追加（${inv.lines?.length || 0}件・税込 ¥${total}）`);
}

async function rejectDelivery(fs, env, pid, replyToken) {
  const doc = await fs.get(C.projects, pid);
  if (!doc) return reply(env, replyToken, '案件が見つかりませんでした。');
  if (doc.data.status === 'approved') return reply(env, replyToken, `「${doc.data.name}」はすでに納品完了です。`);
  await fs.set(C.projects, pid, { status: 'rejected', rejectedAt: new Date().toISOString() });
  const ids = await reply(env, replyToken, [text(`↩️ 「${doc.data.name}」を差し戻しにしました。\n修正してほしい点を、このメッセージにリプライしてください。`)]);
  await Promise.all(ids.map(mid => fs.set(C.lineMessages, mid, { kind: 'reject', id: pid }, { merge: false })));
}

/** 納品完了時：工程ごとの予算と実績を編集者の実績データに積む（次回の予算提案・見積もり補正に使う） */
async function recordBudgetResult(fs, project) {
  const budgets = Object.entries(project.budgetsH || {}).filter(([, h]) => Number(h) > 0);
  if (!budgets.length || !project.editorId) return;
  await fs.update(C.editors, project.editorId, cur => {
    const base = cur || {};
    const stats = { ...(base.stats || {}) };
    const b = { ...(stats.budgets || {}) };
    for (const [k, h] of budgets) {
      const s = b[k] || { budgetSec: 0, actualSec: 0, n: 0 };
      b[k] = { budgetSec: s.budgetSec + Number(h) * 3600, actualSec: s.actualSec + (project.actualSec?.[k] || 0), n: s.n + 1 };
    }
    return { ...base, stats: { ...stats, budgets: b } };
  });
}
