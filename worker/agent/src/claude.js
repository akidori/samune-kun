/* Claude 呼び出し（構造化出力） */

import Anthropic from '@anthropic-ai/sdk';
import { HttpError } from './http.js';
import { PLAN_SYSTEM, PLAN_SCHEMA, ASK_SYSTEM, ASK_SCHEMA, REPLAN_SYSTEM, REPLAN_SCHEMA } from './prompts.js';

const MODEL = 'claude-opus-5-5';

async function structuredCall(env, { system, schema, content, effort = 'medium' }) {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(500, 'ANTHROPIC_API_KEY が未設定です');
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort, format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content }],
  });
  if (response.stop_reason === 'refusal') {
    throw new HttpError(422, 'AIがこの内容には回答できませんでした。ディレクターに直接相談してください。');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new HttpError(502, 'AIの応答が途中で切れました。もう一度お試しください。');
  }
  const out = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  try {
    return JSON.parse(out);
  } catch {
    throw new HttpError(502, 'AIの応答を読み取れませんでした。もう一度お試しください。');
  }
}

const asData = (label, data) => `${label}\n\n<data>\n${JSON.stringify(data, null, 2)}\n</data>`;

export const planToday = (env, context) => structuredCall(env, {
  system: PLAN_SYSTEM,
  schema: PLAN_SCHEMA,
  content: asData('以下のデータから、今月のゴールに対する現在地を整理し、今日やるべきTODOと時間割を提案してください。', context),
});

export const answerQuestion = (env, context) => structuredCall(env, {
  system: ASK_SYSTEM,
  schema: ASK_SCHEMA,
  content: asData('編集者からの相談です。', context),
});

export const replanFromDelay = (env, context) => structuredCall(env, {
  system: REPLAN_SYSTEM,
  schema: REPLAN_SCHEMA,
  content: asData('作業中のTODOが見積もりを超えました。巻き返しの時間割を作ってください。', context),
});
