'use strict';

const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const mode = process.argv[2] || 'dist';
  if (process.platform !== 'win32' || !['pack', 'dist'].includes(mode)) {
    throw new Error('请在 Windows 上使用 npm run pack 或 npm run dist。');
  }
  const projectDir = fs.realpathSync.native(path.join(__dirname, '..'));
  const cacheDir = path.resolve(process.env.ELECTRON_BUILDER_CACHE || path.join(projectDir, '.cache', 'electron-builder'));
  fs.mkdirSync(cacheDir, { recursive: true });
  // Resolve Windows AppData/package redirection before tools create sibling
  // temporary paths, so archive extraction can rename within the same volume.
  process.env.ELECTRON_BUILDER_CACHE = fs.realpathSync.native(cacheDir);

  const electronDist = path.dirname(require('electron'));
  const { build, Platform, Arch } = require('electron-builder');
  await build({
    projectDir,
    targets: Platform.WINDOWS.createTarget(mode === 'pack' ? 'dir' : 'portable', Arch.x64),
    config: { electronDist },
    publish: 'never'
  });
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
