// 生成商店截图 harness：把真实 popup.html / options.html 的资产路径改写成
// 绝对 file:// URL，并内联 chrome.* 桩与截图驱动脚本，输出到 .generated/。
// 用法：node prototypes/store-shots/build.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, '../../src/extension');
const outDir = path.join(here, '.generated');

const asset = (name) => pathToFileURL(path.join(ext, name)).href;

// 弹窗 380px 定宽，放大居中占满 1280×800 画面；?shot=2 展开预览，默认展开「本次设置」
const POPUP_DRIVER = `
const shot = new URLSearchParams(location.search).get('shot') || '1';
const popupStyle = document.createElement('style');
popupStyle.textContent = [
  'html { background: #edf1f4; scrollbar-width: none; }',
  'html::-webkit-scrollbar { display: none; }',
  'body.popup { margin: 0 auto !important; transform: scale(1.12); transform-origin: top center; }',
].join('\\n');
document.head.appendChild(popupStyle);
window.addEventListener('load', () => {
  setTimeout(() => {
    if (shot === '2') {
      document.querySelector('#preview-toggle')?.click();
      // 预览打开后下滚一点，让标题层级 + 占位图 + 段落同屏
      setTimeout(() => {
        const body = document.querySelector('#preview-body');
        if (body) body.scrollTop = 45;
      }, 200);
    } else {
      document.querySelector('#settings-toggle')?.click();
    }
  }, 200);
});
`;

// 设置页内容略超 800px，整体缩小居中保证一屏收全
const OPTIONS_DRIVER = `
const optionsStyle = document.createElement('style');
optionsStyle.textContent = [
  'html { scrollbar-width: none; }',
  'html::-webkit-scrollbar { display: none; }',
  'body.options { margin-top: 0; margin-bottom: 0; }',
  'main.ps-root { transform: scale(.82); transform-origin: top center; }',
].join('\\n');
document.head.appendChild(optionsStyle);
`;

async function build(page, script, stubFile, driver, outName) {
  let html = await readFile(path.join(ext, page), 'utf8');
  const stub = await readFile(path.join(here, stubFile), 'utf8');
  html = html.replace('href="ui.css"', `href="${asset('ui.css')}"`);
  html = html.replace(`src="${script}"`, `src="${asset(script)}"`);
  html = html.replaceAll('src="icons/', `src="${asset('icons')}/`);
  // 经典内联脚本在解析期执行，先于 deferred 的模块脚本，chrome 桩先于 popup.js/options.js 就位
  html = html.replace('</body>', `<script>\n${stub}\n</script>\n<script>\n${driver}\n</script>\n</body>`);
  await writeFile(path.join(outDir, outName), html);
  console.log(`written: ${path.join('.generated', outName)}`);
}

await mkdir(outDir, { recursive: true });
await build('popup.html', 'popup.js', 'stub-popup.js', POPUP_DRIVER, 'popup-shot.html');
await build('options.html', 'options.js', 'stub-options.js', OPTIONS_DRIVER, 'options-shot.html');
