/**
 * Ensures JAVA_HOME is valid, then runs react-native run-android.
 *
 * Windows note: long project paths used to break the native (CMake) build
 * (MAX_PATH 260). android/app/build.gradle now moves the native build's
 * staging directory to a short path, so the app builds from this folder.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');

function findJdk() {
  const candidates = [
    'C:\\Program Files\\Java\\jdk-17',
    'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.12.101-hotspot',
    process.env.JAVA_HOME,
  ].filter(Boolean);
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'bin', 'java.exe')));
}

function ensureEnvFile(root) {
  const envPath = path.join(root, '.env');
  const example = path.join(root, '.env.example');
  if (!fs.existsSync(envPath) && fs.existsSync(example)) {
    fs.copyFileSync(example, envPath);
    console.log('[run-android] Created .env from .env.example');
  }
}

function resolveCwd() {
  return fs.realpathSync(projectRoot);
}

const jdk = findJdk();
if (!jdk) {
  console.error('No valid JDK found. Install JDK 17 or set JAVA_HOME.');
  process.exit(1);
}

const cwd = resolveCwd();
ensureEnvFile(cwd);

const env = {
  ...process.env,
  JAVA_HOME: jdk,
  CI: process.env.CI || '1',
  Path: path.join(jdk, 'bin') + path.delimiter + (process.env.Path || process.env.PATH || ''),
};

const extraArgs = process.argv.slice(2);
if (!extraArgs.includes('--no-packager')) extraArgs.push('--no-packager');
if (!extraArgs.some((a) => a === '--port' || a.startsWith('--port='))) {
  extraArgs.push('--port', '8082');
}

console.log('[run-android] Using JAVA_HOME=' + jdk);
console.log('[run-android] Building from ' + cwd);

const result = spawnSync('npx', ['react-native', 'run-android', ...extraArgs], {
  stdio: 'inherit',
  env,
  shell: true,
  cwd,
});

process.exit(result.status == null ? 1 : result.status);
