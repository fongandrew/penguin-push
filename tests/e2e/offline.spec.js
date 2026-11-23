import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 700 } });

test('works offline once loaded (service worker), room links included', async ({
	page,
	context,
}) => {
	test.setTimeout(60000);
	// The worker is off on localhost unless ?sw=1.
	await page.goto('/?sw=1');
	await page.evaluate(() => navigator.serviceWorker.ready);
	// One controlled load, so every module passes through the worker's cache.
	await page.reload();
	await page.waitForFunction(() => !!navigator.serviceWorker.controller && !!window.__game);

	await context.setOffline(true);
	for (const url of ['/?sw=1', '/?room=ABCD&sw=1']) {
		await page.goto(url);
		await page.waitForFunction(() => !!window.__game);
		await page.evaluate(() => window.__game.startSolo({ map: 'grid', bots: 1 }));
		await expect(page.locator('#hud')).toBeVisible();
	}
	await context.setOffline(false);
});
