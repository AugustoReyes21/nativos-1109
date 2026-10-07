import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const [kind, path] = process.argv.slice(2);
if (kind === 'zap') {
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const alerts = report.site.flatMap(site => site.alerts);
  const vulnerabilities = alerts.filter(alert => Number(alert.riskcode) >= 1);
  for (const alert of alerts) console.log(alert.riskdesc + ': ' + alert.name);
  if (vulnerabilities.length) process.exit(1);
} else if (kind === 'sarif') {
  const files = readdirSync(path).filter(name => name.endsWith('.sarif'));
  if (!files.length) throw new Error('Missing SAST report');
  let issues = 0;
  for (const name of files) {
    const report = JSON.parse(readFileSync(join(path, name), 'utf8'));
    for (const run of report.runs) for (const result of run.results ?? []) {
      const rule = run.tool.driver.rules.find(rule => rule.id === result.ruleId);
      if (Number(rule?.properties?.['security-severity'] ?? 0) >= 4 || result.level === 'error') {
        console.error('SAST finding: ' + result.ruleId); issues++;
      }
    }
  }
  if (issues) process.exit(1);
} else throw new Error('Expected zap or sarif and report path');
