// 共通の試験データ（security/vectors.json）を作る。手元で1回実行して、結果をリポジトリに置く。
//   node security/make-vectors.mjs > security/vectors.json
// 試験用の鍵は公開してよい固定値（本番の鍵ではない）。

import { canonicalJson, parseCanonicalJson } from './canonical.mjs';
import { buildBundle, sha256Hex, hmacHex } from './bundle.mjs';
import { buildSpecial } from './special.mjs';

const TEST_KEY = sha256Hex('akane-v3-g1-public-test-key-not-a-secret');
const OTHER_KEY = sha256Hex('akane-v3-g1-other-test-key');

function code(fn) {
  try { fn(); return null; } catch (e) { return e.message; }
}

const valid = [
  null, true, false, 0, 1, -1, 9007199254740991, -9007199254740991,
  '', 'a', 'あかね', '絵文字😀', 'quote"back\\slash', 'line\nbreak\ttab', '\u0001\u001f', '  ', 'é', '/',
  [], [1, 'a', null], [[[]]], {}, { b: 1, a: 2 }, { 'a.b': 1, 'a-b': 2, a_b: 3, A: 4, a: 5, '0': 6, '10': 7, '9': 8 },
  { nested: { z: [1, { y: 'x' }], a: false } }, { body: { slot: 'S1', weights: [3, 2, 1] }, version: 7 }
];

const special = [
  'NEG_ZERO', 'NAN', 'INFINITY', 'FLOAT', 'UNSAFE_INT', 'UNDEFINED', 'FUNCTION', 'DATE', 'MAP', 'SPARSE_ARRAY',
  'CIRCULAR', 'KEY_SPACE', 'KEY_JAPANESE', 'KEY_EMPTY', 'KEY_PROTO', 'KEY_CONSTRUCTOR', 'KEY_PROTOTYPE',
  'LONE_HIGH', 'LONE_LOW', 'REVERSED_PAIR', 'NESTED_UNDEFINED', 'BIGINT', 'SYMBOL'
];

const parseSources = [
  '{"a":1}', '{ "a":1}', '{"b":1,"a":2}', '', '   ', '{a}', '1.0', '1', '{"a":1,"a":2}',
  '"\\u00e9"', '"é"', '[1,2]', '[1, 2]', 'null', '{"x":1e3}', '{"x":-0}', '"\\ud800"', '{"__proto__":1}',
  '{"k":"\\u2028"}', '{"k":" "}', '{"k":"\\/"}', '{"k":"/"}'
];

const bundleFields = {
  kind: 'OPERATION', env: 'PROD', version: 3,
  issued_at: '2026-11-01T09:00:00+09:00', expires_at: '2026-11-15T09:00:00+09:00',
  experiment_id: 'EXP_E3_001',
  body: { first_line_type: { A: 'scene', B: 'murmur' }, emoji_range: [1, 3], note: 'テスト' }
};
const okText = buildBundle(bundleFields, TEST_KEY);
const ok = JSON.parse(okText);
const NOW = Date.parse('2026-11-02T00:00:00+09:00');

function reSign(mut, key = TEST_KEY, rehash = true) {
  const b = JSON.parse(okText);
  mut(b);
  if (rehash) {
    const c = { body: b.body, env: b.env, experiment_id: b.experiment_id, expires_at: b.expires_at,
      issued_at: b.issued_at, kind: b.kind, v: b.v, version: b.version };
    b.content_hash = sha256Hex(canonicalJson(c));
  }
  const u = Object.assign({}, b);
  delete u.signature;
  b.signature = hmacHex(key, canonicalJson(u));
  return canonicalJson(b);
}

const verifyCases = [
  { name: 'ok', text: okText, env: 'PROD', nowMs: NOW, expect: null },
  { name: 'ok_at_skew_edge', text: okText, env: 'PROD', nowMs: Date.parse('2026-11-01T08:55:00+09:00'), expect: null },
  { name: 'not_yet_valid', text: okText, env: 'PROD', nowMs: Date.parse('2026-11-01T08:54:59+09:00'), expect: 'AKANE_BUNDLE_NOT_YET_VALID' },
  { name: 'expired_exact', text: okText, env: 'PROD', nowMs: Date.parse('2026-11-15T09:00:00+09:00'), expect: 'AKANE_BUNDLE_EXPIRED' },
  { name: 'wrong_env', text: okText, env: 'DEV', nowMs: NOW, expect: 'AKANE_BUNDLE_ENV_MISMATCH' },
  { name: 'wrong_key', text: okText, env: 'PROD', nowMs: NOW, key: OTHER_KEY, expect: 'AKANE_BUNDLE_SIGNATURE_INVALID' },
  { name: 'body_tampered', text: okText.replace('"murmur"', '"murmor"'), env: 'PROD', nowMs: NOW, expect: 'AKANE_BUNDLE_SIGNATURE_INVALID' },
  { name: 'version_tampered', text: okText.replace('"version":3', '"version":4'), env: 'PROD', nowMs: NOW, expect: 'AKANE_BUNDLE_SIGNATURE_INVALID' },
  { name: 'hash_wrong_but_signed', text: reSign((b) => { b.body.note = 'x'; }, TEST_KEY, false), env: 'PROD', nowMs: NOW, expect: 'AKANE_BUNDLE_HASH_MISMATCH' },
  { name: 'not_canonical_space', text: okText.replace('{"body"', '{ "body"'), env: 'PROD', nowMs: NOW, expect: 'AKANE_BUNDLE_FORMAT' },
  { name: 'extra_key', text: reSign((b) => { b.extra = 1; }), env: 'PROD', nowMs: NOW, expect: 'AKANE_BUNDLE_FORMAT' },
  { name: 'validity_over_14_days', text: reSign((b) => { b.expires_at = '2026-11-15T09:00:01+09:00'; }), env: 'PROD', nowMs: NOW, expect: 'AKANE_BUNDLE_FORMAT' },
  { name: 'bad_time_format', text: reSign((b) => { b.issued_at = '2026-11-01 09:00:00'; }), env: 'PROD', nowMs: NOW, expect: 'AKANE_BUNDLE_FORMAT' },
  { name: 'impossible_date', text: reSign((b) => { b.issued_at = '2026-02-30T09:00:00+09:00'; b.expires_at = '2026-03-05T09:00:00+09:00'; }), env: 'PROD', nowMs: NOW, expect: 'AKANE_BUNDLE_FORMAT' },
  { name: 'version_zero', text: reSign((b) => { b.version = 0; }), env: 'PROD', nowMs: NOW, expect: 'AKANE_BUNDLE_FORMAT' },
  { name: 'bad_kind', text: reSign((b) => { b.kind = 'ADMIN'; }), env: 'PROD', nowMs: NOW, expect: 'AKANE_BUNDLE_FORMAT' },
  { name: 'bad_experiment_id', text: reSign((b) => { b.experiment_id = 'x y'; }), env: 'PROD', nowMs: NOW, expect: 'AKANE_BUNDLE_FORMAT' },
  { name: 'body_array', text: reSign((b) => { b.body = []; }), env: 'PROD', nowMs: NOW, expect: 'AKANE_BUNDLE_FORMAT' },
  { name: 'uppercase_signature', text: okText.replace(ok.signature, ok.signature.toUpperCase()), env: 'PROD', nowMs: NOW, expect: 'AKANE_BUNDLE_FORMAT' },
  { name: 'governance_ok', text: buildBundle(Object.assign({}, bundleFields, { kind: 'GOVERNANCE', experiment_id: null, body: { k4: true } }), OTHER_KEY), env: 'PROD', nowMs: NOW, key: OTHER_KEY, expect: null },
  { name: 'empty_text', text: '', env: 'PROD', nowMs: NOW, expect: 'AKANE_BUNDLE_FORMAT' }
];

const out = {
  note: 'GAS（09・13）とGitHub（security/）の共通試験データ。試験用の鍵は公開値で、本番では使わない。',
  test_key: TEST_KEY,
  other_key: OTHER_KEY,
  canonical_valid: valid.map((v) => ({ input: v, expect: canonicalJson(v) })),
  canonical_invalid: special.map((s) => ({ special: s, expect_error: code(() => canonicalJson(buildSpecial(s))) })),
  parse_canonical: parseSources.map((src) => {
    const err = code(() => parseCanonicalJson(src));
    return err ? { source: src, expect_error: err } : { source: src, expect: canonicalJson(parseCanonicalJson(src)) };
  }),
  sha256: ['', 'abc', 'あかね', canonicalJson({ a: 1 })].map((t) => ({ text: t, expect: sha256Hex(t) })),
  hmac: [
    { key: TEST_KEY, text: '' }, { key: TEST_KEY, text: 'abc' }, { key: TEST_KEY, text: '{"a":"あかね"}' },
    { key: OTHER_KEY, text: 'abc' }
  ].map((c) => Object.assign(c, { expect: hmacHex(c.key, c.text) })),
  bundle_build: { fields: bundleFields, key: 'test_key', expect: okText },
  bundle_verify: verifyCases.map((c) => ({
    name: c.name, text: c.text, env: c.env, nowMs: c.nowMs,
    key: c.key === OTHER_KEY ? 'other_key' : 'test_key', expect: c.expect
  }))
};

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
