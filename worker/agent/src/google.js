/* Google 連携：Firebase IDトークン検証 / Firestore REST（サービスアカウント）/ Drive（OAuthリフレッシュトークン） */

import { HttpError } from './http.js';

const b64url = {
  encode(bytes) {
    const bin = typeof bytes === 'string' ? bytes : String.fromCharCode(...new Uint8Array(bytes));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decodeToString(s) {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    return decodeURIComponent(escape(bin));
  },
  decodeToBytes(s) {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    return Uint8Array.from(bin, c => c.charCodeAt(0));
  },
};
const utf8b64url = str => b64url.encode(String.fromCharCode(...new TextEncoder().encode(str)));

/* ───────── Firebase ID トークン検証 ───────── */

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let jwksCache = { keys: null, exp: 0 };

async function firebaseJwks() {
  if (jwksCache.keys && Date.now() < jwksCache.exp) return jwksCache.keys;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new HttpError(503, 'Firebase公開鍵の取得に失敗しました');
  const maxAge = Number((res.headers.get('cache-control') || '').match(/max-age=(\d+)/)?.[1] || 3600);
  jwksCache = { keys: (await res.json()).keys, exp: Date.now() + maxAge * 1000 };
  return jwksCache.keys;
}

export async function verifyFirebaseIdToken(token, projectId) {
  if (!token) throw new HttpError(401, 'ログインが必要です');
  const [h, p, s] = token.split('.');
  if (!s) throw new HttpError(401, '不正なトークンです');
  const header = JSON.parse(b64url.decodeToString(h));
  const payload = JSON.parse(b64url.decodeToString(p));
  const jwk = (await firebaseJwks()).find(k => k.kid === header.kid);
  if (!jwk || header.alg !== 'RS256') throw new HttpError(401, '不正なトークンです');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url.decodeToBytes(s), new TextEncoder().encode(`${h}.${p}`));
  const now = Math.floor(Date.now() / 1000);
  if (!ok || payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}` || payload.exp < now || !payload.sub) {
    throw new HttpError(401, 'ログインの有効期限が切れています。再ログインしてください');
  }
  return { uid: payload.sub, email: payload.email || '', name: payload.name || '' };
}

/* ───────── サービスアカウント → アクセストークン ───────── */

const tokenCache = new Map();

function pemToPkcs8(pem) {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\\n/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(body), c => c.charCodeAt(0));
}

async function serviceAccountToken(env, scope) {
  const cacheKey = 'sa:' + scope;
  const hit = tokenCache.get(cacheKey);
  if (hit && Date.now() < hit.exp) return hit.token;
  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON || 'null');
  if (!sa) throw new HttpError(500, 'GOOGLE_SERVICE_ACCOUNT_JSON が未設定です');
  const now = Math.floor(Date.now() / 1000);
  const header = utf8b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = utf8b64url(JSON.stringify({ iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const key = await crypto.subtle.importKey('pkcs8', pemToPkcs8(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claim}`));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claim}.${b64url.encode(sig)}` }),
  });
  if (!res.ok) throw new HttpError(502, `Googleの認証に失敗しました: ${await res.text()}`);
  const { access_token, expires_in } = await res.json();
  tokenCache.set(cacheKey, { token: access_token, exp: Date.now() + (expires_in - 120) * 1000 });
  return access_token;
}

async function driveOAuthToken(env) {
  const hit = tokenCache.get('drive');
  if (hit && Date.now() < hit.exp) return hit.token;
  if (!env.GOOGLE_OAUTH_REFRESH_TOKEN) throw new HttpError(500, 'GOOGLE_OAUTH_REFRESH_TOKEN が未設定です（ドライブ保存）');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: env.GOOGLE_OAUTH_REFRESH_TOKEN,
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new HttpError(502, `ドライブの認証に失敗しました: ${await res.text()}`);
  const { access_token, expires_in } = await res.json();
  tokenCache.set('drive', { token: access_token, exp: Date.now() + (expires_in - 120) * 1000 });
  return access_token;
}

/* ───────── Firestore REST ───────── */

export function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toValue(x)])) } };
}

export function fromValue(v) {
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
  if ('referenceValue' in v) return v.referenceValue;
  return null;
}
const fromFields = f => Object.fromEntries(Object.entries(f).map(([k, x]) => [k, fromValue(x)]));

export class Firestore {
  constructor(env) {
    this.env = env;
    this.base = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  }
  async req(path, init = {}) {
    const token = await serviceAccountToken(this.env, 'https://www.googleapis.com/auth/datastore');
    const res = await fetch(this.base + path, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers } });
    if (res.status === 404) return null;
    if (!res.ok) {
      const err = new HttpError(res.status === 409 || res.status === 412 ? 409 : 502, `Firestore: ${res.status} ${await res.text()}`);
      err.firestoreStatus = res.status;
      throw err;
    }
    return res.json();
  }
  /** @returns {Promise<{data: object, updateTime: string}|null>} */
  async get(col, id) {
    const doc = await this.req(`/${col}/${encodeURIComponent(id)}`);
    return doc ? { id, data: fromFields(doc.fields || {}), updateTime: doc.updateTime } : null;
  }
  /** 指定フィールドだけ上書き（ドキュメントが無ければ作成）。precondition で楽観ロック */
  async set(col, id, data, { merge = true, updateTime, exists } = {}) {
    const qs = new URLSearchParams();
    if (merge) Object.keys(data).forEach(k => qs.append('updateMask.fieldPaths', k.includes('-') ? `\`${k}\`` : k));
    if (updateTime) qs.set('currentDocument.updateTime', updateTime);
    else if (exists !== undefined) qs.set('currentDocument.exists', String(exists));
    const doc = await this.req(`/${col}/${encodeURIComponent(id)}?${qs}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields: toValue(data).mapValue.fields }),
    });
    return { id, data: fromFields(doc.fields || {}), updateTime: doc.updateTime };
  }
  /** 等価条件のみの簡易クエリ */
  async where(col, filters, limit = 200) {
    const fieldFilters = Object.entries(filters).map(([field, value]) => ({
      fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: toValue(value) },
    }));
    const where = fieldFilters.length === 1 ? fieldFilters[0] : { compositeFilter: { op: 'AND', filters: fieldFilters } };
    const rows = await this.req(':runQuery', {
      method: 'POST',
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: col }], where, limit } }),
    });
    return (rows || []).filter(r => r.document).map(r => ({
      id: decodeURIComponent(r.document.name.split('/').pop()),
      data: fromFields(r.document.fields || {}),
      updateTime: r.document.updateTime,
    }));
  }
  /** 読み取り→変更→条件付き書き込みを競合時にリトライ */
  async update(col, id, mutate, attempts = 4) {
    for (let i = 0; i < attempts; i++) {
      const cur = await this.get(col, id);
      const next = mutate(cur ? cur.data : null);
      if (next == null) return cur;
      try {
        return await this.set(col, id, next, cur ? { merge: false, updateTime: cur.updateTime } : { merge: false, exists: false });
      } catch (e) {
        if (e.status !== 409 || i === attempts - 1) throw e;
      }
    }
  }
}

/* ───────── Drive ───────── */

export class Drive {
  constructor(env) { this.env = env; }
  async req(url, init = {}) {
    const token = await driveOAuthToken(this.env);
    const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
    if (!res.ok) throw new HttpError(502, `Drive: ${res.status} ${await res.text()}`);
    return res;
  }
  async findFolder(name, parentId) {
    const q = [`name = '${name.replace(/'/g, "\\'")}'`, `mimeType = 'application/vnd.google-apps.folder'`, 'trashed = false', parentId ? `'${parentId}' in parents` : null].filter(Boolean).join(' and ');
    const res = await this.req(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`);
    return (await res.json()).files?.[0]?.id || null;
  }
  async ensureFolder(name, parentId) {
    const found = await this.findFolder(name, parentId);
    if (found) return found;
    const res = await this.req('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', ...(parentId ? { parents: [parentId] } : {}) }),
    });
    return (await res.json()).id;
  }
  async multipartUpload(metadata, body, contentType) {
    const boundary = 'mt' + crypto.randomUUID().replace(/-/g, '');
    const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`;
    const tail = `\r\n--${boundary}--`;
    const bodyBytes = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body);
    const parts = [new TextEncoder().encode(head), bodyBytes, new TextEncoder().encode(tail)];
    const payload = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    parts.reduce((offset, p) => { payload.set(p, offset); return offset + p.length; }, 0);
    const res = await this.req('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: payload,
    });
    return res.json();
  }
  /** HTML を Google ドキュメントに変換 → PDF に書き出し → PDF をフォルダに保存（一時ドキュメントは削除） */
  async saveHtmlAsPdf(html, fileName, folderId) {
    const doc = await this.multipartUpload({ name: fileName, mimeType: 'application/vnd.google-apps.document' }, html, 'text/html; charset=UTF-8');
    try {
      const pdf = await (await this.req(`https://www.googleapis.com/drive/v3/files/${doc.id}/export?mimeType=application/pdf`)).arrayBuffer();
      return await this.multipartUpload({ name: `${fileName}.pdf`, parents: [folderId], mimeType: 'application/pdf' }, pdf, 'application/pdf');
    } finally {
      await this.req(`https://www.googleapis.com/drive/v3/files/${doc.id}`, { method: 'DELETE' }).catch(() => {});
    }
  }
}
