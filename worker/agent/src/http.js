export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Plugin-Token',
    'Access-Control-Max-Age': '86400',
  };
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
}

/** 日本時間の日付情報 */
export function jst(date = new Date()) {
  const d = new Date(date.getTime() + 9 * 3600 * 1000);
  const pad = n => String(n).padStart(2, '0');
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
  return {
    year: y, month: m, day,
    ym: `${y}-${pad(m)}`,
    ymd: `${y}-${pad(m)}-${pad(day)}`,
    hm: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    lastDay: new Date(Date.UTC(y, m, 0)).getUTCDate(),
  };
}

export const newId = prefix => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export const clip = (v, n = 1000) => String(v ?? '').slice(0, n);
