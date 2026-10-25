// G2 data：GASと共通の試験データ（data/vectors.json）を作る
//   node data/make-vectors.mjs > data/vectors.json
// GAS側（99の akane_testG2Vectors）は、同じデータで 12 の RowToRecord_・Reconstruct_・ReconstructSinceEpoch_ を動かし、
// 期待値と一致するかを確かめる。CI は、このファイルの出力と data/vectors.json が同じかも確かめる。

import { HEADERS, EVENT_TYPES, buildRow, rowToRecord, reconstruct, reconstructSinceEpoch, summarize } from './events.mjs';

const T = (d, hm) => '2026-11-' + d + 'T' + hm + ':00+09:00';
const id = (n) => 'EVT_00000000-0000-4000-8000-' + String(n).padStart(12, '0');

function row(n, type, subject, observed, payload, opts) {
  const o = opts || {};
  return buildRow({ event_id: o.eventId || id(n), event_type: type, subject_key: type + ':' + subject, observed_at: observed,
    payload, corrects: o.corrects, source: o.source }, o.env || 'PROD', o.recordedAt || observed);
}

function obsOf(r) { return r[3]; }

// ---------- 1. 行の形 ----------
const good = row(1, 'FOLLOWERS_DAILY', '2026-11-02', T('02', '05:30'), { followers: 120 });
const mod = (i, v) => { const r = good.slice(); r[i] = v; return r; };
const corr = row(2, 'CORRECTION', 'FOLLOWERS_DAILY:2026-11-02', T('02', '06:00'), { value: { followers: 121 } }, { corrects: obsOf(good) });
const actionsDev = row(3, 'DECISION', 'X1:mid', T('02', '06:00'), { r: 1 }, { source: 'ACTIONS', env: 'DEV' });
const rowCases = [
  ['ok', good, true],
  ['correction_ok', corr, true],
  ['actions_dev_ok', actionsDev, true],
  ['too_short', good.slice(0, 9), false],
  ['too_long', good.concat(['']), false],
  ['non_string', mod(8, 1), false],
  ['bad_event_id', mod(0, 'EVT_x'), false],
  ['unknown_type', mod(1, 'NOPE'), false],
  ['subject_prefix', mod(2, 'METRIC_72H:1'), false],
  ['obs_mismatch', mod(3, 'OBS_' + '0'.repeat(40)), false],
  ['observed_no_offset', mod(4, '2026-11-02T05:30:00'), false],
  ['observed_bad_date', mod(4, '2026-02-30T05:30:00+09:00'), false],
  ['recorded_hour_24', mod(5, '2026-11-02T24:00:00+09:00'), false],
  ['unknown_source', mod(6, 'OTHER'), false],
  ['prod_source_dev_env', mod(7, 'DEV'), false],
  ['payload_not_canonical', mod(8, '{"followers": 120}'), false],
  ['payload_array', mod(8, '[1]'), false],
  ['payload_float', mod(8, '{"followers":1.5}'), false],
  ['corrects_on_normal', mod(9, obsOf(good)), false],
  ['correction_without_target', (() => { const r = corr.slice(); r[9] = ''; return r; })(), false],
  ['correction_value_not_object', row(4, 'CORRECTION', 'FOLLOWERS_DAILY:2026-11-02', T('02', '06:00'), { value: 3 }, { corrects: obsOf(good) }), false],
  ['subject_control_char', row(5, 'METRIC_72H', '1\u0007', T('02', '06:00'), { views: 1 }), false]
].map(([name, r, ok]) => ({ name, row: r, ok }));

// ---------- 2. 再構成 ----------
const cases = [];
function add(name, rows, epoch) { cases.push({ name, rows, epoch: epoch === true }); }

// 再取得：観測日時が新しいものを採用。別の対象は別々
add('reacquire_latest_wins', [
  row(10, 'METRIC_72H', '100', T('02', '05:30'), { missing: true, code: 'X' }),
  row(11, 'METRIC_72H', '100', T('02', '06:30'), { views: 5, likes: 1, replies: 0, reposts: 0, quotes: 0 }),
  row(12, 'METRIC_72H', '101', T('02', '05:30'), { views: 9, likes: 0, replies: 0, reposts: 0, quotes: 0 })
]);

// 同じ ID・同じ内容（記録日時だけ違う）→ 1件。重複を数えない
add('duplicate_same_content', [
  row(20, 'FOLLOWERS_DAILY', '2026-11-02', T('02', '05:30'), { followers: 10 }),
  row(20, 'FOLLOWERS_DAILY', '2026-11-02', T('02', '05:30'), { followers: 10 }, { recordedAt: T('02', '05:31') })
]);

// 同じ ID・内容違い → 衝突。その ID の記録は外し、対象は隔離
add('id_conflict_quarantine', [
  row(30, 'FOLLOWERS_DAILY', '2026-11-03', T('03', '05:30'), { followers: 10 }),
  row(30, 'FOLLOWERS_DAILY', '2026-11-03', T('03', '05:30'), { followers: 99 }, { recordedAt: T('03', '05:31') }),
  row(31, 'FOLLOWERS_DAILY', '2026-11-03', T('03', '05:40'), { followers: 11 }),
  row(32, 'FOLLOWERS_DAILY', '2026-11-04', T('04', '05:30'), { followers: 12 })
]);

// 訂正：対象の値を置き換える。存在しない観測・採用されなかった観測への訂正は異常として残す
const c1 = row(40, 'CLICKS_DAILY', '2026-11-01:ALL', T('02', '05:30'), { date: '2026-11-01', total: 3, urls: 1 });
const c2old = row(41, 'CLICKS_DAILY', '2026-10-31:ALL', T('01', '05:30'), { date: '2026-10-31', total: 1, urls: 1 });
const c2new = row(42, 'CLICKS_DAILY', '2026-10-31:ALL', T('01', '06:30'), { date: '2026-10-31', total: 2, urls: 1 });
add('corrections', [
  c1, c2old, c2new,
  row(43, 'CORRECTION', 'CLICKS_DAILY:2026-11-01:ALL', T('02', '08:00'), { value: { date: '2026-11-01', total: 4, urls: 1 } }, { corrects: obsOf(c1) }),
  row(44, 'CORRECTION', 'CLICKS_DAILY:2026-11-01:ALL', T('02', '09:00'), { value: { date: '2026-11-01', total: 5, urls: 1 } }, { corrects: obsOf(c1) }),
  row(45, 'CORRECTION', 'CLICKS_DAILY:x', T('02', '08:00'), { value: { a: 1 } }, { corrects: 'OBS_' + 'a'.repeat(40) }),
  row(46, 'CORRECTION', 'CLICKS_DAILY:2026-10-31:ALL', T('02', '08:00'), { value: { a: 1 } }, { corrects: obsOf(c2old) })
]);

// 最初の1件だけが有効：同じ内容の記録し直しは異常にしない。内容違いは異常。二重投稿は DOUBLE_PUBLISH
add('first_only', [
  row(50, 'POST_PLANNED', '2026-11-02:S1', T('02', '07:00'), { slot: 'S1', dry_run: true }),
  row(51, 'POST_PLANNED', '2026-11-02:S1', T('02', '07:05'), { slot: 'S1', dry_run: true }),
  row(52, 'POST_PLANNED', '2026-11-02:S1', T('02', '07:10'), { slot: 'S1', dry_run: false }),
  row(53, 'POST_PUBLISHED', '2026-11-02:S2', T('02', '12:00'), { id: '1' }),
  row(54, 'POST_PUBLISHED', '2026-11-02:S2', T('02', '12:01'), { id: '2' }),
  row(55, 'EXPERIMENT_REGISTERED', 'E1', T('02', '01:00'), { h: 'a' }, { source: 'ACTIONS' }),
  row(56, 'EXPERIMENT_REGISTERED', 'E1', T('02', '02:00'), { h: 'b' }, { source: 'ACTIONS' })
]);

// 並び順：同じ観測日時なら発生元の優先順（GAS-PROD → GAS-DEV → ACTIONS）、次に event_id
add('ordering_ties', [
  row(62, 'DECISION', 'E2:mid', T('02', '03:00'), { r: 'a' }, { source: 'ACTIONS' }),
  row(61, 'DATA_QUALITY_FAILED', 'FOLLOWERS:2026-11-02', T('02', '03:00'), { kind: 'FOLLOWERS', reason: 'SPIKE' }),
  row(60, 'DATA_QUALITY_FAILED', 'FOLLOWERS:2026-11-02', T('02', '03:00'), { kind: 'FOLLOWERS', reason: 'SHAPE' }),
  row(63, 'HALT_SET', 'ALL.F4', T('02', '03:00'), { s: 1 }, { env: 'DEV' })
]);

// 衝突した訂正：訂正の対象も隔離する
const tgt = row(70, 'METRIC_72H', '200', T('02', '05:30'), { views: 1, likes: 0, replies: 0, reposts: 0, quotes: 0 });
add('conflicted_correction', [
  tgt,
  row(71, 'CORRECTION', 'METRIC_72H:200', T('02', '07:00'), { value: { views: 2 } }, { corrects: obsOf(tgt) }),
  row(71, 'CORRECTION', 'METRIC_72H:200', T('02', '07:00'), { value: { views: 3 } }, { corrects: obsOf(tgt), recordedAt: T('02', '07:01') })
]);

// 形が読めない行：INVALID_ROW（1件にまとめる）
add('invalid_rows', [
  row(80, 'REPLY_PLANNED', '300', T('02', '09:00'), { reply_to: '300', round: 1 }),
  mod(8, 'not json'),
  good.slice(0, 3)
]);

// 運用起点：最新の起点より後だけ。起点をまたぐ衝突は引き継ぐ
const ep1 = row(90, 'OPERATION_EPOCH', '2026-11-01', T('01', '00:00'), { note: 'start' });
const ep2 = row(91, 'OPERATION_EPOCH', '2026-11-02', T('02', '00:00'), { note: 'owner' });
add('since_epoch', [
  row(92, 'FOLLOWERS_DAILY', '2026-11-01', T('01', '05:30'), { followers: 1 }),
  ep1, ep2,
  row(93, 'FOLLOWERS_DAILY', '2026-11-02', T('02', '00:00'), { followers: 2 }),
  row(94, 'FOLLOWERS_DAILY', '2026-11-03', T('03', '05:30'), { followers: 3 }),
  row(95, 'FOLLOWERS_DAILY', '2026-11-01', T('01', '06:30'), { followers: 4 }),
  row(95, 'FOLLOWERS_DAILY', '2026-11-04', T('04', '05:30'), { followers: 5 }, { recordedAt: T('04', '05:31') })
], true);
add('no_epoch', [row(96, 'FOLLOWERS_DAILY', '2026-11-05', T('05', '05:30'), { followers: 6 })], true);

const recon = cases.map((c) => {
  const records = c.rows.map(rowToRecord);
  const rec = c.epoch ? reconstructSinceEpoch(records) : reconstruct(records);
  return { name: c.name, epoch: c.epoch, rows: c.rows, expect: summarize(rec) };
});

process.stdout.write(JSON.stringify({
  note: 'G2 共通試験データ。GAS 99 akane_testG2Vectors と data/test.mjs が使う。手で編集しない（make-vectors.mjs で作る）',
  headers: HEADERS,
  event_types: EVENT_TYPES,
  rows: rowCases,
  reconstruct: recon
}, null, 1) + '\n');
