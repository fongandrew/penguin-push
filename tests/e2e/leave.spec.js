import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 700 } });

test('leaving a match needs a confirmation, and solo play pauses meanwhile', async ({ page }) => {
	test.setTimeout(60000);
	await page.goto('/');
	await page.evaluate(() => {
		window.__game.startSolo({ map: 'grid', bots: 1 });
		window.__game.skipCountdown();
	});
	await expect(page.locator('#hud')).toBeVisible();

	// Pause: the dialog opens and match time stops.
	await page.click('#btn-quit');
	await expect(page.locator('#leave')).toBeVisible();
	const t0 = await page.evaluate(() => window.__game.state.t);
	await page.waitForTimeout(800);
	expect(await page.evaluate(() => window.__game.state.t)).toBe(t0);

	// Keep playing: back in the match, time moving again.
	await page.click('#btn-stay');
	await expect(page.locator('#leave')).toBeHidden();
	await page.waitForFunction((t) => window.__game.state.t > t + 300, t0);
	expect(await page.evaluate(() => window.__game.screen())).toBe('game');

	// Esc opens it too; leaving takes the second, deliberate tap.
	await page.keyboard.press('Escape');
	await expect(page.locator('#leave')).toBeVisible();
	await page.click('#btn-leave');
	await expect(page.locator('#solo')).toBeVisible();
});
