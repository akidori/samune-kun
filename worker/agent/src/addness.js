/*
 * Addness 連携（MCP サーバー経由）
 *
 *   Addness の月ゴール（編集者が Addness で設定）
 *     └ 案件ゴール（ものがたりっちの案件ごとに自動作成）
 *         └ 今日のTODO（自動作成し、編集者の「今やるべきToDo」に入れる）
 *             └ 手順（チェックリスト。ものがたりっちでチェックすると Addness でも完了）
 *
 * 使うツールは get_goal / create_goal / create_today_todo / complete_goal のみ。
 */

import { HttpError } from './http.js';

const PROTOCOL_VERSION = '2025-06-18';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function parseGoalId(input) {
  return (String(input || '').match(UUID) || [])[0]?.toLowerCase() || '';
}

export class AddnessClient {
  constructor(url, token) {
    if (!url) throw new HttpError(500, 'ADDNESS_MCP_URL が未設定です');
    if (!token) throw new HttpError(400, 'Addness のトークンが未設定です');
    this.url = url;
    this.token = token;
    this.session = null;
    this.seq = 0;
    this.ready = null;
  }

  async post(message) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${this.token}`,
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        ...(this.session ? { 'Mcp-Session-Id': this.session } : {}),
      },
      body: JSON.stringify(message),
    });
    if (res.status === 401 || res.status === 403) throw new HttpError(401, 'Addness の認証に失敗しました。トークンを確認してください');
    if (!res.ok && res.status !== 202) throw new HttpError(502, `Addness: ${res.status} ${await res.text()}`);
    this.session = res.headers.get('mcp-session-id') || this.session;
    if (message.id === undefined) return null;
    const type = res.headers.get('content-type') || '';
    if (type.includes('text/event-stream')) {
      const body = await res.text();
      for (const line of body.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const msg = JSON.parse(line.slice(5).trim());
          if (msg.id === message.id) return msg;
        } catch { /* keep scanning */ }
      }
      throw new HttpError(502, 'Addness の応答を読み取れませんでした');
    }
    return res.json();
  }

  async rpc(method, params) {
    const msg = await this.post({ jsonrpc: '2.0', id: ++this.seq, method, params });
    if (msg.error) throw new HttpError(502, `Addness: ${msg.error.message || JSON.stringify(msg.error)}`);
    return msg.result;
  }

  init() {
    this.ready ||= (async () => {
      await this.rpc('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'monogataricchi', version: '0.1.0' } });
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    })();
    return this.ready;
  }

  /** @returns {Promise<{text: string, data: any}>} */
  async tool(name, args) {
    await this.init();
    const result = await this.rpc('tools/call', { name, arguments: args });
    const text = (result.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (result.isError) throw new HttpError(502, `Addness（${name}）: ${text.slice(0, 300)}`);
    return { text, data: result.structuredContent || null };
  }

  async getGoal(goalId) {
    const { text, data } = await this.tool('get_goal', { goal_id: goalId, include_body: false });
    return { ...parseGoalText(text), ...pickGoal(data), raw: text.slice(0, 2000) };
  }

  /** @returns {Promise<string>} 作成したゴールの UUID */
  async createGoal({ title, parentId, dod, due, status }) {
    const { text, data } = await this.tool('create_goal', {
      title: String(title).slice(0, 128),
      parent_id: parentId,
      ...(dod ? { definition_of_done: dod } : {}),
      ...(due ? { due_date: due } : {}),
      ...(status ? { status } : {}),
    });
    const id = data?.id || data?.goal?.id || (text.match(UUID) || []).map(s => s.toLowerCase()).find(u => u !== parentId);
    if (!id) throw new HttpError(502, 'Addness でゴールを作れませんでした');
    return id;
  }

  addToToday(goalId) { return this.tool('create_today_todo', { objective_id: goalId }); }
  complete(goalId) { return this.tool('complete_goal', { goal_id: goalId }); }
}

function pickGoal(data) {
  const g = data?.goal || data;
  if (!g || typeof g !== 'object') return {};
  return Object.fromEntries(Object.entries({
    title: g.title, ideal: g.definitionOfDone || g.definition_of_done, due: g.dueDate || g.due_date,
  }).filter(([, v]) => v));
}

/** get_goal のテキスト応答から、タイトル・理想・期限を拾う（構造化データが無い場合の予備） */
export function parseGoalText(text) {
  const lines = String(text).split('\n').map(l => l.trim()).filter(Boolean);
  const field = re => lines.find(l => re.test(l))?.replace(re, '').trim() || '';
  const title = field(/^[#\-*\s]*(タイトル|title)\s*[:：]\s*/i)
    || (lines[0] || '').replace(/^#+\s*/, '').replace(/\[[^\]]*\]\s*/g, '').trim();
  const ideal = field(/^[#\-*\s]*(理想|definition of done)\s*[:：]\s*/i);
  const due = (field(/^[#\-*\s]*(期限|due)\s*[:：]\s*/i).match(/\d{4}-\d{2}-\d{2}/) || [])[0] || '';
  return { title, ideal, due };
}

const fmtSec = s => (s < 60 ? `${s}秒` : `${Math.round(s / 60)}分`);

/**
 * 今日のプランを Addness に反映する。作ったゴールの ID は ids に入れて返す（次回は差分だけ反映）。
 * ids: { [todoId]: { goalId, steps: [goalId], doneSteps: [index], done: bool } }
 */
export async function syncPlanToAddness({ client, monthGoalId, plan, projects, ids = {}, today, ensureProjectGoal }) {
  const out = { ...ids };
  for (const todo of plan.todos || []) {
    let entry = out[todo.id];
    if (!entry) {
      const project = projects.find(p => p.id === todo.projectId);
      const parentId = project ? await ensureProjectGoal(project) : monthGoalId;
      const goalId = await client.createGoal({ title: todo.title, parentId, dod: todo.doneWhen, due: today, status: 'IN_PROGRESS' });
      const steps = [];
      for (const st of todo.steps || []) {
        steps.push(await client.createGoal({ title: `${st.title}（${fmtSec(Number(st.seconds) || 0)}）`, parentId: goalId }));
      }
      await client.addToToday(goalId).catch(() => {}); // 入れられない時もゴール自体は作れている
      entry = out[todo.id] = { goalId, steps, doneSteps: [], done: false };
    }
    const doneSteps = new Set(entry.doneSteps);
    for (const [i, st] of (todo.steps || []).entries()) {
      if ((st.done || todo.done) && entry.steps[i] && !doneSteps.has(i)) {
        await client.complete(entry.steps[i]);
        doneSteps.add(i);
      }
    }
    entry.doneSteps = [...doneSteps].sort((a, b) => a - b);
    if (todo.done && !entry.done) {
      await client.complete(entry.goalId);
      entry.done = true;
    }
  }
  return out;
}
