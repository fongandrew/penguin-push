import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 700 } });

test('title → changing station → solo match → leaderboard', async ({ page }) => {
	// Software-rendered WebGL in CI is slow; this walks a whole match.
	test.setTimeout(90000);
	/** @type {string[]} */
	const errors = [];
	page.on('pageerror', (e) => errors.push(e.message));
	await page.goto('/');
	await page.click('#btn-play');
	await expect(page.locator('#station')).toBeVisible();

	// A brand-new player starts with a random name and outfit, already saved.
	const start = await page.evaluate(() => ({
		look: window.__game.state.look,
		name: window.__game.state.name,
		saved: localStorage.getItem('penguin-push:look'),
	}));
	expect(start.saved).toBe(JSON.stringify(start.look));
	expect(start.name).not.toBe('Penguin');

	// Dress up: the look is saved and shows in the match.
	await page.click('[data-tab="hat"]');
	await page.click('[aria-label="Next Hat"]');
	await page.click('[data-tab="species"]');
	await page.click('[aria-label="Next Penguin"]');
	const look = await page.evaluate(() => window.__game.state.look);
	expect(look.hat).toBe((start.look.hat + 1) % 9);
	expect(look.species).toBe((start.look.species + 1) % 7);

	await page.click('text=Play vs Computer');
	await page.click('[data-map="hill"]');
	await page.click('[data-bots="3"]');
	await page.click('#btn-solo-start');
	await expect(page.locator('#hud')).toBeVisible();
	await page.waitForFunction(() => window.__game.state.mode === 'play', null, { timeout: 15000 });
	const s = await page.evaluate(() => ({
		n: window.__game.state.penguins.length,
		map: window.__game.state.mapId,
		myLook: window.__game.state.penguins[0].look,
	}));
	expect(s.n).toBe(4);
	expect(s.map).toBe('hill');
	expect(s.myLook).toEqual(look);

	// Walk: the keyboard moves our penguin.
	const x0 = await page.evaluate(() => window.__game.state.penguins[0].x);
	await page.keyboard.down('KeyA');
	await page.waitForTimeout(600);
	await page.keyboard.up('KeyA');
	const x1 = await page.evaluate(() => window.__game.state.penguins[0].x);
	expect(x1).toBeLessThan(x0);

	// A snowball power: the E key throws one.
	await page.evaluate(() => {
		const me = window.__game.state.penguins[0];
		me.power = 'snowball';
		me.uses = 3;
	});
	await expect(page.locator('#btn-power')).toBeVisible();
	await page.keyboard.press('KeyE');
	await page.waitForFunction(() => window.__game.state.penguins[0].uses === 2);

	// Send every computer penguin swimming for good.
	await page.evaluate(() => {
		const g = window.__game;
		g.state.penguins[0].invulnMs = 1e9;
		for (const p of g.state.penguins.slice(1)) {
			p.lives = 1;
			g.teleport(p.id, 40, 0);
		}
	});
	// Game time is capped per frame, so on a slow software renderer the fall
	// and the winner's dance can take a while in real time.
	await expect(page.locator('#results')).toBeVisible({ timeout: 60000 });
	await expect(page.locator('#results-title')).toContainText('You win');
	await expect(page.locator('#board tbody tr')).toHaveCount(4);

	// Wins add up across rounds.
	await page.click('#btn-again');
	await page.waitForFunction(() => window.__game.state.matchNo === 2);
	const wins = await page.evaluate(() => window.__game.state.tally.get('you').wins);
	expect(wins).toBe(1);
	expect(errors).toEqual([]);
});
