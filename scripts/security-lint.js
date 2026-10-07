#!/usr/bin/env node
// Security lint: fails on patterns banned by .claude/rules/security.md and coding-standards.md.
// Runs as `npm run lint:sec` and as a Claude Code PostToolUse hook after every edit (exit 2 = feedback to Claude).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const RULES = [
  { dirs: ['src'], re: /Math\.random\s*\(/, msg: 'Math.random is banned in src/: use crypto.randomInt / randomBytes' },
  { dirs: ['src', 'public'], re: /console\.(log|info|debug)\([^)]*\b(pin|credBlock|token|body|msisdn|iccid|balance)\b/i, msg: 'Logging a sensitive value' },
  { dirs: ['src'], re: /\.(prepare|get|all|run)\(\s*`[^`]*\$\{/, msg: 'SQL built with a template literal: use ? parameters' },
  { dirs: ['src', 'public'], re: /\beval\s*\(|new Function\s*\(/, msg: 'eval / new Function is banned' },
  { dirs: ['public'], re: /\.innerHTML\s*=\s*[^'"`\s]|insertAdjacentHTML|document\.write/, msg: 'HTML injection sink with dynamic data: use textContent / h()' },
  { dirs: ['src'], re: /\b(balance|holder_name|upi_pin|iccid)\b\s+(TEXT|INTEGER)/i, msg: 'Schema column for data that must never be stored' },
  { dirs: ['src'], re: /from ['"]\.\.?\/(\.\.\/)?simulators\//, msg: 'Only app.js / adapters may import simulators', allow: ['src/app.js', 'src/adapters/'] },
  { dirs: ['src'], re: /UPDATE profiles SET state/, msg: 'Only modules/profiles.js may change profile state', allow: ['src/modules/profiles.js'] },
];

const files = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? files(p) : /\.(js|sql)$/.test(f) ? [p] : [];
});

const findings = [];
for (const rule of RULES) {
  for (const d of rule.dirs) {
    for (const f of files(join(ROOT, d))) {
      const rel = relative(ROOT, f);
      if (rule.allow?.some((a) => rel.startsWith(a))) continue;
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (rule.re.test(line) && !line.includes('lint-ok')) findings.push(`${rel}:${i + 1}  ${rule.msg}\n    ${line.trim().slice(0, 140)}`);
      });
    }
  }
}

if (findings.length) {
  console.error(`security-lint: ${findings.length} finding(s)\n${findings.join('\n')}`);
  process.exit(process.argv.includes('--hook') ? 2 : 1);
}
if (!process.argv.includes('--hook')) console.log('security-lint: clean');
