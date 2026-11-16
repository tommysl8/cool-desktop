// PASS/FAIL table printer for validators and gates. ASCII only.
// A row is { name, pass, detail } where pass is true (PASS), false (FAIL) or null/'skip' (SKIP).
// A row with warn: true and a passing (or skipped) result shows as WARN: reported, never a failure.

function status(row) {
  if (row.pass === false) return 'FAIL';
  if (row.warn) return 'WARN';
  if (row.skip || row.pass === null || row.pass === undefined || row.pass === 'skip') return 'SKIP';
  return row.pass ? 'PASS' : 'FAIL';
}

function cell(text) {
  return String(text ?? '').replace(/\|/g, '\\|');
}

/** Counts: { total, passed, failed, skipped, warned }. */
export function summarize(rows) {
  const s = { total: rows.length, passed: 0, failed: 0, skipped: 0, warned: 0 };
  for (const r of rows) {
    const st = status(r);
    if (st === 'PASS') s.passed++;
    else if (st === 'FAIL') s.failed++;
    else if (st === 'WARN') s.warned++;
    else s.skipped++;
  }
  return s;
}

/**
 * Markdown-compatible table. Multi-line details keep their first line in the table; the remaining
 * lines are listed under the table so nothing is lost.
 */
export function formatReport(rows, { title } = {}) {
  const lines = [];
  if (title) lines.push(title, '');
  const body = rows.map((r) => {
    const detail = String(r.detail ?? '').split(/\r?\n/);
    return { st: status(r), name: cell(r.name), first: cell(detail[0]), rest: detail.slice(1).filter((l) => l.trim() !== '') };
  });
  const w1 = 6;
  const w2 = Math.max(5, ...body.map((b) => b.name.length));
  const w3 = Math.max(6, ...body.map((b) => b.first.length));
  const row = (a, b, c) => `| ${a.padEnd(w1)} | ${b.padEnd(w2)} | ${c.padEnd(w3)} |`;
  lines.push(row('RESULT', 'CHECK', 'DETAIL'));
  lines.push(`|${'-'.repeat(w1 + 2)}|${'-'.repeat(w2 + 2)}|${'-'.repeat(w3 + 2)}|`);
  for (const b of body) lines.push(row(b.st, b.name, b.first));
  const extra = body.filter((b) => b.rest.length);
  if (extra.length) {
    lines.push('', 'Details:');
    for (const b of extra) {
      lines.push(`  [${b.st}] ${b.name}`);
      for (const l of b.rest) lines.push('    ' + l);
    }
  }
  const s = summarize(rows);
  lines.push('', `${s.total} checks: ${s.passed} PASS, ${s.failed} FAIL, ${s.skipped} SKIP${s.warned ? `, ${s.warned} WARN` : ''}`);
  return lines.join('\n');
}

/** Print the table with `log` (default console.log) and return the counts. */
export function printReport(rows, { title, log = console.log } = {}) {
  log(formatReport(rows, { title }));
  return summarize(rows);
}
