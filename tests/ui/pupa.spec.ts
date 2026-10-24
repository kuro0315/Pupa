import { test, expect } from '@playwright/test';
import fs from 'node:fs';
const setRange = async (page: import('@playwright/test').Page, id: string, value: string) => { await page.locator(id).evaluate((el, value) => { (el as HTMLInputElement).value = value; el.dispatchEvent(new Event('input', {bubbles:true})); }, value); };
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

test('card gear never copies; fan controls preview, cancel and persist', async ({ page }) => {
  await page.goto('/'); await page.keyboard.press('ArrowDown');
  await page.getByTestId('settings-button').first().click();
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
  await expect(page.locator('#preview-launcher')).toBeHidden();
  const before = await cards(page).first().getAttribute('style');
  await setRange(page, '#fan-spread', '30'); await setRange(page, '#fan-distance', '24');
  expect(await cards(page).first().getAttribute('style')).not.toBe(before);
  await page.getByRole('button', {name:'キャンセル', exact:true}).click();
  await openSettings(page); await expect(page.locator('#fan-spread')).toHaveValue('72');
  await expect(page.locator('#fan-distance')).toHaveValue('0');
  await setRange(page, '#fan-spread', '35'); await setRange(page, '#fan-distance', '18');
  await page.locator('#source-app').uncheck(); await page.locator('#save-settings').click();
  await openSettings(page); await expect(page.locator('#fan-spread')).toHaveValue('35');
  await expect(page.locator('#fan-distance')).toHaveValue('18'); await expect(page.locator('#source-app')).not.toBeChecked();
  await page.screenshot({path:'artifacts/pupa-settings.png'});
});

test('source labels are explicitly estimated and icons are local-only', async ({page}) => {
  await page.goto('/');
  await expect(page.getByTestId('source-app-label').first()).toContainText('推定');
  await expect(page.getByTestId('source-app-label').last()).toHaveText('アプリ不明');
  await expect(page.getByTestId('source-watermark')).toHaveCount(5);
  await expect(page.getByTestId('source-app-label').first()).toHaveAttribute('title', /保証するものではありません/);
});

test('lowering history cap requires acknowledgement including pins', async ({page}) => {
  await page.addInitScript(() => {
    const state:any = {entries:Array.from({length:35},(_,i)=>({id:`fixture-${i}`,text:`Synthetic ${i}`,kind:'text',color:'mint',createdAt:Date.now()-i,pinned:true})),settings:{shortcut:'CommandOrControl+Shift+Space',historyLimit:60,persistence:false,sourceApp:true,fanSpread:42,fanDistance:0},paused:false,status:{shortcutRegistered:true,storageWarning:null,platform:'linux',wayland:false,version:'test'}};
    (window as any).updates=[];
    (window as any).pupa = {getState:async()=>state,onState:()=>()=>{},onShown:()=>()=>{},hide:()=>{},quit:()=>{},updateSettings:async(s:any)=>{(window as any).updates.push(s);return{ok:true};}};
  });
  await page.goto('/'); await openSettings(page); await page.locator('#history-limit').selectOption('30');
  await expect(page.locator('#history-reduction-warning')).toBeVisible();
  await expect(page.locator('#history-reduction-description')).toContainText('ピン留め');
  await page.locator('#save-settings').click(); await expect(page.getByTestId('settings-dialog')).toBeVisible();
  expect(await page.evaluate(()=>(window as any).updates.length)).toBe(0);
  await page.getByTestId('confirm-history-reduction').check(); await page.locator('#save-settings').click();
  expect(await page.evaluate(()=>(window as any).updates[0].confirmHistoryReduction)).toBe(true);
});

test('copy failure retains visible card and exact text is selected on success', async ({page}) => {
  await page.addInitScript(() => {
    const state = {entries:[{id:'exact-entry',text:'  Exact\ntext\t🌙  ',kind:'text',color:'mint',createdAt:Date.now(),pinned:false}],settings:{shortcut:'CommandOrControl+Shift+Space',historyLimit:60,persistence:false},paused:false,status:{shortcutRegistered:true,storageWarning:null,platform:'linux',wayland:false,version:'test'}};
    (window as any).hidden=0;(window as any).copied=[];(window as any).fail=true;
    (window as any).pupa = {getState:async()=>state,onState:()=>()=>{},onShown:()=>()=>{},hide:()=>{(window as any).hidden++;},quit:()=>{},copyEntry:async(id:string)=>{(window as any).copied.push(id);return (window as any).fail?{ok:false,error:'Synthetic copy error'}:{ok:true};}};
  });
  await page.goto('/'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(page.locator('#toast')).toContainText('Synthetic copy error');
  expect(await page.evaluate(()=>(window as any).hidden)).toBe(0);
  await expect(cards(page).first()).toBeVisible();
  await page.evaluate(()=>(window as any).fail=false); await page.keyboard.press('Enter');
  await expect.poll(()=>page.evaluate(()=>(window as any).hidden)).toBe(1);
  expect(await page.evaluate(()=>(window as any).copied)).toEqual(['exact-entry','exact-entry']);
});


for (const viewport of [
  { width: 780, height: 900, name: 'native' },
  { width: 780, height: 1440, name: 'tall' },
  { width: 780, height: 480, name: 'short' },
  { width: 2560, height: 1080, name: 'ultrawide' },
  { width: 390, height: 640, name: 'narrow' },
]) {
  test(`wide fan uses work-area height and keeps every card visible: ${viewport.name}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize(viewport);
    await page.goto('/'); await expect(cards(page)).toHaveCount(5);
    const bounds = await page.getByTestId('fan-card').evaluateAll(elements => elements.map(el => {
      const { left, top, right, bottom } = el.getBoundingClientRect();
      return { left, top, right, bottom };
    }));
    const fanTop = Math.min(...bounds.map(rect => rect.top));
    const fanBottom = Math.max(...bounds.map(rect => rect.bottom));
    expect(fanTop).toBeLessThanOrEqual(20);
    expect(fanBottom).toBeGreaterThanOrEqual(viewport.height - 20);
    for (const rect of bounds) {
      expect(rect.left).toBeGreaterThanOrEqual(10);
      expect(rect.right).toBeLessThanOrEqual(viewport.width - 10);
      expect(rect.top).toBeGreaterThanOrEqual(10);
      expect(rect.bottom).toBeLessThanOrEqual(viewport.height - 10);
    }
    const angles = await cards(page).evaluateAll(elements => elements.map(el => parseFloat((el as HTMLElement).style.getPropertyValue('--angle'))));
    expect(Math.max(...angles) - Math.min(...angles)).toBeGreaterThanOrEqual(140);
    // Focus is the keyboard equivalent of hover, so both paths must use the
    // same unclipped enlargement at the top and bottom of the fan.
    for (let index = 0; index < 5; index++) {
      await page.getByTestId('copy-entry').nth(index).focus();
      await expect(cards(page).nth(index)).toHaveClass(/is-expanded/);
      const expanded = await page.getByTestId('fan-card').nth(index).boundingBox();
      expect(expanded).not.toBeNull();
      expect(expanded!.x).toBeGreaterThanOrEqual(10);
      expect(expanded!.y).toBeGreaterThanOrEqual(10);
      expect(expanded!.x + expanded!.width).toBeLessThanOrEqual(viewport.width - 10);
      expect(expanded!.y + expanded!.height).toBeLessThanOrEqual(viewport.height - 10);
      expect(expanded!.width).toBeGreaterThan(await cards(page).nth(index).evaluate(el => (el as HTMLElement).offsetWidth));
      const pull = await cards(page).nth(index).evaluate(el => {
        const slot = el as HTMLElement;
        const card = slot.querySelector<HTMLElement>('.clip-card')!;
        const matrix = new DOMMatrixReadOnly(getComputedStyle(card).transform);
        const restCenter = parseFloat(slot.style.left) + slot.offsetWidth / 2;
        const rect = card.getBoundingClientRect();
        return { scale: Math.hypot(matrix.a, matrix.b), leftward: restCenter - (rect.left + rect.width / 2) };
      });
      expect(pull.scale).toBeGreaterThanOrEqual(1.05);
      expect(pull.scale).toBeLessThanOrEqual(1.1);
      expect(pull.leftward).toBeGreaterThanOrEqual(viewport.width > 560 ? 80 : 5);
    }
    await page.locator('.fan-stage').focus();
    await page.mouse.move(0, 0);
    await page.getByTestId('copy-entry').last().hover();
    await expect(cards(page).last()).toHaveClass(/is-expanded/);
    const hovered = await page.getByTestId('fan-card').last().boundingBox();
    expect(hovered!.y + hovered!.height).toBeLessThanOrEqual(viewport.height - 10);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBeTruthy();
    fs.mkdirSync('artifacts', { recursive: true });
    await page.locator('.fan-stage').focus(); await page.mouse.move(0, 0);
    await page.screenshot({ path: `artifacts/pupa-fan-${viewport.name}.png` });
  });
}

test('spread slider opens vertical spacing while resize preserves clamped focus', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 780, height: 900 });
  await page.goto('/'); await openSettings(page);
  await expect(page.locator('#fan-spread')).toHaveAttribute('max', '84');
  const span = () => page.getByTestId('fan-card').evaluateAll(elements => {
    const rects = elements.map(el => el.getBoundingClientRect());
    return Math.max(...rects.map(r => r.bottom)) - Math.min(...rects.map(r => r.top));
  });
  await setRange(page, '#fan-spread', '20'); const closed = await span();
  await setRange(page, '#fan-spread', '84'); const opened = await span();
  expect(opened - closed).toBeGreaterThan(160);
  await setRange(page, '#fan-distance', '90');
  await page.locator('#save-settings').click();
  await expect(page.getByTestId('settings-dialog')).not.toBeVisible();
  await page.getByTestId('copy-entry').first().focus();
  await expect(cards(page).first()).toHaveClass(/is-expanded/);
  await expect(page.getByTestId('copy-entry').first()).toBeFocused();
  for (const viewport of [{ width: 780, height: 480 }, { width: 390, height: 640 }, { width: 780, height: 1440 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(async () => page.getByTestId('fan-card').first().evaluate(el => {
      const r = el.getBoundingClientRect();
      return r.left >= 10 && r.top >= 10 && r.right <= innerWidth - 10 && r.bottom <= innerHeight - 10;
    })).toBeTruthy();
    await expect(cards(page).first()).toHaveClass(/is-expanded/);
    await expect(page.getByTestId('copy-entry').first()).toBeFocused();
  }
});


test('explicit focus replaces hover and stationary resize cannot steal it', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 780, height: 900 });
  await page.goto('/'); await expect(cards(page)).toHaveCount(5);
  await page.getByTestId('copy-entry').last().hover();
  await expect(cards(page).last()).toHaveClass(/is-expanded/);
  await page.getByTestId('copy-entry').first().focus();
  await expect(cards(page).first()).toHaveClass(/is-expanded/);
  await expect(cards(page).last()).not.toHaveClass(/is-expanded/);
  // The first leaf stays top-anchored when card dimensions are capped. The
  // bottom leaf, not the first leaf, must follow this 40 px height increase.
  const beforeResize = await cards(page).last().evaluate(el => parseFloat((el as HTMLElement).style.top));
  await page.setViewportSize({ width: 780, height: 940 });
  await expect.poll(() => cards(page).last().evaluate(el => parseFloat((el as HTMLElement).style.top))).toBeCloseTo(beforeResize + 40, 1);
  await expect(page.getByTestId('copy-entry').first()).toBeFocused();
  await expect(cards(page).first()).toHaveClass(/is-expanded/);
  // A real mouse move must still be able to choose a different card.
  await page.mouse.move(0, 0);
  await page.getByTestId('copy-entry').last().hover();
  await expect(cards(page).last()).toHaveClass(/is-expanded/);
});
