// Records only an isolated browser fixture. Never reads the desktop or clipboard.
// Run with Node 24: node scripts/record-readme-demo.mjs
// Then encode: python3 scripts/encode-readme-gif.py
import {chromium, expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const frames = path.join(root, 'artifacts/readme-demo-frames');
await mkdir(frames, {recursive: true});
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5188', '--strictPort'], {cwd: root, stdio: 'ignore'});
let browser;
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch('http://127.0.0.1:5188')).ok) break; } catch {}
    if (i > 100) throw new Error('Demo server did not start');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/opt/google/chrome/chrome'});
  const page = await browser.newPage({viewport: {width: 1100, height: 780}, deviceScaleFactor: 1});
  await page.addInitScript(() => {
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
        {text: '架空カフェの打ち合わせ\n火曜日 14:00\nひだまりルーム', kind: 'text', name: 'メモ', color: 'rose', icon: logo('#5f9c64', 'M')},
        {text: '小さなアイデアを、\n次のひらめきにつなげる。', kind: 'text', name: 'メモ', color: 'mint', icon: logo('#5f9c64', 'M')},
      ].map((entry, index) => ({id: `fictional-${index}`, text: entry.text, kind: entry.kind, color: entry.color,
        createdAt: now - (index + 1) * 60000, pinned: false,
        source: {kind: 'foreground', name: entry.name, icon: entry.icon}})),
      settings: {shortcut: 'CommandOrControl+Shift+Space', historyLimit: 60, persistence: false, hideAfterCopy: true, sourceApp: true, fanSpread: 60, fanDistance: 0},
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
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    document.body.style.background = '#10171b';
    const overlay = document.createElement('aside');
    overlay.style.cssText = 'position:fixed;left:48px;top:66px;width:290px;z-index:9000;pointer-events:none;color:#dce4d9;font-family:Arial,"Noto Sans",sans-serif';
    overlay.innerHTML = '<div style="font-size:12px;letter-spacing:5px;color:#a8b5a6">CLIPBOARD MANAGER</div><div style="font-size:74px;font-weight:700;letter-spacing:-5px;margin:18px 0 10px;color:#e6ed3c">PUPA</div><div style="font-size:18px;letter-spacing:1px">Copy. Call. Click.</div><div id="demo-caption" style="font-size:24px;line-height:1.6;margin-top:76px;color:#dce4d9">ショートカットで<br>呼び出す。</div><pre id="demo-result" style="display:none;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.8;background:#1c2b30;padding:15px;margin-top:20px;border-left:2px solid #e6ed3c"></pre><div style="margin-top:58px;font-size:11px;color:#718987">操作デモ / コピー内容・アプリ名はすべて架空</div>';
    document.body.append(overlay);
    const cursor = document.createElement('div'); cursor.id = 'demo-cursor';
    cursor.style.cssText = 'position:fixed;left:410px;top:700px;width:12px;height:12px;border:2px solid #fff;background:#65c6cf99;border-radius:50%;z-index:9999;pointer-events:none;transform:translate(-50%,-50%);box-shadow:0 0 0 3px #10182088';
    document.body.append(cursor);
    document.addEventListener('pointermove', event => {cursor.style.left = `${event.clientX}px`; cursor.style.top = `${event.clientY}px`;}, true);
    window.readmeDemo.hide();
  });
  let recording = true;
  const times = [];
  const capture = (async () => {
    const start = Date.now();
    while (recording) {
      const index = times.length; times.push(Date.now() - start);
      await page.screenshot({path: path.join(frames, `${String(index).padStart(4, '0')}.png`), animations: 'allow'});
      await page.waitForTimeout(Math.max(1, 100 * (index + 1) - (Date.now() - start)));
    }
  })();
  const caption = text => page.locator('#demo-caption').evaluate((element, value) => {element.innerText = value;}, text);
  await page.waitForTimeout(650);
  await page.evaluate(() => window.readmeDemo.show()); await page.waitForTimeout(1100);
  const points = await page.locator('.card-slot').evaluateAll(elements => {
    const regions = elements.map(element => ({id: element.dataset.id, cx: parseFloat(element.style.left) + element.offsetWidth / 2,
      cy: parseFloat(element.style.top) + element.offsetHeight / 2, w: element.offsetWidth, h: element.offsetHeight, a: parseFloat(element.style.getPropertyValue('--angle')) * Math.PI / 180}));
    const local = (r, x, y) => ({x: (x-r.cx)*Math.cos(r.a)+(y-r.cy)*Math.sin(r.a), y: -(x-r.cx)*Math.sin(r.a)+(y-r.cy)*Math.cos(r.a)});
    const inside = (r,x,y) => {const p=local(r,x,y);return Math.abs(p.x)<r.w/2 && Math.abs(p.y)<r.h/2;};
    return regions.map((r,index) => {
      let best;
      for(let y=16;y<innerHeight-16;y+=5) for(let x=360;x<innerWidth-16;x+=5) {
        if(!inside(r,x,y)||regions.slice(index+1).some(other=>inside(other,x,y))) continue;
        const p=local(r,x,y);const score=Math.min(r.w/2-Math.abs(p.x),r.h/2-Math.abs(p.y));
        if(!best || score>best.score) best={x,y,id:r.id,score};
      }
      if(!best) throw new Error('No exposed card');return best;
    });
  });
  await caption('カーソルを合わせて\nカードを選ぶ。');
  for (const point of points.slice(0, 3)) {
    await page.mouse.move(point.x, point.y, {steps: 16});
    await expect(page.locator('.card-slot.is-expanded')).toHaveAttribute('data-id', point.id);
    await page.waitForTimeout(950);
  }
  await caption('クリックして\nもう一度コピー。'); await page.waitForTimeout(500);
  await page.mouse.click(points[2].x, points[2].y);
  await expect.poll(() => page.evaluate(() => window.readmeDemo.copied())).toBe(points[2].id);
  await page.waitForTimeout(850);
  await caption('貼り付け先で、\nいつもの操作を。');
  await page.locator('#demo-result').evaluate(element => {element.textContent=window.readmeDemo.copiedText(); element.style.display='block';});
  await page.waitForTimeout(1500);
  await page.locator('#demo-result').evaluate(element => {element.style.display='none';});
  await caption('必要なときに、\nまた呼び出す。');
  await page.evaluate(() => window.readmeDemo.show());
  await page.mouse.move(410, 700); await page.waitForTimeout(1700);
  await page.evaluate(() => window.readmeDemo.hide());
  await caption('ショートカットで\n呼び出す。'); await page.waitForTimeout(550);
  recording = false; await capture;
  await writeFile(path.join(frames, 'timings.json'), JSON.stringify(times));
  console.log(`Recorded ${times.length} synthetic frames in ${frames}`);
} finally {
  await browser?.close(); server.kill();
}
