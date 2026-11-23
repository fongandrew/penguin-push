import { describe, expect, it } from 'vitest';

import {
	edgeRadius,
	floeAt,
	jarAt,
	makeArena,
	MAPS,
	onIsland,
	rollPath,
	shrinkAt,
	startSpots,
	supportAt,
	waveAt,
} from '../public/src/arena.js';
import { SHRINK_END_MS, SHRINK_MIN, SHRINK_START_MS } from '../public/src/constants.js';

describe('arena', () => {
	it('is seed-derived: same seed, same island and jars', () => {
		for (const m of MAPS) {
			const a = makeArena(m.id, 1234);
			const b = makeArena(m.id, 1234);
			expect(edgeRadius(a, 1.1)).toBe(edgeRadius(b, 1.1));
			for (let i = 0; i < 10; i++) expect(jarAt(a, i)).toEqual(jarAt(b, i));
		}
	});

	it('puts every start spot and jar on the ice', () => {
		for (const m of MAPS) {
			for (let seed = 1; seed < 30; seed++) {
				const a = makeArena(m.id, seed);
				for (const s of startSpots(a, 4)) expect(supportAt(a, s.x, s.y, 0).ok).toBe(true);
				for (let i = 0; i < 6; i++) {
					const j = jarAt(a, i);
					expect(onIsland(a, j.x, j.y, j.spawn)).toBe(true);
					expect(j.expire).toBeGreaterThan(j.spawn);
				}
			}
		}
	});

	it('shrinks in sudden death', () => {
		expect(shrinkAt(0)).toBe(1);
		expect(shrinkAt(SHRINK_START_MS)).toBe(1);
		expect(shrinkAt((SHRINK_START_MS + SHRINK_END_MS) / 2)).toBeLessThan(1);
		expect(shrinkAt(SHRINK_END_MS * 2)).toBeCloseTo(SHRINK_MIN);
		const a = makeArena('hill', 7);
		expect(onIsland(a, 5, 0, 0)).toBe(true);
		expect(onIsland(a, 5, 0, SHRINK_END_MS)).toBe(false);
	});

	it('floats floes, then sinks them now and then', () => {
		const a = makeArena('floes', 9);
		const f = a.floes[0];
		if (!f) throw new Error('no floes');
		expect(floeAt(f, 0).sink).toBe(0);
		let sunk = false;
		for (let t = 0; t < 40000; t += 100) if (floeAt(f, t).sink >= 1) sunk = true;
		expect(sunk).toBe(true);
	});

	it('warns before each wave, then sweeps it across', () => {
		const a = makeArena('cove', 3);
		const w = a.waves;
		if (!w) throw new Error('no waves');
		expect(waveAt(a, 0)).toBeNull();
		expect(waveAt(a, w.first - 100)?.phase).toBe('warn');
		const go = waveAt(a, w.first + w.travel / 2);
		expect(go?.phase).toBe('go');
		expect(Math.abs(go?.front ?? 99)).toBeLessThan(1);
	});

	it('rolls a giant snowball down the hill and into the sea', () => {
		const a = makeArena('hill', 5);
		const home = a.balls[0];
		if (!home || !a.hill) throw new Error('no ball');
		// Kick it away from the hilltop, toward the nearest shore.
		const angle = Math.atan2(home.y - a.hill.y, home.x - a.hill.x);
		const roll = rollPath(a, 0, angle, 1000);
		expect(roll.end).toBe('splash');
		expect(rollPath(a, 0, angle, 1000)).toBe(roll);
	});
});
