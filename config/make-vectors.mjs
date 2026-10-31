// G3a config：GASと共通の試験データ（config/vectors.json）を作る
//   node config/make-vectors.mjs > config/vectors.json
// GAS側（99の akane_testG3Vectors）：
//   - 00 の憲法などと constitution.json の写しの一致
//   - 送信ID・受信確認の event_id を GAS の SHA-256 で作り直して一致、12 の形として正しいこと
//   - 発行した運用設定一式を 13 の検証（署名・形式・環境・期限）が通すこと
// 中身の規則の場面（body）と取り込みの場面（intake）は、G3b で GAS の 13・取り込みが同じ結果になるかを確かめるために使う。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, checkBundleBody } from './rules.mjs';
import { sendIdOf, ackInput, intakePlan, rowKeyOf, flagInput } from './outbox.mjs';
import { issueOperation } from './issue.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const G1 = JSON.parse(fs.readFileSync(path.join(dir, '..', 'security', 'vectors.json'), 'utf8'));
const cfg = loadConfig(dir);
const B = cfg.baseline.params;
const NOW = Date.parse('2026-11-02T10:00:00+09:00');

const P = (over) => Object.assign({}, B, over || {});
const op = { experiment_id: null };

// ---------- 中身の規則 ----------
const bodyCases = [
  ['baseline_ok', 'OPERATION', { schema: 1, params: P() }, op, null],
  ['one_int_change_ok', 'OPERATION', { schema: 1, params: P({ B_BULLET_PCT: 35 }) }, op, null],
  ['one_enum_change_ok', 'OPERATION', { schema: 1, params: P({ FIRST_LINE_STYLE: 'MURMUR' }) }, op, null],
  ['governance_disabled', 'GOVERNANCE', { schema: 1, params: P() }, op, null],
  ['experiment_not_allowed', 'OPERATION', { schema: 1, params: P() }, { experiment_id: 'EXP_1' }, null],
  ['shape_extra_key', 'OPERATION', { schema: 1, params: P(), x: 1 }, op, null],
  ['shape_schema', 'OPERATION', { schema: 2, params: P() }, op, null],
  ['shape_params_array', 'OPERATION', { schema: 1, params: [] }, op, null],
  ['param_unknown', 'OPERATION', { schema: 1, params: P({ NEW_PARAM: 1 }) }, op, null],
  ['param_missing', 'OPERATION', { schema: 1, params: (() => { const p = P(); delete p.LINK_POSITION; return p; })() }, op, null],
  ['param_type_int', 'OPERATION', { schema: 1, params: P({ NORMAL_LINES_MAX: '4' }) }, op, null],
  ['param_type_enum', 'OPERATION', { schema: 1, params: P({ PRODUCT_SLOT: 4 }) }, op, null],
  ['param_range_low', 'OPERATION', { schema: 1, params: P({ NORMAL_EMOJI_MAX: 0 }) }, op, null],
  ['param_range_high', 'OPERATION', { schema: 1, params: P({ NORMAL_LINES_MAX: 5 }) }, op, null],
  ['param_range_enum', 'OPERATION', { schema: 1, params: P({ LINK_POSITION: 'PROFILE' }) }, op, null],
  ['param_step_from_baseline', 'OPERATION', { schema: 1, params: P({ B_BULLET_PCT: 45 }) }, op, null],
  ['param_step_from_previous_ok', 'OPERATION', { schema: 1, params: P({ B_BULLET_PCT: 45 }) }, op, P({ B_BULLET_PCT: 35 })],
  ['param_drift', 'OPERATION', { schema: 1, params: P({ B_BULLET_PCT: 50 }) }, op, P({ B_BULLET_PCT: 45 })],
  ['param_drift_low', 'OPERATION', { schema: 1, params: P({ THEME_SEASON_BONUS_X10: 0 }) }, op, P({ THEME_SEASON_BONUS_X10: 5 })],
  ['param_drift_edge_ok', 'OPERATION', { schema: 1, params: P({ THEME_RECENT_PENALTY_PCT: 50 }) }, op, P({ THEME_RECENT_PENALTY_PCT: 75 })],
  ['too_many_changes', 'OPERATION', { schema: 1, params: P({ B_BULLET_PCT: 35, PRODUCT_SLOT: 'S3' }) }, op, null],
  ['two_changes_vs_baseline_one_vs_previous_ok', 'OPERATION', { schema: 1, params: P({ B_BULLET_PCT: 35, PRODUCT_SLOT: 'S3' }) }, op, P({ B_BULLET_PCT: 35 })],
  ['previous_invalid', 'OPERATION', { schema: 1, params: P() }, op, { B_BULLET_PCT: 25 }],
  ['emoji_range_respects_owner_min', 'OPERATION', { schema: 1, params: P({ NORMAL_EMOJI_MAX: 2 }) }, op, null]
].map(([name, kind, body, bundle, previous]) => {
  const r = checkBundleBody(kind, body, bundle, { registry: cfg.registry, baseline: cfg.baseline, previous });
  return { name, kind, body, experiment_id: bundle.experiment_id, previous, expect: r.ok ? null : r.code, param: r.param };
});

// ---------- 送信ID・受信確認 ----------
const texts = ['{"a":1}', 'あかね', 'x'.repeat(300)];
const sendIds = texts.map((t) => ({ text: t, expect: sendIdOf(t) }));
const sid = sendIdOf('{"a":1}');
const T0 = '2026-11-02T10:00:00+09:00';
const T1 = '2026-11-02T11:00:00+09:00';
const acks = [
  ['PROD', sid, 'ACCEPTED', null, T0], ['PROD', sid, 'IDEMPOTENT', null, T0], ['PROD', sid, 'REJECTED', 'AKANE_BUNDLE_VERSION_OLD', T0],
  ['DEV', sid, 'ACCEPTED', null, T0], ['PROD', sid, 'ACCEPTED', null, T1]
].map(([env, s, result, code, at]) => ({ env, send_id: s, result, code, observed_at: at,
  expect: ackInput(env, s, result, code, at) }));
const rk = rowKeyOf(sendIdOf('BUNDLE_V1'), 'BUNDLE_V2');
const flags = [['PROD', rk, 'AKANE_INTAKE_SEND_ID_MISMATCH', T0]].map(([env, k, code, at]) => ({ env, row_key: k, code, observed_at: at,
  claimed: sendIdOf('BUNDLE_V1'), text: 'BUNDLE_V2', expect: flagInput(env, k, code, at) }));

// ---------- 発行（G1 の試験用の鍵） ----------
const issued = issueOperation({ config: cfg, params: P({ B_BULLET_PCT: 35 }), previous: null, env: 'PROD', version: 1,
  nowMs: NOW, key: G1.test_key });

// ---------- 取り込みの場面（設計案 v0.2 5.1） ----------
const t1 = 'BUNDLE_V1';
const t2 = 'BUNDLE_V2';
const t3 = 'BUNDLE_V3';
const row = (t) => [sendIdOf(t), t, '2026-11-02T10:00:00+09:00'];
const R = {
  accepted: { ok: true, accepted: true },
  idempotent: { ok: true, idempotent: true },
  old: { ok: false, code: 'AKANE_BUNDLE_VERSION_OLD', notify: false },
  conflict: { ok: false, code: 'AKANE_BUNDLE_SAME_VERSION_DIFFERENT_HASH', notify: true, f9: true },
  expired: { ok: false, code: 'AKANE_BUNDLE_EXPIRED', notify: false },
  signature: { ok: false, code: 'AKANE_BUNDLE_SIGNATURE_INVALID', notify: true },
  body: { ok: false, code: 'AKANE_BUNDLE_PARAM_RANGE', notify: true },
  writeUnknown: { ok: false, code: 'AKANE_EVENT_WRITE_UNKNOWN', notify: true, writeUnknown: true },
  recordFailed: { ok: false, code: 'AKANE_EVENT_APPEND_FAILED', notify: true, retryable: true },
  eventsUnreadable: { ok: false, code: 'AKANE_BUNDLE_EVENTS_UNREADABLE', notify: true },
  rulesMissing: { ok: false, code: 'AKANE_BUNDLE_BODY_RULES_MISSING', notify: true },
  notYet: { ok: false, code: 'AKANE_BUNDLE_NOT_YET_VALID', notify: false },
  failed: { ok: false, code: 'AKANE_BUNDLE_FAILED', notify: true },
  previousInvalid: { ok: false, code: 'AKANE_BUNDLE_PREVIOUS_INVALID', notify: true }
};
const intakeCases = [
  ['new_version_accepted', [row(t1)], [], { [t1]: 'accepted' }],
  ['already_acked_skipped', [row(t1)], [sendIdOf(t1)], { [t1]: 'accepted' }],
  ['same_row_twice_in_one_run', [row(t1), row(t1)], [], { [t1]: 'accepted' }],
  ['resend_idempotent', [row(t1)], [], { [t1]: 'idempotent' }],
  ['same_version_different_hash', [row(t2)], [], { [t2]: 'conflict' }],
  ['old_version', [row(t2)], [], { [t2]: 'old' }],
  ['expired_and_signature', [row(t1), row(t2)], [], { [t1]: 'expired', [t2]: 'signature' }],
  ['body_rule_rejected', [row(t3)], [], { [t3]: 'body' }],
  ['send_id_mismatch', [[sendIdOf(t1), t2, 'x']], [], { [t2]: 'accepted' }],
  ['mismatch_then_real_row_of_claimed_id', [[sendIdOf(t1), t2, 'x'], row(t1)], [], { [t1]: 'accepted', [t2]: 'accepted' }],
  ['mismatch_then_real_row_of_same_text', [[sendIdOf(t1), t2, 'x'], row(t2)], [], { [t1]: 'accepted', [t2]: 'accepted' }],
  ['real_row_then_mismatch', [row(t2), [sendIdOf(t1), t2, 'x'], row(t1)], [], { [t1]: 'accepted', [t2]: 'accepted' }],
  ['mismatch_already_flagged_skipped', [[sendIdOf(t1), t2, 'x'], row(t2)], [], { [t2]: 'accepted' }, [rk]],
  ['previous_invalid_retry', [row(t1)], [], { [t1]: 'previousInvalid' }],
  ['write_unknown_retry', [row(t1)], [], { [t1]: 'writeUnknown' }],
  ['record_failed_retry', [row(t1)], [], { [t1]: 'recordFailed' }],
  ['transient_codes_retry', [row(t1), row(t2), row(t3)], [], { [t1]: 'eventsUnreadable', [t2]: 'rulesMissing', [t3]: 'notYet' }],
  ['unexpected_failure_retry', [row(t1)], [], { [t1]: 'failed' }],
  ['bad_rows_ignored', [['x', t1, 'y'], [sendIdOf(t1)], 'z', [sendIdOf(t1), '', 'y']], [], {}],
  ['accept_after_ack_failure', [row(t1)], [], { [t1]: 'idempotent' }]
].map(([name, rows, acked, results, flagged]) => ({
  name, rows, acked, results, flagged: flagged || [],
  expect: intakePlan(rows, new Set(acked), (text) => (results[text] ? R[results[text]] : { ok: false, code: 'AKANE_TEST_NO_RESULT' }),
    new Set(flagged || []))
}));
const limitRows = [];
for (let i = 0; i < 22; i++) { limitRows.push(row('B' + i)); }
intakeCases.push({ name: 'at_most_20_per_run', rows: limitRows, acked: [], results: {}, flagged: [], all: 'accepted',
  expect: intakePlan(limitRows, new Set(), () => R.accepted) });

process.stdout.write(JSON.stringify({
  note: 'G3a 共通試験データ。GAS 99 akane_testG3Vectors と config/test.mjs が使う。手で編集しない（make-vectors.mjs で作る）',
  constitution: cfg.constitution,
  test_key: G1.test_key,
  now_ms: NOW,
  issued,
  send_ids: sendIds,
  acks,
  flags,
  results: R,
  body: bodyCases,
  intake: intakeCases
}, null, 1) + '\n');
