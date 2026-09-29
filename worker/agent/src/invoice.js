/* 請求：承認ごとに明細を追加 → 月末に確定して PDF をドライブに保存 */

import { Drive } from './google.js';
import { jst } from './http.js';
import { pushToDirector, text } from './line.js';

export const TAX_RATE = 0.1;
const COL = 'mt_invoices';

export function totals(lines) {
  const subtotal = lines.reduce((s, l) => s + (Number(l.fee) || 0), 0);
  const tax = Math.floor(subtotal * TAX_RATE);
  return { subtotal, tax, total: subtotal + tax };
}

function nextYm(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** 承認された案件を、その月の請求書（下書き）に1行追加する。同じ案件は二重に入らない */
export async function addInvoiceLine(fs, project, approvedAt = new Date()) {
  let ym = jst(approvedAt).ym;
  // その月がすでに発行済みなら翌月分に回す
  for (let i = 0; i < 2; i++) {
    const cur = await fs.get(COL, `${project.editorId}_${ym}`);
    if (cur?.data.status === 'issued') { ym = nextYm(ym); continue; }
    break;
  }
  const id = `${project.editorId}_${ym}`;
  const saved = await fs.update(COL, id, cur => {
    const base = cur || { editorId: project.editorId, editorName: project.editorName || '', month: ym, status: 'draft', lines: [], createdAt: new Date().toISOString() };
    if (base.lines.some(l => l.projectId === project.id)) return undefined;
    const lines = [...base.lines, { projectId: project.id, name: project.name, channel: project.channelName || '', fee: Number(project.fee) || 0, approvedAt: approvedAt.toISOString() }];
    return { ...base, lines, ...totals(lines), updatedAt: new Date().toISOString() };
  });
  return { id, month: ym, ...(saved?.data || {}) };
}

const yen = n => '¥' + Number(n || 0).toLocaleString('ja-JP');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderInvoiceHtml(inv, editor, env, issuedAt = new Date()) {
  const p = editor.invoiceProfile || {};
  const [y, m] = inv.month.split('-').map(Number);
  const due = new Date(Date.UTC(y, m + 1, 0)); // 翌月末
  const d = jst(issuedAt);
  const rows = inv.lines.map((l, i) => `
    <tr><td>${i + 1}</td><td>${esc(l.name)}${l.channel ? `<br><small>${esc(l.channel)}</small>` : ''}</td>
    <td>${esc(jst(new Date(l.approvedAt)).ymd)}</td><td style="text-align:right">${yen(l.fee)}</td></tr>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>請求書</title></head>
<body style="font-family:sans-serif;font-size:10.5pt;color:#111">
<h1 style="text-align:center;letter-spacing:.4em">請求書</h1>
<p style="text-align:right">請求番号：${esc(inv.invoiceNo)}<br>発行日：${d.year}年${d.month}月${d.day}日</p>
<p style="font-size:14pt"><u>${esc(env.BILL_TO_NAME || 'ご担当者')} 御中</u></p>
<p>${y}年${m}月分の動画編集業務について、下記のとおりご請求申し上げます。</p>
<table border="1" cellpadding="6" style="border-collapse:collapse;width:100%">
  <tr><th style="width:36%">ご請求金額（税込）</th><td style="font-size:16pt;font-weight:bold">${yen(inv.total)}</td></tr>
  <tr><th>お支払期限</th><td>${due.getUTCFullYear()}年${due.getUTCMonth() + 1}月${due.getUTCDate()}日</td></tr>
</table>
<br>
<table border="1" cellpadding="6" style="border-collapse:collapse;width:100%">
  <tr style="background:#eee"><th>No</th><th>案件</th><th>納品完了日</th><th>金額（税抜）</th></tr>
  ${rows}
  <tr><td colspan="3" style="text-align:right">小計</td><td style="text-align:right">${yen(inv.subtotal)}</td></tr>
  <tr><td colspan="3" style="text-align:right">消費税（10%対象）</td><td style="text-align:right">${yen(inv.tax)}</td></tr>
  <tr><td colspan="3" style="text-align:right"><b>合計</b></td><td style="text-align:right"><b>${yen(inv.total)}</b></td></tr>
</table>
<br>
<table border="1" cellpadding="6" style="border-collapse:collapse;width:100%">
  <tr><th style="width:36%">発行者</th><td>${esc(p.name || editor.name)}<br>${esc(p.address)}</td></tr>
  <tr><th>登録番号</th><td>${esc(p.invoiceNo || '—')}</td></tr>
  <tr><th>お振込先</th><td style="white-space:pre-wrap">${esc(p.bank)}</td></tr>
</table>
<p><small>※振込手数料は貴社にてご負担をお願いいたします。</small></p>
</body></html>`;
}

/** 指定月の下書き請求書をすべて確定してドライブに保存する */
export async function issueMonth(fs, env, ym, { editorId } = {}) {
  const filters = { month: ym, status: 'draft', ...(editorId ? { editorId } : {}) };
  const drafts = await fs.where(COL, filters);
  if (!drafts.length) return [];
  const drive = new Drive(env);
  const root = env.DRIVE_ROOT_FOLDER_ID || await drive.ensureFolder('ものがたりっち請求書');
  const results = [];
  for (const inv of drafts) {
    if (!inv.data.lines?.length) continue;
    const editor = (await fs.get('mt_editors', inv.data.editorId))?.data || { name: inv.data.editorName };
    const editorName = editor.invoiceProfile?.name || editor.name || inv.data.editorId;
    const issuedAt = new Date();
    const data = { ...inv.data, ...totals(inv.data.lines), invoiceNo: `${ym.replace('-', '')}-${inv.data.editorId.slice(0, 6).toUpperCase()}` };
    const folder = await drive.ensureFolder(editorName, root);
    const file = await drive.saveHtmlAsPdf(renderInvoiceHtml(data, editor, env, issuedAt), `請求書_${ym}_${editorName}`, folder);
    await fs.set(COL, inv.id, {
      ...data,
      status: 'issued',
      issuedAt: issuedAt.toISOString(),
      driveFileId: file.id,
      driveUrl: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
    }, { merge: false, updateTime: inv.updateTime });
    results.push({ id: inv.id, editorName, total: data.total, driveUrl: file.webViewLink });
  }
  if (results.length && env.DIRECTOR_LINE_USER_ID) {
    const body = results.map(r => `・${r.editorName} ${yen(r.total)}\n  ${r.driveUrl}`).join('\n');
    await pushToDirector(env, [text(`🧾 ${ym} の請求書を${results.length}件作成し、ドライブに保存しました。\n\n${body}`)]).catch(() => {});
  }
  return results;
}
