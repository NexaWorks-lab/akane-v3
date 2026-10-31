// G3b config の試験（発行の準備・署名・追記。秘密も通信も使わない。鍵は G1 の試験用の公開してよい鍵だけ）
//   node config/issue-test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, parseCanonicalJson } from '../security/canonical.mjs';
import { sha256Hex, verifyBundle } from '../security/bundle.mjs';
import { buildRow } from '../data/events.mjs';
import { loadConfig } from './rules.mjs';
import { issueOperation, jstTimestamp } from './issue.mjs';
import { sendIdOf, rowKeyOf, ackInput, flagInput, outboxRow, OUTBOX_HEADERS } from './outbox.mjs';
import { operationState, planIssue, readPlan, checkSigned, STALE_MS } from './state.mjs';
import { readOutboxRows, appendOutboxRow } from './link.mjs';
import { runPrepare, runSign, runAppend, prepareInput } from './issue-run.mjs';
import { deliveryReport, deliveryMarkdown, ACK_WAIT_MS } from '../data/delivery.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(fs.readFileSync(path.join(dir, 'vectors.json'), 'utf8'));
const cfg = loadConfig(dir);
const B = cfg.baseline.params;
const K = V.test_key;
const NOW = V.now_ms;
const T = jstTimestamp(NOW);

let passed = 0;
const failures = [];

function ck(name, ok) {
  if (ok === true) { passed++; } else { failures.push(name); }
}
function errOf(fn) {
  try { fn(); return null; } catch (e) { return e.message; }
}
async function errOfA(fn) {
  try { await fn(); return null; } catch (e) { return e.message; }
}
const P = (over) => Object.assign({}, B, over || {});

function issue(version, params, previous, nowMs) {
  return issueOperation({ config: cfg, params, previous: previous === undefined ? null : previous, env: 'PROD', version,
    nowMs: nowMs === undefined ? NOW - 3600000 * 24 : nowMs, key: K });
}
function evtId(h) {
  return 'EVT_' + h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20, 32);
}
/** GAS の 13 が書く受け入れ記録と同じ行（akane_bundlesAcceptedInput_） */
function acceptedRow(text, over) {
  const b = parseCanonicalJson(text);
  const o = over || {};
  const input = {
    event_id: evtId(sha256Hex(canonicalJson({ e: b.env, h: b.content_hash, k: b.kind, t: 'BUNDLE_ACCEPTED', v: b.version }))),
    event_type: 'BUNDLE_ACCEPTED',
    subject_key: o.subject || ('BUNDLE_ACCEPTED:' + b.env + ':' + b.kind + ':' + b.version),
    observed_at: b.issued_at,
    payload: o.payload || { bundle: text, content_hash: b.content_hash, kind: b.kind, version: b.version }
  };
  if (o.source) { input.source = o.source; }
  return buildRow(input, o.env || 'PROD', T);
}
function ackRow(sendId, result, code) { return buildRow(ackInput('PROD', sendId, result, code || null, T), 'PROD', T); }
function flagRow(rowKey) { return buildRow(flagInput('PROD', rowKey, 'AKANE_INTAKE_SEND_ID_MISMATCH', T), 'PROD', T); }

const t1 = issue(1, P({ B_BULLET_PCT: 35 }));
const t2 = issue(2, P({ B_BULLET_PCT: 45 }), P({ B_BULLET_PCT: 35 }));
const r1 = outboxRow(t1, T);
const r2 = outboxRow(t2, T);

// ---------- 1. 状態 ----------
const s0 = operationState([], [], 'PROD');
ck('empty: version 0, no previous, nothing pending', s0.maxVersion === 0 && s0.maxHash === null && s0.previous === null && s0.pending === 0);

const s1 = operationState([acceptedRow(t1), ackRow(r1[0], 'ACCEPTED')], [r1], 'PROD');
ck('one accepted and acked: version 1, previous = its params, nothing pending', s1.maxVersion === 1 &&
  s1.maxHash === parseCanonicalJson(t1).content_hash && canonicalJson(s1.previous) === canonicalJson(P({ B_BULLET_PCT: 35 })) && s1.pending === 0);

const s2 = operationState([acceptedRow(t1), acceptedRow(t2), ackRow(r1[0], 'ACCEPTED'), ackRow(r2[0], 'ACCEPTED')], [r1, r2], 'PROD');
ck('highest accepted version is used', s2.maxVersion === 2 && s2.previous.B_BULLET_PCT === 45);
ck('row order does not matter', operationState([acceptedRow(t2), acceptedRow(t1)], [], 'PROD').maxVersion === 2);
const t2early = issue(2, P({ B_BULLET_PCT: 45 }), P({ B_BULLET_PCT: 35 }), NOW - 3 * 86400000);
ck('the highest version wins even if it was issued earlier', operationState([acceptedRow(t1), acceptedRow(t2early)], [], 'PROD').maxVersion === 2 &&
  operationState([acceptedRow(t2early), acceptedRow(t1)], [], 'PROD').previous.B_BULLET_PCT === 45);

ck('unacked outbox row is pending', operationState([acceptedRow(t1)], [r1], 'PROD').pending === 1);
ck('REJECTED ack is processed (not pending)', operationState([ackRow(r2[0], 'REJECTED', 'AKANE_BUNDLE_PARAM_STEP')], [r2], 'PROD').pending === 0);
const tam = [r1[0], t2, T];
ck('tampered row without a flag is pending; with a flag it is not', operationState([], [tam], 'PROD').pending === 1 &&
  operationState([flagRow(rowKeyOf(tam[0], tam[1]))], [tam], 'PROD').pending === 0);
ck('an ack of the real row does not clear a tampered row with the same id', operationState([ackRow(r1[0], 'ACCEPTED')], [tam], 'PROD').pending === 1);
ck('rows 13 ignores are not pending (bad id / empty text)', operationState([], [['x', t1, T], [r1[0], '', T], ['', '', '']], 'PROD').pending === 0);
ck('acks of the other env do not count', operationState([buildRow(ackInput('DEV', r1[0], 'ACCEPTED', null, T), 'DEV', T)], [r1], 'PROD').pending === 1);
ck('accepted records of the other env (both columns) are not counted', operationState([acceptedRow(issueDev(1), { env: 'DEV' })], [], 'PROD').maxVersion === 0);

function issueDev(version) {
  return issueOperation({ config: cfg, params: P({ B_BULLET_PCT: 35 }), previous: null, env: 'DEV', version, nowMs: NOW - 86400000, key: K });
}

const inv = (rows) => errOf(() => operationState(rows, [], 'PROD'));
ck('unreadable accepted row -> STATE_INVALID', inv([['x', 'BUNDLE_ACCEPTED', 'BUNDLE_ACCEPTED:PROD:OPERATION:1', '', '', '', '', '', '', '']]) ===
  'AKANE_ISSUE_STATE_INVALID');
ck('accepted record from another source -> STATE_INVALID', inv([acceptedRow(t1, { source: 'ACTIONS' })]) === 'AKANE_ISSUE_STATE_INVALID');
ck('env column and subject env differ -> STATE_INVALID', inv([acceptedRow(t1, { subject: 'BUNDLE_ACCEPTED:DEV:OPERATION:1' })]) === 'AKANE_ISSUE_STATE_INVALID');
ck('payload does not match the bundle -> STATE_INVALID', inv([acceptedRow(t1, { payload: {
  bundle: t1, content_hash: parseCanonicalJson(t1).content_hash, kind: 'OPERATION', version: 2 } })]) === 'AKANE_ISSUE_STATE_INVALID');
ck('payload with an extra key -> STATE_INVALID', inv([acceptedRow(t1, { payload: {
  bundle: t1, content_hash: parseCanonicalJson(t1).content_hash, kind: 'OPERATION', version: 1, x: 1 } })]) === 'AKANE_ISSUE_STATE_INVALID');
ck('payload bundle not JSON -> STATE_INVALID', inv([acceptedRow(t1, { payload: {
  bundle: 'x', content_hash: parseCanonicalJson(t1).content_hash, kind: 'OPERATION', version: 1 } })]) === 'AKANE_ISSUE_STATE_INVALID');
const t1b = issue(1, P({ PRODUCT_SLOT: 'S3' }));
ck('two contents at the same version -> STATE_INVALID', inv([acceptedRow(t1), acceptedRow(t1b, { subject: 'BUNDLE_ACCEPTED:PROD:OPERATION:1' })]) ===
  'AKANE_ISSUE_STATE_INVALID');
const dupId = acceptedRow(t1);
const dupConflict = dupId.slice();
dupConflict[8] = canonicalJson({ bundle: t1b, content_hash: parseCanonicalJson(t1b).content_hash, kind: 'OPERATION', version: 1 });
ck('quarantined accepted record (id conflict) -> STATE_INVALID', inv([dupId, dupConflict]) === 'AKANE_ISSUE_STATE_INVALID');
// レビュー①：鍵がなくても確かめられる不一致は GitHub 側で止める
const t1obj = parseCanonicalJson(t1);
const t1bad = canonicalJson(Object.assign({}, t1obj, { body: { schema: 1, params: P({ B_BULLET_PCT: 45 }) } }));   // 本文だけ書き換え（ハッシュはそのまま）
ck('content_hash does not match the body -> STATE_INVALID', inv([acceptedRow(t1bad)]) === 'AKANE_ISSUE_STATE_INVALID');
const rowBadId = acceptedRow(t1); rowBadId[0] = evtId(sha256Hex('other'));
ck('event_id does not match the bundle -> STATE_INVALID', inv([rowBadId]) === 'AKANE_ISSUE_STATE_INVALID');
const rowBadObs = buildRow({ event_id: acceptedRow(t1)[0], event_type: 'BUNDLE_ACCEPTED', subject_key: 'BUNDLE_ACCEPTED:PROD:OPERATION:1',
  observed_at: T, payload: { bundle: t1, content_hash: t1obj.content_hash, kind: 'OPERATION', version: 1 } }, 'PROD', T);
ck('observed_at is not the issue time -> STATE_INVALID', inv([rowBadObs]) === 'AKANE_ISSUE_STATE_INVALID');

// レビュー①：BUNDLE_HEAD（GAS の Property）とイベントの食い違いは 13 が拒否 → 次の準備はその拒否で止まる
const t2h = issue(2, P({ B_BULLET_PCT: 45 }), P({ B_BULLET_PCT: 35 }));
const r2h = outboxRow(t2h, T);
const sHead = operationState([acceptedRow(t1), ackRow(r1[0], 'ACCEPTED'), ackRow(r2h[0], 'REJECTED', 'AKANE_BUNDLE_SAME_VERSION_DIFFERENT_HASH')],
  [r1, r2h], 'PROD');
ck('HEAD ahead of events: 13 rejected v2 -> lastRejected carries the code', sHead.lastRejected === 'AKANE_BUNDLE_SAME_VERSION_DIFFERENT_HASH' &&
  sHead.pending === 0 && sHead.maxVersion === 1);
ck('last send rejected for a state reason -> LAST_REJECTED (no new issue)', ['NONE', 'B_BULLET_PCT'].every((param) =>
  errOf(() => planIssue(sHead, cfg, { param, value: param === 'NONE' ? '' : '45' })) === 'AKANE_ISSUE_LAST_REJECTED'));
ck('owner confirmed the reason -> plan proceeds (13 still decides)', planIssue(sHead, cfg, { param: 'NONE', value: '', confirmRejected: true }).version === 2);
ck('confirm must be exactly true', errOf(() => planIssue(sHead, cfg, { param: 'NONE', value: '', confirmRejected: 'true' })) === 'AKANE_ISSUE_LAST_REJECTED');
ck('other state codes also stop (VERSION_OLD / SIGNATURE / EXPIRED / unknown)', ['AKANE_BUNDLE_VERSION_OLD', 'AKANE_BUNDLE_SIGNATURE_INVALID',
  'AKANE_BUNDLE_EXPIRED', 'AKANE_X'].every((code) => errOf(() => planIssue(operationState([acceptedRow(t1), ackRow(r1[0], 'ACCEPTED'),
  ackRow(r2h[0], 'REJECTED', code)], [r1, r2h], 'PROD'), cfg, { param: 'NONE', value: '' })) === 'AKANE_ISSUE_LAST_REJECTED'));
const sBody = operationState([acceptedRow(t1), ackRow(r1[0], 'ACCEPTED'), ackRow(r2h[0], 'REJECTED', 'AKANE_BUNDLE_PARAM_STEP')], [r1, r2h], 'PROD');
ck('last send rejected by a body rule -> next issue allowed', sBody.lastRejected === 'AKANE_BUNDLE_PARAM_STEP' &&
  planIssue(sBody, cfg, { param: 'NONE', value: '' }).version === 2);
ck('an older rejection does not stop when the last send was accepted', operationState([acceptedRow(t1), ackRow(r2h[0], 'REJECTED',
  'AKANE_BUNDLE_VERSION_OLD'), ackRow(r1[0], 'ACCEPTED')], [r2h, r1], 'PROD').lastRejected === null);
ck('tampered / bad rows after the last send are not the last send', operationState([acceptedRow(t1), ackRow(r1[0], 'ACCEPTED'),
  ackRow(r2h[0], 'REJECTED', 'AKANE_BUNDLE_VERSION_OLD'), flagRow(rowKeyOf(tam[0], tam[1]))], [r1, r2h, tam, ['x', 'y', 'z']], 'PROD').lastRejected ===
  'AKANE_BUNDLE_VERSION_OLD');
ck('rejections of the other env are not used', operationState([acceptedRow(t1), ackRow(r1[0], 'ACCEPTED'), ackRow(r2h[0], 'REJECTED', 'AKANE_BUNDLE_VERSION_OLD'),
  buildRow(ackInput('DEV', r1[0], 'REJECTED', 'AKANE_BUNDLE_VERSION_OLD', T), 'DEV', T)], [r2h, r1], 'PROD').lastRejected === null);
// レビュー 必須1：拒否の状態は状態の印に入る
const stA = operationState([acceptedRow(t1), ackRow(r1[0], 'ACCEPTED'), ackRow(r2h[0], 'REJECTED', 'AKANE_BUNDLE_PARAM_STEP')], [r1, r2h], 'PROD');
const stB = operationState([acceptedRow(t1), ackRow(r1[0], 'ACCEPTED'), ackRow(r2h[0], 'REJECTED', 'AKANE_BUNDLE_VERSION_OLD')], [r1, r2h], 'PROD');
const stC = operationState([acceptedRow(t1), ackRow(r1[0], 'ACCEPTED'), ackRow(r2h[0], 'ACCEPTED')], [r1, r2h], 'PROD');
ck('stamp includes lastRejected (same version / pending / rows, different rejection)', stA.pending === 0 && stB.pending === 0 &&
  stA.maxVersion === stB.maxVersion && new Set([stA.stamp, stB.stamp, stC.stamp]).size === 3);

// レビュー 必須2：受信確認・不正の記録は再構成で採用されたものだけ。隔離・異常は発行停止
const ackA = ackRow(r1[0], 'ACCEPTED');
const ackConflict = ackA.slice();
ackConflict[8] = canonicalJson({ result: 'REJECTED', send_id: r1[0], code: 'AKANE_BUNDLE_PARAM_STEP' });   // 同じ event_id で中身が違う
ck('ack with an id conflict (quarantined) -> STATE_INVALID, not treated as processed',
  errOf(() => operationState([acceptedRow(t1), ackA, ackConflict], [r1], 'PROD')) === 'AKANE_ISSUE_STATE_INVALID');
const flA = flagRow(rowKeyOf(tam[0], tam[1]));
const flConflict = flA.slice();
flConflict[8] = canonicalJson({ code: 'AKANE_X', row_key: rowKeyOf(tam[0], tam[1]) });
ck('flag with an id conflict (quarantined) -> STATE_INVALID', errOf(() => operationState([flA, flConflict], [tam], 'PROD')) === 'AKANE_ISSUE_STATE_INVALID');
ck('unreadable ack / flag rows -> STATE_INVALID', ['DELIVERY_ACK', 'INTAKE_REJECTED'].every((t) =>
  errOf(() => operationState([['x', t, t + ':y', '', '', '', '', '', '', '']], [], 'PROD')) === 'AKANE_ISSUE_STATE_INVALID'));
const ackOdd = buildRow({ event_id: evtId(sha256Hex('odd')), event_type: 'DELIVERY_ACK', subject_key: 'DELIVERY_ACK:' + r1[0], observed_at: T,
  payload: { result: 'DONE', send_id: r1[0] } }, 'PROD', T);
const ackOther = buildRow({ event_id: evtId(sha256Hex('other-id')), event_type: 'DELIVERY_ACK', subject_key: 'DELIVERY_ACK:' + r1[0], observed_at: T,
  payload: { result: 'ACCEPTED', send_id: r2[0] } }, 'PROD', T);
ck('ack with an unknown result / another send id -> STATE_INVALID', errOf(() => operationState([ackOdd], [r1], 'PROD')) === 'AKANE_ISSUE_STATE_INVALID' &&
  errOf(() => operationState([ackOther], [r1], 'PROD')) === 'AKANE_ISSUE_STATE_INVALID');
const devCopy = ackA.slice(); devCopy[7] = 'DEV'; devCopy[6] = 'GAS-DEV';
devCopy[3] = buildRow(ackInput('DEV', r1[0], 'ACCEPTED', null, T), 'DEV', T)[3];
ck('records of the other env are not mixed into the delivery reconstruct', operationState([acceptedRow(t1), ackA, devCopy], [r1], 'PROD').pending === 0);
const ackLater = buildRow(ackInput('PROD', r2h[0], 'REJECTED', 'AKANE_BUNDLE_VERSION_OLD', jstTimestamp(NOW + 3600000)), 'PROD', T);
ck('the latest ack of a send is adopted (retry at another time)', operationState([acceptedRow(t1), ackRow(r1[0], 'ACCEPTED'),
  ackRow(r2h[0], 'REJECTED', 'AKANE_BUNDLE_PARAM_STEP'), ackLater], [r1, r2h], 'PROD').lastRejected === 'AKANE_BUNDLE_VERSION_OLD');

ck('governance records are not used for OPERATION', operationState([], [], 'PROD').maxVersion === 0);
ck('bad inputs', errOf(() => operationState(null, [], 'PROD')) === 'AKANE_ISSUE_INPUT_INVALID' &&
  errOf(() => operationState([], [], 'QA')) === 'AKANE_ISSUE_INPUT_INVALID');

ck('stamp: same state -> same stamp', operationState([acceptedRow(t1)], [], 'PROD').stamp === operationState([acceptedRow(t1)], [], 'PROD').stamp);
ck('stamp changes with version / pending / outbox rows', new Set([
  s0.stamp, s1.stamp, s2.stamp,
  operationState([acceptedRow(t1), ackRow(r1[0], 'ACCEPTED')], [r1, ['x', 'y', 'z']], 'PROD').stamp,
  operationState([acceptedRow(t1)], [r1], 'PROD').stamp
]).size === 5);

// ---------- 2. 発行の判断 ----------
const plan0 = planIssue(s0, cfg, { param: 'B_BULLET_PCT', value: '35' });
ck('first plan: version 1, from baseline, one change', plan0.version === 1 && plan0.previous === null && plan0.params.B_BULLET_PCT === 35 &&
  plan0.stamp === s0.stamp && plan0.env === 'PROD');
const plan1 = planIssue(s1, cfg, { param: 'B_BULLET_PCT', value: '45' });
ck('next plan: version 2, previous = accepted v1', plan1.version === 2 && plan1.previous.B_BULLET_PCT === 35 && plan1.params.B_BULLET_PCT === 45);
const planN = planIssue(s1, cfg, { param: 'NONE', value: '' });
ck('NONE: same params, new version (extend the period)', planN.version === 2 && canonicalJson(planN.params) === canonicalJson(s1.previous));
ck('enum value', planIssue(s1, cfg, { param: 'PRODUCT_SLOT', value: 'S3' }).params.PRODUCT_SLOT === 'S3');
ck('pending -> refuse', errOf(() => planIssue(operationState([acceptedRow(t1)], [r1], 'PROD'), cfg, { param: 'NONE', value: '' })) ===
  'AKANE_ISSUE_PENDING');
ck('rule errors stop the plan (step / range / drift / unknown / value)', [
  [s0, 'B_BULLET_PCT', '45', 'AKANE_BUNDLE_PARAM_STEP'],
  [s0, 'NORMAL_LINES_MAX', '5', 'AKANE_BUNDLE_PARAM_RANGE'],
  [s2, 'B_BULLET_PCT', '50', 'AKANE_BUNDLE_PARAM_DRIFT'],
  [s0, 'FIRST_LINE_STYLE', 'LOUD', 'AKANE_BUNDLE_PARAM_RANGE'],
  [s0, 'NOPE', '1', 'AKANE_ISSUE_PARAM_UNKNOWN'],
  [s0, 'B_BULLET_PCT', '3.5', 'AKANE_ISSUE_VALUE_INVALID'],
  [s0, 'B_BULLET_PCT', '', 'AKANE_ISSUE_VALUE_INVALID'],
  [s0, 'B_BULLET_PCT', '1e1', 'AKANE_ISSUE_VALUE_INVALID'],
  [s0, 'PRODUCT_SLOT', 's3', 'AKANE_ISSUE_VALUE_INVALID'],
  [s0, 'NONE', '35', 'AKANE_ISSUE_VALUE_INVALID']
].every(([s, param, value, code]) => errOf(() => planIssue(s, cfg, { param, value })) === code));
ck('value with spaces around is trimmed', planIssue(s0, cfg, { param: 'B_BULLET_PCT', value: ' 35 ' }).params.B_BULLET_PCT === 35);
ck('plan does not change the state object', s1.previous.B_BULLET_PCT === 35 && Object.isFrozen(s1));
ck('plan round trip', canonicalJson(readPlan(canonicalJson(plan1))) === canonicalJson(plan1));
ck('bad plans refused', ['x', '{}', canonicalJson(Object.assign({}, plan1, { v: 2 })), canonicalJson(Object.assign({}, plan1, { extra: 1 })),
  canonicalJson(Object.assign({}, plan1, { stamp: 'x' })), canonicalJson(Object.assign({}, plan1, { version: 0 }))
].every((t) => errOf(() => readPlan(t)) === 'AKANE_ISSUE_PLAN_INVALID'));

// ---------- 3. 署名した全文の確認 ----------
const signed = issue(2, plan1.params, plan1.previous, NOW);
ck('signed bundle matching the plan passes', checkSigned(plan1, signed, NOW + 60000, 1).sendId === sendIdOf(signed));
ck('stale (> 1 hour after issue) -> STALE', errOf(() => checkSigned(plan1, signed, NOW + STALE_MS + 1, 1)) === 'AKANE_ISSUE_STALE' &&
  checkSigned(plan1, signed, NOW + STALE_MS, 1).sendId === sendIdOf(signed));
ck('issued in the future (> 5 min) -> invalid', errOf(() => checkSigned(plan1, signed, NOW - 6 * 60000, 1)) === 'AKANE_ISSUE_SIGNED_INVALID');
ck('other version / params / env -> mismatch', [
  issue(3, P({ B_BULLET_PCT: 45 }), P({ B_BULLET_PCT: 35 }), NOW),
  issue(2, P({ B_BULLET_PCT: 35 }), P({ B_BULLET_PCT: 35 }), NOW),
  issueOperation({ config: cfg, params: plan1.params, previous: plan1.previous, env: 'DEV', version: 2, nowMs: NOW, key: K })
].every((t) => errOf(() => checkSigned(plan1, t, NOW, 1)) === 'AKANE_ISSUE_SIGNED_MISMATCH'));
ck('not JSON -> invalid', errOf(() => checkSigned(plan1, 'x', NOW, 1)) === 'AKANE_ISSUE_SIGNED_INVALID');

// ---------- 4. 送信箱の読み書き（模擬の Sheets API） ----------
const LINK = 'L'.repeat(30);
function fakeSheets(o) {
  const st = { rows: (o && o.rows ? o.rows : []).map((r) => r.slice()), header: (o && o.header) || OUTBOX_HEADERS.slice(), calls: [], status: (o && o.status) || 200,
    appendStatus: (o && o.appendStatus) || 200, appendReply: (o && o.appendReply) || null, appendThrow: o && o.appendThrow };
  st.fetch = async (url, init) => {
    st.calls.push({ url, method: init.method, body: init.body, auth: init.headers.Authorization });
    if (init.method === 'GET') {
      if (st.status !== 200) { return { status: st.status, json: async () => ({}) }; }
      return { status: 200, json: async () => ({ values: [st.header].concat(st.rows.map((r) => {
        const x = r.slice(); while (x.length && x[x.length - 1] === '') { x.pop(); } return x; })) }) };
    }
    if (st.appendThrow) { throw new Error('network ' + LINK); }
    if (st.appendStatus !== 200) { return { status: st.appendStatus, json: async () => ({}) }; }
    const v = JSON.parse(init.body).values;
    if (!st.appendReply) { v.forEach((r) => st.rows.push(r.slice())); }
    return { status: 200, json: async () => (st.appendReply || { updates: { updatedRows: v.length, updatedColumns: v[0].length } }) };
  };
  return st;
}

const fs1 = fakeSheets({ rows: [r1, ['x']] });
const read1 = await readOutboxRows('tok', LINK, fs1.fetch);
ck('outbox read: rows padded to 3 columns, header dropped', read1.length === 2 && read1[1].join('|') === 'x||' && read1[0][1] === t1);
ck('outbox read: one GET on the outbox sheet only, formatted values, bearer token', fs1.calls.length === 1 && fs1.calls[0].method === 'GET' &&
  fs1.calls[0].url.indexOf(encodeURIComponent("'送信箱_運用'!A1:C")) !== -1 && /FORMATTED_VALUE/.test(fs1.calls[0].url) &&
  fs1.calls[0].auth === 'Bearer tok');
ck('outbox read: header mismatch / missing / status / bad input', (await errOfA(() => readOutboxRows('tok', LINK, fakeSheets({ header: ['send_id', 'text', 'written_at'] }).fetch))) ===
  'AKANE_LINK_HEADERS_MISMATCH' &&
  (await errOfA(() => readOutboxRows('tok', LINK, async () => ({ status: 200, json: async () => ({}) })))) === 'AKANE_LINK_HEADERS_MISSING' &&
  (await errOfA(() => readOutboxRows('tok', LINK, fakeSheets({ status: 403 }).fetch))) === 'AKANE_LINK_READ_STATUS_403' &&
  (await errOfA(() => readOutboxRows('', LINK, fs1.fetch))) === 'AKANE_LINK_INPUT_INVALID' &&
  (await errOfA(() => readOutboxRows('tok', 'bad id', fs1.fetch))) === 'AKANE_LINK_INPUT_INVALID');

const fs2 = fakeSheets({ rows: [] });
const ap = await appendOutboxRow('tok', LINK, r1, fs2.fetch);
ck('append: one POST with RAW, INSERT_ROWS, one row', ap.updatedRows === 1 && fs2.calls.length === 1 && fs2.calls[0].method === 'POST' &&
  /:append\?valueInputOption=RAW&insertDataOption=INSERT_ROWS/.test(fs2.calls[0].url) &&
  fs2.calls[0].url.indexOf(encodeURIComponent("'送信箱_運用'!A:C")) !== -1 &&
  canonicalJson(JSON.parse(fs2.calls[0].body).values) === canonicalJson([r1]) && fs2.rows.length === 1);
let badRowsOk = true;
for (const row of ['x', ['a', 'b'], ['a', 'b', ''], ['a', 'b', 1], ['a', 'b', 'c', 'd']]) {
  badRowsOk = badRowsOk && (await errOfA(() => appendOutboxRow('tok', LINK, row, fs2.fetch))) === 'AKANE_LINK_ROW_INVALID';
}
ck('append: bad rows refused before sending', badRowsOk && fs2.calls.length === 1);
ck('append: unclear results -> APPEND_UNKNOWN (5xx / network / reply without one row)',
  (await errOfA(() => appendOutboxRow('tok', LINK, r1, fakeSheets({ appendStatus: 503 }).fetch))) === 'AKANE_LINK_APPEND_UNKNOWN' &&
  (await errOfA(() => appendOutboxRow('tok', LINK, r1, fakeSheets({ appendThrow: true }).fetch))) === 'AKANE_LINK_APPEND_UNKNOWN' &&
  (await errOfA(() => appendOutboxRow('tok', LINK, r1, fakeSheets({ appendReply: { updates: { updatedRows: 2, updatedColumns: 3 } } }).fetch))) ===
    'AKANE_LINK_APPEND_UNKNOWN');
ck('append: 4xx keeps its status code', (await errOfA(() => appendOutboxRow('tok', LINK, r1, fakeSheets({ appendStatus: 403 }).fetch))) ===
  'AKANE_LINK_APPEND_STATUS_403');
ck('errors never carry the id', (await errOfA(() => appendOutboxRow('tok', LINK, r1, fakeSheets({ appendThrow: true }).fetch))).indexOf(LINK) === -1);

// ---------- 5. 3つのジョブを通しで（模擬の読み書き） ----------
function world(o) {
  const w = { events: (o.events || []).slice(), sheets: fakeSheets({ rows: o.outbox || [] }), appends: 0 };
  w.deps = {
    config: cfg,
    readEvents: async () => w.events.map((r) => r.slice()),
    readOutbox: () => readOutboxRows('tok', LINK, w.sheets.fetch),
    appendRow: (row) => { w.appends++; return appendOutboxRow('tok', LINK, row, w.sheets.fetch); }
  };
  return w;
}
const w = world({ events: [acceptedRow(t1), ackRow(r1[0], 'ACCEPTED')], outbox: [r1] });
const prep = await runPrepare(Object.assign({}, w.deps, { param: 'B_BULLET_PCT', value: '45' }));
const sg = runSign({ config: cfg, planText: prep.text, key: K, nowMs: () => NOW });
ck('sign: verifies with the key, matches the plan, no key in the text', verifyBundle(sg.text, { key: K, env: 'PROD', nowMs: NOW }).ok === true &&
  sg.text.indexOf(K) === -1 && parseCanonicalJson(sg.text).version === 2 && parseCanonicalJson(sg.text).body.params.B_BULLET_PCT === 45);
const apd = await runAppend(Object.assign({}, w.deps, { planText: prep.text, bundleText: sg.text, nowMs: () => NOW + 10 * 60000 }));
ck('append: one row written and verified', w.appends === 1 && w.sheets.rows.length === 2 && w.sheets.rows[1][0] === sendIdOf(sg.text) &&
  w.sheets.rows[1][1] === sg.text && w.sheets.rows[1][2] === jstTimestamp(NOW + 10 * 60000) && apd.sendId === sendIdOf(sg.text));
ck('after the append the next prepare stops (pending)', (await errOfA(() => runPrepare(Object.assign({}, w.deps, { param: 'NONE', value: '' })))) ===
  'AKANE_ISSUE_PENDING');

const wr = world({ events: [acceptedRow(t1), ackRow(r1[0], 'ACCEPTED'), ackRow(r2h[0], 'REJECTED', 'AKANE_BUNDLE_SAME_VERSION_DIFFERENT_HASH')], outbox: [r1, r2h] });
ck('prepare: last state rejection stops; confirmRejected (exactly true) passes it through',
  (await errOfA(() => runPrepare(Object.assign({}, wr.deps, { param: 'NONE', value: '' })))) === 'AKANE_ISSUE_LAST_REJECTED' &&
  (await errOfA(() => runPrepare(Object.assign({}, wr.deps, { param: 'NONE', value: '', confirmRejected: 'true' })))) === 'AKANE_ISSUE_LAST_REJECTED' &&
  (await runPrepare(Object.assign({}, wr.deps, { param: 'NONE', value: '', confirmRejected: true }))).plan.version === 2);
ck('workflow: confirm_rejected is a boolean input passed by env, default false', /confirm_rejected:\n(?:\s{8}[^\n]*\n)*?\s{8}type: boolean\n(?:\s{8}[^\n]*\n)*?\s{8}default: false/.test(
  fs.readFileSync(path.join(dir, '..', '.github', 'workflows', 'issue-operation.yml'), 'utf8')) &&
  /INPUT_CONFIRM_REJECTED: \$\{\{ inputs\.confirm_rejected \}\}/.test(fs.readFileSync(path.join(dir, '..', '.github', 'workflows', 'issue-operation.yml'), 'utf8')));

ck('prepare input from env: confirm only for exactly "true"', prepareInput({ INPUT_CONFIRM_REJECTED: 'true', INPUT_PARAM: 'NONE' }).confirmRejected === true &&
  ['false', '', 'TRUE', '1', undefined].every((v) => prepareInput({ INPUT_CONFIRM_REJECTED: v }).confirmRejected === false) &&
  prepareInput({}).param === '' && prepareInput({ INPUT_VALUE: '35' }).value === '35');

// レビュー 必須1：承認待ちの間に拒否の状態が変わった（値の規則の拒否 → 状態の拒否）
const wrj = world({ events: [acceptedRow(t1), ackRow(r1[0], 'ACCEPTED'), ackRow(r2h[0], 'REJECTED', 'AKANE_BUNDLE_PARAM_STEP')], outbox: [r1, r2h] });
const prj = await runPrepare(Object.assign({}, wrj.deps, { param: 'NONE', value: '' }));
const srj = runSign({ config: cfg, planText: prj.text, key: K, nowMs: () => NOW });
wrj.events.push(buildRow(ackInput('PROD', r2h[0], 'REJECTED', 'AKANE_BUNDLE_VERSION_OLD', jstTimestamp(NOW + 3600000)), 'PROD', T));
ck('rejection changed while waiting -> STATE_CHANGED, nothing written',
  (await errOfA(() => runAppend(Object.assign({}, wrj.deps, { planText: prj.text, bundleText: srj.text, nowMs: () => NOW })))) === 'AKANE_ISSUE_STATE_CHANGED' &&
  wrj.appends === 0);
const wq = world({ events: [acceptedRow(t1), ackRow(r1[0], 'ACCEPTED')], outbox: [r1] });
const pq = await runPrepare(Object.assign({}, wq.deps, { param: 'NONE', value: '' }));
const sq = runSign({ config: cfg, planText: pq.text, key: K, nowMs: () => NOW });
const ackQ = ackRow(r1[0], 'ACCEPTED'); const ackQ2 = ackQ.slice(); ackQ2[8] = canonicalJson({ result: 'IDEMPOTENT', send_id: r1[0] });
wq.events.push(ackQ2);
ck('a quarantine appeared while waiting -> STATE_INVALID, nothing written',
  (await errOfA(() => runAppend(Object.assign({}, wq.deps, { planText: pq.text, bundleText: sq.text, nowMs: () => NOW })))) === 'AKANE_ISSUE_STATE_INVALID' &&
  wq.appends === 0);

// 承認待ちの間に状態が変わった
const wc = world({ events: [acceptedRow(t1), ackRow(r1[0], 'ACCEPTED')], outbox: [r1] });
const pc = await runPrepare(Object.assign({}, wc.deps, { param: 'B_BULLET_PCT', value: '45' }));
const sc = runSign({ config: cfg, planText: pc.text, key: K, nowMs: () => NOW });
wc.events.push(acceptedRow(t2));
ck('state changed while waiting (new accepted version) -> STATE_CHANGED, nothing written',
  (await errOfA(() => runAppend(Object.assign({}, wc.deps, { planText: pc.text, bundleText: sc.text, nowMs: () => NOW })))) === 'AKANE_ISSUE_STATE_CHANGED' &&
  wc.appends === 0);
const wp = world({ events: [acceptedRow(t1), ackRow(r1[0], 'ACCEPTED')], outbox: [r1] });
const pp = await runPrepare(Object.assign({}, wp.deps, { param: 'NONE', value: '' }));
const sp = runSign({ config: cfg, planText: pp.text, key: K, nowMs: () => NOW });
wp.sheets.rows.push(outboxRow(issue(2, P({ B_BULLET_PCT: 35 }), P({ B_BULLET_PCT: 35 }), NOW - 1000), T));
ck('a row appeared while waiting -> PENDING, nothing written',
  (await errOfA(() => runAppend(Object.assign({}, wp.deps, { planText: pp.text, bundleText: sp.text, nowMs: () => NOW })))) === 'AKANE_ISSUE_PENDING' &&
  wp.appends === 0);
const ws = world({ events: [], outbox: [] });
const ps = await runPrepare(Object.assign({}, ws.deps, { param: 'NONE', value: '' }));
const ss = runSign({ config: cfg, planText: ps.text, key: K, nowMs: () => NOW });
ck('approval later than 1 hour -> STALE, nothing written',
  (await errOfA(() => runAppend(Object.assign({}, ws.deps, { planText: ps.text, bundleText: ss.text, nowMs: () => NOW + STALE_MS + 1 })))) ===
    'AKANE_ISSUE_STALE' && ws.appends === 0);
ck('bundle swapped between jobs -> mismatch, nothing written',
  (await errOfA(() => runAppend(Object.assign({}, ws.deps, { planText: ps.text, bundleText: sg.text, nowMs: () => NOW })))) ===
    'AKANE_ISSUE_SIGNED_MISMATCH' && ws.appends === 0);
const wu = world({ events: [acceptedRow(t1), ackRow(r1[0], 'ACCEPTED')], outbox: [r1] });
wu.sheets.appendReply = { updates: { updatedRows: 1, updatedColumns: 3 } };   // 応答は1行だが、実際には書かれていない
const pu = await runPrepare(Object.assign({}, wu.deps, { param: 'NONE', value: '' }));
const su = runSign({ config: cfg, planText: pu.text, key: K, nowMs: () => NOW });
ck('append not visible on re-read -> APPEND_UNVERIFIED',
  (await errOfA(() => runAppend(Object.assign({}, wu.deps, { planText: pu.text, bundleText: su.text, nowMs: () => NOW })))) === 'AKANE_ISSUE_APPEND_UNVERIFIED');
ck('sign: bad key -> code only, no key in the message', errOf(() => runSign({ config: cfg, planText: ps.text, key: 'nothex', nowMs: () => NOW })) ===
  'AKANE_BUNDLE_KEY_INVALID');
ck('sign: plan breaking the rules is refused at signing too', errOf(() => runSign({ config: cfg,
  planText: canonicalJson(Object.assign({}, readPlan(ps.text), { params: P({ B_BULLET_PCT: 45 }) })), key: K, nowMs: () => NOW })) ===
  'AKANE_BUNDLE_PARAM_STEP');

// ---------- 6. ワークフローの形（静的な確認） ----------
const wf = fs.readFileSync(path.join(dir, '..', '.github', 'workflows', 'issue-operation.yml'), 'utf8');
const jobsAt = (name) => wf.slice(wf.indexOf('\n  ' + name + ':\n'));
const jobText = (name) => { const s = jobsAt(name); const m = s.slice(1).search(/\n  [a-z]+:\n/); return m === -1 ? s : s.slice(0, m + 1); };
ck('workflow: manual only, main only, no cancel', /\non:\n  workflow_dispatch:/.test(wf) && !/\n  (push|pull_request|schedule)/.test(wf) &&
  (wf.match(/if: github\.ref == 'refs\/heads\/main'/g) || []).length === 3 && /cancel-in-progress: false/.test(wf));
ck('workflow: the key is only in the sign job (environment issue), sign job has no Google auth', jobText('sign').indexOf('secrets.OPERATION_SIGNING_KEY') !== -1 &&
  (wf.match(/OPERATION_SIGNING_KEY/g) || []).length === (jobText('sign').match(/OPERATION_SIGNING_KEY/g) || []).length && /environment: issue/.test(jobText('sign')) && jobText('sign').indexOf('google-github-actions') === -1 &&
  jobText('sign').indexOf('id-token') === -1);
ck('workflow: prepare is read only, append has the write scope', /spreadsheets\.readonly/.test(jobText('prepare')) &&
  !/auth\/spreadsheets\n/.test(jobText('prepare')) && /auth\/spreadsheets\n/.test(jobText('append')) &&
  /environment: prod/.test(jobText('prepare')) && /environment: prod/.test(jobText('append')));
ck('workflow: inputs only via env (no expression inside run)', !/run: [^\n]*\$\{\{/.test(wf) &&
  !/run: \|\n(?:\s{10,}[^\n]*\n)*?\s{10,}[^\n]*\$\{\{/.test(wf) &&
  wf.split('\n').filter((l) => /\$\{\{ (inputs|needs)\./.test(l)).every((l) => /^\s+[A-Z_]+: \$\{\{/.test(l) || /^\s+(plan|bundle): \$\{\{/.test(l)));
ck('workflow: actions pinned by hash, short tokens, no credential files', (wf.match(/uses: [^\n@]+@[0-9a-f]{40} /g) || []).length === 5 &&
  (wf.match(/access_token_lifetime: 300s/g) || []).length === 2 && (wf.match(/create_credentials_file: false/g) || []).length === 2 &&
  !/set -x|echo \$OPERATION|echo "\$OPERATION/.test(wf));
ck('workflow: param choices equal the registry (plus NONE)', (() => {
  const m = wf.match(/options:\n((?:\s+- [A-Z0-9_]+\n)+)/);
  const opts = m ? m[1].trim().split('\n').map((l) => l.trim().slice(2)) : [];
  return JSON.stringify(opts) === JSON.stringify(['NONE'].concat(cfg.registry.params.map((p) => p.name)));
})());

// ---------- 7. 受け渡しの確認（G2 に追加） ----------
const tA = issue(3, P(), P(), NOW - 86400000);
const tB = issue(4, P(), P(), NOW - 86400000);
const tC = issue(5, P(), P(), NOW - 86400000);
const tD = issue(6, P(), P(), NOW - 86400000);
const tE = issue(7, P(), P(), NOW - 86400000);
const rowsD = [
  outboxRow(tA, jstTimestamp(NOW - 3600000)),                 // 待ち（1時間）
  outboxRow(tB, jstTimestamp(NOW - ACK_WAIT_MS - 1000)),      // 2時間を過ぎた
  outboxRow(tC, 'not a time'),                                // 書いた時刻が読めない → 2時間を過ぎた扱い
  outboxRow(tD, T), outboxRow(tE, T), r1, r2,
  tam, [r2[0], tA, T], ['x', 'y', 'z'], [r1[0], '', T]
];
const evD = [ackRow(sendIdOf(tD), 'ACCEPTED'), ackRow(sendIdOf(tE), 'IDEMPOTENT'), ackRow(r1[0], 'REJECTED', 'AKANE_BUNDLE_PARAM_STEP'),
  buildRow(ackInput('PROD', r2[0], 'ACCEPTED', null, jstTimestamp(NOW - 5000)), 'PROD', T), ackRow(r2[0], 'IDEMPOTENT'),
  flagRow(rowKeyOf(tam[0], tam[1])), buildRow(ackInput('DEV', sendIdOf(tA), 'ACCEPTED', null, T), 'DEV', T)];
const dr = deliveryReport(evD, rowsD, 'PROD', NOW);
ck('delivery: counts by state', dr.sends === 7 && dr.waiting === 1 && dr.overdue === 2 && dr.accepted === 1 && dr.idempotent === 2 &&
  dr.rejected === 1 && dr.tamperedFlagged === 1 && dr.tamperedUnflagged === 1 && dr.ignored === 2 && dr.intakeRejected === 1 && dr.unknownResult === 0);
ck('delivery: the latest ack of a send is used; acks of the other env are not', dr.idempotent === 2 && dr.waiting === 1);
ck('delivery: warnings counted', dr.warnings === 4);
ck('delivery: the wait is 2 hours (2.5 hours is overdue)', ACK_WAIT_MS === 7200000 &&
  deliveryReport([], [outboxRow(tA, jstTimestamp(NOW - 9000000))], 'PROD', NOW).overdue === 1 &&
  deliveryReport([], [outboxRow(tA, jstTimestamp(NOW - 7000000))], 'PROD', NOW).waiting === 1);
const mdD = deliveryMarkdown(dr);
ck('delivery: markdown has counts only (no ids, no text, no times)', mdD.indexOf('SND_') === -1 && mdD.indexOf('ROW_') === -1 &&
  mdD.indexOf('signature') === -1 && !/\d{4}-\d{2}-\d{2}T/.test(mdD) && /注意の項目：4/.test(mdD));
ck('delivery: empty is all zero', deliveryReport([], [], 'PROD', NOW).warnings === 0 && deliveryReport([], [], 'PROD', NOW).sends === 0);

console.log('G3b issue: ' + passed + ' PASS / ' + failures.length + ' FAIL');

if (failures.length) {
  console.log('FAIL: ' + failures.join(' | '));
  process.exitCode = 1;
}
