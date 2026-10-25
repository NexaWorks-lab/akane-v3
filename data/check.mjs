// G2 data：データ品質の確認を実行する（GitHub Actions の data-quality から呼ぶ。読み取りだけ）
//   環境変数：ACCESS_TOKEN（短期トークン）、MAIN_SHEET_ID（メインのID）。どちらも environment「prod」から渡す。
// 出力：件数だけの表（GITHUB_STEP_SUMMARY とログ）。ID・トークン・URL・本文・数値の中身は出さない。
// 終了コード：読めない・形が違う → 1（失敗）。注意の項目があっても 0（表で知らせる）。

import fs from 'node:fs';
import { readEventRows } from './sheets.mjs';
import { qualityReport, reportMarkdown } from './quality.mjs';

// 運用起点（OPERATION_EPOCH）を記録するまでの監視の開始：ver.3 の毎時の処理（DRY_RUN）を始めた時刻。
// 運用起点を記録したら、起点が優先される（quality.mjs）。
const MONITOR_FROM_MS = Date.parse('2026-10-25T14:00:00+09:00');

async function main() {
  let rows;

  try {
    rows = await readEventRows(process.env.ACCESS_TOKEN || '', process.env.MAIN_SHEET_ID || '');
  } catch (e) {
    const code = /^AKANE_[A-Z0-9_]+$/.test(e && e.message) ? e.message : 'AKANE_DATA_READ_FAILED';
    console.log('データ品質の確認：読み取りに失敗（' + code + '）');
    process.exitCode = 1;
    return;
  }

  const report = qualityReport(rows, 'PROD', Date.now(), { monitorFromMs: MONITOR_FROM_MS });
  const md = '## データ品質の確認（G2）\n\n' + reportMarkdown(report) + '\n';

  console.log(md);

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  }
}

main().catch(() => {
  console.log('データ品質の確認：予期しない失敗');
  process.exitCode = 1;
});
