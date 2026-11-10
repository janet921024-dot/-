// 把 src/ 的原始碼轉成網站實際使用的檔案：
//   src/app.jsx    → assets/app.js（JSX 先轉譯好，手機不用即時轉譯）
//   src/*.jsx      → assets/app.css（只保留有用到的 Tailwind 樣式）
//   src/index.html → index.html
import { execFileSync } from 'node:child_process';
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

const page = readFileSync('src/index.html', 'utf8')
  .replace('<!DOCTYPE html>', '<!DOCTYPE html>\n<!-- 這個檔案由 npm run build 產生，請修改 src/ 裡的檔案 -->');
writeFileSync('index.html', page);

console.log('建置完成：index.html、assets/app.js、assets/app.css');
