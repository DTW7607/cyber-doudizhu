const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const testsDir = path.resolve(__dirname, '..', 'tests');
const files = fs.readdirSync(testsDir)
  .filter((name) => name.endsWith('.test.js'))
  // Modified 2026-11-12: runtime supports landlord only. Preserve full upstream suite via --upstream.
  .filter((name) => process.argv.includes('--upstream') || ['landlord-spectator.test.js','landlord-spectator-ui.test.js','landlord-audit.test.js','doudizhu.test.js','doudizhu-custom.test.js','landlord-backend.test.js','landlord-mcp.test.js','landlord-ui.test.js','landlord-selection.test.js','landlord-layout.test.js','cards-fixes.test.js','hidden-hands.test.js','phase-timers.test.js'].includes(name))
  .sort()
  .map((name) => path.join(testsDir, name));

if (files.length === 0) {
  console.error('No test files found.');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: path.resolve(__dirname, '..'),
  stdio: 'inherit',
});

process.exit(result.status === null ? 1 : result.status);
