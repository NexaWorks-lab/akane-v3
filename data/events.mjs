// G2 data：イベントの行の読み取りと、決定的な再構成（GASの 12_Events.gs と同じ規則）
//
// GAS側の対応：
//   akane_eventsHeaders_ / akane_eventsValidTimestamp_ / akane_eventsValidEventId_ / akane_eventsValidSubjectKey_ /
//   akane_eventsValidObservationId_ / akane_eventsObservationId_ / akane_eventsRowToRecord_ / akane_eventsContentKey_ /
//   akane_eventsCompare_ / akane_eventsFirstOnlyTypes_ / akane_eventsReconstructCore_ / akane_eventsReconstructSinceEpoch_
// 種類の一覧は 00_Config.gs の AKANE_CONFIG.EVENT_TYPES と同じ（99 の akane_testG2Vectors で一致を確かめる）。
//
// 12の規則を変えるときは、このファイルと data/vectors.json を同時に直し、
// GAS側（99の akane_testG2Vectors）と GitHub側（data/test.mjs）の両方で一致を確かめること。
// このファイルは読み取りと計算だけ（外部と通信しない）。

import { canonicalJson, parseCanonicalJson } from '../security/canonical.mjs';
import { sha256Hex } from '../security/bundle.mjs';

export const HEADERS = Object.freeze([
  'event_id', 'event_type', 'subject_key', 'observation_id', 'observed_at',
  'recorded_at', 'source', 'env', 'payload', 'corrects'
]);

export const EVENT_TYPES = Object.freeze([
  'POST_PLANNED', 'POST_SENDING', 'POST_PUBLISHED', 'POST_SKIPPED', 'POST_RESULT_UNKNOWN',
  'REPLY_PLANNED', 'REPLY_SENT', 'REPLY_SKIPPED',
  'METRIC_72H', 'CLICKS_DAILY', 'FOLLOWERS_DAILY',
  'DATA_QUALITY_FAILED',
  'EXPERIMENT_REGISTERED', 'ASSIGNMENT_ISSUED', 'DECISION',
  'BUNDLE_ISSUED', 'BUNDLE_ACCEPTED', 'BUNDLE_REJECTED', 'BUNDLE_EXPIRED',
  'CORRECTION',
  'INTAKE_REJECTED', 'DELIVERY_ACK',
  'HALT_SET', 'HALT_CLEARED', 'HALT_CLEAR_REJECTED',
  'OPERATION_EPOCH'
]);

const FIRST_ONLY = Object.freeze(['POST_PLANNED', 'ASSIGNMENT_ISSUED', 'DECISION', 'POST_PUBLISHED', 'EXPERIMENT_REGISTERED']);

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function sourceRank(source) {
  const ranks = { 'GAS-PROD': 0, 'GAS-DEV': 1, 'ACTIONS': 2 };
  return has(ranks, source) ? ranks[source] : -1;
}

export function validDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) { return false; }
  const y = Number(value.slice(0, 4));
  const m = Number(value.slice(5, 7));
  const d = Number(value.slice(8, 10));
  if (y < 1970 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) { return false; }
  const p = new Date(Date.UTC(y, m - 1, d));
  return p.getUTCFullYear() === y && p.getUTCMonth() === m - 1 && p.getUTCDate() === d;
}

export function validTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\+09:00$/.test(value)) {
    return false;
  }
  return validDateKey(value.slice(0, 10));
}

export function validEventId(value) {
  return typeof value === 'string' &&
    /^EVT_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
}

export function validSubjectKey(value, eventType) {
  return typeof value === 'string' && typeof eventType === 'string' &&
    value.length > eventType.length + 1 && value.length <= 500 &&
    value.indexOf(eventType + ':') === 0 && !/[\u0000-\u001F\u007F]/.test(value);
}

export function validObservationId(value) {
  return typeof value === 'string' && /^OBS_[0-9a-f]{40}$/.test(value);
}

export function observationId(subjectKey, observedAt, source) {
  return 'OBS_' + sha256Hex(canonicalJson({ o: observedAt, s: source, k: subjectKey })).slice(0, 40);
}

/** シートの1行（文字列の配列）→ 記録。形が正しくなければ null。 */
export function rowToRecord(row) {
  if (!Array.isArray(row) || row.length !== HEADERS.length) { return null; }

  const r = {};

  for (let i = 0; i < HEADERS.length; i++) {
    if (typeof row[i] !== 'string') { return null; }
    r[HEADERS[i]] = row[i];
  }

  if (!validEventId(r.event_id) || EVENT_TYPES.indexOf(r.event_type) === -1 ||
      !validSubjectKey(r.subject_key, r.event_type) || !validObservationId(r.observation_id) ||
      !validTimestamp(r.observed_at) || !validTimestamp(r.recorded_at) ||
      sourceRank(r.source) < 0 || (r.env !== 'DEV' && r.env !== 'PROD')) {
    return null;
  }

  if ((r.source === 'GAS-PROD' && r.env !== 'PROD') || (r.source === 'GAS-DEV' && r.env !== 'DEV')) {
    return null;
  }

  if (r.observation_id !== observationId(r.subject_key, r.observed_at, r.source)) { return null; }

  let payload;

  try { payload = parseCanonicalJson(r.payload); } catch (e) { return null; }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { return null; }

  if (r.event_type === 'CORRECTION') {
    if (!validObservationId(r.corrects) || !payload.value || typeof payload.value !== 'object' ||
        Array.isArray(payload.value)) {
      return null;
    }
  } else if (r.corrects !== '') {
    return null;
  }

  return Object.freeze(r);
}

export function contentKey(r) {
  return [r.event_type, r.subject_key, r.observation_id, r.observed_at, r.source, r.env, r.payload, r.corrects]
    .join('\u0001');
}

export function compare(a, b) {
  if (a.observed_at !== b.observed_at) { return a.observed_at < b.observed_at ? -1 : 1; }
  const ra = sourceRank(a.source);
  const rb = sourceRank(b.source);
  if (ra !== rb) { return ra - rb; }
  if (a.event_id === b.event_id) { return 0; }
  return a.event_id < b.event_id ? -1 : 1;
}

/** 12 の akane_eventsReconstructCore_ と同じ。 */
export function reconstructCore(records, forced) {
  const anomalies = [];
  const byId = Object.create(null);
  const conflicted = Object.create(null);
  const idSubjects = Object.create(null);
  const idTargets = Object.create(null);
  let invalidRows = 0;

  function note(r) {
    (idSubjects[r.event_id] = idSubjects[r.event_id] || Object.create(null))[r.subject_key] = true;
    if (r.event_type === 'CORRECTION' && r.corrects) {
      (idTargets[r.event_id] = idTargets[r.event_id] || Object.create(null))[r.corrects] = true;
    }
  }

  (records || []).forEach((r) => {
    if (!r) { invalidRows++; return; }

    note(r);

    if (has(byId, r.event_id)) {
      const kept = byId[r.event_id];
      if (contentKey(kept) !== contentKey(r)) { conflicted[r.event_id] = true; }
      const rk = contentKey(r) + '\u0002' + r.recorded_at;
      const kk = contentKey(kept) + '\u0002' + kept.recorded_at;
      if (rk < kk) { byId[r.event_id] = r; }
      return;
    }

    byId[r.event_id] = r;
  });

  if (forced) {
    Object.keys(forced).forEach((id) => {
      conflicted[id] = true;
      idSubjects[id] = idSubjects[id] || Object.create(null);
      idTargets[id] = idTargets[id] || Object.create(null);
      (forced[id].subjects || []).forEach((k) => { idSubjects[id][k] = true; });
      (forced[id].targets || []).forEach((o) => { idTargets[id][o] = true; });
    });
  }

  const quarantine = Object.create(null);

  Object.keys(conflicted).forEach((id) => {
    const keys = Object.keys(idSubjects[id] || {}).sort();
    keys.forEach((k) => { quarantine[k] = true; });
    anomalies.push({ kind: 'EVENT_ID_CONFLICT', event_id: id, subject_key: keys.length ? keys[0] : '' });
  });

  if (invalidRows > 0) { anomalies.push({ kind: 'INVALID_ROW', event_id: '', subject_key: '' }); }

  const ordered = Object.keys(byId).filter((k) => !conflicted[k]).map((k) => byId[k]).sort(compare);
  const obsSubject = Object.create(null);

  ordered.forEach((r) => { obsSubject[r.observation_id] = r.subject_key; });

  Object.keys(conflicted).forEach((id) => {
    Object.keys(idTargets[id] || {}).forEach((obs) => {
      if (obsSubject[obs]) { quarantine[obsSubject[obs]] = true; }
    });
  });

  const corrections = Object.create(null);

  ordered.forEach((r) => { if (r.event_type === 'CORRECTION') { corrections[r.corrects] = r; } });

  const subjects = Object.create(null);

  ordered.forEach((r) => {
    if (r.event_type === 'CORRECTION' || r.event_type === 'OPERATION_EPOCH') { return; }

    const s = subjects[r.subject_key];

    if (!s) { subjects[r.subject_key] = { adopted: r, count: 1 }; return; }

    s.count++;

    if (FIRST_ONLY.indexOf(r.event_type) !== -1) {
      if (r.payload === s.adopted.payload) { return; }
      if (r.event_type === 'POST_PUBLISHED') {
        anomalies.push({ kind: 'DOUBLE_PUBLISH', event_id: r.event_id, subject_key: r.subject_key });
      } else {
        anomalies.push({
          kind: r.event_type === 'EXPERIMENT_REGISTERED' ? 'REGISTRATION_CHANGED' : 'FIRST_ONLY_DUPLICATE',
          event_id: r.event_id, subject_key: r.subject_key
        });
      }
      return;
    }

    s.adopted = r;
  });

  const adoptedObs = Object.create(null);

  Object.keys(subjects).forEach((k) => { adoptedObs[subjects[k].adopted.observation_id] = true; });

  Object.keys(corrections).forEach((obs) => {
    const c = corrections[obs];
    if (!obsSubject[obs]) {
      anomalies.push({ kind: 'CORRECTION_TARGET_MISSING', event_id: c.event_id, subject_key: c.subject_key });
    } else if (!adoptedObs[obs]) {
      anomalies.push({ kind: 'CORRECTION_TARGET_NOT_ADOPTED', event_id: c.event_id, subject_key: c.subject_key });
    }
  });

  const out = Object.create(null);

  Object.keys(subjects).sort().forEach((key) => {
    const s = subjects[key];
    const c = corrections[s.adopted.observation_id];
    const value = c ? parseCanonicalJson(c.payload).value : parseCanonicalJson(s.adopted.payload);
    out[key] = Object.freeze({ adopted: s.adopted, value, corrected: !!c, count: s.count, quarantined: quarantine[key] === true });
  });

  const conflictedOut = Object.create(null);

  Object.keys(conflicted).forEach((id) => {
    conflictedOut[id] = Object.freeze({
      subjects: Object.freeze(Object.keys(idSubjects[id] || {}).sort()),
      targets: Object.freeze(Object.keys(idTargets[id] || {}).sort())
    });
  });

  return Object.freeze({
    ordered: Object.freeze(ordered),
    subjects: Object.freeze(out),
    anomalies: Object.freeze(anomalies.sort((a, b) => {
      const x = a.kind + a.event_id + a.subject_key;
      const y = b.kind + b.event_id + b.subject_key;
      return x < y ? -1 : (x > y ? 1 : 0);
    })),
    quarantined: Object.freeze(Object.keys(quarantine).sort()),
    conflictedEventIds: Object.freeze(conflictedOut)
  });
}

export function reconstruct(records) {
  return reconstructCore(records, null);
}

/** 12 の akane_eventsReconstructSinceEpoch_ と同じ。 */
export function reconstructSinceEpoch(records) {
  const all = reconstruct(records);
  let epochAt = null;

  all.ordered.forEach((r) => { if (r.event_type === 'OPERATION_EPOCH') { epochAt = r.observed_at; } });

  if (epochAt === null) { return reconstructCore([], null); }

  const after = (records || []).filter((r) => !r || (r.observed_at > epochAt && r.event_type !== 'OPERATION_EPOCH'));
  const forced = Object.create(null);
  const afterObs = Object.create(null);

  after.forEach((r) => { if (r) { afterObs[r.observation_id] = true; } });

  Object.keys(all.conflictedEventIds).forEach((id) => {
    const info = all.conflictedEventIds[id];
    const inRange = after.some((r) => r && r.event_id === id) || info.targets.some((o) => afterObs[o] === true);
    if (inRange) { forced[id] = info; }
  });

  return reconstructCore(after, forced);
}

/**
 * 再構成の結果を、比べられる形（JSON にできる値だけ）にまとめる。GAS側と同じ形で比べる。
 */
export function summarize(rec) {
  // 対象キーには ':' が入る（正規化JSONのキーに使えない）ので、キーの順に並べた配列にする
  const subjects = Object.keys(rec.subjects).sort().map((k) => {
    const s = rec.subjects[k];
    return { key: k, adopted: s.adopted.event_id, recorded_at: s.adopted.recorded_at, value: canonicalJson(s.value), corrected: s.corrected, count: s.count,
      quarantined: s.quarantined };
  });
  return {
    ordered: rec.ordered.map((r) => r.event_id),
    subjects,
    anomalies: rec.anomalies.map((a) => a.kind + '|' + a.event_id + '|' + a.subject_key),
    quarantined: rec.quarantined.slice()
  };
}

/** 試験データ・ツール用：12 の akane_eventsBuildRecord_ と同じ形の行を作る（検証は最小限）。 */
export function buildRow(input, env, recordedAt) {
  const source = env === 'PROD' ? 'GAS-PROD' : (env === 'DEV' ? 'GAS-DEV' : input.source);
  const src = input.source || source;
  return HEADERS.map((h) => ({
    event_id: input.event_id, event_type: input.event_type, subject_key: input.subject_key,
    observation_id: input.observation_id || observationId(input.subject_key, input.observed_at, src),
    observed_at: input.observed_at, recorded_at: recordedAt, source: src, env,
    payload: typeof input.payload === 'string' ? input.payload : canonicalJson(input.payload),
    corrects: input.corrects || ''
  })[h]);
}
