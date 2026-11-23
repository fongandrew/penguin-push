import { describe, expect, it } from 'vitest';

import { downhillAt, rollPath } from '../public/src/arena.js';
import { FALL_MS, RESPAWN_MS, START_LIVES, STEP } from '../public/src/constants.js';
import { addThrow, onOut, tick } from '../public/src/game.js';
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
	it('flipper-shoves the penguin in front of you', () => {
		const s = soloMatch('cove', 1, 0);
		const solo = new SoloLink(s);
		const [me, them] = s.penguins;
		if (!me || !them) throw new Error('roster');
		me.x = 0;
		me.y = 0;
		me.face = 0;
		them.x = 1.0;
		them.y = 0;
		// Everyone else far away.
		for (const p of s.penguins.slice(2)) p.x = -5;
		tick(s, solo, 16, STEP, { ...IDLE, shove: true });
		expect(them.vx).toBeGreaterThan(5);
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
		if (!arena || !me || !home || !arena.hill) throw new Error('setup');
		const down = downhillAt(arena, home.x, home.y);
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

	it('plays out a whole computer-only match on every map', () => {
		for (const map of ['hill', 'floes', 'cove', 'maze']) {
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

describe('walls and holes', () => {
	it('stops you walking through a snow wall', () => {
		const s = soloMatch('maze', 5, 0);
		const link = onlyMe(s);
		const me = s.penguins[0];
		const w = s.arena?.walls.find((x) => x.ax === x.bx);
		if (!me || !w) throw new Error('setup');
		// Stand left of a vertical wall and walk right into it.
		me.x = w.ax - 0.9;
		me.y = (w.ay + w.by) / 2;
		me.invulnMs = 1e9;
		run(s, link, 1500, { ...IDLE, mx: 1 });
		expect(me.x).toBeLessThan(w.ax);
	});

	it('drops you in a hole', () => {
		const s = soloMatch('maze', 5, 0);
		const link = onlyMe(s);
		const me = s.penguins[0];
		const h = s.arena?.holes[0];
		if (!me || !h) throw new Error('setup');
		me.x = h.ax;
		me.y = h.ay;
		run(s, link, 50);
		expect(me.mode).toBe('fall');
	});
});
