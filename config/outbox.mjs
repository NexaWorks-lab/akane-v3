// G3a config：送信箱（Actions → GAS）の形と、受信確認（DELIVERY_ACK）・取り込みの期待する結果（参照の実装。純粋関数）
//
// 送信箱：連携用スプレッドシート「送信箱_運用」。列＝送信ID・設定一式の全文・書いた時刻。Actions は追記だけ（G3b）。
// 送信ID：'SND_' ＋ 全文の SHA-256 の先頭32桁（内容から決まる）。
// 受信確認：メインのイベント DELIVERY_ACK（対象キー DELIVERY_ACK:送信ID）。GAS だけが書く（G3b）。
//   event_id は 12 の形（EVT_ ＋ 8-4-4-4-12 の16進）で、'DELIVERY_ACK:環境:送信ID:結果:コード:観測日時' の SHA-256 から決める。
//   同じ event_id なら中身（観測日時を含む）も同じ（12 の ID 衝突にならない）。
// 不正な行（送信IDと全文が合わない）：受信確認ではなく INTAKE_REJECTED（対象キー INTAKE_REJECTED:行のキー）。
// 受け入れの正は 13 の BUNDLE_ACCEPTED と BUNDLE_HEAD。受信確認は「処理した」という記録だけ。
// 設計案 v0.2 5.1 の表を、この参照の実装と共通試験データ（config/vectors.json）にする。G3b の GAS の取り込みは同じ結果にする。

import { sha256Hex } from '../security/bundle.mjs';

export const OUTBOX_SHEET = '送信箱_運用';
export const OUTBOX_HEADERS = Object.freeze(['send_id', 'bundle', 'written_at']);
export const MAX_ROWS_PER_RUN = 20;
export const RESULTS = Object.freeze(['ACCEPTED', 'IDEMPOTENT', 'REJECTED']);

/**
 * 13 の拒否のうち「その設定一式そのものが受け入れられない」もの（受信確認 REJECTED にして、もう処理しない）。
 * これ以外の失敗（イベントが読めない・ロック・記録の失敗・鍵が未設定・状態の異常・まだ有効でない など）は
 * 設定一式のせいとは限らないので、受信確認を書かずに次の回にもう一度（RETRY）。
 */
export const FINAL_REJECT_CODES = Object.freeze([
  'AKANE_BUNDLE_FORMAT', 'AKANE_BUNDLE_TOO_LARGE', 'AKANE_BUNDLE_SIGNATURE_INVALID', 'AKANE_BUNDLE_HASH_MISMATCH',
  'AKANE_BUNDLE_ENV_MISMATCH', 'AKANE_BUNDLE_EXPIRED', 'AKANE_BUNDLE_VERSION_OLD', 'AKANE_BUNDLE_SAME_VERSION_DIFFERENT_HASH',
  'AKANE_BUNDLE_VERSION_CONFLICT', 'AKANE_BUNDLE_CONCURRENT_CONFLICT', 'AKANE_BUNDLE_BODY_REJECTED',
  'AKANE_BUNDLE_BODY_SHAPE', 'AKANE_BUNDLE_PARAM_UNKNOWN', 'AKANE_BUNDLE_PARAM_MISSING', 'AKANE_BUNDLE_PARAM_TYPE',
  'AKANE_BUNDLE_PARAM_RANGE', 'AKANE_BUNDLE_PARAM_STEP', 'AKANE_BUNDLE_PARAM_DRIFT', 'AKANE_BUNDLE_PARAM_TOO_MANY_CHANGES',
  'AKANE_BUNDLE_EXPERIMENT_NOT_ALLOWED', 'AKANE_BUNDLE_GOVERNANCE_DISABLED'
]);
// AKANE_BUNDLE_PREVIOUS_INVALID（前に受け入れた版の状態の異常）は、新しい設定一式の不正とは限らないので RETRY。
// 状態の異常の通知・停止の判断は G3b で扱う。

const SEND_ID_RE = /^SND_[0-9a-f]{32}$/;
const CODE_RE = /^AKANE_[A-Z0-9_]{1,60}$/;

export function sendIdOf(text) {
  return 'SND_' + sha256Hex(text).slice(0, 32);
}

export function validSendId(s) {
  return typeof s === 'string' && SEND_ID_RE.test(s);
}

/**
 * 受信確認の event_id（12 の EVT_ 形式）。観測日時も含めて決める：
 * 同じ event_id なら記録の中身（観測日時を含む）も必ず同じになり、12 の ID 衝突にならない。
 * 別の時刻の再試行は別の記録になる（どちらも同じ対象キー。再構成は新しいほうを採用。重複しても害はない）。
 * 取り込みは、受信確認がすでにある送信IDを処理しないので、ふつうは1件だけになる。
 */
export function ackEventId(env, sendId, result, code, observedAt) {
  const h = sha256Hex('DELIVERY_ACK:' + env + ':' + sendId + ':' + result + ':' + (code || '') + ':' + observedAt);
  return 'EVT_' + h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20, 32);
}

/** 受信確認の記録の入力（12 の追記の入力の形）。 */
export function ackInput(env, sendId, result, code, observedAt) {
  if ((env !== 'PROD' && env !== 'DEV') || !validSendId(sendId) || RESULTS.indexOf(result) === -1 ||
      !(code === null || CODE_RE.test(code)) || typeof observedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/.test(observedAt)) {
    throw new Error('AKANE_INTAKE_ACK_INVALID');
  }
  const payload = { result, send_id: sendId };
  if (code !== null) { payload.code = code; }
  return {
    event_id: ackEventId(env, sendId, result, code, observedAt),
    event_type: 'DELIVERY_ACK',
    subject_key: 'DELIVERY_ACK:' + sendId,
    observed_at: observedAt,
    payload
  };
}

/** Actions が送信箱に書く1行（G3b で使う）。 */
export function outboxRow(text, writtenAt) {
  if (typeof text !== 'string' || text === '' || typeof writtenAt !== 'string') {
    throw new Error('AKANE_OUTBOX_ROW_INVALID');
  }
  return [sendIdOf(text), text, writtenAt];
}

/**
 * 送信箱の不正な行（送信IDと全文が合わない）の記録のキー。受信確認（DELIVERY_ACK）とは別の記録（INTAKE_REJECTED）にする。
 * キーは書かれた送信IDと全文の両方から決める（正しい行の送信IDを「処理済み」にしない）。
 */
export function rowKeyOf(claimed, text) {
  return 'ROW_' + sha256Hex(String(claimed) + '\u0001' + String(text)).slice(0, 32);
}

/** 不正な行の記録の入力（INTAKE_REJECTED。中身は行のキーと理由のコードだけ。全文は入れない）。 */
export function flagInput(env, rowKey, code, observedAt) {
  if ((env !== 'PROD' && env !== 'DEV') || !/^ROW_[0-9a-f]{32}$/.test(rowKey) || !CODE_RE.test(code) ||
      typeof observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/.test(observedAt)) {
    throw new Error('AKANE_INTAKE_FLAG_INVALID');
  }
  const h = sha256Hex('INTAKE_REJECTED:' + env + ':' + rowKey + ':' + code + ':' + observedAt);
  return {
    event_id: 'EVT_' + h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20, 32),
    event_type: 'INTAKE_REJECTED',
    subject_key: 'INTAKE_REJECTED:' + rowKey,
    observed_at: observedAt,
    payload: { code, row_key: rowKey }
  };
}

/**
 * 取り込みの1回分の計画（参照の実装）。
 * rows：送信箱の行（見出しを除く。上から古い順）
 * acked：受信確認（DELIVERY_ACK）がある送信ID の集合（Set）
 * accept(text)：13 の受け入れ（{ ok, code, accepted, idempotent, notify, retryable, writeUnknown }）
 * flagged：不正な行として記録済みの行のキーの集合（Set。省略すると空）
 * 返り値：[{ index, sendId, rowKey, action, result, code, notify }]
 *   action：'ACK'（受信確認を書く）/ 'FLAG'（不正な行として INTAKE_REJECTED を書いて通知。受信確認は書かない）/
 *           'SKIP'（受信確認・不正の記録がある、この回で処理済み）/ 'RETRY'（次の回にもう一度）/ 'IGNORE'（送信IDの形が違う行）
 *   受信確認を書くのは、受け入れ・冪等・FINAL_REJECT_CODES の拒否だけ。それ以外は RETRY。
 *   不正な行（送信IDと全文が合わない）は、正しい行の処理済みの状態（acked・done）に一切触れない。
 * 1回に処理するのは MAX_ROWS_PER_RUN 件まで（SKIP・IGNORE は数えない）。
 */
export function intakePlan(rows, acked, accept, flagged) {
  const out = [];
  const done = new Set(acked);
  const flags = new Set(flagged || []);
  let handled = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const claimed = Array.isArray(row) ? row[0] : null;
    const text = Array.isArray(row) ? row[1] : null;

    if (!validSendId(claimed) || typeof text !== 'string' || text === '') {
      out.push({ index: i, sendId: null, rowKey: null, action: 'IGNORE', result: null, code: null, notify: false });
      continue;
    }

    if (sendIdOf(text) !== claimed) {
      // 送信IDと全文が合わない（書き換え）：別の記録（INTAKE_REJECTED）だけ。正しい行の状態には触れない
      const rowKey = rowKeyOf(claimed, text);
      if (flags.has(rowKey)) {
        out.push({ index: i, sendId: null, rowKey, action: 'SKIP', result: null, code: null, notify: false });
        continue;
      }
      if (handled >= MAX_ROWS_PER_RUN) { break; }
      handled++;
      flags.add(rowKey);
      out.push({ index: i, sendId: null, rowKey, action: 'FLAG', result: null, code: 'AKANE_INTAKE_SEND_ID_MISMATCH', notify: true });
      continue;
    }

    if (done.has(claimed)) {
      out.push({ index: i, sendId: claimed, rowKey: null, action: 'SKIP', result: null, code: null, notify: false });
      continue;
    }

    if (handled >= MAX_ROWS_PER_RUN) { break; }

    handled++;

    let r;
    try { r = accept(text); } catch (e) { r = null; }

    const finalReject = r && r.ok !== true && FINAL_REJECT_CODES.indexOf(r.code) !== -1 && r.writeUnknown !== true;
    const success = r && r.ok === true && (r.accepted === true || r.idempotent === true);

    if (!success && !finalReject) {
      out.push({ index: i, sendId: claimed, rowKey: null, action: 'RETRY', result: null,
        code: r && typeof r.code === 'string' ? r.code : null, notify: false });
      continue;
    }

    done.add(claimed);

    if (r.ok === true && r.accepted === true) {
      out.push({ index: i, sendId: claimed, rowKey: null, action: 'ACK', result: 'ACCEPTED', code: null, notify: false });
    } else if (r.ok === true && r.idempotent === true) {
      out.push({ index: i, sendId: claimed, rowKey: null, action: 'ACK', result: 'IDEMPOTENT', code: null, notify: false });
    } else {
      out.push({ index: i, sendId: claimed, rowKey: null, action: 'ACK', result: 'REJECTED', code: r.code, notify: r.notify === true });
    }
  }

  return out;
}
