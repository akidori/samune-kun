/* LINE Messaging API */

import { HttpError } from './http.js';

const API = 'https://api.line.me/v2/bot/message';

async function call(env, path, body) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) throw new HttpError(500, 'LINE_CHANNEL_ACCESS_TOKEN が未設定です');
  const res = await fetch(`${API}/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      ...(path === 'push' ? { 'X-Line-Retry-Key': crypto.randomUUID() } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new HttpError(502, `LINE送信に失敗しました（${res.status}）: ${await res.text()}`);
  const data = await res.json().catch(() => ({}));
  return (data.sentMessages || []).map(m => m.id);
}

/** @returns {Promise<string[]>} 送信したメッセージID（引用返信の突き合わせに使う） */
export function pushToDirector(env, messages) {
  if (!env.DIRECTOR_LINE_USER_ID) throw new HttpError(500, 'DIRECTOR_LINE_USER_ID が未設定です');
  return call(env, 'push', { to: env.DIRECTOR_LINE_USER_ID, messages });
}

export function reply(env, replyToken, messages) {
  if (!replyToken) return Promise.resolve([]);
  return call(env, 'reply', { replyToken, messages: Array.isArray(messages) ? messages : [text(messages)] });
}

export const text = t => ({ type: 'text', text: String(t).slice(0, 4900) });

export function approvalButtons(projectId, summary) {
  return {
    type: 'template',
    altText: `納品確認：${summary}`.slice(0, 400),
    template: {
      type: 'buttons',
      text: summary.slice(0, 160),
      actions: [
        { type: 'postback', label: '✅ OK（納品完了）', data: `approve:${projectId}`, displayText: 'OK（納品完了）' },
        { type: 'postback', label: '↩️ 差し戻し', data: `reject:${projectId}`, displayText: '差し戻し' },
      ],
    },
  };
}

export async function verifySignature(body, signature, secret) {
  if (!signature || !secret) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
