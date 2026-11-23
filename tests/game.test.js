import { describe, expect, it } from 'vitest';

import { CELL, downhillDirs, rollPath, tileCenter } from '../public/src/arena.js';
import { FALL_MS, RESPAWN_MS, START_LIVES, STEP } from '../public/src/constants.js';
import { addThrow, onOut, tick } from '../public/src/game.js';
import { knock, movePenguin } from '../public/src/physics.js';
import { SoloLink } from '../public/src/solo.js';
import { IDLE, soloMatch } from './helpers.js';

/**
 * Run `ms` of match time.
 *
 * @param {import('../public/src/state.js').State} s
 * @param {import('../public/src/game.js').Link} link
 * @param {number} ms
 * @param {import('../public/src/state.js').Input} [input]
 */
function run(s, link, ms, input = IDLE) {
	const end = s.t + ms;
	while (s.t < end) tick(s, link, s.t + STEP * 1000, STEP, input);
}

/** A link where only penguin 0 is simulated (the rest stand still). */
function onlyMe(/** @type {import('../public/src/state.js').State} */ s) {
	const solo = new SoloLink(s);
	return {
		owns: (/** @type {number} */ pid) => pid === 0,
		send: solo.send.bind(solo),
		claim: solo.claim.bind(solo),
	};
}

describe('match rules', () => {
	/**
	 * Shove penguin 1 from 1 unit away, with us moving at `speed` toward it.
	 * Returns how far it slides.
	 *
	 * @param {number} speed
	 */
	function shoveTravel(speed) {
		const s = soloMatch('grid', 1, 0);
		const arena = s.arena;
		if (!arena) throw new Error('arena');
		// An all-ice board, so nobody falls in mid-measurement.
		arena.level.fill(0);
		arena.block.fill(0);
		arena.blocks.length = 0;
		arena.crack.fill(Infinity);
		const [me, them] = s.penguins;
		if (!me || !them) throw new Error('roster');
		for (const p of s.penguins.slice(2)) p.x = -9;
		me.x = -1;
		me.y = 0;
		me.face = 0;
		me.vx = speed;
		them.x = 0;
		them.y = 0;
		them.invulnMs = 0;
		// Stunned, so it can't steer while we measure its slide.
		them.stunMs = 1e9;
		// Own both so the shove lands directly, then let it slide unsteered.
		const both = {
			owns: (/** @type {number} */ pid) => pid < 2,
			send: () => {},
			claim: () => {},
		};
		const x0 = them.x;
		tick(s, both, s.t + 16, STEP, { ...IDLE, shove: true });
		for (let i = 0; i < 180; i++) movePenguin(them, IDLE, arena, s.t, STEP, [], []);
		return them.x - x0;
	}

	it('a standing shove is a nudge; a running shove sends them flying', () => {
		const standing = shoveTravel(0);
		const running = shoveTravel(4.4);
		expect(standing).toBeGreaterThan(0.6);
		expect(standing).toBeLessThan(CELL * 1.2);
		expect(running).toBeGreaterThan(standing * 2.2);
	});

	it('loses a life in the water and drops back in', () => {
		const s = soloMatch('hill', 1, 0);
		const link = onlyMe(s);
		const me = s.penguins[0];
		if (!me) throw new Error('roster');
		me.x = 30;
		run(s, link, 50);
		expect(me.mode).toBe('fall');
		expect(me.lives).toBe(START_LIVES - 1);
		run(s, link, FALL_MS + RESPAWN_MS + 100);
		expect(me.mode).toBe('play');
		expect(Math.hypot(me.x, me.y)).toBeLessThan(6);
	});

	it('is out after the last life, and the last penguin standing wins', () => {
		const s = soloMatch('hill', 1, 0);
		onOut(s, 3);
		onOut(s, 1);
		expect(s.mode).toBe('play');
		onOut(s, 2);
		expect(s.mode).toBe('done');
		expect(s.result).toEqual({ winner: 0, order: [0, 2, 1, 3] });
		expect(s.tally.get(s.roster[0]?.key ?? '')?.wins).toBe(1);
		expect(s.tally.get(s.roster[1]?.key ?? '')?.played).toBe(1);
	});

	it('stuns a penguin hit by a snowball', () => {
		const s = soloMatch('cove', 1, 0);
		const link = onlyMe(s);
		const me = s.penguins[0];
		if (!me) throw new Error('roster');
		me.x = 2;
		me.y = 2;
		addThrow(s, { type: 'throw', id: 99, by: 1, x: 0, y: 2, angle: 0, t: Math.round(s.t) });
		run(s, link, 300);
		expect(me.stunMs).toBeGreaterThan(0);
	});

	it('bowls you over with a rolling giant snowball', () => {
		const s = soloMatch('hill', 3, 0);
		const link = new SoloLink(s);
		const arena = s.arena;
		const me = s.penguins[0];
		const home = arena?.balls[0];
		if (!arena || !me || !home) throw new Error('setup');
		const down = downhillDirs(arena, 0)[0];
		if (!down) throw new Error('slope');
		const angle = Math.atan2(down.y, down.x);
		link.claim({ type: 'kick', ball: 0, angle, by: 1, t: 0 });
		// Stand on its path, half a second down the lane.
		const roll = rollPath(arena, 0, angle, 0);
		me.x = roll.pts[60] ?? 0;
		me.y = roll.pts[61] ?? 0;
		const own = {
			owns: (/** @type {number} */ pid) => pid === 0,
			send: () => {},
			claim: () => {},
		};
		const x0 = me.x;
		const y0 = me.y;
		run(s, own, 900);
		expect([...me.hitBy].some((k) => k.startsWith('ball:0'))).toBe(true);
		expect(Math.hypot(me.x - x0, me.y - y0)).toBeGreaterThan(1.5);
	});

	it('a giant snowball ploughs you all the way into the sea, from anywhere in its lane', () => {
		for (const along of [1.5, 4, 6.5]) {
			for (const side of [0, 0.6]) {
				const s = soloMatch('hill', 5, 0);
				const arena = s.arena;
				const me = s.penguins[0];
				const home = arena?.balls[0];
				if (!arena || !me || !home) throw new Error('setup');
				for (const p of s.penguins.slice(1)) {
					p.x = 30;
					p.mode = 'out';
				}
				me.x = home.x + side;
				me.y = home.y + along;
				me.invulnMs = 0;
				new SoloLink(s).claim({ type: 'kick', ball: 0, angle: Math.PI / 2, by: 1, t: 0 });
				const own = {
					owns: (/** @type {number} */ pid) => pid === 0,
					send: () => {},
					claim: () => {},
				};
				let fell = false;
				for (let i = 0; i < 300 && !fell; i++) {
					tick(s, own, s.t + STEP * 1000, STEP, IDLE);
					fell = me.mode !== 'play';
				}
				expect(fell).toBe(true);
			}
		}
	});

	it('plays out a whole computer-only match on every map', () => {
		for (const map of ['hill', 'floes', 'cove', 'grid']) {
			const s = soloMatch(map, 77);
			const link = new SoloLink(s);
			let guard = 0;
			while (s.mode !== 'done' && guard++ < 200 * 60)
				tick(s, link, s.t + STEP * 1000, STEP, IDLE);
			expect(s.mode).toBe('done');
			expect(s.result?.order).toHaveLength(4);
		}
	});
});

describe('blocks and water squares', () => {
	it('stops you walking through an ice block', () => {
		const s = soloMatch('grid', 5, 0);
		const link = onlyMe(s);
		const me = s.penguins[0];
		const b = s.arena?.blocks[0];
		if (!me || !b) throw new Error('setup');
		me.x = b.x - 1.0;
		me.y = b.y;
		me.invulnMs = 1e9;
		run(s, link, 1200, { ...IDLE, mx: 1 });
		expect(me.x).toBeLessThan(b.x - 0.5);
	});

	it('drops you in a water square', () => {
		const s = soloMatch('grid', 5, 0);
		const link = onlyMe(s);
		const me = s.penguins[0];
		const arena = s.arena;
		if (!me || !arena) throw new Error('setup');
		const k = arena.level.findIndex((l, k) => l < 0 && k > arena.n * 3);
		const c = tileCenter(arena, k);
		me.x = c.x;
		me.y = c.y;
		run(s, link, 50);
		expect(me.mode).toBe('fall');
	});
});

describe('controls', () => {
	/** A lone penguin on the middle of the cove map. */
	function lone() {
		const s = soloMatch('cove', 9, 0);
		const link = onlyMe(s);
		const me = s.penguins[0];
		const arena = s.arena;
		if (!me || !arena) throw new Error('setup');
		for (const p of s.penguins.slice(1)) p.x = 99;
		// A clear row: put us on a free tile centre with free tiles to the east.
		const k = arena.level.findIndex((l, k) => {
			if (l !== 0 || arena.block[k]) return false;
			for (let d = 1; d <= 3; d++)
				if (arena.level[k + d] !== 0 || arena.block[k + d]) return false;
			const c = tileCenter(arena, k);
			return !arena.obstacles.some((o) => Math.hypot(c.x - o.x, c.y - o.y) < 3);
		});
		const c = tileCenter(arena, k);
		me.x = c.x;
		me.y = c.y;
		me.invulnMs = 1e9;
		return { s, link, me, k };
	}

	it('stops quickly when you let go (grippy, not a skating rink)', () => {
		const { s, link, me } = lone();
		run(s, link, 600, { ...IDLE, mx: 1 });
		expect(me.vx).toBeGreaterThan(3.5);
		const x0 = me.x;
		run(s, link, 600);
		expect(Math.hypot(me.vx, me.vy)).toBeLessThan(0.2);
		expect(me.x - x0).toBeLessThan(0.7);
	});

	it('snaps a nearly-straight stick to the grid and centres you in your row', () => {
		const { s, link, me } = lone();
		const y0 = me.y;
		me.y += 0.3;
		run(s, link, 500, { ...IDLE, mx: 1, my: 0.15 });
		expect(Math.abs(me.y - y0)).toBeLessThan(0.12);
	});

	it('still sends you sliding when you get shoved', () => {
		const { s, link, me } = lone();
		const x0 = me.x;
		me.invulnMs = 0;
		knock(me, 9.5, 0, 0);
		run(s, link, 1200);
		expect(me.x - x0).toBeGreaterThan(2.5);
	});
});

describe('computer penguins', () => {
	it('keep moving on every map instead of standing around', () => {
		for (const map of ['hill', 'floes', 'grid']) {
			const s = soloMatch(map, 21);
			const link = new SoloLink(s);
			let still = 0;
			let total = 0;
			for (let f = 0; f < 60 * 25 && s.mode !== 'done'; f++) {
				tick(s, link, s.t + STEP * 1000, STEP, IDLE);
				for (const p of s.penguins) {
					if (p.mode !== 'play' || p.stunMs > 0) continue;
					total++;
					if (p.speed < 0.3) still++;
				}
			}
			expect(still / total).toBeLessThan(0.12);
		}
	});
});

describe('teetering at the edge', () => {
	/** Our penguin on a tile with water immediately to its east. */
	function atEdge() {
		const s = soloMatch('grid', 5, 0);
		const link = onlyMe(s);
		const me = s.penguins[0];
		const arena = s.arena;
		if (!me || !arena) throw new Error('setup');
		for (const p of s.penguins.slice(1)) p.x = 99;
		const k = arena.level.findIndex(
			(l, k) =>
				l === 0 &&
				!arena.block[k] &&
				!arena.block[k - 1] &&
				(arena.level[k - 1] ?? -1) === 0 &&
				(arena.level[k + 1] ?? 0) < 0 &&
				k % arena.n < arena.n - 1,
		);
		const c = tileCenter(arena, k);
		me.x = c.x - 0.3;
		me.y = c.y;
		me.invulnMs = 0;
		return { s, link, me };
	}

	it('catches you at the brink when you walk off by accident', () => {
		const { s, link, me } = atEdge();
		run(s, link, 250, { ...IDLE, mx: 1 });
		expect(me.mode).toBe('play');
		expect(me.teeterMs).toBeGreaterThan(0);
		// Let go (or turn back) and you're safe.
		run(s, link, 800);
		expect(me.mode).toBe('play');
		expect(me.teeterMs).toBe(0);
	});

	it('still lets you fall in if you keep walking into the water', () => {
		const { s, link, me } = atEdge();
		run(s, link, 900, { ...IDLE, mx: 1 });
		expect(me.mode).toBe('fall');
	});

	it('gives no second chance when you are shoved', () => {
		const { s, link, me } = atEdge();
		knock(me, 8, 0, 0);
		run(s, link, 200);
		expect(me.mode).toBe('fall');
	});
});
