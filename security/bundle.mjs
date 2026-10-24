// G1 security：承認済み設定一式（バンドル）の形式・内容ハッシュ・HMAC署名（仕様 8.3）
//
// 形式（v=1。キーはこの10個だけ。全体を正規化JSONの文字列でやり取りする）
//   v             1（形式の版）
//   kind          'OPERATION'（通常の運用設定）/ 'GOVERNANCE'（K4の統治設定）
//   env           'PROD' / 'DEV'
//   version       1以上の安全な整数（環境ごとに単調増加。単調性の確認はGASの13が行う）
//   issued_at     'yyyy-MM-ddTHH:mm:ss+09:00'
//   expires_at    同じ形。issued_at より後で、issued_at から14日以内
//   experiment_id null か 'EXP_' で始まるID
//   body          設定本体（プレーンなオブジェクト）
//   content_hash  上の8項目（v〜body）の正規化JSONの SHA-256（小文字16進64桁）
//   signature     signature を除いた9項目の正規化JSONの HMAC-SHA256（鍵は16進64桁の文字列をUTF-8で使う。小文字16進64桁）
//
// 鍵：kind ごとに別（OPERATION_SIGNING_KEY / GOVERNANCE_SIGNING_KEY）。どちらも16進64桁。
// 検証の順：設定値 → 鍵 → 形式 → 署名 → 内容ハッシュ → 環境 → 期限（エラーは AKANE_BUNDLE_* のコード）。
// 版の単調性・同じ版で別ハッシュの拒否は、状態を持つGASの13が行う。

import crypto from 'node:crypto';
import { canonicalJson, parseCanonicalJson } from './canonical.mjs';

export const BUNDLE_KEYS = Object.freeze([
  'body', 'content_hash', 'env', 'experiment_id', 'expires_at',
  'issued_at', 'kind', 'signature', 'v', 'version'
]);

// 呼び出し側の設定値の上限（異常な値で期限の確認が抜けないようにする）
export const MAX_VALID_DAYS = 14;
export const MAX_SKEW_MINUTES = 10;

const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/;
const HEX64 = /^[0-9a-f]{64}$/;

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function hmacHex(key, text) {
  return crypto.createHmac('sha256', Buffer.from(key, 'utf8')).update(text, 'utf8').digest('hex');
}

function timeMs(s) {
  if (typeof s !== 'string' || !TIME_RE.test(s)) {
    return null;
  }
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) {
    return null;
  }
  // 実在しない日時（2月30日など）を弾く：同じ文字列に戻るか確かめる
  const back = new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 19) + '+09:00';
  return back === s ? ms : null;
}

// 設定値の確認。正しくなければ null を返す（期限や許容差の比較が NaN で素通りするのを防ぐ）
// opts はプレーンなオブジェクト（プロトタイプが Object.prototype か null）だけ。
// 値は自分のプロパティだけを読む（継承した値は使わない。プロトタイプ汚染の影響を受けない）。
function isPlainObject(x) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) { return false; }
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}
function own(o, name) {
  return Object.prototype.hasOwnProperty.call(o, name) ? o[name] : undefined;
}
function readOptions(opts, needVerify) {
  if (!isPlainObject(opts)) { return null; }
  const vd = own(opts, 'validDays');
  const validDays = vd === undefined ? MAX_VALID_DAYS : vd;
  if (!Number.isSafeInteger(validDays) || validDays < 1 || validDays > MAX_VALID_DAYS) { return null; }
  if (!needVerify) { return { validDays }; }
  const sm = own(opts, 'skewMinutes');
  const skewMinutes = sm === undefined ? 5 : sm;
  if (!Number.isSafeInteger(skewMinutes) || skewMinutes < 0 || skewMinutes > MAX_SKEW_MINUTES) { return null; }
  const nowMs = own(opts, 'nowMs');
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) { return null; }
  const env = own(opts, 'env');
  if (env !== 'PROD' && env !== 'DEV') { return null; }
  return { validDays, skewMs: skewMinutes * 60 * 1000, nowMs, env, key: own(opts, 'key') };
}

function contentOf(b) {
  return {
    body: b.body, env: b.env, experiment_id: b.experiment_id, expires_at: b.expires_at,
    issued_at: b.issued_at, kind: b.kind, v: b.v, version: b.version
  };
}

function checkShape(b, validDays) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) { return 'AKANE_BUNDLE_FORMAT'; }
  const keys = Object.keys(b).sort();
  if (keys.join(',') !== BUNDLE_KEYS.join(',')) { return 'AKANE_BUNDLE_FORMAT'; }
  if (b.v !== 1) { return 'AKANE_BUNDLE_FORMAT'; }
  if (b.kind !== 'OPERATION' && b.kind !== 'GOVERNANCE') { return 'AKANE_BUNDLE_FORMAT'; }
  if (b.env !== 'PROD' && b.env !== 'DEV') { return 'AKANE_BUNDLE_FORMAT'; }
  if (!Number.isSafeInteger(b.version) || b.version < 1) { return 'AKANE_BUNDLE_FORMAT'; }
  const issued = timeMs(b.issued_at);
  const expires = timeMs(b.expires_at);
  if (issued === null || expires === null || expires <= issued ||
      expires - issued > validDays * 86400 * 1000) {
    return 'AKANE_BUNDLE_FORMAT';
  }
  if (b.experiment_id !== null &&
      (typeof b.experiment_id !== 'string' || !/^EXP_[A-Za-z0-9_-]{1,64}$/.test(b.experiment_id))) {
    return 'AKANE_BUNDLE_FORMAT';
  }
  if (!b.body || typeof b.body !== 'object' || Array.isArray(b.body)) { return 'AKANE_BUNDLE_FORMAT'; }
  if (typeof b.content_hash !== 'string' || !HEX64.test(b.content_hash)) { return 'AKANE_BUNDLE_FORMAT'; }
  if (typeof b.signature !== 'string' || !HEX64.test(b.signature)) { return 'AKANE_BUNDLE_FORMAT'; }
  return null;
}

/**
 * バンドルを作る（GitHub側の発行用）。返り値は正規化JSONの文字列。
 * fields: { kind, env, version, issued_at, expires_at, experiment_id, body }
 */
export function buildBundle(fields, key, opts = {}) {
  const o = readOptions(opts, false);
  if (!o) {
    throw new Error('AKANE_BUNDLE_OPTIONS_INVALID');
  }
  const validDays = o.validDays;
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('AKANE_BUNDLE_FORMAT');
  }
  if (typeof key !== 'string' || !HEX64.test(key)) {
    throw new Error('AKANE_BUNDLE_KEY_INVALID');
  }
  const b = {
    v: 1, kind: fields.kind, env: fields.env, version: fields.version,
    issued_at: fields.issued_at, expires_at: fields.expires_at,
    experiment_id: fields.experiment_id === undefined ? null : fields.experiment_id,
    body: fields.body
  };
  b.content_hash = sha256Hex(canonicalJson(contentOf(b)));
  b.signature = '0'.repeat(64);
  const shape = checkShape(b, validDays);
  if (shape) { throw new Error(shape); }
  const unsigned = Object.assign({}, b);
  delete unsigned.signature;
  b.signature = hmacHex(key, canonicalJson(unsigned));
  return canonicalJson(b);
}

/**
 * バンドルを検証する（GASの13と同じ手順。版の単調性は対象外）。
 * opts: { key, env('PROD'/'DEV'), nowMs(0以上の整数), validDays=14(1〜14の整数), skewMinutes=5(0〜10の整数) }
 * opts はプレーンなオブジェクトだけ。値は自分のプロパティだけを読む。
 * 設定値が正しくなければ AKANE_BUNDLE_OPTIONS_INVALID（何も検証せずに拒否）。
 * 返り値：{ ok: true, bundle } か { ok: false, code }。例外は投げない。
 */
export function verifyBundle(text, opts) {
  try {
    const o = readOptions(opts, true);
    if (!o) {
      return { ok: false, code: 'AKANE_BUNDLE_OPTIONS_INVALID' };
    }
    const validDays = o.validDays;
    const skew = o.skewMs;

    if (typeof o.key !== 'string' || !HEX64.test(o.key)) {
      return { ok: false, code: 'AKANE_BUNDLE_KEY_INVALID' };
    }

    let b;
    try {
      b = parseCanonicalJson(text);
    } catch (e) {
      return { ok: false, code: 'AKANE_BUNDLE_FORMAT' };
    }

    const shape = checkShape(b, validDays);
    if (shape) { return { ok: false, code: shape }; }

    const unsigned = Object.assign({}, b);
    delete unsigned.signature;
    const expected = hmacHex(o.key, canonicalJson(unsigned));
    if (!crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(b.signature, 'utf8'))) {
      return { ok: false, code: 'AKANE_BUNDLE_SIGNATURE_INVALID' };
    }

    if (sha256Hex(canonicalJson(contentOf(b))) !== b.content_hash) {
      return { ok: false, code: 'AKANE_BUNDLE_HASH_MISMATCH' };
    }

    if (b.env !== o.env) {
      return { ok: false, code: 'AKANE_BUNDLE_ENV_MISMATCH' };
    }

    const issued = timeMs(b.issued_at);
    const expires = timeMs(b.expires_at);
    if (!(o.nowMs >= issued - skew)) {
      return { ok: false, code: 'AKANE_BUNDLE_NOT_YET_VALID' };
    }
    if (!(o.nowMs < expires)) {
      return { ok: false, code: 'AKANE_BUNDLE_EXPIRED' };
    }

    return { ok: true, bundle: b };
  } catch (e) {
    return { ok: false, code: 'AKANE_BUNDLE_FAILED' };
  }
}
