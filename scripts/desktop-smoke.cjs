'use strict';
const { _electron: electron, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  // Explicit synthetic clipboard adapter; this never reads/writes the CI OS clipboard.
  const app = await electron.launch({ args: ['.'], cwd: path.join(__dirname, '..'), env: { ...process.env, PUPA_TEST_MODE: '1' } });
  let userData;
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.pupa));
    await expect.poll(() => app.evaluate(() => Boolean(global.pupaTest))).toBeTruthy();
    if (process.env.CI === 'true' && process.platform === 'linux') {
      // CI runs in a fresh Xvfb session. Read only the synthetic value we just wrote,
      // never an existing desktop clipboard. This verifies Electron's real OS API.
      const roundTrip = await app.evaluate(async ({ clipboard, ClipboardItem }) => {
        const synthetic = 'Pupa isolated Xvfb clipboard test — ひとひら';
        await clipboard.write([new ClipboardItem({ 'text/plain': synthetic })]);
        const items = await clipboard.read();
        const item = items.find(value => value.types.includes('text/plain'));
        const value = item ? await (await item.getType('text/plain')).text() : null;
        await clipboard.write([new ClipboardItem({ 'text/plain': '' })]);
        return value === synthetic;
      });
      assert.equal(roundTrip, true, 'real isolated OS clipboard API round-trip');
    }
    await app.evaluate(async () => {
      const test = global.pupaTest;
      test.setClipboard('小さなひらめきを、逃さない。\n今日の「いいな」を、明日のアイデアに。');
      await test.tick();
      test.setClipboard('https://github.com/kuro0315/Pupa'); await test.tick();
      test.setClipboard("const littleThings = ['ひらめき', 'ことば', '好き'];"); await test.tick();
    });
    assert.equal(await page.locator('.clip-card').count(), 3);
    userData = await app.evaluate(() => global.pupaTest.userData);
    assert.equal(fs.existsSync(path.join(userData, 'history.json')), false);
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.card-slot').first()).toHaveClass(/is-expanded/);
    await app.evaluate(() => global.pupaTest.add('Rerender focus fixture'));
    await expect(page.locator('.card-slot.is-expanded')).toHaveCount(1);
    await page.waitForTimeout(1100);
    fs.mkdirSync('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/pupa-native-linux.png' });
    await page.keyboard.press('Enter');
    assert.equal(await app.evaluate(() => global.pupaTest.isVisible()), false);
    assert.match(await app.evaluate(() => global.pupaTest.getClipboard()), /littleThings/);
    for (let i = 0; i < 3; i++) {
      await app.evaluate(() => global.pupaTest.toggle());
      assert.equal(await app.evaluate(() => global.pupaTest.isVisible()), true);
      await page.keyboard.press('Escape');
      assert.equal(await app.evaluate(() => global.pupaTest.isVisible()), false);
    }
    await app.evaluate(async () => {
      const test = global.pupaTest;
      test.setPaused(true); test.setClipboard('not captured while paused'); await test.tick();
      test.setPaused(false); await test.tick();
    });
    assert.equal(await app.evaluate(() => global.pupaTest.state().entries.length), 4);
    console.log('PASS: native Electron startup, isolated clipboard collection, default memory-only history, copy-and-hide, repeated toggle/Escape, pause baseline.');
  } finally { await app.close(); if (userData) fs.rmSync(userData, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
