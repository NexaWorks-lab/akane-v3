// G1 security の試験（GitHub Actions の CI で実行。秘密は使わない）
//   node security/test.mjs
// 共通の試験データ（vectors.json）と一致するかを確かめる。GAS側は 99 の akane_testG1Vectors が同じデータで確かめる。

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { canonicalJson, parseCanonicalJson } from './canonical.mjs';
import { buildBundle, verifyBundle, sha256Hex, hmacHex } from './bundle.mjs';
import { buildSpecial } from './special.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(fs.readFileSync(path.join(dir, 'vectors.json'), 'utf8'));

let passed = 0;
const failures = [];

function ck(name, ok) {
  if (ok === true) { passed++; } else { failures.push(name); }
}
function errOf(fn) {
  try { fn(); return null; } catch (e) { return e.message; }
}
function keyOf(name) {
  return name === 'other_key' ? V.other_key : V.test_key;
}

V.canonical_valid.forEach((c, i) => ck('canonical_valid #' + i, canonicalJson(c.input) === c.expect));
V.canonical_invalid.forEach((c) => ck('canonical_invalid ' + c.special,
  errOf(() => canonicalJson(buildSpecial(c.special))) === c.expect_error));
V.parse_canonical.forEach((c, i) => {
  const e = errOf(() => parseCanonicalJson(c.source));
  ck('parse_canonical #' + i, c.expect_error ? e === c.expect_error
    : e === null && canonicalJson(parseCanonicalJson(c.source)) === c.expect);
});
V.sha256.forEach((c, i) => ck('sha256 #' + i, sha256Hex(c.text) === c.expect));
V.hmac.forEach((c, i) => ck('hmac #' + i, hmacHex(c.key, c.text) === c.expect));
ck('bundle_build', buildBundle(V.bundle_build.fields, keyOf(V.bundle_build.key)) === V.bundle_build.expect);
V.bundle_verify.forEach((c) => {
  const r = verifyBundle(c.text, { key: keyOf(c.key), env: c.env, nowMs: c.nowMs });
  ck('bundle_verify ' + c.name, c.expect === null ? r.ok === true : (r.ok === false && r.code === c.expect));
});

// 秘密の扱い：鍵の形が違えば発行も検証もしない。結果に鍵が出ない
ck('bad key rejected', errOf(() => buildBundle(V.bundle_build.fields, 'short')) === 'AKANE_BUNDLE_KEY_INVALID' &&
  verifyBundle(V.bundle_build.expect, { key: 'short', env: 'PROD', nowMs: 0 }).code === 'AKANE_BUNDLE_KEY_INVALID');
ck('key never in output', V.bundle_verify.every((c) =>
  JSON.stringify(verifyBundle(c.text, { key: keyOf(c.key), env: c.env, nowMs: c.nowMs })).indexOf(keyOf(c.key)) === -1));

// 設定値の異常（NaN などで期限の確認が素通りしないこと）
const okText = V.bundle_build.expect;
const nowOk = V.bundle_verify.find((c) => c.name === 'ok').nowMs;
const expiredNow = V.bundle_verify.find((c) => c.name === 'expired_exact').nowMs;
const base = { key: V.test_key, env: 'PROD', nowMs: nowOk };
ck('options baseline ok', verifyBundle(okText, base).ok === true);
const badOpts = [
  ['opts_null', null], ['opts_array', []], ['opts_string', 'x'],
  ['now_undefined', { nowMs: undefined }], ['now_nan', { nowMs: NaN }], ['now_infinity', { nowMs: Infinity }],
  ['now_neg_infinity', { nowMs: -Infinity }], ['now_float', { nowMs: nowOk + 0.5 }], ['now_negative', { nowMs: -1 }],
  ['now_string', { nowMs: String(nowOk) }], ['now_null', { nowMs: null }], ['now_date', { nowMs: new Date(nowOk) }],
  ['now_bigint', { nowMs: BigInt(nowOk) }],
  ['days_nan', { validDays: NaN }], ['days_infinity', { validDays: Infinity }], ['days_zero', { validDays: 0 }],
  ['days_negative', { validDays: -1 }], ['days_float', { validDays: 1.5 }], ['days_over', { validDays: 15 }],
  ['days_string', { validDays: '14' }], ['days_null', { validDays: null }],
  ['skew_nan', { skewMinutes: NaN }], ['skew_infinity', { skewMinutes: Infinity }], ['skew_negative', { skewMinutes: -1 }],
  ['skew_float', { skewMinutes: 0.5 }], ['skew_over', { skewMinutes: 11 }], ['skew_string', { skewMinutes: '5' }],
  ['skew_null', { skewMinutes: null }],
  ['env_undefined', { env: undefined }], ['env_lower', { env: 'prod' }]
];
badOpts.forEach(([name, patch]) => {
  const opts = (patch === null || typeof patch !== 'object' || Array.isArray(patch)) ? patch : Object.assign({}, base, patch);
  ck('options ' + name, verifyBundle(okText, opts).code === 'AKANE_BUNDLE_OPTIONS_INVALID');
});
ck('options undefined', verifyBundle(okText, undefined).code === 'AKANE_BUNDLE_OPTIONS_INVALID');
// 期限切れの時刻で、設定値が異常なら必ず拒否（ok にならない）
ck('expired + nan days still rejected', verifyBundle(okText, Object.assign({}, base, { nowMs: expiredNow, validDays: NaN })).ok === false);
// opts はプレーンなオブジェクトだけ。継承した値は使わない
function withProps(target, props) { return Object.assign(target, props); }
function F0() { return JSON.parse(JSON.stringify(V.bundle_build.fields)); }
class Opts {}
ck('opts Date rejected', verifyBundle(okText, withProps(new Date(nowOk), base)).code === 'AKANE_BUNDLE_OPTIONS_INVALID');
ck('opts custom class rejected', verifyBundle(okText, withProps(new Opts(), base)).code === 'AKANE_BUNDLE_OPTIONS_INVALID');
ck('opts custom proto rejected', verifyBundle(okText, withProps(Object.create({ x: 1 }), base)).code === 'AKANE_BUNDLE_OPTIONS_INVALID');
ck('opts Map rejected', verifyBundle(okText, withProps(new Map(), base)).code === 'AKANE_BUNDLE_OPTIONS_INVALID');
ck('opts null proto ok', verifyBundle(okText, withProps(Object.create(null), base)).ok === true);
ck('opts all inherited rejected', verifyBundle(okText, Object.create(base)).code === 'AKANE_BUNDLE_OPTIONS_INVALID');
['key', 'env', 'nowMs'].forEach((k) => {
  const o = Object.assign({}, base); delete o[k];
  ck('opts missing own ' + k + ' rejected', verifyBundle(okText, o).ok === false);
});
// Object.prototype が汚染されても、継承した値は使わない
const POLLUTE = { nowMs: nowOk, env: 'PROD', key: V.test_key, validDays: 0, skewMinutes: NaN };
Object.keys(POLLUTE).forEach((k) => { Object.prototype[k] = POLLUTE[k]; });
try {
  ck('polluted: missing own nowMs rejected', verifyBundle(okText, { key: V.test_key, env: 'PROD' }).code === 'AKANE_BUNDLE_OPTIONS_INVALID');
  ck('polluted: missing own env rejected', verifyBundle(okText, { key: V.test_key, nowMs: nowOk }).code === 'AKANE_BUNDLE_OPTIONS_INVALID');
  ck('polluted: missing own key rejected', verifyBundle(okText, { env: 'PROD', nowMs: nowOk }).code === 'AKANE_BUNDLE_KEY_INVALID');
  ck('polluted: bad inherited days/skew ignored', verifyBundle(okText, Object.assign({}, base)).ok === true);
  ck('polluted: build ignores inherited validDays', buildBundle(F0(), V.test_key, {}) === V.bundle_build.expect);
} finally {
  Object.keys(POLLUTE).forEach((k) => { delete Object.prototype[k]; });
}
ck('build opts Date rejected', errOf(() => buildBundle(F0(), V.test_key, new Date())) === 'AKANE_BUNDLE_OPTIONS_INVALID');
ck('build opts custom proto rejected', errOf(() => buildBundle(F0(), V.test_key, Object.create({ validDays: 14 }))) === 'AKANE_BUNDLE_OPTIONS_INVALID');
// 境界：上限ちょうどは受け入れる
ck('options days 14 / skew 0 ok', verifyBundle(okText, Object.assign({}, base, { validDays: 14, skewMinutes: 0 })).ok === true);
ck('options skew 10 ok', verifyBundle(okText, Object.assign({}, base, { skewMinutes: 10 })).ok === true);
ck('options days 13 rejects 14-day bundle', verifyBundle(okText, Object.assign({}, base, { validDays: 13 })).code === 'AKANE_BUNDLE_FORMAT');
const issuedMs = Date.parse(V.bundle_build.fields.issued_at);
ck('skew 0: 1ms before issued rejected', verifyBundle(okText, Object.assign({}, base, { skewMinutes: 0, nowMs: issuedMs - 1 })).code === 'AKANE_BUNDLE_NOT_YET_VALID');
ck('skew 0: at issued ok', verifyBundle(okText, Object.assign({}, base, { skewMinutes: 0, nowMs: issuedMs })).ok === true);
ck('skew 10: edge ok', verifyBundle(okText, Object.assign({}, base, { skewMinutes: 10, nowMs: issuedMs - 600000 })).ok === true);
ck('skew 10: edge-1 rejected', verifyBundle(okText, Object.assign({}, base, { skewMinutes: 10, nowMs: issuedMs - 600001 })).code === 'AKANE_BUNDLE_NOT_YET_VALID');
ck('expired - 1ms ok', verifyBundle(okText, Object.assign({}, base, { nowMs: expiredNow - 1 })).ok === true);
// 発行側の設定値
const F = V.bundle_build.fields;
[NaN, Infinity, 0, -1, 1.5, 15, '14', null].forEach((d) =>
  ck('build validDays ' + String(d), errOf(() => buildBundle(F, V.test_key, { validDays: d })) === 'AKANE_BUNDLE_OPTIONS_INVALID'));
ck('build opts null', errOf(() => buildBundle(F, V.test_key, null)) === 'AKANE_BUNDLE_OPTIONS_INVALID');
ck('build validDays 13 rejects 14-day', errOf(() => buildBundle(F, V.test_key, { validDays: 13 })) === 'AKANE_BUNDLE_FORMAT');
ck('build validDays 14 same as default', buildBundle(F, V.test_key, { validDays: 14 }) === V.bundle_build.expect);
ck('build fields null', errOf(() => buildBundle(null, V.test_key)) === 'AKANE_BUNDLE_FORMAT');
// 鍵の取り違え：OPERATION 鍵で GOVERNANCE バンドルは通らない（13 は kind で鍵を選ぶ）
const gov = V.bundle_verify.find((c) => c.name === 'governance_ok');
ck('governance bundle with operation key rejected',
  verifyBundle(gov.text, { key: V.test_key, env: 'PROD', nowMs: gov.nowMs }).code === 'AKANE_BUNDLE_SIGNATURE_INVALID');

const total = passed + failures.length;
console.log('G1 security: ' + passed + ' PASS / ' + failures.length + ' FAIL (total ' + total + ')');
if (failures.length) {
  console.log('FAIL: ' + failures.join(', '));
  process.exitCode = 1;
}
