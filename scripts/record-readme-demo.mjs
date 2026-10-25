// Records only an isolated browser fixture. Never reads the desktop or clipboard.
// Run with Node 24: node scripts/record-readme-demo.mjs
// Then encode: python3 scripts/encode-readme-gif.py
import {chromium, expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdir, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const frames = path.join(root, 'artifacts/readme-demo-frames');
await rm(frames, {recursive: true, force: true});
await mkdir(frames, {recursive: true});
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5188', '--strictPort'], {cwd: root, stdio: 'ignore'});
let browser;
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch('http://127.0.0.1:5188')).ok) break; } catch {}
    if (i > 100) throw new Error('Demo server did not start');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/opt/google/chrome/chrome', args: ['--enable-unsafe-swiftshader']});
  const page = await browser.newPage({viewport: {width: 780, height: 900}, deviceScaleFactor: 1});
  await page.addInitScript(() => {
    // Isolated recording only: allow shader capture on the software GPU.
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, options) {
      return getContext.call(this, type, type === 'webgl2' ? {...options, failIfMajorPerformanceCaveat: false} : options);
    };
    const logo = (color, mark) => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(4, 4, 56, 56);
      ctx.fillStyle = '#f4ffff'; ctx.font = 'bold 34px monospace'; ctx.textAlign = 'center'; ctx.fillText(mark, 32, 44);
      return canvas.toDataURL('image/png');
    };
    const now = Date.now();
    const state = {
      entries: [
        {text: '週末の買いもの\n・りんご\n・ミルク\n・コーヒー', kind: 'text', name: 'メモ', color: 'mint', icon: logo('#5f9c64', 'M')},
        {text: 'https://example.com/luna', kind: 'link', name: 'ブラウザー', color: 'butter', icon: logo('#568bcc', 'O')},
        {text: "const greeting = 'Hello, Pupa!';\nconsole.log(greeting);", kind: 'code', name: 'コードエディター', color: 'lavender', icon: logo('#218bd8', '>')},
        {text: '星あかり企画.pdf\n月のスケッチ', files: ['/fictional/星あかり企画.pdf', '/fictional/月のスケッチ'], kind: 'files', name: 'ファイル', color: 'butter', icon: logo('#c59c42', 'F')},
        {text: '架空カフェの打ち合わせ\n火曜日 14:00\nひだまりルーム', kind: 'text', name: 'メモ', color: 'rose', icon: logo('#5f9c64', 'M')},
        {text: '小さなアイデアを、\n次のひらめきにつなげる。', kind: 'text', name: 'メモ', color: 'mint', icon: logo('#5f9c64', 'M')},
        {text: '次の週末は、海辺の図書室へ。', kind: 'text', name: 'メモ', color: 'lavender', icon: logo('#5f9c64', 'M')},
      ].map((entry, index) => ({id: `fictional-${index}`, text: entry.text, files: entry.files, kind: entry.kind, color: entry.color,
        createdAt: now - (index + 1) * 60000, pinned: false,
        source: {kind: 'foreground', name: entry.name, icon: entry.icon}})),
      settings: {shortcut: 'CommandOrControl+Shift+Space', historyLimit: 60, persistence: false, hideAfterCopy: true, sourceApp: true, fanSpread: 60, fanDistance: 0, visibleCards: 5, visualEffects: 'auto'},
      paused: false, status: {shortcutRegistered: true, platform: 'linux', wayland: false, version: '0.2.3'},
    };
    let shown = () => {}, copied = null;
    const hide = () => { document.querySelector('.fan-stage').style.visibility = 'hidden'; };
    window.pupa = {
      getState: async () => state, onState: () => () => {}, onShown: callback => {shown = callback; return () => {};},
      hide, quit() {}, copyEntry: async id => {copied = id; return {ok: true, dismissToken: id};},
      completeCopyDismissal: async () => {hide(); return {ok: true};},
    };
    window.readmeDemo = {show: () => {document.querySelector('.fan-stage').style.visibility = 'visible'; shown();}, hide,
      copied: () => copied, copiedText: () => state.entries.find(entry => entry.id === copied)?.text};
  });
  await page.goto('http://127.0.0.1:5188');
  await expect(page.getByTestId('clipboard-card')).toHaveCount(5);
  await expect(page.locator('.fan-stage')).toHaveAttribute('data-effects-backend', 'three');
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    document.body.style.background = '#10171b';
    const cursor = document.createElement('div'); cursor.id = 'demo-cursor';
    cursor.style.cssText = 'position:fixed;left:24px;top:850px;width:12px;height:12px;border:2px solid #fff;background:#65c6cf99;border-radius:50%;z-index:9999;pointer-events:none;transform:translate(-50%,-50%);box-shadow:0 0 0 3px #10182088';
    document.body.append(cursor);
    document.addEventListener('pointermove', event => {cursor.style.left = `${event.clientX}px`; cursor.style.top = `${event.clientY}px`;}, true);
  });
  await page.waitForTimeout(1100);
  let recording = true;
  const times = [];
  const capture = (async () => {
    const start = Date.now();
    while (recording) {
      const index = times.length; times.push(Date.now() - start);
      await page.screenshot({path: path.join(frames, `${String(index).padStart(4, '0')}.png`), animations: 'allow'});
      await page.waitForTimeout(Math.max(1, 80 * (index + 1) - (Date.now() - start)));
    }
  })();
  await page.waitForTimeout(550);
  const exposedPoints = () => page.locator('.card-slot').evaluateAll(elements => {
    const regions = elements.map(element => ({id: element.dataset.id, cx: parseFloat(element.style.left) + element.offsetWidth / 2,
      cy: parseFloat(element.style.top) + element.offsetHeight / 2, w: element.offsetWidth, h: element.offsetHeight, a: parseFloat(element.style.getPropertyValue('--angle')) * Math.PI / 180}));
    const local = (r, x, y) => ({x: (x-r.cx)*Math.cos(r.a)+(y-r.cy)*Math.sin(r.a), y: -(x-r.cx)*Math.sin(r.a)+(y-r.cy)*Math.cos(r.a)});
    const inside = (r,x,y) => {const p=local(r,x,y);return Math.abs(p.x)<r.w/2 && Math.abs(p.y)<r.h/2;};
    return regions.map((r,index) => {
      let best;
      for(let y=16;y<innerHeight-16;y+=5) for(let x=16;x<innerWidth-16;x+=5) {
        if(!inside(r,x,y)||regions.slice(index+1).some(other=>inside(other,x,y))) continue;
        const p=local(r,x,y);const score=Math.min(r.w/2-Math.abs(p.x),r.h/2-Math.abs(p.y));
        if(!best || score>best.score) best={x,y,id:r.id,score};
      }
      if(!best) throw new Error('No exposed card');return best;
    });
  });
  let points = await exposedPoints();
  for (const point of points.slice(0, 3)) {
    await page.mouse.move(point.x, point.y, {steps: 16});
    await expect(page.locator('.card-slot.is-expanded')).toHaveAttribute('data-id', point.id);
    await page.waitForTimeout(950);
  }
  await page.mouse.wheel(0, 110);
  await expect(page.locator('#deck-position-label')).toHaveText('2–6 / 7');
  await page.waitForTimeout(700);
  await page.mouse.wheel(0, 110);
  await expect(page.locator('#deck-position-label')).toHaveText('3–7 / 7');
  await page.waitForTimeout(700);
  points = await exposedPoints();
  const file = points.find(point => point.id === 'fictional-3');
  await page.mouse.move(file.x, file.y, {steps: 12});
  await expect(page.locator('.card-slot.is-expanded')).toHaveAttribute('data-id', file.id);
  await page.waitForTimeout(1000);
  await page.mouse.click(file.x, file.y);
  await expect.poll(() => page.evaluate(() => window.readmeDemo.copied())).toBe(file.id);
  await page.waitForTimeout(850);
  await page.evaluate(() => window.readmeDemo.show());
  await page.mouse.move(24, 850); await page.waitForTimeout(1700);
  recording = false; await capture;
  await writeFile(path.join(frames, 'timings.json'), JSON.stringify(times));
  console.log(`Recorded ${times.length} synthetic frames in ${frames}`);
} finally {
  await browser?.close(); server.kill();
}
