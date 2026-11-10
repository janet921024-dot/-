// 把 src/ 的原始碼轉成網站實際使用的檔案：
//   src/app.jsx    → assets/app.js（JSX 先轉譯好，手機不用即時轉譯）
//   src/*.jsx      → assets/app.css（只保留有用到的 Tailwind 樣式）
//   src/index.html → index.html
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { transformSync } from '@babel/core';

mkdirSync('assets', { recursive: true });

const { code } = transformSync(readFileSync('src/app.jsx', 'utf8'), {
  filename: 'app.jsx',
  presets: [['@babel/preset-env', { targets: 'defaults' }], '@babel/preset-react'],
  sourceType: 'script',
  compact: true,
  comments: false,
  babelrc: false,
  configFile: false,
});
writeFileSync('assets/app.js', code);

execFileSync('npx', ['tailwindcss', '-i', 'src/tailwind.css', '--content', 'src/**/*.{jsx,html}', '-o', 'assets/app.css', '--minify'], { stdio: 'inherit' });

// 檔名後加上內容的版本號，網站更新後瀏覽器（包含 LINE 內建瀏覽器）就不會沿用舊檔案
const version = (file) => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 10);
const page = readFileSync('src/index.html', 'utf8')
  .replace('<!DOCTYPE html>', '<!DOCTYPE html>\n<!-- 這個檔案由 npm run build 產生，請修改 src/ 裡的檔案 -->')
  .replace('href="assets/app.css"', `href="assets/app.css?v=${version('assets/app.css')}"`)
  .replace('src="assets/app.js"', `src="assets/app.js?v=${version('assets/app.js')}"`);
writeFileSync('index.html', page);

console.log('建置完成：index.html、assets/app.js、assets/app.css');
