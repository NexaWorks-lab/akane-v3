// G2 data：データ品質の確認を実行する（GitHub Actions の data-quality から呼ぶ。読み取りだけ）
//   環境変数：ACCESS_TOKEN（短期トークン）、MAIN_SHEET_ID（メインのID）、LINK_SHEET_ID（連携用のID。G3b）。environment「prod」から渡す。
//   G3b（2026-10-31）：連携用シートの送信箱も読み（読み取りだけ）、受け渡しの件数の表を足す（data/delivery.mjs）。
// 出力：件数だけの表（GITHUB_STEP_SUMMARY とログ）。ID・トークン・URL・本文・数値の中身は出さない。
// 終了コード：読めない・形が違う → 1（失敗）。注意の項目があっても 0（表で知らせる）。

import fs from 'node:fs';
import { readEventRows } from './sheets.mjs';
import { qualityReport, reportMarkdown } from './quality.mjs';
import { deliveryReport, deliveryMarkdown } from './delivery.mjs';
import { readOutboxRows } from '../config/link.mjs';

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

  const now = Date.now();
  const report = qualityReport(rows, 'PROD', now, { monitorFromMs: MONITOR_FROM_MS });
  let md = '## データ品質の確認（G2）\n\n' + reportMarkdown(report) + '\n';

  // 送信箱の受け渡し（G3b）。連携用の ID が渡されていないときは表を出さない
  if (process.env.LINK_SHEET_ID) {
    try {
      const outbox = await readOutboxRows(process.env.ACCESS_TOKEN || '', process.env.LINK_SHEET_ID);
      md += '\n' + deliveryMarkdown(deliveryReport(rows, outbox, 'PROD', now)) + '\n';
    } catch (e) {
      const code = /^AKANE_[A-Z0-9_]+$/.test(e && e.message) ? e.message : 'AKANE_LINK_READ_FAILED';
      md += '\n### 送信箱の受け渡し（G3b）\n\n読み取りに失敗（' + code + '）\n';
      process.exitCode = 1;
    }
  }

  console.log(md);

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  }
}

main().catch(() => {
  console.log('データ品質の確認：予期しない失敗');
  process.exitCode = 1;
});
