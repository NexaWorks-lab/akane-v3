// G3b config：運用設定一式の発行（GitHub Actions の issue-operation から呼ぶ）
//   node config/issue-run.mjs prepare   準備（environment prod・読み取りだけ）：状態を読み、次の版と params を決める
//   node config/issue-run.mjs sign      署名（environment issue・オーナーの承認のあと）：鍵で署名する（Google に触れない）
//   node config/issue-run.mjs append    追記（environment prod）：状態を読み直して同じなら、送信箱に1行を追記する
//
// 環境変数（ジョブごとに必要なものだけを渡す）：
//   prepare：ACCESS_TOKEN, MAIN_SHEET_ID, LINK_SHEET_ID, INPUT_PARAM, INPUT_VALUE, INPUT_CONFIRM_REJECTED（'true' のときだけ有効）
//   sign   ：OPERATION_SIGNING_KEY, PLAN
//   append ：ACCESS_TOKEN, MAIN_SHEET_ID, LINK_SHEET_ID, PLAN, BUNDLE
// 出力：GITHUB_OUTPUT（plan・bundle は base64）と、件数・版・コードだけのログ。
// 鍵・トークン・ID・URL・全文は、ログ・例外・Summary に出さない。失敗は終了コード 1 とコードだけ。

import fs from 'node:fs';
import { canonicalJson } from '../security/canonical.mjs';
import { readEventRows } from '../data/sheets.mjs';
import { loadConfig } from './rules.mjs';
import { issueOperation, jstTimestamp } from './issue.mjs';
import { outboxRow } from './outbox.mjs';
import { operationState, planIssue, readPlan, checkSigned } from './state.mjs';
import { readOutboxRows, appendOutboxRow } from './link.mjs';

const ENV = 'PROD';
const CODE_RE = /^AKANE_[A-Z0-9_]+$/;

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(String(s || ''), 'base64').toString('utf8');

function output(name, value) {
  if (!process.env.GITHUB_OUTPUT) { throw new Error('AKANE_ISSUE_NO_OUTPUT'); }
  fs.appendFileSync(process.env.GITHUB_OUTPUT, name + '=' + value + '\n');
}

function summary(md) {
  if (process.env.GITHUB_STEP_SUMMARY) { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n'); }
}

/** 読み取り（イベントと送信箱）→ 状態。deps は試験で差し替える。 */
export async function readState(deps, env) {
  const events = await deps.readEvents();
  const outbox = await deps.readOutbox();
  return operationState(events, outbox, env);
}

/** 準備の入力（環境変数から。確認のチェックは 'true' のときだけ有効） */
export function prepareInput(env) {
  return { param: env.INPUT_PARAM || '', value: env.INPUT_VALUE || '', confirmRejected: env.INPUT_CONFIRM_REJECTED === 'true' };
}

export async function runPrepare(deps) {
  const config = deps.config;
  const state = await readState(deps, ENV);
  const plan = planIssue(state, config, { param: deps.param, value: deps.value, confirmRejected: deps.confirmRejected === true });
  return { plan, text: canonicalJson(plan) };
}

export function runSign(deps) {
  const plan = readPlan(deps.planText);
  const key = deps.key;
  const text = issueOperation({
    config: deps.config, params: plan.params, previous: plan.previous,
    env: plan.env, version: plan.version, nowMs: deps.nowMs(), key
  });

  // 全文に鍵が入っていないこと（念のため）
  if (typeof key === 'string' && key !== '' && text.indexOf(key) !== -1) {
    throw new Error('AKANE_ISSUE_KEY_IN_OUTPUT');
  }

  return { plan, text };
}

export async function runAppend(deps) {
  const plan = readPlan(deps.planText);
  const text = deps.bundleText;
  const now = deps.nowMs();
  const signed = checkSigned(plan, text, now, deps.config.registry.schema);

  // 承認待ちの間に状態が変わっていないか（書く直前に読み直す）
  const state = await readState(deps, plan.env);

  if (state.stamp !== plan.stamp) {
    throw new Error(state.pending !== 0 ? 'AKANE_ISSUE_PENDING' : 'AKANE_ISSUE_STATE_CHANGED');
  }

  const row = outboxRow(text, jstTimestamp(now));

  await deps.appendRow(row);

  // 書いた行を読み直して確かめる（最後の行が、書いた行と同じ）
  const after = await deps.readOutbox();
  const last = after.length ? after[after.length - 1] : null;

  if (!last || last[0] !== row[0] || last[1] !== row[1] || last[2] !== row[2] || after.length !== state.outboxRows + 1) {
    throw new Error('AKANE_ISSUE_APPEND_UNVERIFIED');
  }

  return { plan, sendId: signed.sendId };
}

function realReaders() {
  const token = process.env.ACCESS_TOKEN || '';
  const mainId = process.env.MAIN_SHEET_ID || '';
  const linkId = process.env.LINK_SHEET_ID || '';

  if (mainId !== '' && mainId === linkId) { throw new Error('AKANE_ISSUE_LINK_IS_MAIN'); }

  return {
    readEvents: () => readEventRows(token, mainId),
    readOutbox: () => readOutboxRows(token, linkId),
    appendRow: (row) => appendOutboxRow(token, linkId, row)
  };
}

async function main(mode) {
  const config = loadConfig();

  if (mode === 'prepare') {
    const r = await runPrepare(Object.assign(realReaders(), { config }, prepareInput(process.env)));
    output('plan', b64(r.text));
    const line = '発行の準備：OK 版=' + r.plan.version + ' 変更=' + r.plan.param;
    console.log(line);
    summary('## 運用設定の発行（準備）\n\n' + line);
    return;
  }

  if (mode === 'sign') {
    const key = process.env.OPERATION_SIGNING_KEY || '';
    const r = runSign({ config, planText: unb64(process.env.PLAN), key, nowMs: () => Date.now() });
    output('bundle', b64(r.text));
    console.log('署名：OK 版=' + r.plan.version);
    return;
  }

  if (mode === 'append') {
    const r = await runAppend(Object.assign(realReaders(), {
      config, planText: unb64(process.env.PLAN), bundleText: unb64(process.env.BUNDLE), nowMs: () => Date.now()
    }));
    const line = '送信箱への追記：OK 版=' + r.plan.version + '（次の毎時の処理で GAS が受け入れを判断します）';
    console.log(line);
    summary('## 運用設定の発行（追記）\n\n' + line);
    return;
  }

  throw new Error('AKANE_ISSUE_MODE_INVALID');
}

if (process.argv[1] && process.argv[1].endsWith('issue-run.mjs')) {
  main(process.argv[2]).catch((e) => {
    const code = e && CODE_RE.test(e.message) ? e.message : 'AKANE_ISSUE_FAILED';
    console.log('発行：失敗（' + code + '）');
    summary('## 運用設定の発行\n\n失敗（' + code + '）');
    process.exitCode = 1;
  });
}
