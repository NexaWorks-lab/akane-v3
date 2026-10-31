// G3a config の試験（GitHub Actions の CI で実行。秘密も通信も使わない。鍵は G1 の試験用の公開してよい鍵だけ）
//   node config/test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../security/canonical.mjs';
import { verifyBundle } from '../security/bundle.mjs';
import { validEventId, validSubjectKey, buildRow, rowToRecord, reconstruct } from '../data/events.mjs';
import { loadConfig, validateConfig, checkBundleBody, checkOperationBody, checkParamsInRange } from './rules.mjs';
import { sendIdOf, validSendId, ackEventId, ackInput, intakePlan, outboxRow, FINAL_REJECT_CODES, MAX_ROWS_PER_RUN, rowKeyOf, flagInput } from './outbox.mjs';
import { issueOperation, jstTimestamp } from './issue.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(fs.readFileSync(path.join(dir, 'vectors.json'), 'utf8'));
const cfg = loadConfig(dir);
const B = cfg.baseline.params;

let passed = 0;
const failures = [];

function ck(name, ok) {
  if (ok === true) { passed++; } else { failures.push(name); }
}
function errOf(fn) {
  try { fn(); return null; } catch (e) { return e.message; }
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const ctx = (previous) => ({ registry: cfg.registry, baseline: cfg.baseline, previous: previous === undefined ? null : previous });

// ---------- 1. 設定の定義 ----------
ck('config loads and validates', validateConfig(cfg) === true);
ck('vectors carry the same constitution copy', canonicalJson(clone(V.constitution)) === canonicalJson(clone(cfg.constitution)));
ck('allowlist types equal the constitution copy (E1..E7)', JSON.stringify(cfg.allowlist.experiments.map((e) => e.type)) ===
  JSON.stringify(cfg.constitution.EXPERIMENT_TYPES));
ck('every experiment in the allowlist has at least one parameter', cfg.constitution.EXPERIMENT_TYPES.every((t) =>
  cfg.registry.params.some((p) => p.experiment === t)));
ck('baseline is inside the registry', checkParamsInRange(B, cfg.registry).ok === true);
ck('baseline = current 02 behaviour (owner approved v0.2)', canonicalJson(B) === canonicalJson({
  B_BULLET_PCT: 25, FIRST_LINE_STYLE: 'SCENE', LINK_POSITION: 'REPLY', NORMAL_EMOJI_MAX: 3, NORMAL_LINES_MAX: 4,
  PRODUCT_ANGLE_MODE: 'ROTATE', PRODUCT_SLOT: 'S4', THEME_RECENT_PENALTY_PCT: 100, THEME_SEASON_BONUS_X10: 15
}));
const constKeys = JSON.stringify(cfg.constitution);
ck('registry does not contain constitution items (inviolable stays out of the parameter table)', cfg.registry.params.every((p) =>
  constKeys.indexOf('"' + p.name + '"') === -1) && !cfg.registry.params.some((p) => /POST_MAX|PRODUCT_POST_TARGET|DISCLOSURE|EXPERIENCE|PRICE/.test(p.name)));
ck('owner-fixed minimums are outside the table (emoji at least 1, lines at least 3 in range)',
  cfg.registry.params.find((p) => p.name === 'NORMAL_EMOJI_MAX').min === 1 &&
  cfg.registry.params.find((p) => p.name === 'NORMAL_LINES_MAX').min === 3);

function broken(mut) {
  const c = clone(cfg);
  mut(c);
  return errOf(() => validateConfig(c));
}
ck('config: duplicate parameter name rejected', /PARAM_NAME/.test(broken((c) => { c.registry.params[1].name = c.registry.params[0].name; })));
ck('config: unknown experiment rejected', /PARAM_EXPERIMENT/.test(broken((c) => { c.registry.params[0].experiment = 'E9'; })));
ck('config: int without step / min>max rejected', /PARAM_INT/.test(broken((c) => { delete c.registry.params[0].step; })) &&
  /PARAM_INT/.test(broken((c) => { c.registry.params[0].min = 99; })));
ck('config: enum with one value / duplicate / lowercase rejected', /PARAM_ENUM/.test(broken((c) => { c.registry.params[3].values = ['SCENE']; })) &&
  /PARAM_ENUM/.test(broken((c) => { c.registry.params[3].values = ['SCENE', 'SCENE']; })) &&
  /PARAM_ENUM/.test(broken((c) => { c.registry.params[3].values = ['SCENE', 'murmur']; })));
ck('config: unknown parameter type rejected', /PARAM_TYPE/.test(broken((c) => { c.registry.params[0].type = 'FLOAT'; })));
ck('config: baseline outside the table rejected', /BASELINE_PARAM_RANGE/.test(broken((c) => { c.baseline.params.NORMAL_LINES_MAX = 5; })) &&
  /BASELINE_PARAM_MISSING/.test(broken((c) => { delete c.baseline.params.LINK_POSITION; })) &&
  /BASELINE_PARAM_UNKNOWN/.test(broken((c) => { c.baseline.params.X = 1; })));
ck('config: allowlist must match constitution types', /ALLOWLIST_TYPES/.test(broken((c) => { c.allowlist.experiments.pop(); })) &&
  /ALLOWLIST_UNIT/.test(broken((c) => { c.allowlist.experiments[0].unit = 'WEEK'; })));
ck('config: registry schema / max changes', /REGISTRY/.test(broken((c) => { c.registry.schema = 2; })) &&
  /REGISTRY/.test(broken((c) => { c.registry.max_changed_params = 0; })));

// ---------- 2. 中身の規則（共通の試験データ） ----------
V.body.forEach((c) => {
  const r = checkBundleBody(c.kind, c.body, { experiment_id: c.experiment_id }, ctx(c.previous));
  ck('body ' + c.name, (c.expect === null ? r.ok === true : (r.ok === false && r.code === c.expect)) && r.param === c.param);
});

// すべての整数の項目・すべての値（範囲の外も）で、絶対範囲 → 1回の変更幅 → 累積の上限 の順に正しく判定する
let exhaustive = true;
cfg.registry.params.filter((p) => p.type === 'INT').forEach((p) => {
  for (let prevV = p.min; prevV <= p.max; prevV++) {
    for (let v = p.min - 2; v <= p.max + 2; v++) {
      const prev = Object.assign({}, B, { [p.name]: prevV });
      const prevOk = Math.abs(prevV - B[p.name]) <= p.drift;
      const r = checkOperationBody({ schema: 1, params: Object.assign({}, B, { [p.name]: v }) }, ctx(prevOk ? prev : null));
      const ref = prevOk ? prevV : B[p.name];
      let want = null;
      if (v < p.min || v > p.max) { want = 'AKANE_BUNDLE_PARAM_RANGE'; }
      else if (Math.abs(v - ref) > p.step) { want = 'AKANE_BUNDLE_PARAM_STEP'; }
      else if (Math.abs(v - B[p.name]) > p.drift) { want = 'AKANE_BUNDLE_PARAM_DRIFT'; }
      if ((want === null) !== r.ok || (want !== null && r.code !== want)) { exhaustive = false; }
    }
  }
});
ck('every int value: range, step and drift in this order', exhaustive);
ck('enum: any listed value, one change at a time', cfg.registry.params.filter((p) => p.type === 'ENUM').every((p) =>
  p.values.every((v) => checkOperationBody({ schema: 1, params: Object.assign({}, B, { [p.name]: v }) }, ctx()).ok === true)));
ck('inherited / prototype keys are not params', checkOperationBody({ schema: 1, params: Object.create(Object.assign({}, B)) }, ctx()).code ===
  'AKANE_BUNDLE_BODY_SHAPE' && checkOperationBody(Object.assign(Object.create({ schema: 1 }), { params: B }), ctx()).code === 'AKANE_BUNDLE_BODY_SHAPE');
ck('broken context -> rejected, no exception', checkOperationBody({ schema: 1, params: B }, null).code === 'AKANE_BUNDLE_BODY_REJECTED' &&
  checkBundleBody('X', {}, {}, ctx()).code === 'AKANE_BUNDLE_BODY_REJECTED' &&
  checkBundleBody('OPERATION', { schema: 1, params: B }, null, ctx()).code === 'AKANE_BUNDLE_EXPERIMENT_NOT_ALLOWED');
ck('rule results never carry values', V.body.every((c) => {
  const r = checkBundleBody(c.kind, c.body, { experiment_id: c.experiment_id }, ctx(c.previous));
  return Object.keys(r).sort().join(',') === 'code,ok,param';
}));

// ---------- 3. 発行 ----------
const K = V.test_key;
const v1 = verifyBundle(V.issued, { key: K, env: 'PROD', nowMs: V.now_ms });
ck('issued bundle (vectors) verifies with G1, kind OPERATION, experiment null, 14 days', v1.ok === true &&
  v1.bundle.kind === 'OPERATION' && v1.bundle.experiment_id === null && v1.bundle.version === 1 &&
  Date.parse(v1.bundle.expires_at) - Date.parse(v1.bundle.issued_at) === 14 * 86400000 &&
  canonicalJson(v1.bundle.body) === canonicalJson({ schema: 1, params: Object.assign({}, B, { B_BULLET_PCT: 35 }) }));
ck('issue is deterministic', issueOperation({ config: cfg, params: Object.assign({}, B, { B_BULLET_PCT: 35 }), previous: null, env: 'PROD',
  version: 1, nowMs: V.now_ms, key: K }) === V.issued);
const iss = (o) => errOf(() => issueOperation(Object.assign({ config: cfg, params: B, previous: null, env: 'PROD', version: 2, nowMs: V.now_ms, key: K }, o)));
ck('issue refuses bodies the GAS would refuse (same rules)', iss({ params: Object.assign({}, B, { B_BULLET_PCT: 50 }) }) === 'AKANE_BUNDLE_PARAM_STEP' &&
  iss({ params: Object.assign({}, B, { X: 1 }) }) === 'AKANE_BUNDLE_PARAM_UNKNOWN' &&
  iss({ params: Object.assign({}, B, { B_BULLET_PCT: 35, PRODUCT_SLOT: 'S3' }) }) === 'AKANE_BUNDLE_PARAM_TOO_MANY_CHANGES');
ck('issue refuses bad inputs and bad keys (key never in the message)', iss({ env: 'STAGE' }) === 'AKANE_ISSUE_INPUT_INVALID' &&
  iss({ version: 0 }) === 'AKANE_ISSUE_INPUT_INVALID' && iss({ nowMs: -1 }) === 'AKANE_ISSUE_INPUT_INVALID' &&
  iss({ key: 'short' }) === 'AKANE_BUNDLE_KEY_INVALID' && iss({ config: null }) === 'AKANE_ISSUE_INPUT_INVALID' &&
  V.issued.indexOf(K) === -1);
ck('issued bundle fails for the other env / other key', verifyBundle(V.issued, { key: K, env: 'DEV', nowMs: V.now_ms }).code === 'AKANE_BUNDLE_ENV_MISMATCH' &&
  verifyBundle(V.issued, { key: 'f'.repeat(64), env: 'PROD', nowMs: V.now_ms }).code === 'AKANE_BUNDLE_SIGNATURE_INVALID');
ck('jst timestamp', jstTimestamp(Date.parse('2026-11-02T00:00:00Z')) === '2026-11-02T09:00:00+09:00');

// ---------- 4. 送信箱・受信確認・取り込み ----------
const T0 = '2026-11-02T10:00:00+09:00';
const T1 = '2026-11-02T11:00:00+09:00';
ck('send ids (vectors)', V.send_ids.every((c) => sendIdOf(c.text) === c.expect && validSendId(c.expect)));
// 実装から独立した固定値（推奨1）
ck('fixed values: send id / ack id / flag id / row key', sendIdOf('{"a":1}') === 'SND_015abd7f5cc57a2dd94b7590f04ad808' &&
  ackEventId('PROD', 'SND_015abd7f5cc57a2dd94b7590f04ad808', 'ACCEPTED', null, T0) === 'EVT_3dbde48f-43bb-6315-cdf0-8ecf7931b6b9' &&
  rowKeyOf(sendIdOf('BUNDLE_V1'), 'BUNDLE_V2') === 'ROW_b34741c7cd296fdfc7eae3ea33b1c997' &&
  flagInput('PROD', 'ROW_b34741c7cd296fdfc7eae3ea33b1c997', 'AKANE_INTAKE_SEND_ID_MISMATCH', T0).event_id === 'EVT_c9cdc2bc-7ca3-60d5-7ef4-87c6f9e2a3f5');
ck('ack inputs (vectors) and the 12 event format', V.acks.every((c) => {
  const a = ackInput(c.env, c.send_id, c.result, c.code, c.observed_at);
  const row = buildRow(a, c.env, c.observed_at);
  return canonicalJson(a) === canonicalJson(c.expect) && validEventId(a.event_id) && validSubjectKey(a.subject_key, 'DELIVERY_ACK') &&
    rowToRecord(row) !== null;
}));
ck('ack ids: result / env / code / time change the id', new Set(V.acks.map((c) => c.expect.event_id)).size === V.acks.length);
ck('flag inputs (vectors) and the 12 event format', V.flags.every((c) => {
  const f = flagInput(c.env, c.row_key, c.code, c.observed_at);
  return canonicalJson(f) === canonicalJson(c.expect) && rowKeyOf(c.claimed, c.text) === c.row_key && validEventId(f.event_id) &&
    validSubjectKey(f.subject_key, 'INTAKE_REJECTED') && rowToRecord(buildRow(f, c.env, c.observed_at)) !== null &&
    JSON.stringify(f).indexOf(c.text) === -1;
}));

// 必須2：同じ受信確認の再試行。同じ時刻なら記録の中身まで同じ（12 の重複排除で1件）。別の時刻なら別の記録で、衝突しない
const sid0 = V.acks[0].send_id;
const a0 = ackInput('PROD', sid0, 'ACCEPTED', null, T0);
const a0again = ackInput('PROD', sid0, 'ACCEPTED', null, T0);
const a1 = ackInput('PROD', sid0, 'ACCEPTED', null, T1);
const recs = [buildRow(a0, 'PROD', T0), buildRow(a0again, 'PROD', T0), buildRow(a1, 'PROD', T1)].map(rowToRecord);
const rec = reconstruct(recs);
ck('ack retry: same time -> identical event; other time -> other id; no id conflict, latest adopted',
  canonicalJson(a0) === canonicalJson(a0again) && a0.event_id !== a1.event_id && rec.anomalies.length === 0 &&
  rec.quarantined.length === 0 && rec.subjects['DELIVERY_ACK:' + sid0].adopted.event_id === a1.event_id);
ck('ack / flag inputs refuse bad values', errOf(() => ackInput('PROD', 'SND_x', 'ACCEPTED', null, T0)) === 'AKANE_INTAKE_ACK_INVALID' &&
  errOf(() => ackInput('PROD', sid0, 'DONE', null, T0)) === 'AKANE_INTAKE_ACK_INVALID' &&
  errOf(() => ackInput('QA', sid0, 'ACCEPTED', null, T0)) === 'AKANE_INTAKE_ACK_INVALID' &&
  errOf(() => ackInput('PROD', sid0, 'REJECTED', 'bad code', T0)) === 'AKANE_INTAKE_ACK_INVALID' &&
  errOf(() => ackInput('PROD', sid0, 'ACCEPTED', null, '2026-11-02')) === 'AKANE_INTAKE_ACK_INVALID' &&
  errOf(() => flagInput('PROD', 'ROW_x', 'AKANE_X', T0)) === 'AKANE_INTAKE_FLAG_INVALID' &&
  errOf(() => flagInput('PROD', V.flags[0].row_key, 'x', T0)) === 'AKANE_INTAKE_FLAG_INVALID');
ck('outbox row', canonicalJson(outboxRow('abc', 't')) === canonicalJson([sendIdOf('abc'), 'abc', 't']) &&
  errOf(() => outboxRow('', 't')) === 'AKANE_OUTBOX_ROW_INVALID');

V.intake.forEach((c) => {
  const accept = (text) => (c.all ? V.results[c.all] : (c.results[text] ? V.results[c.results[text]] : { ok: false, code: 'AKANE_TEST_NO_RESULT' }));
  ck('intake ' + c.name, canonicalJson(intakePlan(c.rows, new Set(c.acked), accept, new Set(c.flagged))) === canonicalJson(c.expect));
});
// 期待する結果の固定値（推奨1：実装から独立）
const shape = (name) => V.intake.find((c) => c.name === name).expect.map((e) => e.action + (e.result ? ':' + e.result : ''));
ck('intake fixed expectations', JSON.stringify(shape('mismatch_then_real_row_of_claimed_id')) === '["FLAG","ACK:ACCEPTED"]' &&
  JSON.stringify(shape('mismatch_then_real_row_of_same_text')) === '["FLAG","ACK:ACCEPTED"]' &&
  JSON.stringify(shape('real_row_then_mismatch')) === '["ACK:ACCEPTED","FLAG","ACK:ACCEPTED"]' &&
  JSON.stringify(shape('mismatch_already_flagged_skipped')) === '["SKIP","ACK:ACCEPTED"]' &&
  JSON.stringify(shape('previous_invalid_retry')) === '["RETRY"]' &&
  JSON.stringify(shape('same_version_different_hash')) === '["ACK:REJECTED"]' &&
  JSON.stringify(shape('accept_after_ack_failure')) === '["ACK:IDEMPOTENT"]');
const lim = V.intake.find((c) => c.name === 'at_most_20_per_run');
ck('intake: at most 20 handled per run', lim.expect.length === MAX_ROWS_PER_RUN);
ck('intake: retry never writes an ack; flags never carry a send id', V.intake.every((c) => c.expect.every((e) =>
  (e.action !== 'RETRY' || e.result === null) && (e.action !== 'FLAG' || (e.sendId === null && e.rowKey !== null)))));
ck('final reject codes: 13 or G3 codes only; PREVIOUS_INVALID is retried', FINAL_REJECT_CODES.every((x) => /^AKANE_BUNDLE_[A-Z0-9_]+$/.test(x)) &&
  FINAL_REJECT_CODES.indexOf('AKANE_BUNDLE_PREVIOUS_INVALID') === -1 && FINAL_REJECT_CODES.indexOf('AKANE_BUNDLE_NOT_YET_VALID') === -1 &&
  FINAL_REJECT_CODES.indexOf('AKANE_BUNDLE_BODY_RULES_MISSING') === -1);
// 必須1：書き換えた行は、正しい行の状態（受信確認・この回の処理済み）に触れない（どちらの順番でも）
const tReal = 'REAL';
const tamper = [sendIdOf(tReal), 'OTHER', 'x'];
const tamper2 = [sendIdOf('OTHER2'), tReal, 'x'];
const okAll = () => ({ ok: true, accepted: true });
const p1 = intakePlan([tamper, [sendIdOf(tReal), tReal, 'x']], new Set(), okAll);
const p2 = intakePlan([tamper2, [sendIdOf(tReal), tReal, 'x']], new Set(), okAll);
const p3 = intakePlan([[sendIdOf(tReal), tReal, 'x'], tamper, tamper2], new Set(), okAll);
ck('intake: tampered rows never mark the real send id (both orders)', p1[1].action === 'ACK' && p1[1].sendId === sendIdOf(tReal) &&
  p2[1].action === 'ACK' && p2[1].sendId === sendIdOf(tReal) && p3.map((e) => e.action).join(',') === 'ACK,FLAG,FLAG' &&
  p3[1].rowKey !== p3[2].rowKey);
ck('intake: the same tampered row twice in one run is flagged once', intakePlan([tamper, tamper], new Set(), okAll).map((e) => e.action).join(',') ===
  'FLAG,SKIP');
ck('intake: accept throwing -> retry', intakePlan([[sendIdOf('t'), 't', 'x']], new Set(), () => { throw new Error('x'); })[0].action === 'RETRY');
ck('intake: ok without accepted/idempotent -> retry (not acked)', intakePlan([[sendIdOf('t'), 't', 'x']], new Set(), () => ({ ok: true }))[0].action === 'RETRY');

// ---------- 5. このディレクトリのコードは通信も書き込みもしない ----------
const src = ['rules.mjs', 'outbox.mjs', 'issue.mjs'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
ck('static: no network, no environment secrets, no logging', !/fetch\(|https?:\/\/|process\.env|console\.log/.test(src));

const total = passed + failures.length;
console.log('G3a config: ' + passed + ' PASS / ' + failures.length + ' FAIL (total ' + total + ')');
if (failures.length) {
  console.log('FAIL: ' + failures.join(', '));
  process.exitCode = 1;
}
