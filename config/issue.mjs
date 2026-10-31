// G3a config：運用設定一式（OPERATION）の発行（純粋関数。鍵は呼び出し側が渡す）
//
// - 中身は checkOperationBody（rules.mjs）で、GAS の 13 と同じ規則で確かめてから署名する（不合格なら発行しない）。
// - 形式・署名は G1（security/bundle.mjs）の buildBundle。発行のあと verifyBundle で自分で確かめ直す。
// - 鍵は16進64桁。G3a では試験用の公開してよい鍵だけを使う。本番の運用鍵は G3b（オーナー承認のあと）で、
//   GitHub の environment シークレットから実行時に渡す。鍵・全文はログ・例外の文言に出さない。
// - 統治の設定一式（GOVERNANCE）は発行しない（ステップ1では GAS が受け入れないため）。

import { buildBundle, verifyBundle } from '../security/bundle.mjs';
import { checkBundleBody, isPlainObject } from './rules.mjs';

const H = 3600000;

export function jstTimestamp(ms) {
  return new Date(ms + 9 * H).toISOString().slice(0, 19) + '+09:00';
}

/**
 * opts：{ config（loadConfig の結果）, params, previous（直前に受け入れた版の params か null）, env, version, nowMs, key }
 * 返り値：設定一式の全文（正規化JSONの文字列）。不合格なら例外（コードだけ）。
 */
export function issueOperation(opts) {
  if (!isPlainObject(opts) || !isPlainObject(opts.config)) {
    throw new Error('AKANE_ISSUE_INPUT_INVALID');
  }

  const { config, params, env, version, nowMs, key } = opts;
  const previous = opts.previous === undefined ? null : opts.previous;

  if ((env !== 'PROD' && env !== 'DEV') || !Number.isSafeInteger(version) || version < 1 ||
      !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error('AKANE_ISSUE_INPUT_INVALID');
  }

  const body = { schema: config.registry.schema, params };
  const fields = {
    kind: 'OPERATION', env, version,
    issued_at: jstTimestamp(nowMs),
    expires_at: jstTimestamp(nowMs + config.constitution.BUNDLE.VALID_DAYS * 24 * H),
    experiment_id: null,
    body
  };
  const rule = checkBundleBody('OPERATION', body, fields, { registry: config.registry, baseline: config.baseline, previous });

  if (!rule.ok) {
    throw new Error(rule.code);
  }

  let text;

  try {
    text = buildBundle(fields, key);
  } catch (e) {
    throw new Error(/^AKANE_[A-Z0-9_]+$/.test(e && e.message) ? e.message : 'AKANE_ISSUE_FAILED');
  }

  const v = verifyBundle(text, { key, env, nowMs });

  if (!v.ok) {
    throw new Error('AKANE_ISSUE_SELF_CHECK_FAILED');
  }

  return text;
}
