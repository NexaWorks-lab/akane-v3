// G3b config：連携用スプレッドシートの「送信箱_運用」の読み書き（Sheets API）
//
// - 認証：GitHub Actions の OIDC → Workload Identity → サービスアカウントの短期トークン（G0・G2 と同じ）。
//   サービスアカウントは連携用シートの編集者、メインのシートの閲覧者。
// - 読むのは送信箱の1シートだけ。書くのは追記（values:append、RAW）の1行だけ。ほかのシート・範囲には触れない。
// - 見出しの行が（send_id・bundle・written_at）と完全に一致しなければ、読み書きしない。
// - ログ・例外の文言に、トークン・ID・URL・応答の本文・全文を出さない（公開リポジトリのため）。

import { API } from '../data/sheets.mjs';
import { OUTBOX_SHEET, OUTBOX_HEADERS } from './outbox.mjs';

export const MAX_OUTBOX_ROWS = 20000;
const ID_RE = /^[A-Za-z0-9_-]{20,100}$/;

function checkInput(token, sheetId) {
  if (typeof token !== 'string' || token === '' || typeof sheetId !== 'string' || !ID_RE.test(sheetId)) {
    throw new Error('AKANE_LINK_INPUT_INVALID');
  }
}

async function call(f, url, init, prefix) {
  let res;

  try { res = await f(url, init); } catch (e) { throw new Error(prefix + '_FAILED'); }

  if (!res || res.status !== 200) {
    throw new Error(prefix + '_STATUS_' + (res && Number.isInteger(res.status) ? res.status : 0));
  }

  try { return await res.json(); } catch (e) { throw new Error(prefix + '_SHAPE'); }
}

/** 送信箱の行（見出しを除く。各行は3列にそろえる）。 */
export async function readOutboxRows(token, linkId, fetchImpl) {
  const f = fetchImpl || fetch;

  checkInput(token, linkId);

  const range = encodeURIComponent("'" + OUTBOX_SHEET + "'!A1:C");
  const json = await call(f, API + '/' + linkId + '/values/' + range +
    '?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE',
  { method: 'GET', headers: { Authorization: 'Bearer ' + token } }, 'AKANE_LINK_READ');
  const values = json && Array.isArray(json.values) ? json.values : null;

  if (values === null || values.length === 0) {
    throw new Error('AKANE_LINK_HEADERS_MISSING');
  }

  const head = values[0];

  if (!Array.isArray(head) || head.length !== OUTBOX_HEADERS.length || OUTBOX_HEADERS.some((h, i) => head[i] !== h)) {
    throw new Error('AKANE_LINK_HEADERS_MISMATCH');
  }

  if (values.length - 1 > MAX_OUTBOX_ROWS) {
    throw new Error('AKANE_LINK_TOO_MANY_ROWS');
  }

  return values.slice(1).map((row) => {
    if (!Array.isArray(row)) { return ['', '', '']; }
    const out = row.slice(0, OUTBOX_HEADERS.length);
    while (out.length < OUTBOX_HEADERS.length) { out.push(''); }
    return out;
  });
}

/**
 * 送信箱に1行を追記する（RAW。数式・日付への変換をしない）。
 * 返り値：{ updatedRows }。1行と確かめられなければ例外（AKANE_LINK_APPEND_UNKNOWN：書けたかどうか不明）。
 */
export async function appendOutboxRow(token, linkId, row, fetchImpl) {
  const f = fetchImpl || fetch;

  checkInput(token, linkId);

  if (!Array.isArray(row) || row.length !== OUTBOX_HEADERS.length || !row.every((c) => typeof c === 'string' && c !== '')) {
    throw new Error('AKANE_LINK_ROW_INVALID');
  }

  const range = encodeURIComponent("'" + OUTBOX_SHEET + "'!A:C");
  let json;

  try {
    json = await call(f, API + '/' + linkId + '/values/' + range +
      ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS&includeValuesInResponse=false',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ majorDimension: 'ROWS', values: [row] })
    }, 'AKANE_LINK_APPEND');
  } catch (e) {
    // 送ったあとの失敗は、書けたかどうか分からない（次の発行の準備で送信箱を読み直して判断する）
    throw new Error(/_STATUS_4\d\d$/.test(e.message) ? e.message : 'AKANE_LINK_APPEND_UNKNOWN');
  }

  const u = json && json.updates;

  if (!u || u.updatedRows !== 1 || u.updatedColumns !== OUTBOX_HEADERS.length) {
    throw new Error('AKANE_LINK_APPEND_UNKNOWN');
  }

  return { updatedRows: 1 };
}
