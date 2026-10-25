// G2 data：データ品質の確認（読み取りと計算だけ。純粋関数）
//
// 入力：イベントの行（文字列の配列の配列）、対象の env、現在時刻（Unix ミリ秒）、
//       opts.monitorFromMs（運用起点がまだないときの「監視の開始時刻」。なければ起点がない限り判定不能）
// 出力：確認項目ごとの件数（または判定不能）だけ。ID・本文・URL・数値の中身は出さない（公開リポジトリのログに出すため）。
//
// 監視の開始（起点）：対象の env の最新の運用起点（OPERATION_EPOCH）があればそれ、なければ opts.monitorFromMs。
//   どちらもなければ、「記録がないこと」を数える項目（枠・日次・72時間）は判定不能（null）とする。
// 分析の規則（06・04 の申し送り）：
// - 対象の env の記録だけで再構成し、隔離中（quarantined）の対象は、件数にも正常の判定にも使わない。
// - DRY_RUN の結果（POST_SKIPPED）は実投稿として数えない。実投稿は POST_PUBLISHED だけ。
// - 数値は 0 以上の安全な整数のときだけ正常（0 も正常）。missing の印がなくても、値が欠けていれば欠損。

import { rowToRecord, reconstruct } from './events.mjs';

export const SLOTS = Object.freeze([
  Object.freeze({ id: 'S1', time: '07:00' }), Object.freeze({ id: 'S2', time: '12:00' }),
  Object.freeze({ id: 'S3', time: '16:00' }), Object.freeze({ id: 'S4', time: '20:00' })
]);

export const POLICY = Object.freeze({
  SLOT_WINDOW_H: 2,          // 01 の枠の窓（2時間）
  PLAN_RESULT_GRACE_H: 1,    // 計画から結果までの猶予（02・04 は同じ実行の中で結果を記録する）
  REPLY_RESULT_GRACE_H: 1,
  SENDING_GRACE_H: 1,
  DAILY_FROM_HOUR: 5,        // 06 は 5:00〜6:59 に動く
  DAILY_READY_HOUR: 7,       // 7時以降はその日の記録があるはず
  METRIC_MAX_AGE_H: 96,
  RECENT_DAYS: 7,
  POST_METRICS: Object.freeze(['views', 'likes', 'replies', 'reposts', 'quotes'])
});

/** 公開してよい表示名（許可リスト）。ここにない項目は表に出さない。 */
export const LABELS = Object.freeze({
  ROWS: '行の数',
  INVALID_ROWS: '形が読めない行',
  OTHER_ENV_ROWS: '別の環境の行',
  ID_CONFLICTS_ENV: 'ID の衝突（この環境）',
  ID_CONFLICTS_ALL: 'ID の衝突（全環境）',
  QUARANTINED: '隔離中の対象',
  ANOMALY_DOUBLE_PUBLISH: '異常：二重投稿',
  ANOMALY_FIRST_ONLY_DUPLICATE: '異常：最初の1件だけ有効な記録の内容違い',
  ANOMALY_REGISTRATION_CHANGED: '異常：実験の登録の変更',
  ANOMALY_CORRECTION_TARGET_MISSING: '異常：訂正の対象がない',
  ANOMALY_CORRECTION_TARGET_NOT_ADOPTED: '異常：訂正の対象が採用されていない',
  MONITOR_START: '監視の開始（1＝運用起点、2＝設定の開始時刻、0＝不明）',
  POST_PLAN_NO_RESULT: '投稿枠：計画だけで結果がない',
  POST_SLOT_MISSING: '投稿枠：計画も結果もない（窓を過ぎた）',
  POST_SENDING_OPEN: '投稿：送信開始のまま結果がない',
  POST_RESULT_UNKNOWN: '投稿：結果不明',
  POST_DRY_RUN: '投稿枠：DRY_RUN の結果',
  POST_PUBLISHED: '投稿枠：実際の投稿',
  POST_PUBLISHED_NO_ID: '実際の投稿：投稿IDが読めない',
  REPLY_PLAN_NO_RESULT: '返事：計画だけで結果がない',
  REPLY_TIME_UP_7D: '返事：時間切れ（直近7日の記録の数）',
  FOLLOWERS_MISSING_DAYS: 'フォロワー数：記録がない・欠損・不正な日',
  CLICKS_MISSING_DAYS: '前日のクリック数：記録がない・欠損・不正な日',
  METRIC_72H_EXPIRED_MISSING: '72時間の実績：窓を過ぎても記録がない・欠損・不完全',
  DATA_QUALITY_FAILED_7D: '06 の品質の注意（直近7日の記録の数）'
});

const H = 3600000;

export function isCount(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

export function jstMs(ts) {
  return Date.parse(ts);
}

export function jstDate(ms) {
  return new Date(ms + 9 * H).toISOString().slice(0, 10);
}

export function addDays(dateKey, n) {
  return new Date(Date.parse(dateKey + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}

function datesBetween(from, to) {
  const out = [];
  for (let d = from; d <= to && out.length < 4000; d = addDays(d, 1)) { out.push(d); }
  return out;
}

/**
 * データ品質の確認。返り値：{ checks: [{ id, count, warn }], warnings, unknown }
 *   count：件数。判定できないときは null（unknown に数える）
 *   warn：注意の項目で count が 1 以上
 */
export function qualityReport(rows, env, nowMs, opts) {
  const monitorFrom = opts && opts.monitorFromMs !== undefined ? opts.monitorFromMs : null;

  if (!Array.isArray(rows) || (env !== 'PROD' && env !== 'DEV') || !Number.isSafeInteger(nowMs) ||
      (monitorFrom !== null && !Number.isSafeInteger(monitorFrom))) {
    throw new Error('AKANE_QUALITY_INVALID_INPUT');
  }

  const records = rows.map((r) => rowToRecord(r));
  const mine = records.filter((r) => r !== null && r.env === env);
  const rec = reconstruct(mine);
  const all = reconstruct(records);
  const subjects = rec.subjects;
  const quarantined = new Set(rec.quarantined);
  const use = (k) => subjects[k] && !quarantined.has(k) ? subjects[k] : null;
  const live = rec.ordered.filter((r) => !quarantined.has(r.subject_key));
  const checks = [];

  function add(id, count, isWarn) {
    if (!Object.prototype.hasOwnProperty.call(LABELS, id)) { throw new Error('AKANE_QUALITY_UNKNOWN_CHECK'); }
    checks.push({ id, count, warn: isWarn === true && count !== null && count > 0 });
  }

  // 監視の開始
  let epochAt = null;
  rec.ordered.forEach((r) => { if (r.event_type === 'OPERATION_EPOCH') { epochAt = r.observed_at; } });
  const startMs = epochAt !== null ? jstMs(epochAt) : monitorFrom;

  // 1. 記録そのもの
  add('ROWS', rows.length, false);
  add('INVALID_ROWS', records.filter((r) => r === null).length, true);
  add('OTHER_ENV_ROWS', records.filter((r) => r !== null && r.env !== env).length, false);
  add('ID_CONFLICTS_ENV', rec.anomalies.filter((a) => a.kind === 'EVENT_ID_CONFLICT').length, true);
  add('ID_CONFLICTS_ALL', all.anomalies.filter((a) => a.kind === 'EVENT_ID_CONFLICT').length, true);
  add('QUARANTINED', rec.quarantined.length, true);
  ['DOUBLE_PUBLISH', 'FIRST_ONLY_DUPLICATE', 'REGISTRATION_CHANGED', 'CORRECTION_TARGET_MISSING',
    'CORRECTION_TARGET_NOT_ADOPTED'].forEach((k) => {
    add('ANOMALY_' + k, rec.anomalies.filter((a) => a.kind === k).length, true);
  });
  add('MONITOR_START', epochAt !== null ? 1 : (monitorFrom !== null ? 2 : 0), false);

  // 2. 投稿枠
  const resultOf = (slotKey) => use('POST_SKIPPED:' + slotKey) || use('POST_PUBLISHED:' + slotKey);
  let planNoResult = 0;
  let dryRun = 0;
  let published = 0;

  Object.keys(subjects).filter((k) => /^POST_PLANNED:\d{4}-\d{2}-\d{2}:S[1-4]$/.test(k)).forEach((k) => {
    const s = use(k);
    if (!s) { return; }
    const r = resultOf(k.slice('POST_PLANNED:'.length));
    if (!r && jstMs(s.adopted.observed_at) + POLICY.PLAN_RESULT_GRACE_H * H < nowMs) { planNoResult++; }
  });

  Object.keys(subjects).filter((k) => /^POST_SKIPPED:\d{4}-\d{2}-\d{2}:S[1-4]$/.test(k)).forEach((k) => {
    const s = use(k);
    if (s && s.value && s.value.reason === 'DRY_RUN' && !use('POST_PUBLISHED:' + k.slice('POST_SKIPPED:'.length))) { dryRun++; }
  });

  const publishedPosts = [];
  let publishedNoId = 0;

  Object.keys(subjects).filter((k) => /^POST_PUBLISHED:/.test(k)).forEach((k) => {
    const s = use(k);
    if (!s) { return; }
    published++;
    // 02後半で POST_PUBLISHED の payload に post_id（Threads の投稿ID）を入れる。観測日時を投稿の時刻とみなす
    const pid = s.value && typeof s.value.post_id === 'string' && /^[0-9]{1,30}$/.test(s.value.post_id) ? s.value.post_id : null;
    if (pid === null) { publishedNoId++; } else { publishedPosts.push({ id: pid, ms: jstMs(s.adopted.observed_at) }); }
  });

  let slotMissing = null;

  if (startMs !== null) {
    slotMissing = 0;
    datesBetween(jstDate(startMs), jstDate(nowMs)).forEach((d) => {
      SLOTS.forEach((sl) => {
        const t = jstMs(d + 'T' + sl.time + ':00+09:00');
        const key = d + ':' + sl.id;
        if (t >= startMs && t + POLICY.SLOT_WINDOW_H * H < nowMs && !use('POST_PLANNED:' + key) && !resultOf(key)) {
          slotMissing++;
        }
      });
    });
  }

  // 未確定の送信：POST_SENDING のあと POST_PUBLISHED がない（猶予を過ぎた）・POST_RESULT_UNKNOWN
  let sendingOpen = 0;
  Object.keys(subjects).filter((k) => /^POST_SENDING:/.test(k)).forEach((k) => {
    const s = use(k);
    if (s && !use('POST_PUBLISHED:' + k.slice('POST_SENDING:'.length)) &&
        jstMs(s.adopted.observed_at) + POLICY.SENDING_GRACE_H * H < nowMs) { sendingOpen++; }
  });
  const resultUnknown = Object.keys(subjects).filter((k) => /^POST_RESULT_UNKNOWN:/.test(k) && use(k)).length;

  add('POST_PLAN_NO_RESULT', planNoResult, true);
  add('POST_SLOT_MISSING', slotMissing, true);
  add('POST_SENDING_OPEN', sendingOpen, true);
  add('POST_RESULT_UNKNOWN', resultUnknown, true);
  add('POST_DRY_RUN', dryRun, false);
  add('POST_PUBLISHED', published, false);
  add('POST_PUBLISHED_NO_ID', publishedNoId, true);

  // 3. 返事
  let replyNoResult = 0;
  Object.keys(subjects).filter((k) => /^REPLY_PLANNED:[0-9]{1,30}$/.test(k)).forEach((k) => {
    const s = use(k);
    if (!s) { return; }
    const id = k.slice('REPLY_PLANNED:'.length);
    if (!use('REPLY_SKIPPED:' + id) && !use('REPLY_SENT:' + id) &&
        jstMs(s.adopted.observed_at) + POLICY.REPLY_RESULT_GRACE_H * H < nowMs) {
      replyNoResult++;
    }
  });
  const since = nowMs - POLICY.RECENT_DAYS * 86400000;
  const recent = (r) => jstMs(r.observed_at) >= since;
  const reasonOf = (r) => { try { return JSON.parse(r.payload).reason; } catch (e) { return null; } };

  add('REPLY_PLAN_NO_RESULT', replyNoResult, true);
  add('REPLY_TIME_UP_7D', live.filter((r) => r.event_type === 'REPLY_SKIPPED' && recent(r) && reasonOf(r) === 'TIME_UP').length, false);

  // 4. フォロワー数（その日）・前日のクリック数（記録する日 d：d の 5:00 が開始より後、d の 7:00 を過ぎた日）
  function missingDays(keyOf, valid) {
    if (startMs === null) { return null; }
    let n = 0;
    datesBetween(jstDate(startMs), jstDate(nowMs)).forEach((d) => {
      const from = jstMs(d + 'T' + String(POLICY.DAILY_FROM_HOUR).padStart(2, '0') + ':00:00+09:00');
      const ready = jstMs(d + 'T' + String(POLICY.DAILY_READY_HOUR).padStart(2, '0') + ':00:00+09:00');
      if (from < startMs || ready > nowMs) { return; }
      const s = use(keyOf(d));
      if (!s || !s.value || s.value.missing === true || !valid(s.value)) { n++; }
    });
    return n;
  }

  add('FOLLOWERS_MISSING_DAYS', missingDays((d) => 'FOLLOWERS_DAILY:' + d, (v) => isCount(v.followers)), true);
  add('CLICKS_MISSING_DAYS', missingDays((d) => 'CLICKS_DAILY:' + addDays(d, -1) + ':ALL',
    (v) => isCount(v.total) && isCount(v.urls)), true);

  // 5. 72時間の実績：実際の投稿（POST_PUBLISHED）と、記録のある投稿（ver.2 の投稿を含む）について、
  //    投稿から96時間を過ぎても、記録がない・欠損・5つの指標がそろわないもの
  let metricExpired = null;

  if (startMs !== null) {
    const posts = new Map();
    publishedPosts.forEach((p) => posts.set(p.id, p.ms));
    Object.keys(subjects).filter((k) => /^METRIC_72H:[0-9]{1,30}$/.test(k)).forEach((k) => {
      const s = use(k);
      const pid = k.slice('METRIC_72H:'.length);
      const posted = s && s.value && typeof s.value.posted_at === 'string' ? jstMs(s.value.posted_at) : NaN;
      if (!posts.has(pid) && Number.isFinite(posted)) { posts.set(pid, posted); }
    });
    metricExpired = 0;
    posts.forEach((ms, pid) => {
      if (!(ms >= startMs) || !(ms + POLICY.METRIC_MAX_AGE_H * H < nowMs)) { return; }
      const s = use('METRIC_72H:' + pid);
      const ok = s && s.value && s.value.missing !== true && POLICY.POST_METRICS.every((m) => isCount(s.value[m]));
      if (!ok) { metricExpired++; }
    });
  }
  add('METRIC_72H_EXPIRED_MISSING', metricExpired, true);

  // 6. 06 の品質の注意：直近7日の記録の数（隔離中の対象は除く）
  add('DATA_QUALITY_FAILED_7D', live.filter((r) => r.event_type === 'DATA_QUALITY_FAILED' && recent(r)).length, true);

  return {
    checks,
    warnings: checks.filter((c) => c.warn).length,
    unknown: checks.filter((c) => c.count === null).length
  };
}

/** 公開してよい形の表（許可リストの表示名と件数だけ）。 */
export function reportMarkdown(report) {
  const lines = ['| 確認 | 件数 | 判定 |', '|---|---|---|'];
  report.checks.forEach((c) => {
    if (!Object.prototype.hasOwnProperty.call(LABELS, c.id)) { return; }
    const n = c.count === null ? '—' : String(Number(c.count));
    const j = c.count === null ? '判定不能' : (c.warn ? '注意' : 'OK');
    lines.push('| ' + LABELS[c.id] + ' | ' + n + ' | ' + j + ' |');
  });
  lines.push('');
  lines.push('注意の項目：' + Number(report.warnings) + '　判定不能の項目：' + Number(report.unknown));
  return lines.join('\n');
}
