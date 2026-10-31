// G3b config：発行の前の状態の確認（純粋関数。外部と通信しない。鍵を使わない）
//
// - メインのイベント（BUNDLE_ACCEPTED・DELIVERY_ACK・INTAKE_REJECTED）と、連携用シートの送信箱の行から、
//   受け入れ済みの最大版・そのハッシュ・その版の params（次の版の previous）・送信箱の未処理の行の数を決める。
// - 発行の判断（次の版・params）と、署名した全文の確認（追記の直前）も、ここで行う。
// - 署名は確かめない（準備・追記のジョブは鍵を持たない）。イベントに書けるのは GAS だけ（サービスアカウントは閲覧者）で、
//   受け入れの最終判断は GAS の 13 が署名・版・previous の規則で行う（二重の守り）。
// - 迷う状態（読めない受け入れ記録・隔離・同じ版に別の内容・ほかの発生元・内容ハッシュ／event_id／観測日時の不一致）は、
//   発行しない（AKANE_ISSUE_STATE_INVALID。2026-10-31 レビュー①：鍵がなくても確かめられるものは GitHub 側でも止める）。
// - GAS の BUNDLE_HEAD（Script Property）は GitHub から読めない（読めるようにしない）。HEAD とイベントの食い違いは 13 が拒否し
//   （HEAD が先：同じ版で SAME_VERSION_DIFFERENT_HASH か VERSION_OLD、受信確認 REJECTED）、次の準備はその拒否を見て止める
//   （AKANE_ISSUE_LAST_REJECTED。オーナーが原因を確かめて confirmRejected を付けたときだけ進める）。
// 例外の文言はコードだけ（全文・ID・値は入れない）。

import { canonicalJson, parseCanonicalJson } from '../security/canonical.mjs';
import { sha256Hex } from '../security/bundle.mjs';
import { rowToRecord, reconstruct } from '../data/events.mjs';
import { isPlainObject, checkOperationBody } from './rules.mjs';
import { sendIdOf, validSendId, rowKeyOf } from './outbox.mjs';

const H = 3600000;
export const STALE_MS = 1 * H;
export const SKEW_MS = 5 * 60000;

// 中身の規則による拒否（値を直せば次の発行で済む）。これ以外の拒否は状態の異常の疑いとして止める
export const BODY_REJECT_CODES = Object.freeze([
  'AKANE_BUNDLE_BODY_REJECTED', 'AKANE_BUNDLE_BODY_SHAPE', 'AKANE_BUNDLE_PARAM_UNKNOWN', 'AKANE_BUNDLE_PARAM_MISSING',
  'AKANE_BUNDLE_PARAM_TYPE', 'AKANE_BUNDLE_PARAM_RANGE', 'AKANE_BUNDLE_PARAM_STEP', 'AKANE_BUNDLE_PARAM_DRIFT',
  'AKANE_BUNDLE_PARAM_TOO_MANY_CHANGES', 'AKANE_BUNDLE_EXPERIMENT_NOT_ALLOWED', 'AKANE_BUNDLE_GOVERNANCE_DISABLED'
]);

function evtId(h) {
  return 'EVT_' + h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20, 32);
}

/** 内容ハッシュ（security/bundle.mjs の contentOf と同じ。鍵は使わない） */
function contentHashOf(b) {
  return sha256Hex(canonicalJson({
    body: b.body, env: b.env, experiment_id: b.experiment_id, expires_at: b.expires_at,
    issued_at: b.issued_at, kind: b.kind, v: b.v, version: b.version
  }));
}

const DELIVERY_TYPES = Object.freeze(['DELIVERY_ACK', 'INTAKE_REJECTED']);

const SUBJECT_RE = /^BUNDLE_ACCEPTED:(PROD|DEV):(OPERATION|GOVERNANCE):([1-9][0-9]{0,15})$/;

function fail(code) { throw new Error(code); }

/**
 * 状態（GAS の 13 の Collect_ と取り込みの IntakeSeen_ に合わせる）。
 * eventRows：メインのイベントの行（見出しを除く）。outboxRows：送信箱の行（見出しを除く）。
 * 返り値：{ env, maxVersion, maxHash, previous（params か null）, pending, outboxRows, lastRejected（コードか null）, stamp }
 */
export function operationState(eventRows, outboxRows, env) {
  if ((env !== 'PROD' && env !== 'DEV') || !Array.isArray(eventRows) || !Array.isArray(outboxRows)) {
    fail('AKANE_ISSUE_INPUT_INVALID');
  }

  const source = env === 'PROD' ? 'GAS-PROD' : 'GAS-DEV';
  const records = [];
  const delivery = [];         // この環境の DELIVERY_ACK・INTAKE_REJECTED
  const acked = new Set();
  const ackCode = new Map();   // 送信ID → 受信確認 REJECTED のコード（再構成で採用した1件）
  const flagged = new Set();

  eventRows.forEach((row) => {
    const r = rowToRecord(row);

    if (!r) {
      // 読めない行のうち受け入れ記録（またはその疑い）は、版の上限が決められないので発行しない
      // 受信確認・不正の記録も同じ（処理済みかどうかが決められない。2026-10-31 レビュー 必須2）
      if (Array.isArray(row) && DELIVERY_TYPES.concat(['BUNDLE_ACCEPTED']).indexOf(row[1]) !== -1) { fail('AKANE_ISSUE_STATE_INVALID'); }
      return;
    }

    records.push(r);

    if (r.env === env && DELIVERY_TYPES.indexOf(r.event_type) !== -1) { delivery.push(r); }
  });

  // 受信確認・不正の記録は、この環境の記録だけで再構成し、採用された記録だけを「処理済み」にする（レビュー 必須2）。
  // 対象キーには環境が入らない（DELIVERY_ACK:送信ID）ので、別の環境の記録を混ぜない。
  // 隔離（ID の衝突など）や異常がひとつでもあれば、処理済みの判断を信頼できないので発行しない（安全側）。
  const drec = reconstruct(delivery);

  if (drec.quarantined.length > 0 || drec.anomalies.some((a) => a.kind === 'EVENT_ID_CONFLICT' || a.kind === 'INVALID_ROW')) {
    fail('AKANE_ISSUE_STATE_INVALID');
  }

  Object.keys(drec.subjects).forEach((k) => {
    const s = drec.subjects[k];
    let m;

    if (s.quarantined) { fail('AKANE_ISSUE_STATE_INVALID'); }

    if ((m = k.match(/^DELIVERY_ACK:(SND_[0-9a-f]{32})$/))) {
      let pl = null;
      try { pl = parseCanonicalJson(s.adopted.payload); } catch (e) { pl = null; }
      if (!pl || ['ACCEPTED', 'IDEMPOTENT', 'REJECTED'].indexOf(pl.result) === -1 || pl.send_id !== m[1]) { fail('AKANE_ISSUE_STATE_INVALID'); }
      acked.add(m[1]);
      if (pl.result === 'REJECTED') { ackCode.set(m[1], typeof pl.code === 'string' ? pl.code : 'AKANE_UNKNOWN'); }
    } else if ((m = k.match(/^INTAKE_REJECTED:(ROW_[0-9a-f]{32})$/))) {
      flagged.add(m[1]);
    }
  });

  const rec = reconstruct(records);

  if (rec.quarantined.some((k) => k.indexOf('BUNDLE_ACCEPTED:') === 0)) {
    fail('AKANE_ISSUE_STATE_INVALID');
  }

  const versions = new Map();   // version → Map(hash → params)

  rec.ordered.forEach((r) => {
    if (r.event_type !== 'BUNDLE_ACCEPTED') { return; }

    const m = r.subject_key.match(SUBJECT_RE);

    if (r.env !== env && m && m[1] !== env) { return; }   // 両方が別の環境：数えない（13 と同じ）

    if (!m || m[1] !== env || r.env !== env || r.source !== source) { fail('AKANE_ISSUE_STATE_INVALID'); }

    if (m[2] !== 'OPERATION') { return; }

    let p;
    let b;

    try {
      p = parseCanonicalJson(r.payload);
      b = parseCanonicalJson(p.bundle);
    } catch (e) {
      fail('AKANE_ISSUE_STATE_INVALID');
    }

    const version = Number(m[3]);

    if (!isPlainObject(p) || Object.keys(p).sort().join(',') !== 'bundle,content_hash,kind,version' ||
        !isPlainObject(b) || b.kind !== 'OPERATION' || p.kind !== 'OPERATION' || b.env !== env ||
        b.version !== version || p.version !== version || typeof b.content_hash !== 'string' ||
        b.content_hash !== p.content_hash || !isPlainObject(b.body) || !isPlainObject(b.body.params)) {
      fail('AKANE_ISSUE_STATE_INVALID');
    }

    // 鍵がなくても確かめられるもの（13 の Collect_ と同じ）：内容ハッシュ・event_id・観測日時
    if (contentHashOf(b) !== b.content_hash ||
        r.event_id !== evtId(sha256Hex(canonicalJson({ e: env, h: b.content_hash, k: 'OPERATION', t: 'BUNDLE_ACCEPTED', v: version }))) ||
        r.observed_at !== b.issued_at) {
      fail('AKANE_ISSUE_STATE_INVALID');
    }

    if (!versions.has(version)) { versions.set(version, new Map()); }
    versions.get(version).set(b.content_hash, b.body.params);
  });

  let maxVersion = 0;

  versions.forEach((hashes, v) => {
    if (hashes.size !== 1) { fail('AKANE_ISSUE_STATE_INVALID'); }   // 同じ版に別の内容（13 は F9）
    if (v > maxVersion) { maxVersion = v; }
  });

  const maxHash = maxVersion ? Array.from(versions.get(maxVersion).keys())[0] : null;
  const previous = maxVersion ? versions.get(maxVersion).get(maxHash) : null;


  // 最後の送信（送信IDと全文が合う行のうち一番下）が拒否されていれば、そのコード
  let lastRejected = null;

  for (let i = outboxRows.length - 1; i >= 0; i--) {
    const row = outboxRows[i];
    if (Array.isArray(row) && validSendId(row[0]) && typeof row[1] === 'string' && row[1] !== '' && sendIdOf(row[1]) === row[0]) {
      lastRejected = ackCode.has(row[0]) ? ackCode.get(row[0]) : null;
      break;
    }
  }

  // 送信箱の未処理の行：13 の取り込みが、まだ受信確認（DELIVERY_ACK）も不正の記録（INTAKE_REJECTED）も書いていない行
  let pending = 0;

  outboxRows.forEach((row) => {
    const claimed = Array.isArray(row) ? row[0] : null;
    const text = Array.isArray(row) ? row[1] : null;

    if (!validSendId(claimed) || typeof text !== 'string' || text === '') { return; }   // 13 も読み飛ばす行

    if (sendIdOf(text) === claimed) {
      if (!acked.has(claimed)) { pending++; }
    } else if (!flagged.has(rowKeyOf(claimed, text))) {
      pending++;
    }
  });

  const stamp = sha256Hex(canonicalJson({
    env,
    max_version: maxVersion,
    max_hash: maxHash,
    previous_hash: previous === null ? null : sha256Hex(canonicalJson(previous)),
    pending,
    outbox_rows: outboxRows.length,
    last_rejected: lastRejected   // 承認待ちの間に拒否の状態が変わったら印も変わる（レビュー 必須1）
  }));

  return Object.freeze({ env, maxVersion, maxHash, previous, pending, outboxRows: outboxRows.length, lastRejected, stamp });
}

/**
 * 発行の判断（準備のジョブ）。
 * input：{ param（'NONE' か表の項目名）, value（文字列）, confirmRejected（true／省略） }。'NONE' は同じ値のまま新しい版（期限の延長）。
 * 最後の送信が中身の規則以外の理由で拒否されていたら止める（AKANE_ISSUE_LAST_REJECTED）。
 * オーナーが app_ownerCheckBundles などで原因を確かめ、confirmRejected を付けたときだけ進める。
 * 返り値（ジョブの出力。鍵・全文は含まない）：{ v, env, version, param, params, previous, stamp }
 */
export function planIssue(state, config, input) {
  if (!state || !isPlainObject(config) || !isPlainObject(input) || typeof input.param !== 'string') {
    fail('AKANE_ISSUE_INPUT_INVALID');
  }

  if (state.pending !== 0) { fail('AKANE_ISSUE_PENDING'); }

  if (state.lastRejected !== null && state.lastRejected !== undefined &&
      BODY_REJECT_CODES.indexOf(state.lastRejected) === -1 && input.confirmRejected !== true) {
    fail('AKANE_ISSUE_LAST_REJECTED');
  }

  const registry = config.registry;
  const base = config.baseline.params;
  const previous = state.previous;
  const params = {};

  Object.keys(previous || base).forEach((k) => { params[k] = (previous || base)[k]; });

  if (input.param !== 'NONE') {
    const def = registry.params.find((p) => p.name === input.param);
    const raw = typeof input.value === 'string' ? input.value.trim() : '';

    if (!def) { fail('AKANE_ISSUE_PARAM_UNKNOWN'); }

    if (def.type === 'INT') {
      if (!/^-?[0-9]{1,6}$/.test(raw)) { fail('AKANE_ISSUE_VALUE_INVALID'); }
      params[def.name] = Number(raw);
    } else {
      if (!/^[A-Z][A-Z0-9_]{0,31}$/.test(raw)) { fail('AKANE_ISSUE_VALUE_INVALID'); }
      params[def.name] = raw;
    }
  } else if (typeof input.value === 'string' && input.value.trim() !== '') {
    fail('AKANE_ISSUE_VALUE_INVALID');   // 変えない発行に値を付けない（取り違えの防止）
  }

  const r = checkOperationBody({ schema: registry.schema, params }, { registry, baseline: config.baseline, previous });

  if (!r.ok) { fail(r.code); }

  return Object.freeze({
    v: 1,
    env: state.env,
    version: state.maxVersion + 1,
    param: input.param,
    params,
    previous,
    stamp: state.stamp
  });
}

/** ジョブの間で渡した計画を読み直す（形が違えば例外）。 */
export function readPlan(text) {
  let p;

  try { p = parseCanonicalJson(text); } catch (e) { fail('AKANE_ISSUE_PLAN_INVALID'); }

  if (!isPlainObject(p) || Object.keys(p).sort().join(',') !== 'env,param,params,previous,stamp,v,version' || p.v !== 1 ||
      (p.env !== 'PROD' && p.env !== 'DEV') || !Number.isSafeInteger(p.version) || p.version < 1 ||
      typeof p.param !== 'string' || !isPlainObject(p.params) || !(p.previous === null || isPlainObject(p.previous)) ||
      typeof p.stamp !== 'string' || !/^[0-9a-f]{64}$/.test(p.stamp)) {
    fail('AKANE_ISSUE_PLAN_INVALID');
  }

  return p;
}

/**
 * 署名した全文の確認（追記の直前）。計画と同じ版・環境・本体で、experiment_id は null、発行から1時間以内。
 * 返り値：{ sendId, issuedMs }
 */
export function checkSigned(plan, text, nowMs, schema) {
  let b;

  try { b = parseCanonicalJson(text); } catch (e) { fail('AKANE_ISSUE_SIGNED_INVALID'); }

  if (!isPlainObject(b) || b.kind !== 'OPERATION' || b.env !== plan.env || b.version !== plan.version ||
      b.experiment_id !== null || canonicalJson(b.body) !== canonicalJson({ schema, params: plan.params })) {
    fail('AKANE_ISSUE_SIGNED_MISMATCH');
  }

  const issuedMs = Date.parse(typeof b.issued_at === 'string' ? b.issued_at : '');

  if (!Number.isFinite(issuedMs) || !Number.isSafeInteger(nowMs)) { fail('AKANE_ISSUE_SIGNED_INVALID'); }
  if (issuedMs > nowMs + SKEW_MS) { fail('AKANE_ISSUE_SIGNED_INVALID'); }
  if (nowMs - issuedMs > STALE_MS) { fail('AKANE_ISSUE_STALE'); }

  return { sendId: sendIdOf(text), issuedMs };
}
