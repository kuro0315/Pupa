import {test, expect} from '@playwright/test';
import fs from 'node:fs';
test.use({launchOptions: {executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ['--enable-unsafe-swiftshader']}});

test('light mode never loads Three.js and the effects preference saves and cancels', async ({page}) => {
  const gpuRequests: string[] = [];
  page.on('request', request => { if (request.url().includes('effects-three')) gpuRequests.push(request.url()); });
  await page.addInitScript(() => {
    const state = {entries: [{id: 'effects-fixture', text: 'Synthetic effects demo', kind: 'text', color: 'mint', createdAt: Date.now(), pinned: false}],
      settings: {shortcut: 'CommandOrControl+Shift+Space', historyLimit: 60, persistence: false, visualEffects: 'light'}, paused: false,
      status: {shortcutRegistered: true, platform: 'linux', wayland: false, version: 'effects-test'}};
    let changed: (value: unknown) => void = () => {};
    (window as any).pupa = {getState: async () => state, onState: (fn: typeof changed) => {changed = fn; return () => {};}, onShown: () => () => {}, hide() {}, quit() {},
      updateSettings: async (patch: object) => {Object.assign(state.settings, patch); changed(state); return {ok: true};}};
  });
  await page.goto('/');
  await expect(page.locator('.fan-stage')).toHaveAttribute('data-effects-mode', 'light');
  await page.keyboard.press('ArrowDown'); await page.waitForTimeout(400);
  expect(gpuRequests).toEqual([]); await expect(page.locator('.pupa-effects-canvas')).toHaveCount(0);
  await page.keyboard.press(','); await expect(page.locator('#visual-effects')).toHaveValue('light');
  await page.locator('#visual-effects').selectOption('off');
  await expect(page.locator('.fan-stage')).toHaveAttribute('data-effects-mode', 'off');
  await page.getByRole('button', {name: 'キャンセル', exact: true}).click();
  await expect(page.locator('.fan-stage')).toHaveAttribute('data-effects-mode', 'light');
  await page.keyboard.press(','); await page.locator('#visual-effects').selectOption('off'); await page.locator('#save-settings').click();
  await page.keyboard.press(','); await expect(page.locator('#visual-effects')).toHaveValue('off');
  expect(gpuRequests).toEqual([]);
});

test('reduced motion avoids GPU loading and missing WebGL falls back without affecting copy', async ({page}) => {
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('effects-three')) requests.push(request.url()); });
  await page.emulateMedia({reducedMotion: 'reduce'}); await page.goto('/');
  await page.keyboard.press('ArrowDown'); await page.waitForTimeout(300);
  await expect(page.locator('.fan-stage')).toHaveAttribute('data-effects-mode', 'off');
  expect(requests).toEqual([]);
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    (HTMLCanvasElement.prototype as any).getContext = function(type: string, ...args: unknown[]) {
      if (type === 'webgl2' || type === 'webgl') return null;
      return (original as any).call(this, type, ...args);
    };
  });
  await page.emulateMedia({reducedMotion: 'no-preference'}); await page.reload();
  await expect(page.locator('.fan-stage')).toHaveAttribute('data-effects-backend', 'fallback');
  await expect(page.locator('.fan-stage')).toHaveAttribute('data-effects-mode', 'light');
  await expect(page.locator('.pupa-effects-canvas')).toHaveCount(0);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(page.locator('#preview-launcher')).toBeVisible();
});

test.describe('GPU lifecycle and draw budget', () => {
  test('particles draw only during interaction, stay within budget, and release hidden resources', async ({page}) => {
    const shaderErrors: string[] = [];
    page.on('console', message => { if (message.type() === 'error' && /WebGLProgram|shader/i.test(message.text())) shaderErrors.push(message.text()); });
    await page.addInitScript(() => {
      // Allow the isolated test to exercise shaders on a software GPU. Production
      // requests failIfMajorPerformanceCaveat, so it can choose the light fallback.
      const original = HTMLCanvasElement.prototype.getContext;
      (HTMLCanvasElement.prototype as any).getContext = function(type: string, options: object) {
        return (original as any).call(this, type, type === 'webgl2' ? {...options, failIfMajorPerformanceCaveat: false} : options);
      };
      const raf = requestAnimationFrame;
      (window as any).effectsRafRequests = 0;
      window.requestAnimationFrame = callback => { (window as any).effectsRafRequests++; return raf(callback); };
    });
    await page.goto('/');
    const stage = page.locator('.fan-stage');
    await expect(stage).toHaveAttribute('data-effects-backend', 'three');
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => stage.getAttribute('data-effects-frames')).not.toBe('0');
    await expect(stage).toHaveAttribute('data-effects-active', 'false');
    expect(Number(await stage.getAttribute('data-effects-draw-calls'))).toBeLessThanOrEqual(2);
    expect(Number(await stage.getAttribute('data-effects-pixels'))).toBeLessThanOrEqual(725000);
    await expect(stage).toHaveAttribute('data-effects-textures', '0');
    await expect(stage).toHaveAttribute('data-effects-geometries', '2');
    const idle = await page.evaluate(() => (window as any).effectsRafRequests);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as any).effectsRafRequests)).toBe(idle);
    expect(shaderErrors).toEqual([]);
    await expect(page.locator('.pupa-effects-canvas')).toHaveCount(1);
    fs.mkdirSync('artifacts', {recursive: true});
    fs.writeFileSync('artifacts/pupa-effects-budget.json', JSON.stringify({
      environment: 'isolated Chromium software GPU',
      pixels: Number(await stage.getAttribute('data-effects-pixels')),
      drawCalls: Number(await stage.getAttribute('data-effects-draw-calls')),
      textures: Number(await stage.getAttribute('data-effects-textures')),
      geometries: Number(await stage.getAttribute('data-effects-geometries')),
      idleFrameRequests: 0,
    }, null, 2));
    await page.keyboard.press('ArrowDown'); await page.waitForTimeout(100);
    await page.screenshot({path: 'artifacts/pupa-three-hover.png'});
    await page.keyboard.press('Enter'); await page.waitForTimeout(100);
    await page.screenshot({path: 'artifacts/pupa-three-copy.png'});
    await expect(page.locator('#preview-launcher')).toBeVisible();
    expect(shaderErrors).toEqual([]);
    await page.clock.install(); await page.keyboard.press('Escape'); await page.clock.fastForward(5200);
    await expect(page.locator('.pupa-effects-canvas')).toHaveCount(0);
  });
});
