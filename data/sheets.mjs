// G2 data：メインのスプレッドシートの「イベント」シートを読む（Sheets API。読み取りだけ）
//
// 認証：GitHub Actions の OIDC → Workload Identity → サービスアカウントの短期トークン（G0 と同じ）。
//       サービスアカウントはメインのスプレッドシートの「閲覧者」。このファイルは読み取りの要求しか送らない。
// 出力：行（文字列の配列の配列。見出しの行は除く）。末尾の空のセルは '' で埋めて10列にそろえる。
//       文字列でないセル（数値など）はそのまま返す（rowToRecord が「形が読めない行」として数える）。
// ログ・例外の文言に、トークン・ID・URL・応答の本文を出さない（公開リポジトリのため）。

import { HEADERS } from './events.mjs';

export const API = 'https://sheets.googleapis.com/v4/spreadsheets';
export const EVENTS_SHEET = 'イベント';
export const MAX_ROWS = 200000;

export async function readEventRows(token, sheetId, fetchImpl) {
  const f = fetchImpl || fetch;

  if (typeof token !== 'string' || token === '' || typeof sheetId !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(sheetId)) {
    throw new Error('AKANE_DATA_INPUT_INVALID');
  }

  const range = encodeURIComponent("'" + EVENTS_SHEET + "'!A1:J");
  const url = API + '/' + sheetId + '/values/' + range +
    '?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER';
  let res;

  try {
    res = await f(url, { method: 'GET', headers: { Authorization: 'Bearer ' + token } });
  } catch (e) {
    throw new Error('AKANE_DATA_READ_FAILED');
  }

  if (!res || res.status !== 200) {
    throw new Error('AKANE_DATA_READ_STATUS_' + (res && Number.isInteger(res.status) ? res.status : 0));
  }

  let json;

  try { json = await res.json(); } catch (e) { throw new Error('AKANE_DATA_READ_SHAPE'); }

  const values = json && Array.isArray(json.values) ? json.values : null;

  if (values === null || values.length === 0) {
    throw new Error('AKANE_DATA_HEADERS_MISSING');
  }

  const head = values[0];

  if (!Array.isArray(head) || head.length !== HEADERS.length || HEADERS.some((h, i) => head[i] !== h)) {
    throw new Error('AKANE_DATA_HEADERS_MISMATCH');
  }

  if (values.length - 1 > MAX_ROWS) {
    throw new Error('AKANE_DATA_TOO_MANY_ROWS');
  }

  return values.slice(1).map((row) => {
    if (!Array.isArray(row)) { return null; }
    const out = row.slice(0, HEADERS.length + 1);
    while (out.length < HEADERS.length) { out.push(''); }
    return out;
  });
}
