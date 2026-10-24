// G0 基準3-B：Google 側（Workload Identity の attribute-condition）が、environment なしのジョブを拒否するかを確かめる。
//
// auth アクションは使わず、次の2段階を自分で行って、どこで止まったかを区別する。
//   段階1：GitHub から OIDC トークンを取得する（ACTIONS_ID_TOKEN_REQUEST_URL / _TOKEN）
//   段階2：Google STS でトークン交換を試す（ここで attribute-condition が評価される）
//
// 判定
//   PASS     段階2が拒否され、理由に「attribute condition」が含まれる
//   FAIL     段階2が成功した（environment なしで交換できてしまった）
//   未確認   段階1の失敗、または段階2が別の理由で失敗した（設定不備などと区別できないため、合格にしない）
//
// 出力：判定・段階・HTTP の番号・Google のエラー種別（error）だけ。トークン・プロバイダ名・応答の全文は出さない。

import fs from 'node:fs';

const provider = process.env.GCP_WIF_PROVIDER || '';
const reqUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL || '';
const reqToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || '';

function out(verdict, stage, note) {
  const lines = [
    '## G0 基準3-B：Google側の拒否の確認',
    '',
    '| 判定 | 段階 | 補足 |',
    '|---|---|---|',
    `| ${verdict} | ${stage} | ${note} |`,
    '',
    '※PASS 以外は、G0の基準3-Bを満たさない（未確認は、設定を確かめて再実行する）。'
  ];
  const text = lines.join('\n');
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n'); }
  if (verdict !== 'PASS') { process.exitCode = 1; }
}

async function main() {
  if (!/^projects\/\d+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/.test(provider)) {
    return out('未確認', '前提', 'GCP_WIF_PROVIDER の形が不正');
  }
  if (!reqUrl || !reqToken) {
    return out('未確認', '段階1', 'OIDC トークンを要求できない（id-token: write の権限を確認）');
  }

  // 段階1：OIDC トークン（audience は google-github-actions/auth の既定と同じ）
  let oidc = '';
  try {
    const audience = 'https://iam.googleapis.com/' + provider;
    const r = await fetch(reqUrl + '&audience=' + encodeURIComponent(audience), {
      headers: { Authorization: 'Bearer ' + reqToken }
    });
    if (r.status !== 200) { return out('未確認', '段階1', 'OIDC の取得が HTTP ' + r.status); }
    const j = await r.json();
    oidc = (j && j.value) || '';
    if (!oidc) { return out('未確認', '段階1', 'OIDC トークンが空'); }
  } catch (e) {
    return out('未確認', '段階1', 'OIDC の取得で例外（詳細は出さない）');
  }

  // 段階2：STS のトークン交換
  try {
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience: '//iam.googleapis.com/' + provider,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      subject_token: oidc
    });
    const r = await fetch('https://sts.googleapis.com/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    if (r.status === 200) {
      return out('FAIL', '段階2', 'environment なしでトークン交換できてしまった（条件を見直すこと）');
    }
    const err = (j && typeof j.error === 'string') ? j.error.replace(/[^a-z_]/gi, '').slice(0, 40) : '不明';
    const desc = (j && typeof j.error_description === 'string') ? j.error_description : '';
    if (/attribute condition/i.test(desc)) {
      return out('PASS', '段階2', 'HTTP ' + r.status + '・' + err + '・attribute condition による拒否');
    }
    return out('未確認', '段階2', 'HTTP ' + r.status + '・' + err + '・拒否の理由が attribute condition ではない');
  } catch (e) {
    return out('未確認', '段階2', 'STS への通信で例外（詳細は出さない）');
  }
}

main().catch(() => out('未確認', '不明', '例外（詳細は出さない）'));
