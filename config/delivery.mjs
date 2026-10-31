// G3b data：送信箱（Actions → GAS）の受け渡しの確認（純粋関数。件数だけ。G3b 変更計画 v0.3 7章）
//
// 区別して数える：
//   - 受信確認（DELIVERY_ACK）がまだない送信：書いてから2時間以内（待ち）／2時間を過ぎた（RETRY が続いている。注意）
//   - 受信確認の結果ごとの数（ACCEPTED・IDEMPOTENT・REJECTED。送信IDごとに再構成で採用した1件）
//   - 不正な行（送信IDと全文が合わない行）：記録済み（INTAKE_REJECTED）／まだ記録がない
//   - INTAKE_REJECTED の記録の数
// 出力に ID・全文・時刻は入れない（公開リポジトリのため）。

import { rowToRecord, reconstruct } from './events.mjs';
import { parseCanonicalJson } from '../security/canonical.mjs';
import { sendIdOf, validSendId, rowKeyOf } from '../config/outbox.mjs';

export const ACK_WAIT_MS = 2 * 3600000;

export function deliveryReport(eventRows, outboxRows, env, nowMs) {
  const records = [];

  (eventRows || []).forEach((row) => {
    const r = rowToRecord(row);
    if (r && r.env === env && (r.event_type === 'DELIVERY_ACK' || r.event_type === 'INTAKE_REJECTED')) { records.push(r); }
  });

  const rec = reconstruct(records);
  const ackResult = new Map();
  const flagged = new Set();
  let intakeRejected = 0;

  Object.keys(rec.subjects).forEach((k) => {
    const s = rec.subjects[k];
    let m;

    if ((m = k.match(/^DELIVERY_ACK:(SND_[0-9a-f]{32})$/))) {
      let p = null;
      try { p = parseCanonicalJson(s.adopted.payload); } catch (e) { p = null; }
      ackResult.set(m[1], p && typeof p.result === 'string' ? p.result : 'UNKNOWN');
    } else if ((m = k.match(/^INTAKE_REJECTED:(ROW_[0-9a-f]{32})$/))) {
      flagged.add(m[1]);
      intakeRejected++;
    }
  });

  const out = {
    sends: 0, waiting: 0, overdue: 0,
    accepted: 0, idempotent: 0, rejected: 0, unknownResult: 0,
    tamperedFlagged: 0, tamperedUnflagged: 0, ignored: 0,
    intakeRejected
  };

  (outboxRows || []).forEach((row) => {
    const claimed = Array.isArray(row) ? row[0] : null;
    const text = Array.isArray(row) ? row[1] : null;

    if (!validSendId(claimed) || typeof text !== 'string' || text === '') { out.ignored++; return; }

    if (sendIdOf(text) !== claimed) {
      if (flagged.has(rowKeyOf(claimed, text))) { out.tamperedFlagged++; } else { out.tamperedUnflagged++; }
      return;
    }

    out.sends++;

    const res = ackResult.get(claimed);

    if (res === undefined) {
      const written = Date.parse(typeof row[2] === 'string' ? row[2] : '');
      if (Number.isFinite(written) && nowMs - written <= ACK_WAIT_MS) { out.waiting++; } else { out.overdue++; }
    } else if (res === 'ACCEPTED') {
      out.accepted++;
    } else if (res === 'IDEMPOTENT') {
      out.idempotent++;
    } else if (res === 'REJECTED') {
      out.rejected++;
    } else {
      out.unknownResult++;
    }
  });

  out.warnings = (out.overdue > 0 ? 1 : 0) + (out.tamperedUnflagged > 0 ? 1 : 0) + (out.unknownResult > 0 ? 1 : 0) +
    (out.rejected > 0 ? 1 : 0) + (out.tamperedFlagged > 0 ? 1 : 0);

  return Object.freeze(out);
}

export function deliveryMarkdown(r) {
  const mark = (bad) => (bad ? '注意' : 'OK');
  return [
    '### 送信箱の受け渡し（G3b）',
    '',
    '| 項目 | 件数 | 判定 |',
    '|---|---|---|',
    '| 送信（送信IDと全文が合う行） | ' + r.sends + ' | - |',
    '| 受信確認待ち（2時間以内） | ' + r.waiting + ' | OK |',
    '| 受信確認なし（2時間を過ぎた） | ' + r.overdue + ' | ' + mark(r.overdue > 0) + ' |',
    '| 受信確認：ACCEPTED | ' + r.accepted + ' | - |',
    '| 受信確認：IDEMPOTENT | ' + r.idempotent + ' | - |',
    '| 受信確認：REJECTED | ' + r.rejected + ' | ' + mark(r.rejected > 0) + ' |',
    '| 受信確認：結果が読めない | ' + r.unknownResult + ' | ' + mark(r.unknownResult > 0) + ' |',
    '| 不正な行（記録済み） | ' + r.tamperedFlagged + ' | ' + mark(r.tamperedFlagged > 0) + ' |',
    '| 不正な行（まだ記録がない） | ' + r.tamperedUnflagged + ' | ' + mark(r.tamperedUnflagged > 0) + ' |',
    '| INTAKE_REJECTED の記録 | ' + r.intakeRejected + ' | - |',
    '| 読み飛ばす行（形が違う） | ' + r.ignored + ' | - |',
    '',
    '注意の項目：' + r.warnings
  ].join('\n');
}
