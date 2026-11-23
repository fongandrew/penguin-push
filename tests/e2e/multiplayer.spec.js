import { expect, test } from '@playwright/test';

/**
 * Two real browsers, one room on the Node relay (`npm run dev:relay`).
 *
 * @param {import('@playwright/test').Browser} browser
 * @param {string} name
 */
async function player(browser, name) {
	const ctx = await browser.newContext({ viewport: { width: 390, height: 700 } });
	await ctx.addInitScript((n) => localStorage.setItem('penguin-push:name', n), name);
	const page = await ctx.newPage();
	// This spec only reads game state: skip the 3D drawing so two browsers
	// running at once don't starve each other (or the relay sockets) of CPU.
	await page.goto('/?render=0');
	return page;
}

test('two friends play a match and share a leaderboard', async ({ browser }) => {
	test.setTimeout(90000);
	const a = await player(browser, 'Ana');
	const b = await player(browser, 'Ben');

	await a.evaluate(() => window.__game.createRoom());
	await a.waitForFunction(() => (window.__game.online()?.session.net.slot ?? -1) >= 0);
	const code = await a.evaluate(() => window.__game.online().code);
	expect(code).toMatch(/^[A-Z0-9]{4}$/);

	await b.evaluate((c) => window.__game.joinRoom(c), code);
	await b.waitForFunction(() => window.__game.online()?.session.players.size === 2);
	await expect(b.locator('#lobby-wait')).toContainText('Waiting for Ana');

	// Two people: room for at most two computer penguins, and none is allowed.
	await expect(a.locator('#lobby-bots [data-bots]')).toHaveCount(3);
	await expect(a.locator('#lobby-bots [data-bots="3"]')).toHaveCount(0);
	await expect(a.locator('#lobby-bots [data-bots="0"]')).toHaveCount(1);

	// The host's settings show up for the guest.
	await a.click('[data-bots="1"]');
	await b.waitForFunction(() => window.__game.online().session.settings.bots === 1);

	await a.click('#btn-lobby-start');
	// Both screens must have the match before we compare rosters.
	await a.waitForFunction(() => window.__game.screen() === 'game');
	await b.waitForFunction(() => window.__game.screen() === 'game');
	const rosterA = await a.evaluate(() => JSON.stringify(window.__game.state.roster));
	const rosterB = await b.evaluate(() => JSON.stringify(window.__game.state.roster));
	expect(rosterA).toBe(rosterB);
	expect(JSON.parse(rosterA)).toHaveLength(3);

	// Ben moves; Ana sees it.
	await b.waitForFunction(() => window.__game.state.mode === 'play', null, { timeout: 15000 });
	await b.evaluate(() => {
		const g = window.__game;
		g.state.penguins[1].invulnMs = 1e9;
		g.teleport(1, 0, 0);
	});
	await a.waitForFunction(
		() => {
			const p = window.__game.state.penguins[1];
			return p.remote && Math.hypot(p.x, p.y) < 1.5;
		},
		null,
		{ timeout: 10000 },
	);

	// The bot (host-owned) and Ben both splash out: Ana wins on both screens.
	await a.evaluate(() => {
		const g = window.__game;
		g.state.penguins[0].invulnMs = 1e9;
		const bot = g.state.penguins[2];
		bot.lives = 1;
		g.teleport(2, 40, 0);
	});
	await b.evaluate(() => {
		const g = window.__game;
		const me = g.state.penguins[1];
		me.invulnMs = 0;
		me.lives = 1;
		g.teleport(1, 40, 0);
	});
	await a.waitForFunction(() => window.__game.state.mode === 'done', null, { timeout: 20000 });
	await b.waitForFunction(() => window.__game.state.mode === 'done', null, { timeout: 20000 });
	const ra = await a.evaluate(() => window.__game.state.result);
	const rb = await b.evaluate(() => window.__game.state.result);
	expect(ra).toEqual(rb);
	expect(ra.winner).toBe(0);
	await expect(b.locator('#results')).toBeVisible({ timeout: 20000 });
	await expect(b.locator('#results-title')).toContainText('Ana wins');
});
