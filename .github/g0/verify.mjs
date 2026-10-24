// G0 先行検証：GitHub Actions（OIDC → Workload Identity → サービスアカウントの短期トークン）で
// Sheets API を使えるかを確かめる。合格基準は仕様 3.3.3 の 1（正常な往復10回）と 8（権限）。
//
// 環境変数（すべて GitHub の environment「prod」の secrets から渡す。ログには出さない）
//   ACCESS_TOKEN   google-github-actions/auth が発行した短期トークン
//   LINK_SHEET_ID  連携専用スプレッドシート（サービスアカウント＝編集者）
//   MAIN_SHEET_ID  ver.3 のメインのスプレッドシート（サービスアカウント＝閲覧者）
//
// 出力：合否の要約だけ（ID・トークン・URL・応答本文は出さない）。公開リポジトリではログも公開されるため。
// このスクリプトの判定は「Sheets API検証」（基準1・8の一部）だけ。G0全体の合否は、基準3・課金の確認とあわせてオーナーが判断する。
// メインのスプレッドシートは読み取りだけを試す。書き込みの試験は「タイトルを同じ値で更新する」要求で行い、
// 万一許可されていても中身は変わらない。

import fs from 'node:fs';

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const TAB = 'G0検証';
const ROUNDS = 10;

const token = process.env.ACCESS_TOKEN || '';
const linkId = process.env.LINK_SHEET_ID || '';
const mainId = process.env.MAIN_SHEET_ID || '';

const results = [];
let stage = '開始';
function record(name, ok, note) {
  results.push({ name, ok, note: note || '' });
}

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  return { status: res.status, json };
}

function enc(s) { return encodeURIComponent(s); }

async function ensureTab() {
  const r = await call('GET', `${API}/${linkId}?fields=sheets.properties.title`);
  if (r.status !== 200) { return 'META_' + r.status; }
  const titles = ((r.json && r.json.sheets) || []).map((s) => s.properties.title);
  if (titles.includes(TAB)) { return 'EXISTS'; }
  const a = await call('POST', `${API}/${linkId}:batchUpdate`, {
    requests: [{ addSheet: { properties: { title: TAB } } }]
  });
  return a.status === 200 ? 'CREATED' : 'ADD_' + a.status;
}

async function roundTrip(i, runId) {
  const nonce = runId + '-' + i + '-' + Math.random().toString(36).slice(2, 10);
  const row = [runId, String(i), nonce, new Date().toISOString()];
  const ap = await call(
    'POST',
    `${API}/${linkId}/values/${enc(TAB + '!A:D')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS&includeValuesInResponse=false`,
    { values: [row] }
  );
  if (ap.status !== 200) { return 'APPEND_' + ap.status; }
  const range = ap.json && ap.json.updates && ap.json.updates.updatedRange;
  if (!range) { return 'NO_RANGE'; }
  const rd = await call('GET', `${API}/${linkId}/values/${enc(range)}?valueRenderOption=UNFORMATTED_VALUE`);
  if (rd.status !== 200) { return 'READ_' + rd.status; }
  const got = (rd.json && rd.json.values && rd.json.values[0]) || [];
  return JSON.stringify(got) === JSON.stringify(row) ? 'OK' : 'MISMATCH';
}

async function main() {
  stage = '前提の確認';
  if (!token || !linkId || !mainId) {
    record('前提：環境変数がそろっている', false, 'ACCESS_TOKEN / LINK_SHEET_ID / MAIN_SHEET_ID のどれかが空');
    return;
  }
  const idShape = /^[A-Za-z0-9_-]{20,100}$/;
  if (!idShape.test(linkId) || !idShape.test(mainId)) {
    record('前提：IDの形', false, 'スプレッドシートIDの形ではない');
    return;
  }
  if (linkId === mainId) {
    record('前提：連携用とメインが別のスプレッドシート', false, '同じIDのため通信せずに中止');
    return;
  }
  record('前提：環境変数がそろい、連携用とメインが別', true);

  // 1. 正常な往復10回（連携専用スプレッドシート）
  stage = '連携用タブの準備';
  const tab = await ensureTab();
  record('連携用タブの準備', tab === 'EXISTS' || tab === 'CREATED', tab);
  if (tab === 'EXISTS' || tab === 'CREATED') {
    const runId = 'G0-' + (process.env.GITHUB_RUN_ID || 'local') + '-' + (process.env.GITHUB_RUN_ATTEMPT || '1');
    stage = '往復10回';
    let fails = 0;
    const codes = {};
    for (let i = 1; i <= ROUNDS; i++) {
      let c;
      try { c = await roundTrip(i, runId); } catch (e) { c = 'EXCEPTION'; }
      if (c !== 'OK') { fails++; }
      codes[c] = (codes[c] || 0) + 1;
    }
    record('基準1：正常な往復10回で失敗0件', fails === 0, JSON.stringify(codes));
  }

  // 8. 権限：メインは読めるが書けない
  stage = 'メインの読み取り';
  const rm = await call('GET', `${API}/${mainId}?fields=properties.title`);
  const mainTitle = rm.json && rm.json.properties && rm.json.properties.title;
  record('基準8：メインを読める（閲覧者）', rm.status === 200 && typeof mainTitle === 'string', 'HTTP ' + rm.status);

  if (rm.status === 200 && typeof mainTitle === 'string') {
    stage = 'メインへの書き込み試験';
    const wm = await call('POST', `${API}/${mainId}:batchUpdate`, {
      requests: [{ updateSpreadsheetProperties: { properties: { title: mainTitle }, fields: 'title' } }]
    });
    let note = 'HTTP ' + wm.status;
    if (wm.status === 200) {
      note += '：権限過剰（書けてしまう）。直ちにメインの共有を「閲覧者」に直すこと';
    } else if (wm.status !== 403) {
      note += '：想定外の応答（403でないため不合格）';
    }
    record('基準8：メインに書けない（403）', wm.status === 403, note);
  } else {
    record('基準8：メインに書けない（403）', false, '読み取りに失敗したため未実施');
  }
}

function report() {
  const lines = ['## G0：Sheets API検証の結果', '', '| 試験 | 結果 | 補足 |', '|---|---|---|'];
  for (const r of results) {
    lines.push(`| ${r.name} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.note} |`);
  }
  const allOk = results.length > 0 && results.every((r) => r.ok);
  lines.push('', allOk ? '**Sheets API検証：PASS**' : '**Sheets API検証：FAIL**',
    '', '※G0全体の合否は、基準3（3-A・3-B）と課金の確認とあわせてオーナーが判断する。');
  const text = lines.join('\n');
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
  }
  if (!allOk) { process.exitCode = 1; }
}

main()
  .catch(() => { record('実行', false, '例外（詳細は出さない）。段階：' + stage); })
  .finally(report);
