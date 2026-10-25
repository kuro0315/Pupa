import { test, expect } from '@playwright/test';
import fs from 'node:fs';
const setRange = async (page: import('@playwright/test').Page, id: string, value: string) => { await page.locator(id).evaluate((el, value) => { (el as HTMLInputElement).value = value; el.dispatchEvent(new Event('input', {bubbles:true})); }, value); };
const cards = (page: import('@playwright/test').Page) => page.getByTestId('clipboard-card');
const openSettings = async (page: import('@playwright/test').Page) => { await page.keyboard.press(','); await expect(page.getByTestId('settings-dialog')).toBeVisible(); };

test('paging visibly moves retained cards, updates position, and signals the history boundary', async ({page}) => {
  await installHandFixture(page, 12); await page.goto('/'); await expect(cards(page)).toHaveCount(7);
  await expect(page.locator('#deck-position-label')).toHaveText('1–7 / 12');
  const before = await page.locator('#deck-scroll-thumb').getAttribute('style');
  await page.keyboard.press('PageDown');
  await expect(page.locator('#deck-position-label')).toHaveText('6–12 / 12');
  await expect(page.locator('.fan-stage')).toHaveClass(/is-scrolling/);
  expect(await page.locator('#deck-scroll-thumb').getAttribute('style')).not.toBe(before);
  expect(await cards(page).evaluateAll(elements => elements.some(element => element.getAnimations().some(a => a.playState === 'running')))).toBeTruthy();
  await page.keyboard.press('PageDown'); await expect(page.locator('#deck-boundary')).toHaveText('末尾');
  await page.keyboard.press('PageUp'); await expect(page.locator('#deck-position-label')).toHaveText('1–7 / 12');
  await page.keyboard.press('PageUp'); await expect(page.locator('#deck-boundary')).toHaveText('先頭');
  expect(await page.evaluate(() => (window as any).handCopies)).toEqual([]);
});

test('wheel paging reports its position with reduced motion and disappears when history fits', async ({page}) => {
  await page.emulateMedia({reducedMotion: 'reduce'});
  await installHandFixture(page, 12); await page.goto('/'); await expect(cards(page)).toHaveCount(7);
  await cards(page).first().dispatchEvent('wheel', {deltaY: 100, bubbles: true});
  await expect(page.locator('#deck-position-label')).toHaveText('2–8 / 12');
  expect(await cards(page).evaluateAll(elements => elements.every(element => element.getAnimations().length === 0))).toBeTruthy();
  await page.keyboard.press('Control+f'); await page.getByTestId('search-input').fill('HAND 01');
  await expect(cards(page)).toHaveCount(1); await expect(page.locator('#deck-position')).toBeHidden();
  await expect(page.locator('#deck-scroll-rail')).toBeHidden();
});

test('moving cards ignore pointer copies while keyboard copy remains immediate', async ({page}) => {
  await installHandFixture(page, 12); await page.goto('/'); await expect(cards(page)).toHaveCount(7);
  await page.keyboard.press('PageDown');
  await page.getByTestId('copy-entry').first().dispatchEvent('click', {detail: 1, button: 0, bubbles: true});
  expect(await page.evaluate(() => (window as any).handCopies)).toEqual([]);
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).handCopies.length)).toBe(1);
});

test('visible card count previews, cancels, persists and preserves access to hidden history', async ({page}) => {
  await page.goto('/'); await expect(cards(page)).toHaveCount(5);
  await openSettings(page);
  await expect(page.locator('#visible-cards')).toHaveValue('0');
  await page.locator('#visible-cards').selectOption('3'); await expect(cards(page)).toHaveCount(3);
  await page.getByRole('button', {name: 'キャンセル', exact: true}).click(); await expect(cards(page)).toHaveCount(5);
  await openSettings(page); await page.locator('#visible-cards').selectOption('2');
  await page.locator('#save-settings').click(); await expect(cards(page)).toHaveCount(2);
  const first = await cards(page).first().getAttribute('data-id');
  await page.keyboard.press('PageDown'); await expect(cards(page)).toHaveCount(2);
  expect(await cards(page).first().getAttribute('data-id')).not.toBe(first);
  await openSettings(page); await expect(page.locator('#visible-cards')).toHaveValue('2');
  await page.locator('#visible-cards').selectOption('0'); await page.locator('#save-settings').click();
  await expect(cards(page)).toHaveCount(5);
});

test('ten configured cards fit a small viewport and remain keyboard selectable', async ({page}) => {
  await page.setViewportSize({width: 390, height: 480});
  await page.addInitScript(() => {
    const state = {entries: Array.from({length: 12}, (_, i) => ({id: `count-${i}`, text: `Synthetic card ${i + 1}`, kind: 'text', color: 'mint', createdAt: Date.now(), pinned: false})),
      settings: {shortcut: 'CommandOrControl+Shift+Space', historyLimit: 60, persistence: false, visibleCards: 10}, paused: false,
      status: {shortcutRegistered: true, platform: 'linux', wayland: false, version: 'visible-count-test'}};
    (window as any).pupa = {getState: async () => state, onState: () => () => {}, onShown: () => () => {}, hide() {}, quit() {}};
  });
  await page.emulateMedia({reducedMotion: 'reduce'}); await page.goto('/');
  await expect(cards(page)).toHaveCount(10);
  expect(await cards(page).evaluateAll(elements => elements.every(element => {
    const r = element.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
  }))).toBeTruthy();
  for (let i = 0; i < 11; i++) await page.keyboard.press('ArrowDown');
  await expect(page.locator('.card-slot.is-expanded')).toHaveAttribute('data-id', 'count-10');
});

test('file cards show filenames and counts, filter by type, and report missing originals', async ({page}) => {
  await page.addInitScript(() => {
    const state = {entries: [
      {id: 'file-group', text: '架空の資料 #1.pdf\n<架空フォルダー>', files: ['/tmp/架空の資料 #1.pdf', '/tmp/<架空フォルダー>'],
        kind: 'files', color: 'mint', createdAt: Date.now(), pinned: false},
      {id: 'plain-text', text: 'Synthetic plain text', kind: 'text', color: 'butter', createdAt: Date.now(), pinned: false},
    ], settings: {shortcut: 'CommandOrControl+Shift+Space', historyLimit: 60, persistence: false}, paused: false,
      status: {shortcutRegistered: true, platform: 'linux', wayland: false, version: 'files-test'}};
    (window as any).fileCopies = [];
    (window as any).pupa = {getState: async () => state, onState: () => () => {}, onShown: () => () => {}, hide() {}, quit() {},
      copyEntry: async (id: string) => { (window as any).fileCopies.push(id); return {ok: false, error: '元のファイルが見つかりません。'}; }};
  });
  await page.goto('/'); await expect(cards(page)).toHaveCount(2);
  await expect(page.locator('.file-card-heading')).toContainText('2 個');
  await expect(page.locator('.file-card-names')).toHaveText('架空の資料 #1.pdf\n<架空フォルダー>');
  await expect(page.locator('.file-card-note')).toHaveText('元の場所からコピー');
  await page.keyboard.press('Control+f'); await page.locator('[data-filter="files"]').click();
  await expect(cards(page)).toHaveCount(1);
  await page.getByTestId('search-input').fill('資料 #1'); await expect(cards(page)).toHaveCount(1);
  await page.keyboard.press('Escape'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(page.locator('#toast')).toContainText('元のファイルが見つかりません');
  expect(await page.evaluate(() => (window as any).fileCopies)).toEqual(['file-group']);
  await expect(page.locator('.fan-stage')).not.toHaveClass(/is-copy-dismiss/);
});

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

test('source labels show app names without estimate suffix and icons are local-only', async ({page}) => {
  await page.goto('/');
  await expect(page.getByTestId('source-app-label').first()).toHaveText('Memo Lab（デモ）');
  await expect(page.getByTestId('source-app-label').last()).toHaveText('アプリ不明');
  await expect(page.getByTestId('source-watermark')).toHaveCount(5);
  await expect(page.getByTestId('source-app-label').first()).toHaveAttribute('title', /保証するものではありません/);
});

test('local app icon renders as a decorative watermark and remote artwork is rejected', async ({page}) => {
  await page.addInitScript(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#218bd8'; ctx.fillRect(8, 8, 48, 48);
    const state = {entries: [canvas.toDataURL('image/png'), 'https://example.invalid/logo.png'].map((icon, index) => ({
      id: `icon-${index}`, text: 'Synthetic clipboard card', kind: 'text', color: 'mint', createdAt: Date.now(), pinned: false,
      source: {name: 'Synthetic App', kind: 'foreground', icon},
    })), settings: {shortcut: 'CommandOrControl+Shift+Space', historyLimit: 60, persistence: false},
      paused: false, status: {shortcutRegistered: true, platform: 'linux', wayland: false, version: 'icon-test'}};
    (window as any).pupa = {getState: async () => state, onState: () => () => {}, onShown: () => () => {}, hide() {}, quit() {}};
  });
  await page.goto('/');
  const watermark = page.getByTestId('source-watermark').first();
  await expect(watermark.locator('img')).toHaveCount(1);
  await expect.poll(() => watermark.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(64);
  await expect(watermark).toHaveAttribute('aria-hidden', 'true');
  await expect(watermark).toHaveCSS('pointer-events', 'none');
  await expect(watermark).toHaveCSS('opacity', '0.12');
  await expect(page.getByTestId('source-app-label').first()).toHaveText('Synthetic App');
  await expect(page.getByTestId('source-watermark').last().locator('img')).toHaveCount(0);
  await expect(page.getByTestId('source-watermark').last().locator('svg')).toHaveCount(1);
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
    (window as any).pupa = {getState:async()=>state,onState:()=>()=>{},onShown:()=>()=>{},hide:()=>{(window as any).hidden++;},quit:()=>{},copyEntry:async(id:string)=>{(window as any).copied.push(id);return (window as any).fail?{ok:false,error:'Synthetic copy error'}:{ok:true,dismissToken:'exact-copy-token'};},completeCopyDismissal:async(token:string)=>{if(token==='exact-copy-token')(window as any).hidden++;return{ok:true};}};
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
      expect(rect.right).toBeCloseTo(viewport.width - (viewport.width <= 560 ? 12 : 18), 1);
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
      // With the leaf's original tilt preserved, its axis-aligned width can
      // shrink even while it scales up. Measure the actual transform below.
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
    // Hover follows the fixed hand region, not the animated button's changing
    // center. Retrying locator.hover would chase the card after it pulls out.
    const lastRestingPoint = (await restingHandPoints(page)).at(-1)!;
    await page.mouse.move(lastRestingPoint.x, lastRestingPoint.y, { steps: 8 });
    await expect(page.locator('.card-slot.is-expanded')).toHaveCount(1);
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

const installHandFixture = async (page: import('@playwright/test').Page, count = 7) => {
  await page.addInitScript(count => {
    const colors = ['butter', 'mint', 'lavender', 'rose'];
    const state = { entries: Array.from({ length: count }, (_, index) => ({ id: `hand-${index + 1}`, text: `HAND ${String(index + 1).padStart(2, '0')}\nカーソルで手札を選ぶ。\nクリックでコピー。`, kind: 'text', color: colors[index % colors.length], createdAt: Date.now() - index * 60000, pinned: false, source: { kind: 'foreground', name: 'Hand demo' } })), settings: { shortcut: 'CommandOrControl+Shift+Space', historyLimit: 100, persistence: false, sourceApp: true, fanSpread: 72, fanDistance: 0 }, paused: false, status: { shortcutRegistered: true, storageWarning: null, platform: 'linux', wayland: false, version: 'interaction-test' } };
    (window as any).handCopies = []; (window as any).handHidden = 0;
    (window as any).pupa = { getState: async () => state, onState: () => () => {}, onShown: () => () => {}, hide: () => { (window as any).handHidden++; }, quit: () => {}, copyEntry: async (id: string) => { (window as any).handCopies.push(id); return { ok: true, dismissToken: `hand-copy-${(window as any).handCopies.length}` }; }, completeCopyDismissal: async () => { (window as any).handHidden++; return { ok: true }; } };
  }, count);
};

const restingHandPoints = async (page: import('@playwright/test').Page) => page.locator('.card-slot').evaluateAll(elements => {
  const regions = elements.map(element => {
    const el = element as HTMLElement;
    const angle = parseFloat(el.style.getPropertyValue('--angle')) * Math.PI / 180;
    return { id: el.dataset.id!, cx: parseFloat(el.style.left) + el.offsetWidth / 2, cy: parseFloat(el.style.top) + el.offsetHeight / 2, w: el.offsetWidth, h: el.offsetHeight, angle };
  });
  const local = (r: typeof regions[number], x: number, y: number) => ({ x: (x - r.cx) * Math.cos(r.angle) + (y - r.cy) * Math.sin(r.angle), y: -(x - r.cx) * Math.sin(r.angle) + (y - r.cy) * Math.cos(r.angle) });
  const contains = (r: typeof regions[number], x: number, y: number) => { const p = local(r, x, y); return Math.abs(p.x) <= r.w / 2 && Math.abs(p.y) <= r.h / 2; };
  return regions.map((r, index) => {
    let best: { id: string; x: number; y: number; score: number } | null = null;
    for (let y = 12; y < innerHeight - 12; y += 6) for (let x = 12; x < innerWidth - 12; x += 6) {
      if (!contains(r, x, y) || regions.slice(index + 1).some(other => contains(other, x, y))) continue;
      const p = local(r, x, y);
      let score = Math.min(r.w / 2 - Math.abs(p.x), r.h / 2 - Math.abs(p.y));
      for (const other of regions.slice(index + 1)) { const q = local(other, x, y); score = Math.min(score, Math.max(Math.abs(q.x) - other.w / 2, Math.abs(q.y) - other.h / 2)); }
      if (!best || score > best.score) best = { id: r.id, x, y, score };
    }
    if (!best) throw new Error(`No exposed resting region for ${r.id}`);
    return best;
  });
});

test('record seven-card pointer sweep with no sticky selection or accidental copy', async ({ browser }) => {
  fs.mkdirSync('artifacts', { recursive: true });
  const context = await browser.newContext({ viewport: { width: 780, height: 900 }, recordVideo: { dir: 'artifacts', size: { width: 780, height: 900 } } });
  const page = await context.newPage();
  await installHandFixture(page); await page.goto('http://127.0.0.1:5173/');
  await expect(cards(page)).toHaveCount(7); await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(1100);
  // This marker follows real Playwright mouse events. It is a capture overlay,
  // not a replacement animation or part of the production interface.
  await page.evaluate(() => {
    const cursor = document.createElement('div'); cursor.setAttribute('aria-hidden', 'true');
    cursor.style.cssText = 'position:fixed;left:0;top:0;width:14px;height:14px;border:2px solid #fff;background:#46e7ee99;border-radius:50%;z-index:9999;pointer-events:none;transform:translate(-50%,-50%);box-shadow:0 0 0 3px #10182088';
    document.body.append(cursor); document.addEventListener('pointermove', event => { cursor.style.left = `${event.clientX}px`; cursor.style.top = `${event.clientY}px`; }, true);
  });
  const points = await restingHandPoints(page);
  await page.mouse.move(24, 24); await page.waitForTimeout(300);
  const sequence = [...points, ...points.slice(0, -1).reverse()];
  for (const point of sequence) {
    await page.mouse.move(point.x, point.y, { steps: 12 });
    await expect(page.locator('.card-slot.is-expanded')).toHaveCount(1);
    await expect(page.locator('.card-slot.is-expanded')).toHaveAttribute('data-id', point.id);
    await page.waitForTimeout(240);
    await expect(page.locator('.card-slot.is-expanded')).toHaveAttribute('data-id', point.id);
  }
  expect(await page.evaluate(() => (window as any).handCopies)).toEqual([]);
  expect(await page.evaluate(() => (window as any).handHidden)).toBe(0);
  await page.mouse.move(24, 24, { steps: 12 }); await expect(page.locator('.card-slot.is-expanded')).toHaveCount(0);
  await page.waitForTimeout(400);
  await page.keyboard.press('ArrowDown'); await expect(page.locator('.card-slot.is-expanded')).toHaveCount(1);
  await expect(page.locator('.card-slot.is-expanded .card-copy')).toBeFocused();
  // Real pointer movement takes over from keyboard focus; leaving does not
  // resurrect the previously keyboard-selected card.
  await page.mouse.move(points[3].x, points[3].y, { steps: 8 });
  await expect(page.locator('.card-slot.is-expanded')).toHaveAttribute('data-id', points[3].id);
  await page.mouse.move(24, 24); await expect(page.locator('.card-slot.is-expanded')).toHaveCount(0);
  const video = page.video(); await context.close(); await video?.saveAs('artifacts/pupa-hand-pointer-sweep.webm');
});

test('pulled card cannot intercept a neighboring resting region; its exposed tools still work', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.setViewportSize({ width: 780, height: 900 });
  await installHandFixture(page); await page.goto('/'); await expect(cards(page)).toHaveCount(7);
  let crossing: { x: number; y: number; id: string } | null = null;
  for (let active = 0; active < 7 && !crossing; active++) {
    await page.getByTestId('copy-entry').nth(active).focus();
    crossing = await cards(page).evaluateAll((elements, active) => {
      const rects = elements.map(element => { const el = element as HTMLElement; return { el, id: el.dataset.id!, x: parseFloat(el.style.left) + el.offsetWidth / 2, y: parseFloat(el.style.top) + el.offsetHeight / 2, w: el.offsetWidth, h: el.offsetHeight, angle: parseFloat(el.style.getPropertyValue('--angle')) * Math.PI / 180 }; });
      for (let y = 20; y < innerHeight - 20; y += 8) for (let x = 20; x < innerWidth - 20; x += 8) {
        const owner = [...rects].reverse().find(r => { const dx = x - r.x, dy = y - r.y; return Math.abs(dx * Math.cos(r.angle) + dy * Math.sin(r.angle)) < r.w / 2 && Math.abs(-dx * Math.sin(r.angle) + dy * Math.cos(r.angle)) < r.h / 2; });
        const hit = document.elementFromPoint(x, y);
        if (owner && owner.id !== rects[active].id && hit?.closest('.card-slot') === rects[active].el && !hit.closest('.card-icon')) return { x, y, id: owner.id };
      }
      return null;
    }, active);
  }
  expect(crossing).not.toBeNull();
  await page.mouse.move(crossing!.x, crossing!.y);
  await expect(page.locator('.card-slot.is-expanded')).toHaveAttribute('data-id', crossing!.id);
  await page.waitForTimeout(250); await expect(page.locator('.card-slot.is-expanded')).toHaveAttribute('data-id', crossing!.id);
  await page.locator('.card-slot.is-expanded [data-action="settings"]').click();
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
  expect(await page.evaluate(() => (window as any).handCopies)).toEqual([]);
  await page.keyboard.press('Escape');
  await page.getByTestId('copy-entry').last().focus();
  // Find an exposed pulled-out body point outside every resting rectangle.
  const exposed = await cards(page).evaluateAll(elements => {
    const active = elements.at(-1)! as HTMLElement;
    const card = active.querySelector<HTMLElement>('.clip-card')!; const r = card.getBoundingClientRect();
    for (let y = r.top + 20; y < r.bottom - 20; y += 8) for (let x = r.left + 20; x < r.right - 20; x += 8) {
      const hit = document.elementFromPoint(x, y);
      if (!hit?.closest('.card-copy') || hit.closest('.card-slot') !== active) continue;
      const inHand = elements.some(element => { const el = element as HTMLElement; const a = parseFloat(el.style.getPropertyValue('--angle')) * Math.PI / 180, dx = x - parseFloat(el.style.left) - el.offsetWidth / 2, dy = y - parseFloat(el.style.top) - el.offsetHeight / 2; return Math.abs(dx * Math.cos(a) + dy * Math.sin(a)) <= el.offsetWidth / 2 && Math.abs(-dx * Math.sin(a) + dy * Math.cos(a)) <= el.offsetHeight / 2; });
      if (!inHand) return { x, y };
    }
    return null;
  });
  expect(exposed).not.toBeNull(); await page.mouse.click(exposed!.x, exposed!.y);
  await expect.poll(() => page.evaluate(() => (window as any).handCopies)).toEqual(['hand-7']);
});


for (const viewport of [{ width: 780, height: 900 }, { width: 780, height: 480 }, { width: 390, height: 640 }]) {
  test(`local condensed numerals keep three-digit indices clear at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' }); await page.setViewportSize(viewport);
    const fontRequests: string[] = []; page.on('request', request => { if (/\.(ttf|woff2?)(\?|$)/.test(request.url())) fontRequests.push(request.url()); });
    await installHandFixture(page, 100); await page.goto('/');
    await expect(cards(page)).toHaveCount(viewport.height < 600 ? 5 : 7);
    await page.evaluate(() => document.fonts.ready);
    const fonts = await page.evaluate(async () => (await document.fonts.load('28px "Anton"', '0123456789')).map(face => ({ family: face.family, status: face.status })));
    expect(fonts).toHaveLength(1); expect(fonts[0].status).toBe('loaded');
    for (let i = 0; i < 20; i++) await page.keyboard.press('PageDown');
    await expect(page.locator('.card-number').last()).toHaveText('100');
    const measurements = await page.locator('.card-copy').evaluateAll(elements => elements.map(element => {
      const number = element.querySelector<HTMLElement>('.card-number')!, source = element.querySelector<HTMLElement>('.source-label')!, content = element.querySelector<HTMLElement>('.card-content')!;
      return { numberRight: number.offsetLeft + number.offsetWidth, sourceLeft: source.offsetLeft, numberBottom: number.offsetTop + number.offsetHeight, contentTop: content.offsetTop, numberFont: getComputedStyle(number).fontFamily, contentFont: getComputedStyle(content).fontFamily };
    }));
    for (const item of measurements) { expect(item.numberRight).toBeLessThanOrEqual(item.sourceLeft); expect(item.numberBottom).toBeLessThanOrEqual(item.contentTop); expect(item.numberFont).toContain('Anton'); expect(item.contentFont).not.toContain('Anton'); }
    expect(fontRequests.some(url => new URL(url).pathname.endsWith('/fonts/anton/Anton-Regular.ttf'))).toBeTruthy();
    expect(fontRequests.every(url => new URL(url).origin === new URL(page.url()).origin)).toBeTruthy();
  });
}


test('short-screen resting regions support a stable five-card sweep', async ({ page }) => {
  await page.setViewportSize({ width: 780, height: 480 });
  await installHandFixture(page, 5); await page.goto('/'); await expect(cards(page)).toHaveCount(5);
  await page.waitForTimeout(1000);
  const points = await restingHandPoints(page);
  for (const point of [...points, ...points.slice(0, -1).reverse()]) {
    await page.mouse.move(point.x, point.y, { steps: 8 });
    await expect(page.locator('.card-slot.is-expanded')).toHaveCount(1);
    await expect(page.locator('.card-slot.is-expanded')).toHaveAttribute('data-id', point.id);
    await page.waitForTimeout(250);
    await expect(page.locator('.card-slot.is-expanded')).toHaveAttribute('data-id', point.id);
    const rect = await page.locator('.card-slot.is-expanded .clip-card').boundingBox();
    expect(rect!.x).toBeGreaterThanOrEqual(10); expect(rect!.y).toBeGreaterThanOrEqual(10);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(770); expect(rect!.y + rect!.height).toBeLessThanOrEqual(470);
  }
  expect(await page.evaluate(() => (window as any).handCopies)).toEqual([]);
  expect(await page.evaluate(() => (window as any).handHidden)).toBe(0);
  await page.mouse.move(2, 2); await expect(page.locator('.card-slot.is-expanded')).toHaveCount(0);
});


const installDismissalFixture = async (page: import('@playwright/test').Page) => {
  await page.addInitScript(() => {
    const control: any = { copies: [], completions: [], hides: 0, fail: false, tokenless: false, defer: false, successAt: 0, completeAt: 0 };
    (window as any).dismissal = control;
    const state = { entries: [{ id: 'dismiss-card', text: 'Exact dismissal test\nNo automatic copying', kind: 'text', color: 'mint', createdAt: Date.now(), pinned: false }], settings: { shortcut: 'CommandOrControl+Shift+Space', historyLimit: 60, persistence: false, hideAfterCopy: true, fanSpread: 72, fanDistance: 0 }, paused: false, status: { shortcutRegistered: true, storageWarning: null, platform: 'linux', wayland: false, version: 'dismissal-test' } };
    (window as any).pupa = {
      getState: async () => state, onState: () => () => {}, onShown: (fn: () => void) => { control.show = fn; return () => {}; }, onSettings: (fn: () => void) => { control.settings = fn; return () => {}; }, hide: () => { control.hides++; }, quit: () => {},
      copyEntry: async (id: string) => {
        control.copies.push(id); const token = `dismiss-${control.copies.length}`;
        if (control.defer) { control.defer = false; return new Promise(resolve => { control.resolve = () => { control.successAt = performance.now(); resolve({ ok: true, dismissToken: token }); }; }); }
        if (control.fail) return { ok: false, error: 'Synthetic write failure' };
        control.successAt = performance.now(); return control.tokenless ? { ok: true } : { ok: true, dismissToken: token };
      },
      completeCopyDismissal: async (token: string) => { control.completions.push(token); control.completeAt = performance.now(); return control.completeFail ? { ok: false, error: 'Synthetic dismissal failure' } : { ok: true }; },
    };
  });
};

test('copy feedback waits for successful write, rejects repeats, and completes only its token', async ({ page }) => {
  await installDismissalFixture(page); await page.goto('/'); await expect(cards(page)).toHaveCount(1);
  await page.evaluate(() => { (window as any).dismissal.defer = true; });
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  expect(await page.evaluate(() => (window as any).dismissal.copies)).toEqual(['dismiss-card']);
  await expect(page.locator('.fan-stage')).not.toHaveClass(/is-copy-dismiss/);
  await page.evaluate(() => (window as any).dismissal.resolve());
  await expect(page.locator('.fan-stage')).toHaveClass(/is-copy-dismiss/);
  await expect(page.locator('.is-copy-confirmed')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).dismissal.completions)).toEqual(['dismiss-1']);
  expect(await page.evaluate(() => (window as any).dismissal.copies)).toEqual(['dismiss-card']);
  expect(await page.evaluate(() => (window as any).dismissal.hides)).toBe(0);
  await expect(page.locator('.fan-stage')).toHaveClass(/is-copy-dismissed/);
});

test('failed and token-less copies never animate or issue a hide', async ({ page }) => {
  await installDismissalFixture(page); await page.goto('/'); await expect(cards(page)).toHaveCount(1);
  await page.evaluate(() => { (window as any).dismissal.fail = true; });
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(page.locator('#toast')).toContainText('Synthetic write failure');
  await expect(page.locator('.fan-stage')).not.toHaveClass(/is-copy-dismiss/);
  await expect(page.getByTestId('fan-card')).toBeVisible();
  await page.evaluate(() => { (window as any).dismissal.fail = false; (window as any).dismissal.tokenless = true; });
  await page.keyboard.press('Enter'); await page.waitForTimeout(600);
  await expect(page.locator('.fan-stage')).not.toHaveClass(/is-copy-dismiss/);
  expect(await page.evaluate(() => (window as any).dismissal.completions)).toEqual([]);
  await expect(page.getByTestId('copy-afterimage')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).dismissal.hides)).toBe(0);
});

test('Escape cancels copy animation immediately and reopening cancels its old timer', async ({ page }) => {
  await installDismissalFixture(page); await page.goto('/'); await expect(cards(page)).toHaveCount(1);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(page.locator('.fan-stage')).toHaveClass(/is-copy-dismiss/);
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => (window as any).dismissal.hides)).toBe(1);
  await page.evaluate(() => (window as any).dismissal.show());
  await page.waitForTimeout(600);
  await expect(page.locator('.fan-stage')).not.toHaveClass(/is-copy-dismiss/);
  expect(await page.evaluate(() => (window as any).dismissal.completions)).toEqual([]);
  await expect(page.getByTestId('copy-afterimage')).toHaveCount(0);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(page.locator('.fan-stage')).toHaveClass(/is-copy-dismiss/);
  await page.evaluate(() => (window as any).dismissal.show());
  await page.waitForTimeout(600);
  await expect(page.locator('.fan-stage')).not.toHaveClass(/is-copy-dismiss/);
  expect(await page.evaluate(() => (window as any).dismissal.completions)).toEqual([]);
  await expect(page.getByTestId('copy-afterimage')).toHaveCount(0);
});

test('late old write cannot animate a reopened window or unlock a newer copy', async ({ page }) => {
  await installDismissalFixture(page); await page.goto('/'); await expect(cards(page)).toHaveCount(1);
  await page.evaluate(() => { (window as any).dismissal.defer = true; });
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await page.evaluate(() => (window as any).dismissal.show());
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(page.locator('.fan-stage')).toHaveClass(/is-copy-dismiss/);
  await page.evaluate(() => (window as any).dismissal.resolve());
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).dismissal.completions)).toEqual(['dismiss-2']);
  expect(await page.evaluate(() => (window as any).dismissal.copies)).toEqual(['dismiss-card', 'dismiss-card']);
  expect(await page.evaluate(() => (window as any).dismissal.hides)).toBe(0);
});

test('reduced motion completes copy dismissal without moving or flashing the hand', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await installDismissalFixture(page); await page.goto('/'); await expect(cards(page)).toHaveCount(1);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).dismissal.completions)).toEqual(['dismiss-1']);
  expect(await page.evaluate(() => (window as any).dismissal.completeAt - (window as any).dismissal.successAt)).toBeLessThan(200);
  expect(await page.locator('.fan-viewport').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  expect(await page.getByTestId('fan-card').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  await expect(page.getByTestId('copy-afterimage')).toHaveCount(0);
});

test('record actual pointer copy, rightward dismissal, and preview reopening', async ({ browser }) => {
  fs.mkdirSync('artifacts', { recursive: true });
  const context = await browser.newContext({ viewport: { width: 780, height: 900 }, recordVideo: { dir: 'artifacts', size: { width: 780, height: 900 } } });
  const page = await context.newPage(); await page.goto('http://127.0.0.1:5173/'); await expect(cards(page)).toHaveCount(5);
  await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(1100);
  await page.evaluate(() => {
    const cursor = document.createElement('div'); cursor.setAttribute('aria-hidden', 'true'); cursor.style.cssText = 'position:fixed;left:0;top:0;width:14px;height:14px;border:2px solid #fff;background:#46e7ee99;border-radius:50%;z-index:9999;pointer-events:none;transform:translate(-50%,-50%);box-shadow:0 0 0 3px #10182088';
    document.body.append(cursor); document.addEventListener('pointermove', event => { cursor.style.left = `${event.clientX}px`; cursor.style.top = `${event.clientY}px`; }, true);
  });
  const points = await restingHandPoints(page);
  for (const point of points.slice(0, 3)) { await page.mouse.move(point.x, point.y, { steps: 12 }); await expect(page.locator('.card-slot.is-expanded')).toHaveAttribute('data-id', point.id); await page.waitForTimeout(350); }
  await page.mouse.click(points[2].x, points[2].y);
  await expect(page.locator('.fan-stage')).toHaveClass(/is-copy-dismiss/);
  await expect(page.locator('#preview-launcher')).toBeVisible(); await page.waitForTimeout(600);
  await page.locator('#preview-launcher').click(); await expect(cards(page)).toHaveCount(5); await expect(page.locator('.fan-stage')).not.toHaveClass(/is-copy-dismiss/);
  await page.waitForTimeout(1000);
  const reopenedPoints = await restingHandPoints(page);
  await page.mouse.move(reopenedPoints[0].x, reopenedPoints[0].y, { steps: 12 });
  await expect(page.locator('.card-slot.is-expanded')).toHaveAttribute('data-id', reopenedPoints[0].id);
  await page.waitForTimeout(400); await page.mouse.click(reopenedPoints[0].x, reopenedPoints[0].y);
  await expect(page.locator('#preview-launcher')).toBeVisible(); await page.waitForTimeout(700);
  const video = page.video(); await context.close(); await video?.saveAs('artifacts/pupa-copy-dismissal.webm');
});


for (const deviceScaleFactor of [1, 1.25, 2]) {
  test(`right-edge geometry follows actual webview dimensions at DPR ${deviceScaleFactor}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 780, height: 900 }, deviceScaleFactor, reducedMotion: 'reduce' });
    const page = await context.newPage(); await page.goto('http://127.0.0.1:5173/'); await expect(cards(page)).toHaveCount(5);
    for (const viewport of [{ width: 780, height: 900 }, { width: 1920, height: 1080 }, { width: 3440, height: 1440 }, { width: 390, height: 640 }]) {
      await page.setViewportSize(viewport);
      await expect.poll(() => page.getByTestId('fan-card').evaluateAll(elements => elements.every(el => Math.abs(el.getBoundingClientRect().right - innerWidth + (innerWidth <= 560 ? 12 : 18)) < .1))).toBeTruthy();
      const stage = await page.locator('.fan-stage').boundingBox();
      expect(stage).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
      expect(await page.evaluate(() => devicePixelRatio)).toBe(deviceScaleFactor);
    }
    // The renderer measures its actual drawable stage rather than accidentally
    // mixing screen.width (physical display) with webview CSS pixels.
    await page.locator('.fan-stage').evaluate(el => { (el as HTMLElement).style.width = '360px'; });
    await expect.poll(() => page.getByTestId('fan-card').evaluateAll(elements => elements.every(el => Math.abs(el.getBoundingClientRect().right - 348) < .1))).toBeTruthy();
    await context.close();
  });
}

test('successful copy traces an electric rim without leaking content into its afterimage', async ({ page }) => {
  await installDismissalFixture(page); await page.goto('/'); await expect(cards(page)).toHaveCount(1);
  await page.keyboard.press('ArrowDown');
  await page.evaluate(() => {
    const control = (window as any).dismissal; control.defer = true; control.pulseFrames = [];
    const start = performance.now();
    const sample = () => {
      const stage = document.querySelector('.fan-stage')!;
      const card = document.querySelector('.clip-card')!;
      const hand = document.querySelector('.fan-viewport')!;
      if (stage.classList.contains('is-copy-dismiss')) {
        const face = getComputedStyle(card), view = getComputedStyle(hand);
        const matrix = view.transform === 'none' ? null : new DOMMatrixReadOnly(view.transform);
        const ghost = document.querySelector<HTMLElement>('.copy-afterimage');
        const ghostRect = ghost?.getBoundingClientRect();
        control.pulseFrames.push({ color: face.backgroundColor, border: face.borderTopColor, shadow: face.boxShadow, opacity: Number(view.opacity), x: matrix?.m41 ?? 0, ghostOpacity: ghost ? Number(getComputedStyle(ghost).opacity) : 0, ghostText: ghost?.textContent ?? '', ghostChildren: ghost?.childElementCount ?? 0, ghostImages: ghost?.querySelectorAll('img, text, foreignObject, use').length ?? 0, chargeOffset: ghost ? getComputedStyle(ghost.querySelector('.copy-circuit-charge')!).strokeDashoffset : '', ghostX: ghostRect?.x, ghostY: ghostRect?.y });
      }
      if (performance.now() - start < 1200) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.keyboard.press('Enter');
  await expect(page.locator('.fan-stage')).not.toHaveClass(/is-copy-dismiss/);
  await page.evaluate(() => (window as any).dismissal.resolve());
  await expect.poll(() => page.evaluate(() => (window as any).dismissal.completions)).toEqual(['dismiss-1']);
  const frames = await page.evaluate(() => (window as any).dismissal.pulseFrames as Array<{ color: string; border: string; shadow: string; opacity: number; x: number; ghostOpacity: number; ghostText: string; ghostChildren: number; ghostImages: number; chargeOffset: string; ghostX?: number; ghostY?: number }>);
  const lit = frames.filter(frame => frame.shadow.includes('inset') && frame.border !== 'rgb(246, 255, 117)');
  expect(lit.length).toBeGreaterThanOrEqual(2);
  expect(lit.some(frame => frame.x < 1 && frame.opacity > .99 && frame.shadow.includes('rgb(82, 233, 244)'))).toBeTruthy();
  expect(frames.some(frame => frame.x > 20 && frame.opacity < .95)).toBeTruthy();
  expect(frames.some(frame => frame.opacity < .05 && frame.ghostOpacity > .03)).toBeTruthy();
  const ghostFrames = frames.filter(frame => frame.ghostOpacity > .01);
  expect(ghostFrames.length).toBeGreaterThanOrEqual(4);
  expect(ghostFrames.every(frame => frame.ghostText.trim() === '' && frame.ghostChildren === 1 && frame.ghostImages === 0)).toBeTruthy();
  expect(new Set(ghostFrames.map(frame => `${frame.ghostX},${frame.ghostY}`)).size).toBe(1);
  expect(new Set(ghostFrames.map(frame => frame.chargeOffset)).size).toBeGreaterThan(3);
  await expect(page.getByTestId('copy-afterimage')).toHaveCount(0);
  const timing = await page.evaluate(() => (window as any).dismissal.completeAt - (window as any).dismissal.successAt);
  expect(timing).toBeGreaterThanOrEqual(410); expect(timing).toBeLessThan(640);
});


test('dismissal failure removes the success afterimage and restores the usable hand', async ({ page }) => {
  await installDismissalFixture(page); await page.goto('/'); await expect(cards(page)).toHaveCount(1);
  await page.evaluate(() => { (window as any).dismissal.completeFail = true; });
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(page.locator('#toast')).toContainText('ウィンドウを閉じられませんでした');
  await expect(page.getByTestId('copy-afterimage')).toHaveCount(0);
  await expect(page.locator('.fan-stage')).not.toHaveClass(/is-copy-dismiss/);
  expect(await page.locator('.fan-viewport').evaluate(el => (el as HTMLElement).inert)).toBe(false);
});


for (const unavailable of [true, false]) {
  test(`shortcut settings distinguish platform unavailability from key collision: ${unavailable}`, async ({ page }) => {
    await page.addInitScript(unavailable => {
      const state = { entries: [], settings: { shortcut: 'CommandOrControl+Shift+Space', historyLimit: 60, persistence: false }, paused: false, status: { shortcutRegistered: false, ...(unavailable ? { shortcutAvailable: false } : {}), storageWarning: null, platform: 'linux', wayland: true, version: 'shortcut-test' } };
      (window as any).pupa = { getState: async () => state, onState: () => () => {}, onShown: () => () => {}, hide: () => {}, quit: () => {} };
    }, unavailable);
    await page.goto('/'); await expect(page.locator('#empty-settings')).toBeVisible(); await openSettings(page);
    if (unavailable) {
      await expect(page.locator('#settings-status')).toContainText('グローバルショートカットを利用できません');
      await expect(page.locator('#settings-status')).toContainText('トレイメニューまたはアプリのランチャー');
      await expect(page.locator('#settings-status')).not.toContainText('別のキー');
    } else {
      await expect(page.locator('#settings-status')).toContainText('別のキーをお試しください');
      await expect(page.locator('#settings-status')).not.toContainText('グローバルショートカットを利用できません');
    }
  });
}

const installPortalFixture = async (page: import('@playwright/test').Page, initialState = 'needs-approval') => {
  await page.addInitScript(initial => {
    const control: any = { calls: 0, copies: 0, hides: 0, patches: [], throwRequest: false, configureImmediately: false };
    const state: any = { revision: 1, entries: [{ id: 'portal-card', text: 'Wayland fixture', kind: 'text', color: 'mint', createdAt: Date.now(), pinned: false }], settings: { shortcut: 'CommandOrControl+Shift+Space', historyLimit: 60, persistence: false, hideAfterCopy: true, sourceApp: true, fanSpread: 72, fanDistance: 0 }, paused: false, status: { shortcutBackend: 'portal', shortcutState: initial, shortcutRegistered: initial === 'registered', shortcutAvailable: initial !== 'unavailable', shortcutTrigger: initial === 'registered' ? 'Ctrl+Alt+P' : null, shortcutWarning: null, storageWarning: null, platform: 'linux', wayland: true, version: 'portal-test' } };
    const listeners = new Set<(value: any) => void>();
    const emit = () => { state.revision++; for (const callback of listeners) callback(structuredClone(state)); };
    control.change = (value: string, trigger: string | null = null, warning: string | null = null) => { Object.assign(state.status, { shortcutState: value, shortcutRegistered: value === 'registered', shortcutAvailable: value !== 'unavailable', shortcutTrigger: trigger, shortcutWarning: warning }); emit(); };
    control.finish = (value: string, trigger: string | null = null, warning: string | null = null) => { control.change(value, trigger, warning); control.resolve?.({ ok: value === 'registered', ...(warning ? { error: warning } : {}) }); control.resolve = null; };
    (window as any).portal = control;
    (window as any).pupa = {
      getState: async () => structuredClone(state), onState: (callback: (value: any) => void) => { listeners.add(callback); return () => listeners.delete(callback); }, onShown: () => () => {}, hide: () => { control.hides++; }, quit: () => {},
      copyEntry: async () => { control.copies++; return { ok: true }; },
      requestSystemShortcut: async () => { control.calls++; if (control.throwRequest) throw new Error('Synthetic IPC failure'); if (control.configureImmediately && state.status.shortcutState === 'registered') return { ok: true }; control.change('requesting'); return new Promise(resolve => { control.resolve = resolve; }); },
      updateSettings: async (patch: any) => { control.patches.push(patch); Object.assign(state.settings, patch); emit(); return { ok: true }; },
    };
  }, initialState);
};

test('portal setup is explicit, stays settings-only, and reflects only the actual approved trigger', async ({ page }) => {
  await installPortalFixture(page); await page.goto('/'); await expect(cards(page)).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).portal.calls)).toBe(0);
  await page.keyboard.press('ArrowDown'); await page.getByTestId('settings-button').click();
  await expect(page.locator('#system-shortcut-controls')).toBeVisible();
  await expect(page.locator('#native-shortcut-controls')).toBeHidden();
  await expect(page.locator('#shortcut-input')).toBeDisabled();
  await expect(page.locator('#system-shortcut-current')).toBeHidden();
  await expect(page.locator('#source-app-platform-note')).toContainText('Pupa Source App拡張機能の有効化が必要');
  await expect(page.locator('.fan-stage')).not.toContainText('Waylandセッションでのコピー元');
  expect(await page.evaluate(() => (window as any).portal.calls)).toBe(0);
  await page.getByTestId('system-shortcut-button').click();
  await expect(page.getByTestId('system-shortcut-button')).toBeDisabled();
  await expect(page.locator('#system-shortcut-status')).toContainText('操作を待っています');
  await page.getByTestId('system-shortcut-button').evaluate(el => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(await page.evaluate(() => (window as any).portal.calls)).toBe(1);
  expect(await page.evaluate(() => (window as any).portal.patches)).toEqual([]);
  expect(await page.evaluate(() => (window as any).portal.copies)).toBe(0);
  expect(await page.evaluate(() => (window as any).portal.hides)).toBe(0);
  await page.evaluate(() => (window as any).portal.finish('registered', 'Super+Alt+P'));
  await expect(page.locator('#system-shortcut-trigger')).toHaveText('Super+Alt+P');
  await expect(page.getByTestId('system-shortcut-button')).toHaveText('システム設定で変更');
  await expect(page.getByTestId('system-shortcut-button')).toBeEnabled();
  await page.locator('#history-limit').selectOption('30'); await page.locator('#save-settings').click();
  const patch = await page.evaluate(() => (window as any).portal.patches[0]);
  expect(patch.historyLimit).toBe(30); expect(patch).not.toHaveProperty('shortcut');
  expect(await page.evaluate(() => (window as any).portal.calls)).toBe(1);
});

for (const terminal of [
  { state: 'cancelled', warning: '許可されなかったか、キャンセルされました' },
  { state: 'unavailable', warning: 'デスクトップが GlobalShortcuts に対応していません。' },
  { state: 'error', warning: 'ショートカットの要求がシステムに拒否されました。' },
]) {
  test(`portal ${terminal.state} is accurate and retry remains explicit`, async ({ page }) => {
    await installPortalFixture(page); await page.goto('/'); await openSettings(page);
    await page.getByTestId('system-shortcut-button').click();
    await page.evaluate(value => (window as any).portal.finish(value.state, null, value.warning), terminal);
    await expect(page.locator('#system-shortcut-status')).toHaveText(terminal.warning);
    await expect(page.locator('#settings-status')).not.toContainText('別のキー');
    await expect(page.locator('#system-shortcut-current')).toBeHidden();
    await expect(page.getByTestId('system-shortcut-button')).toBeEnabled();
    await page.keyboard.press('Escape'); await openSettings(page);
    expect(await page.evaluate(() => (window as any).portal.calls)).toBe(1);
    await page.getByTestId('system-shortcut-button').click();
    expect(await page.evaluate(() => (window as any).portal.calls)).toBe(2);
    await page.evaluate(() => (window as any).portal.finish('cancelled', null, '設定をキャンセルしました。'));
  });
}

test('portal pending request survives settings dismissal without a second request', async ({ page }) => {
  await installPortalFixture(page); await page.goto('/'); await openSettings(page);
  await page.getByTestId('system-shortcut-button').click(); await page.keyboard.press('Escape'); await openSettings(page);
  await expect(page.getByTestId('system-shortcut-button')).toBeDisabled();
  expect(await page.evaluate(() => (window as any).portal.calls)).toBe(1);
  await page.evaluate(() => (window as any).portal.finish('registered', 'Ctrl+Alt+P'));
  await expect(page.locator('#system-shortcut-trigger')).toHaveText('Ctrl+Alt+P');
  await expect(page.getByTestId('system-shortcut-button')).toBeEnabled();
});

test('portal configure, binding changes, and session closure never invent an active key', async ({ page }) => {
  await installPortalFixture(page, 'registered'); await page.goto('/'); await openSettings(page);
  await expect(page.locator('#system-shortcut-trigger')).toHaveText('Ctrl+Alt+P');
  await page.evaluate(() => { (window as any).portal.configureImmediately = true; });
  await page.getByTestId('system-shortcut-button').click();
  await expect(page.getByTestId('system-shortcut-button')).toBeEnabled();
  await expect(page.locator('#system-shortcut-trigger')).toHaveText('Ctrl+Alt+P');
  await page.evaluate(() => (window as any).portal.change('registered', 'Super+P'));
  await expect(page.locator('#system-shortcut-trigger')).toHaveText('Super+P');
  await page.evaluate(() => (window as any).portal.change('closed', null, 'システムとの接続が終了しました。'));
  await expect(page.locator('#system-shortcut-status')).toHaveText('システムとの接続が終了しました。');
  await expect(page.locator('#system-shortcut-current')).toBeHidden();
  await expect(page.locator('#system-shortcut-trigger')).toHaveText('');
  await expect(page.getByTestId('system-shortcut-button')).toHaveText('システムに再接続');
  expect(await page.evaluate(() => (window as any).portal.calls)).toBe(1);
});

test('portal transport failure permits an explicit retry and does not submit the settings form', async ({ page }) => {
  await installPortalFixture(page); await page.goto('/'); await openSettings(page);
  await page.evaluate(() => { (window as any).portal.throwRequest = true; });
  await page.getByTestId('system-shortcut-button').click();
  await expect(page.locator('#system-shortcut-error')).toContainText('システム設定を開けませんでした');
  await expect(page.getByTestId('system-shortcut-button')).toBeEnabled();
  expect(await page.evaluate(() => (window as any).portal.patches)).toEqual([]);
  await page.evaluate(() => { (window as any).portal.throwRequest = false; });
  await page.getByTestId('system-shortcut-button').click();
  await expect(page.locator('#system-shortcut-error')).toBeHidden();
  await page.evaluate(() => (window as any).portal.finish('registered', null));
  await expect(page.locator('#system-shortcut-trigger')).toHaveText('OSからキー表示は提供されていません');
  await expect(page.locator('#system-shortcut-trigger')).not.toContainText('CommandOrControl');
});

test('non-portal shortcut controls and source-app preferences remain unchanged', async ({ page }) => {
  await page.goto('/'); await openSettings(page);
  await expect(page.locator('#native-shortcut-controls')).toBeVisible();
  await expect(page.locator('#shortcut-input')).toBeEnabled();
  await expect(page.locator('#record-shortcut')).toBeEnabled();
  await expect(page.locator('#system-shortcut-controls')).toBeHidden();
  await expect(page.locator('#source-app-platform-note')).toBeHidden();
});
