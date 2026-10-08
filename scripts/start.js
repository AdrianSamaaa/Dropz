// Starts Drops with Electron. Some hosts (VS Code extensions, for one) export
// ELECTRON_RUN_AS_NODE, which would make electron.exe behave like plain Node.
const { spawn } = require('child_process');
const path = require('path');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

spawn(electron, ['.'], { cwd: path.join(__dirname, '..'), env, stdio: 'inherit' })
  .on('exit', code => process.exit(code ?? 0));
