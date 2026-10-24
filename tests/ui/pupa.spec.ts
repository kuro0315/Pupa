import { test, expect } from '@playwright/test';
import fs from 'node:fs';
const cards = (page: import('@playwright/test').Page) => page.getByTestId('clipboard-card');
const openSettings = async (page: import('@playwright/test').Page) => { await page.keyboard.press(','); await expect(page.getByTestId('settings-dialog')).toBeVisible(); };

test('capture cards-only fan, enlarged card, and entrance animation', async ({ browser }) => {
  fs.mkdirSync('artifacts', { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, recordVideo: { dir: 'artifacts', size: { width: 1440, height: 1000 } } });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:5173/');
  await expect(cards(page)).toHaveCount(5);
  await expect(page.locator('h1')).toHaveCount(0);
  await expect(page.getByTestId('search-input')).toBeHidden();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'artifacts/pupa-fan-resting.png' });
  await page.getByTestId('copy-entry').last().hover();
  await expect(cards(page).last()).toHaveClass(/is-expanded/);
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'artifacts/pupa-fan-hover.png' });
  await page.mouse.move(100, 100);
  await page.keyboard.press('Escape');
  await expect(page.locator('#preview-launcher')).toBeVisible();
  await page.waitForTimeout(500);
  await page.keyboard.press('Control+Shift+Space');
  await page.waitForTimeout(1200);
  await page.setViewportSize({ width: 780, height: 900 });
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'artifacts/pupa-overlay-preview.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  const video = page.video(); await context.close(); await video?.saveAs('artifacts/pupa-card-fan.webm');
});

test('persistent fan geometry and keyboard equivalent of hover', async ({ page }) => {
  await page.goto('/'); await expect(cards(page)).toHaveCount(5); await page.waitForTimeout(1100);
  const angles = await cards(page).evaluateAll(elements => elements.map(el => (el as HTMLElement).style.getPropertyValue('--angle')));
  expect(new Set(angles).size).toBe(5); expect(angles).toContain('0deg');
  await page.keyboard.press('ArrowDown');
  await expect(cards(page).first()).toHaveClass(/is-expanded/);
  await expect(page.getByTestId('copy-entry').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(cards(page).nth(1)).toHaveClass(/is-expanded/);
  await expect(cards(page).first()).not.toHaveClass(/is-expanded/);
});

test('search is on-demand; filters, pin and delete work', async ({ page }) => {
  await page.goto('/'); await expect(cards(page)).toHaveCount(5);
  await page.keyboard.press('Control+f');
  await expect(page.getByTestId('search-input')).toBeFocused();
  await page.getByTestId('search-input').fill('no-such-copy-123');
  await expect(cards(page)).toHaveCount(0); await expect(page.locator('#empty-label')).toHaveText('見つかりませんでした');
  await page.getByTestId('search-input').fill('github'); await expect(cards(page)).toHaveCount(1);
  await page.getByTestId('copy-entry').focus();
  await page.getByTestId('pin-entry').click();
  await page.keyboard.press('Control+f');
  await page.getByTestId('search-input').fill('');
  await page.locator('[data-filter="pinned"]').click(); await expect(cards(page)).toHaveCount(2);
  await page.getByTestId('copy-entry').last().focus();
  await page.getByTestId('delete-entry').last().click(); await expect(cards(page)).toHaveCount(1);
});

test('clear requires confirmation and includes pinned cards', async ({ page }) => {
  await page.goto('/'); await openSettings(page); await page.locator('#clear-history-button').click();
  await expect(page.getByTestId('clear-dialog')).toBeVisible();
  await page.getByRole('button', { name:'やめておく' }).click(); await expect(cards(page)).toHaveCount(5);
  await openSettings(page); await page.locator('#clear-history-button').click(); await page.getByTestId('confirm-clear').click();
  await expect(cards(page)).toHaveCount(0); await expect(page.locator('#empty-label')).toHaveText('履歴はまだありません');
});

test('settings pause, cancel/save and explicit persistence warning', async ({ page }) => {
  await page.goto('/'); await openSettings(page);
  await page.locator('#pause-button').click(); await expect(page.locator('#pause-button')).toHaveText('記録を再開');
  await page.locator('#pause-button').click(); await expect(page.locator('#pause-button')).toHaveText('一時停止');
  await expect(page.locator('#persistence')).not.toBeChecked();
  await expect(page.locator('#persistence-warning')).toContainText('暗号化せず');
  await page.locator('#persistence').check(); await page.getByRole('button', { name:'キャンセル', exact:true }).click();
  await openSettings(page); await expect(page.locator('#persistence')).not.toBeChecked();
  await page.locator('#history-limit').selectOption('30'); await page.locator('#save-settings').click();
  await expect(page.getByTestId('settings-dialog')).not.toBeVisible(); await openSettings(page);
  await expect(page.locator('#history-limit')).toHaveValue('30'); await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-dialog')).not.toBeVisible();
});

test('copy hides; repeated shortcut and backdrop correctly close/reopen', async ({ page }) => {
  await page.goto('/'); await expect(cards(page)).toHaveCount(5); await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter'); await expect(page.locator('#preview-launcher')).toBeVisible();
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Control+Shift+Space'); await expect(page.locator('#preview-launcher')).toBeHidden();
    await page.keyboard.press('Control+Shift+Space'); await expect(page.locator('#preview-launcher')).toBeVisible();
  }
  await page.locator('#preview-launcher').click();
  await page.locator('#backdrop').click({ position:{x:30,y:30} }); await expect(page.locator('#preview-launcher')).toBeVisible();
});

test('reduced motion and small screens keep utilities usable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion:'reduce' }); await page.setViewportSize({width:390,height:640});
  await page.goto('/'); await expect(cards(page)).toHaveCount(5);
  expect(await cards(page).first().evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await openSettings(page); await page.locator('#save-settings').scrollIntoViewIfNeeded(); await expect(page.locator('#save-settings')).toBeVisible();
});

test('untrusted clipboard text is plain text with no remote request', async ({ page }) => {
  await page.addInitScript(() => {
    const state = {entries:[{id:'synthetic',text:'<img src="https://example.invalid/private" onerror="window.hacked=true"><script>window.hacked=true</script>',kind:'text',color:'mint',createdAt:Date.now(),pinned:false}],settings:{shortcut:'CommandOrControl+Shift+Space',historyLimit:60,persistence:false,hideAfterCopy:true},paused:false,status:{shortcutRegistered:true,storageWarning:null,platform:'linux',wayland:false,version:'test'}};
    (window as any).pupa = {getState:async()=>state,onState:()=>()=>{},onShown:()=>()=>{},hide:()=>{},quit:()=>{},copyEntry:async()=>({ok:true})};
  });
  const outbound:string[]=[]; page.on('request',r=>{if(r.url().includes('example.invalid'))outbound.push(r.url());});
  await page.goto('/'); await expect(cards(page)).toHaveCount(1); await expect(page.locator('.card-content')).toContainText('<img');
  await expect(page.locator('.card-content img')).toHaveCount(0); expect(outbound).toEqual([]);
  expect(await page.evaluate(()=>(window as any).hacked)).toBeUndefined();
  expect(await page.locator('.fan-stage').evaluate(el=>getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
});
