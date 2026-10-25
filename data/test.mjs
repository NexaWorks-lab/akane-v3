// G2 data の試験（GitHub Actions の CI で実行。秘密も通信も使わない）
//   node data/test.mjs
// 共通の試験データ（data/vectors.json）と一致するかを確かめる。GAS側は 99 の akane_testG2Vectors が同じデータで確かめる。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { canonicalJson } from '../security/canonical.mjs';
import {
  HEADERS, EVENT_TYPES, rowToRecord, reconstruct, reconstructSinceEpoch, summarize, buildRow, compare, validTimestamp
} from './events.mjs';
import { qualityReport, reportMarkdown, SLOTS, LABELS } from './quality.mjs';
import { readEventRows } from './sheets.mjs';

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

// ---------- 1. 共通の試験データ ----------
ck('headers', canonicalJson(HEADERS.slice()) === canonicalJson(V.headers));
ck('event types', canonicalJson(EVENT_TYPES.slice().sort()) === canonicalJson(V.event_types.slice().sort()));
V.rows.forEach((c) => ck('row ' + c.name, (rowToRecord(c.row) !== null) === c.ok));

function run(rows, epoch) {
  const records = rows.map(rowToRecord);
  return canonicalJson(summarize(epoch ? reconstructSinceEpoch(records) : reconstruct(records)));
}

V.reconstruct.forEach((c) => {
  const want = canonicalJson(c.expect);
  ck('reconstruct ' + c.name, run(c.rows, c.epoch) === want);
  const rev = c.rows.slice().reverse();
  const dup = c.rows.concat(c.rows.slice(0, 1));
  const rot = c.rows.slice(1).concat(c.rows.slice(0, 1));
  ck('reconstruct ' + c.name + ' order/duplicate', run(rev, c.epoch) === want && run(dup, c.epoch) === want &&
    run(rot, c.epoch) === want);
});

// すべての並べ替え（小さな集合）で同じ結果（D6）
const small = V.reconstruct.find((c) => c.name === 'ordering_ties');
function perms(a) {
  if (a.length <= 1) { return [a]; }
  const out = [];
  a.forEach((x, i) => perms(a.slice(0, i).concat(a.slice(i + 1))).forEach((p) => out.push([x].concat(p))));
  return out;
}
ck('all permutations give the same state', perms(small.rows).every((p) => run(p, false) === canonicalJson(small.expect)));

// ---------- 2. 部品 ----------
ck('timestamp rules', validTimestamp('2026-11-02T23:59:59+09:00') && !validTimestamp('2026-11-02T23:59:59Z') &&
  !validTimestamp('2026-13-01T00:00:00+09:00') && !validTimestamp(null));
const a1 = { observed_at: 'x', source: 'GAS-PROD', event_id: 'b' };
ck('compare: source rank then id', compare(a1, { observed_at: 'x', source: 'ACTIONS', event_id: 'a' }) < 0 &&
  compare({ observed_at: 'x', source: 'GAS-PROD', event_id: 'a' }, a1) < 0 && compare(a1, a1) === 0);
ck('summary has no live objects', JSON.stringify(summarize(reconstruct([]))) === '{"ordered":[],"subjects":[],"anomalies":[],"quarantined":[]}');

// ---------- 3. データ品質 ----------
let n = 1000;
const T = (d, hm) => '2026-11-' + d + 'T' + hm + ':00+09:00';
const NOW = Date.parse('2026-11-04T09:00:00+09:00');
const START = Date.parse('2026-11-02T00:00:00+09:00');
const M5 = { views: 1, likes: 0, replies: 0, reposts: 0, quotes: 0 };
function r(type, subject, observed, payload, o) {
  n++;
  const opts = o || {};
  return buildRow({ event_id: opts.id || 'EVT_00000000-0000-4000-8000-' + String(n).padStart(12, '0'), event_type: type,
    subject_key: type + ':' + subject, observed_at: observed, payload, source: opts.source }, opts.env || 'PROD', opts.rec || observed);
}
function cleanDays() {
  const rows = [];
  ['02', '03', '04'].forEach((d) => {
    SLOTS.forEach((s) => {
      const t = T(d, s.time);
      if (Date.parse(t) + 2 * 3600000 >= NOW) { return; }
      rows.push(r('POST_PLANNED', '2026-11-' + d + ':' + s.id, t, { slot: s.id, dry_run: true }));
      rows.push(r('POST_SKIPPED', '2026-11-' + d + ':' + s.id, t, { slot: s.id, reason: 'DRY_RUN' }));
    });
    rows.push(r('FOLLOWERS_DAILY', '2026-11-' + d, T(d, '05:30'), { followers: 100 }));
    rows.push(r('CLICKS_DAILY', '2026-11-' + String(Number(d) - 1).padStart(2, '0') + ':ALL', T(d, '05:30'), { date: 'x', total: 1, urls: 1 }));
  });
  return rows;
}
const rep = (rows, now, from) => qualityReport(rows, 'PROD', now || NOW, from === null ? {} : { monitorFromMs: from === undefined ? START : from });
const q = (rows, now, from) => {
  const x = rep(rows, now, from);
  const m = {};
  x.checks.forEach((c) => { m[c.id] = c.count; });
  m.warnings = x.warnings;
  m.unknown = x.unknown;
  return m;
};
const base = q(cleanDays());
ck('quality: clean data -> no warnings, nothing unknown', base.warnings === 0 && base.unknown === 0 && base.POST_DRY_RUN === 8 &&
  base.POST_PUBLISHED === 0 && base.FOLLOWERS_MISSING_DAYS === 0 && base.CLICKS_MISSING_DAYS === 0 && base.MONITOR_START === 2 &&
  base.ROWS === cleanDays().length);

// 必須4：起点がなければ「記録がないこと」は判定不能。起点があれば、一度も記録がなくても数える
const noStart = q(cleanDays(), NOW, null);
ck('quality: no epoch and no start -> unknown (not zero)', noStart.unknown === 4 && noStart.POST_SLOT_MISSING === null &&
  noStart.FOLLOWERS_MISSING_DAYS === null && noStart.CLICKS_MISSING_DAYS === null && noStart.METRIC_72H_EXPIRED_MISSING === null &&
  noStart.MONITOR_START === 0 && /判定不能/.test(reportMarkdown(rep(cleanDays(), NOW, null))));
const empty = q([]);
ck('quality: nothing ever recorded but start known -> every slot and day counted', empty.POST_SLOT_MISSING === 8 &&
  empty.FOLLOWERS_MISSING_DAYS === 3 && empty.CLICKS_MISSING_DAYS === 3 && empty.unknown === 0);
const noFol02 = cleanDays().filter((x) => x[2] !== 'FOLLOWERS_DAILY:2026-11-02');
const withEpoch = noFol02.concat([r('OPERATION_EPOCH', '2026-11-03', T('03', '00:00'), { note: 'owner' })]);
ck('quality: operation epoch overrides the configured start', q(noFol02).FOLLOWERS_MISSING_DAYS === 1 &&
  q(withEpoch).FOLLOWERS_MISSING_DAYS === 0 && q(withEpoch).MONITOR_START === 1 && q(withEpoch, NOW, null).unknown === 0);
ck('quality: a day whose 5:00 is before the start is not counted', q(noFol02, NOW, Date.parse(T('02', '06:00'))).FOLLOWERS_MISSING_DAYS === 0 &&
  q(noFol02, NOW, Date.parse(T('02', '05:00'))).FOLLOWERS_MISSING_DAYS === 1);
const devEpoch = noFol02.concat([r('OPERATION_EPOCH', '2026-11-03', T('03', '00:00'), { note: 'x' }, { env: 'DEV' })]);
ck('quality: an epoch of another env is not used', q(devEpoch).FOLLOWERS_MISSING_DAYS === 1 && q(devEpoch).MONITOR_START === 2);

// 投稿枠
const noResult = cleanDays().filter((x) => !(x[1] === 'POST_SKIPPED' && x[2] === 'POST_SKIPPED:2026-11-03:S2'));
ck('quality: plan without result', q(noResult).POST_PLAN_NO_RESULT === 1 && q(noResult).warnings === 1);
const lateRes = cleanDays().concat([r('POST_PLANNED', '2026-11-04:S2', T('04', '08:30'), { slot: 'S2' })]);
ck('quality: plan within the grace hour is not counted', q(lateRes).POST_PLAN_NO_RESULT === 0);
const noSlot = cleanDays().filter((x) => x[2].indexOf('2026-11-03:S3') < 0);
ck('quality: slot with neither plan nor result', q(noSlot).POST_SLOT_MISSING === 1);
ck('quality: slots before the start or inside the window are not missing', q(cleanDays(), Date.parse(T('04', '08:59'))).POST_SLOT_MISSING === 0 &&
  q(cleanDays().filter((x) => x[2].indexOf('2026-11-02:S1') < 0), NOW, Date.parse(T('02', '07:01'))).POST_SLOT_MISSING === 0);
const pub = cleanDays().concat([
  r('POST_PLANNED', '2026-11-02:S5'.replace('S5', 'S4'), T('02', '20:00'), { slot: 'S4' }, { id: 'EVT_00000000-0000-4000-8000-0000000000f1' }),
  r('POST_PUBLISHED', '2026-11-01:S4', T('01', '20:01'), { post_id: '9' }),
  r('POST_PUBLISHED', '2026-11-03:S1', T('03', '07:01'), { id: 'x' })
]);
ck('quality: published counted apart from DRY_RUN; published without a post id is flagged', q(pub).POST_PUBLISHED === 2 &&
  q(pub).POST_DRY_RUN === 7 && q(pub).POST_PUBLISHED_NO_ID === 1);
const sending = cleanDays().concat([
  r('POST_SENDING', '2026-11-03:S1', T('03', '07:00'), { c: '1' }),
  r('POST_SENDING', '2026-11-03:S2', T('03', '12:00'), { c: '2' }), r('POST_PUBLISHED', '2026-11-03:S2', T('03', '12:01'), { post_id: '7' }),
  r('POST_SENDING', '2026-11-04:S1', T('04', '08:30'), { c: '3' }),
  r('POST_RESULT_UNKNOWN', '2026-11-03:S3', T('03', '16:05'), { c: '4' })
]);
ck('quality: sending without result (after grace) and unknown results are flagged', q(sending).POST_SENDING_OPEN === 1 &&
  q(sending).POST_RESULT_UNKNOWN === 1);

// 返事（必須3：隔離中の対象は数えない）
const replies = cleanDays().concat([
  r('REPLY_PLANNED', '501', T('04', '07:00'), { reply_to: '501' }),
  r('REPLY_PLANNED', '502', T('04', '07:00'), { reply_to: '502' }),
  r('REPLY_SKIPPED', '502', T('04', '07:01'), { reason: 'TIME_UP' }),
  r('REPLY_PLANNED', '503', T('04', '08:30'), { reply_to: '503' }),
  r('REPLY_SKIPPED', '504', T('01', '07:01'), { reason: 'TIME_UP' })
]);
ck('quality: reply plan without result (after 1 hour), time-ups in 7 days', q(replies).REPLY_PLAN_NO_RESULT === 1 &&
  q(replies).REPLY_TIME_UP_7D === 2 && q(replies, Date.parse(T('20', '00:00'))).REPLY_TIME_UP_7D === 0);
const qid = 'EVT_00000000-0000-4000-8000-0000000000aa';
const qReplies = replies.concat([
  r('REPLY_SKIPPED', '505', T('04', '07:01'), { reason: 'TIME_UP' }, { id: qid }),
  r('REPLY_SKIPPED', '505', T('04', '07:01'), { reason: 'F2' }, { id: qid, rec: T('04', '07:02') }),
  r('REPLY_SKIPPED', '505', T('04', '07:03'), { reason: 'TIME_UP' }),
  r('DATA_QUALITY_FAILED', 'FOLLOWERS:2026-11-03', T('03', '05:30'), { reason: 'SPIKE' }, { id: 'EVT_00000000-0000-4000-8000-0000000000ab' }),
  r('DATA_QUALITY_FAILED', 'FOLLOWERS:2026-11-03', T('03', '05:31'), { reason: 'SPIKE' }),
  r('DATA_QUALITY_FAILED', 'FOLLOWERS:2026-11-03', T('03', '05:30'), { reason: 'SHAPE' }, { id: 'EVT_00000000-0000-4000-8000-0000000000ab', rec: T('03', '05:32') })
]);
ck('quality: quarantined subjects are not counted in time-ups or data quality notes', q(qReplies).REPLY_TIME_UP_7D === 2 &&
  q(qReplies).DATA_QUALITY_FAILED_7D === 0 && q(qReplies).QUARANTINED === 2);

// 必須2：日次の数値の完全性（0 は正常）
const fol = (v) => cleanDays().filter((x) => x[2] !== 'FOLLOWERS_DAILY:2026-11-03').concat([r('FOLLOWERS_DAILY', '2026-11-03', T('03', '05:30'), v)]);
ck('quality: followers must be a count (0 ok; -1, missing key, string, missing flag -> missing)',
  q(fol({ followers: 0 })).FOLLOWERS_MISSING_DAYS === 0 && q(fol({ followers: -1 })).FOLLOWERS_MISSING_DAYS === 1 &&
  q(fol({ code: 'X' })).FOLLOWERS_MISSING_DAYS === 1 && q(fol({ followers: '5' })).FOLLOWERS_MISSING_DAYS === 1 &&
  q(fol({ missing: true, followers: 5 })).FOLLOWERS_MISSING_DAYS === 1);
const clk = (v) => cleanDays().filter((x) => x[2] !== 'CLICKS_DAILY:2026-11-02:ALL').concat([r('CLICKS_DAILY', '2026-11-02:ALL', T('03', '05:30'), v)]);
ck('quality: clicks need total and urls as counts (0 ok)', q(clk({ total: 0, urls: 0 })).CLICKS_MISSING_DAYS === 0 &&
  q(clk({ urls: 1 })).CLICKS_MISSING_DAYS === 1 && q(clk({ total: 1 })).CLICKS_MISSING_DAYS === 1 &&
  q(clk({ total: 1, urls: '1' })).CLICKS_MISSING_DAYS === 1 && q(clk({ missing: true })).CLICKS_MISSING_DAYS === 1);
ck('quality: before 7:00 today is not yet counted', q(cleanDays().filter((x) => x[2] !== 'FOLLOWERS_DAILY:2026-11-04'),
  Date.parse(T('04', '06:59'))).FOLLOWERS_MISSING_DAYS === 0 &&
  q(cleanDays().filter((x) => x[2] !== 'FOLLOWERS_DAILY:2026-11-04')).FOLLOWERS_MISSING_DAYS === 1);

// 必須1：72時間の実績（実際の投稿で記録がない・不完全も数える。DRY_RUN は対象外）
const NOW2 = Date.parse('2026-11-08T12:00:00+09:00');
const met = (extra) => q(cleanDays().concat(extra), NOW2).METRIC_72H_EXPIRED_MISSING;
ck('quality: published post with no 72h record after 96h is counted', met([r('POST_PUBLISHED', '2026-11-02:S1', T('02', '07:01'), { post_id: '701' })]) === 1);
ck('quality: complete record -> ok; incomplete (no missing flag) or missing -> counted',
  met([r('POST_PUBLISHED', '2026-11-02:S1', T('02', '07:01'), { post_id: '702' }), r('METRIC_72H', '702', T('05', '05:30'), Object.assign({ posted_at: T('02', '07:01') }, M5))]) === 0 &&
  met([r('POST_PUBLISHED', '2026-11-02:S1', T('02', '07:01'), { post_id: '703' }), r('METRIC_72H', '703', T('05', '05:30'), { views: 1, likes: 0, replies: 0, reposts: 0, posted_at: T('02', '07:01') })]) === 1 &&
  met([r('METRIC_72H', '704', T('05', '05:30'), { missing: true, code: 'X', posted_at: T('02', '08:00') })]) === 1 &&
  met([r('METRIC_72H', '705', T('05', '05:30'), Object.assign({ posted_at: T('02', '08:00') }, M5, { quotes: -1 }))]) === 1);
ck('quality: inside the 96h window or before the start -> not counted; DRY_RUN never counted',
  met([r('POST_PUBLISHED', '2026-11-05:S1', T('05', '07:01'), { post_id: '706' })]) === 0 &&
  met([r('METRIC_72H', '707', T('05', '05:30'), { missing: true, posted_at: T('01', '08:00') })]) === 0 &&
  met([]) === 0);

const dq = cleanDays().concat([r('DATA_QUALITY_FAILED', 'FOLLOWERS:2026-11-03', T('03', '05:30'), { reason: 'SPIKE' }),
  r('DATA_QUALITY_FAILED', 'FOLLOWERS:2026-10-01', '2026-10-01T05:30:00+09:00', { reason: 'SPIKE' })]);
ck('quality: data quality notes in 7 days (number of records)', q(dq).DATA_QUALITY_FAILED_7D === 1);

const confl = cleanDays().concat([
  r('FOLLOWERS_DAILY', '2026-11-02', T('02', '06:00'), { followers: 1 }, { id: 'EVT_00000000-0000-4000-8000-00000000aaaa' }),
  r('FOLLOWERS_DAILY', '2026-11-02', T('02', '06:00'), { followers: 2 }, { id: 'EVT_00000000-0000-4000-8000-00000000aaaa', rec: T('02', '06:01') })
]);
ck('quality: id conflicts and quarantined subjects (quarantined day counts as missing)', q(confl).ID_CONFLICTS_ENV === 1 &&
  q(confl).ID_CONFLICTS_ALL === 1 && q(confl).QUARANTINED === 1 && q(confl).FOLLOWERS_MISSING_DAYS === 1);
const devConfl = cleanDays().concat([
  r('FOLLOWERS_DAILY', '2026-11-02', T('02', '06:00'), { followers: 1 }, { id: 'EVT_00000000-0000-4000-8000-00000000bbbb', env: 'DEV' }),
  r('FOLLOWERS_DAILY', '2026-11-02', T('02', '06:00'), { followers: 2 }, { id: 'EVT_00000000-0000-4000-8000-00000000bbbb', env: 'DEV', rec: T('02', '06:01') })
]);
ck('quality: conflicts only in another env -> all-env count only', q(devConfl).ID_CONFLICTS_ENV === 0 && q(devConfl).ID_CONFLICTS_ALL === 1 &&
  q(devConfl).QUARANTINED === 0);

const mixed = cleanDays().filter((x) => x[2] !== 'FOLLOWERS_DAILY:2026-11-03')
  .concat([['x'], r('FOLLOWERS_DAILY', '2026-11-03', T('03', '05:30'), { followers: 1 }, { env: 'DEV' })]);
ck('quality: invalid rows and other env rows are counted, other env not used', q(mixed).INVALID_ROWS === 1 &&
  q(mixed).OTHER_ENV_ROWS === 1 && q(mixed).FOLLOWERS_MISSING_DAYS === 1);
ck('quality: bad input rejected', errOf(() => qualityReport(null, 'PROD', NOW)) === 'AKANE_QUALITY_INVALID_INPUT' &&
  errOf(() => qualityReport([], 'XX', NOW)) === 'AKANE_QUALITY_INVALID_INPUT' &&
  errOf(() => qualityReport([], 'PROD', NaN)) === 'AKANE_QUALITY_INVALID_INPUT' &&
  errOf(() => qualityReport([], 'PROD', NOW, { monitorFromMs: NaN })) === 'AKANE_QUALITY_INVALID_INPUT');
const md = reportMarkdown(rep(replies.concat(pub, sending), NOW));
ck('quality: report shows allow-listed labels and counts only', !/EVT_|OBS_|POST_PLANNED|REPLY_|501|701|post_id|2026-11/.test(md) &&
  /\| 件数 \|/.test(md) && md.split('\n').filter((l) => /^\| (?!確認|---)/.test(l)).length === Object.keys(LABELS).length);
const md2 = reportMarkdown({ checks: [{ id: 'SECRET_ID_EVT_1', count: 5, warn: true }, { id: 'ROWS', count: '7<script>', warn: false }], warnings: 1, unknown: 0 });
ck('quality: unknown ids are not printed, counts are numbers only', md2.indexOf('SECRET') === -1 && md2.indexOf('script') === -1 &&
  md2.indexOf('undefined') === -1 && md2.split('\n').filter((l) => /^\| (?!確認|---)/.test(l)).length === 1 &&
  /\| 行の数 \| NaN \| OK \|/.test(md2));

// ---------- 4. シートの読み取り（模擬の fetch） ----------
const SHEET = 'A'.repeat(44);
function fakeFetch(status, body, seen) {
  return async (url, init) => {
    if (seen) { seen.push({ url, init }); }
    return { status, json: async () => body };
  };
}
async function sheetsTests() {
  const seen = [];
  const vals = [HEADERS.slice(), ['a', 'b'], 'x', HEADERS.slice().concat(['extra', 'more'])];
  const rows = await readEventRows('tok', SHEET, fakeFetch(200, { values: vals }, seen));
  ck('sheets: header removed, short rows padded to 10, non-array row -> null', rows.length === 3 && rows[0].length === 10 &&
    rows[0][9] === '' && rows[1] === null && rows[2].length === 11);
  ck('sheets: GET only, read range of the events sheet, unformatted values, token in header only',
    seen.length === 1 && seen[0].init.method === 'GET' && /values\/'%E3%82%A4%E3%83%99%E3%83%B3%E3%83%88'!A1%3AJ\?/.test(seen[0].url) &&
    /valueRenderOption=UNFORMATTED_VALUE/.test(seen[0].url) && seen[0].url.indexOf('tok') === -1 &&
    seen[0].init.headers.Authorization === 'Bearer tok' && !seen[0].init.body);
  const err = async (p) => { try { await p; return null; } catch (e) { return e.message; } };
  ck('sheets: non-200 -> status code only', await err(readEventRows('tok', SHEET, fakeFetch(403, {}))) === 'AKANE_DATA_READ_STATUS_403');
  ck('sheets: header mismatch', await err(readEventRows('tok', SHEET, fakeFetch(200, { values: [['x']] }))) === 'AKANE_DATA_HEADERS_MISMATCH' &&
    await err(readEventRows('tok', SHEET, fakeFetch(200, {}))) === 'AKANE_DATA_HEADERS_MISSING');
  const calls = [];
  ck('sheets: bad inputs -> no request', await err(readEventRows('', SHEET, fakeFetch(200, {}, calls))) === 'AKANE_DATA_INPUT_INVALID' &&
    await err(readEventRows('tok', 'bad/id', fakeFetch(200, {}, calls))) === 'AKANE_DATA_INPUT_INVALID' && calls.length === 0);
  ck('sheets: network error -> code only', await err(readEventRows('tok', SHEET, async () => { throw new Error('secret tok'); })) ===
    'AKANE_DATA_READ_FAILED');
  ck('sheets: bad json -> shape', await err(readEventRows('tok', SHEET, async () => ({ status: 200, json: async () => { throw new Error('x'); } }))) ===
    'AKANE_DATA_READ_SHAPE');
}

// ---------- 5. 実行の入口（読み取りに失敗したら 1。秘密を出さない） ----------
function entryTest() {
  const res = spawnSync(process.execPath, [path.join(dir, 'check.mjs')], {
    env: { PATH: process.env.PATH, ACCESS_TOKEN: '', MAIN_SHEET_ID: '' }, encoding: 'utf8'
  });
  ck('entry: missing inputs -> exit 1 with a code only', res.status === 1 && /AKANE_DATA_INPUT_INVALID/.test(res.stdout));
}

// ---------- 6. このディレクトリのコードは書き込みの要求をしない ----------
function staticTest() {
  const src = ['events.mjs', 'quality.mjs', 'sheets.mjs', 'check.mjs'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  ck('static: no write requests (POST/PUT/PATCH/DELETE, :append, :batchUpdate)', !/method:\s*'(POST|PUT|PATCH|DELETE)'|:append|batchUpdate|:clear/.test(src));
  ck('static: no logging of environment values', !/console\.log\([^)]*process\.env/.test(src));
}

await sheetsTests();
entryTest();
staticTest();

const total = passed + failures.length;
console.log('G2 data: ' + passed + ' PASS / ' + failures.length + ' FAIL (total ' + total + ')');
if (failures.length) {
  console.log('FAIL: ' + failures.join(', '));
  process.exitCode = 1;
}
