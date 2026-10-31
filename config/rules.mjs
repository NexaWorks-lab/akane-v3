// G3a config：設定の定義の読み込みと、運用設定一式（OPERATION）の中身の規則（純粋関数）
//
// 設定の定義（このディレクトリの JSON。変更はオーナーのコミットだけ。AI の提案では変えない）
//   constitution.json  00_Config.gs の憲法などの写し（GitHub側から変えない。00 との一致を CI と GAS で確かめる）
//   allowlist.json     実験の種類の許可リスト（E1〜E7）
//   registry.json      変更可能パラメータ表（範囲・1回の変更幅・累積の上限）
//   baseline.json      基準設定（今の 02 の動作）
//
// 中身の規則（GAS の 13 の akane_bundlesBodyRulesStep1_ を G3b で置き換えるときに、同じ結果にする）
//   GOVERNANCE：ステップ1では受け入れない（AKANE_BUNDLE_GOVERNANCE_DISABLED）
//   OPERATION ：experiment_id は null だけ（G6 まで）。本体は { schema, params } だけ。
//     絶対範囲（表）・1回の変更幅（直前の受け入れ版。なければ基準設定）・累積の上限（基準設定から）・
//     同時の変更数（直前の版から変わった項目は max_changed_params まで）を確かめる。
// 例外は投げない（中身の規則）。設定の定義が壊れているときは loadConfig / validateConfig が例外を投げる（CI で止める）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function isPlainObject(x) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) { return false; }
  const p = Object.getPrototypeOf(x);
  return p === Object.prototype || p === null;
}

const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const CODE_RE = /^[A-Z][A-Z0-9_]{0,31}$/;

/** 設定の定義の形を確かめる。壊れていれば例外（AKANE_CONFIG_INVALID:理由）。 */
export function validateConfig(cfg) {
  const fail = (why) => { throw new Error('AKANE_CONFIG_INVALID:' + why); };

  if (!isPlainObject(cfg)) { fail('CFG'); }

  const { constitution, allowlist, registry, baseline } = cfg;

  if (!isPlainObject(constitution) || !Array.isArray(constitution.EXPERIMENT_TYPES)) { fail('CONSTITUTION'); }
  if (!isPlainObject(allowlist) || !Array.isArray(allowlist.experiments)) { fail('ALLOWLIST'); }

  const types = allowlist.experiments.map((e) => e && e.type);
  if (JSON.stringify(types) !== JSON.stringify(constitution.EXPERIMENT_TYPES)) { fail('ALLOWLIST_TYPES'); }
  if (!allowlist.experiments.every((e) => isPlainObject(e) && (e.unit === 'POST' || e.unit === 'DAY'))) { fail('ALLOWLIST_UNIT'); }

  if (!isPlainObject(registry) || registry.schema !== 1 || !Number.isSafeInteger(registry.max_changed_params) ||
      registry.max_changed_params < 1 || !Array.isArray(registry.params) || registry.params.length === 0) {
    fail('REGISTRY');
  }

  const names = new Set();

  registry.params.forEach((p) => {
    if (!isPlainObject(p) || typeof p.name !== 'string' || !NAME_RE.test(p.name) || names.has(p.name)) { fail('PARAM_NAME'); }
    names.add(p.name);
    if (types.indexOf(p.experiment) === -1) { fail('PARAM_EXPERIMENT'); }
    if (p.type === 'INT') {
      const ok = ['min', 'max', 'step', 'drift'].every((k) => Number.isSafeInteger(p[k])) &&
        p.min <= p.max && p.step >= 1 && p.drift >= 0 && !has(p, 'values');
      if (!ok) { fail('PARAM_INT:' + p.name); }
    } else if (p.type === 'ENUM') {
      const ok = Array.isArray(p.values) && p.values.length >= 2 && p.values.every((v) => typeof v === 'string' && CODE_RE.test(v)) &&
        new Set(p.values).size === p.values.length && !['min', 'max', 'step', 'drift'].some((k) => has(p, k));
      if (!ok) { fail('PARAM_ENUM:' + p.name); }
    } else {
      fail('PARAM_TYPE:' + p.name);
    }
  });

  if (!isPlainObject(baseline) || baseline.schema !== registry.schema || !isPlainObject(baseline.params)) { fail('BASELINE'); }

  const r = checkParamsInRange(baseline.params, registry);
  if (!r.ok) { fail('BASELINE_' + r.code.replace('AKANE_BUNDLE_', '')); }

  return true;
}

export function loadConfig(dir) {
  const d = dir || path.dirname(fileURLToPath(import.meta.url));
  const read = (f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
  const cfg = {
    constitution: read('constitution.json'),
    allowlist: read('allowlist.json'),
    registry: read('registry.json'),
    baseline: read('baseline.json')
  };
  validateConfig(cfg);
  return cfg;
}

/** 全項目がそろい、型・範囲が正しいか（変更幅は見ない）。 */
export function checkParamsInRange(params, registry) {
  if (!isPlainObject(params)) { return { ok: false, code: 'AKANE_BUNDLE_BODY_SHAPE', param: null }; }

  const names = registry.params.map((p) => p.name);
  const keys = Object.keys(params).sort();

  for (const k of keys) {
    if (names.indexOf(k) === -1) { return { ok: false, code: 'AKANE_BUNDLE_PARAM_UNKNOWN', param: null }; }
  }

  for (const p of registry.params) {
    if (!has(params, p.name)) { return { ok: false, code: 'AKANE_BUNDLE_PARAM_MISSING', param: p.name }; }

    const v = params[p.name];

    if (p.type === 'INT') {
      if (!Number.isSafeInteger(v)) { return { ok: false, code: 'AKANE_BUNDLE_PARAM_TYPE', param: p.name }; }
      if (v < p.min || v > p.max) { return { ok: false, code: 'AKANE_BUNDLE_PARAM_RANGE', param: p.name }; }
    } else {
      if (typeof v !== 'string') { return { ok: false, code: 'AKANE_BUNDLE_PARAM_TYPE', param: p.name }; }
      if (p.values.indexOf(v) === -1) { return { ok: false, code: 'AKANE_BUNDLE_PARAM_RANGE', param: p.name }; }
    }
  }

  return { ok: true, code: null, param: null };
}

/**
 * 運用設定一式の本体の確認（純粋関数）。
 * ctx：{ registry, baseline（baseline.json の内容）, previous（直前に受け入れた版の params。なければ null） }
 * 返り値：{ ok, code, param }（param は項目名か null。値は返さない）
 */
export function checkOperationBody(body, ctx) {
  try {
    const registry = ctx.registry;
    const base = ctx.baseline.params;
    const previous = ctx.previous === undefined ? null : ctx.previous;

    if (!isPlainObject(body) || Object.keys(body).sort().join(',') !== 'params,schema' || body.schema !== registry.schema) {
      return { ok: false, code: 'AKANE_BUNDLE_BODY_SHAPE', param: null };
    }

    const r = checkParamsInRange(body.params, registry);
    if (!r.ok) { return r; }

    if (previous !== null && !checkParamsInRange(previous, registry).ok) {
      return { ok: false, code: 'AKANE_BUNDLE_PREVIOUS_INVALID', param: null };
    }

    const ref = previous !== null ? previous : base;
    let changed = 0;

    for (const p of registry.params) {
      const v = body.params[p.name];

      if (v !== ref[p.name]) { changed++; }

      if (p.type === 'INT') {
        if (Math.abs(v - ref[p.name]) > p.step) { return { ok: false, code: 'AKANE_BUNDLE_PARAM_STEP', param: p.name }; }
        if (Math.abs(v - base[p.name]) > p.drift) { return { ok: false, code: 'AKANE_BUNDLE_PARAM_DRIFT', param: p.name }; }
      }
    }

    if (changed > registry.max_changed_params) {
      return { ok: false, code: 'AKANE_BUNDLE_PARAM_TOO_MANY_CHANGES', param: null };
    }

    return { ok: true, code: null, param: null };
  } catch (e) {
    return { ok: false, code: 'AKANE_BUNDLE_BODY_REJECTED', param: null };
  }
}

/**
 * 設定一式の中身の規則（13 の bodyRules(kind, body, bundle) と同じ形）。
 * ctx：checkOperationBody と同じ。
 */
export function checkBundleBody(kind, body, bundle, ctx) {
  if (kind === 'GOVERNANCE') {
    return { ok: false, code: 'AKANE_BUNDLE_GOVERNANCE_DISABLED', param: null };
  }

  if (kind !== 'OPERATION') {
    return { ok: false, code: 'AKANE_BUNDLE_BODY_REJECTED', param: null };
  }

  if (!isPlainObject(bundle) || bundle.experiment_id !== null) {
    return { ok: false, code: 'AKANE_BUNDLE_EXPERIMENT_NOT_ALLOWED', param: null };
  }

  return checkOperationBody(body, ctx);
}
