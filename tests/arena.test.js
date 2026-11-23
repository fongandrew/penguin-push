import { describe, expect, it } from 'vitest';

import {
	capDist,
	downhillAt,
	edgeRadius,
	floeAt,
	heightAt,
	inHole,
	jarAt,
	kickAllowed,
	makeArena,
	MAPS,
	onIsland,
	rollPath,
	shelteredFrom,
	shrinkAt,
	startSpots,
	supportAt,
	wallsAt,
	waveAt,
} from '../public/src/arena.js';
import {
	SHRINK_END_MS,
	SHRINK_MIN,
	SHRINK_START_MS,
	WALLS_CRUMBLE_MS,
} from '../public/src/constants.js';

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

	it('rolls a giant snowball down its lane into a hole or the sea', () => {
		for (let seed = 1; seed < 12; seed++) {
			const a = makeArena('hill', seed);
			a.balls.forEach((home, i) => {
				const down = downhillAt(a, home.x, home.y);
				if (!down) throw new Error('ball should sit on a slope');
				const angle = Math.atan2(down.y, down.x);
				expect(kickAllowed(a, i, angle)).toBe(true);
				expect(kickAllowed(a, i, angle + Math.PI)).toBe(false);
				const roll = rollPath(a, i, angle, 1000);
				// It ends further downhill than it started, and never inside a wall.
				const n = roll.pts.length;
				expect(heightAt(a, roll.pts[n - 2] ?? 0, roll.pts[n - 1] ?? 0)).toBeLessThan(
					heightAt(a, home.x, home.y),
				);
				for (let k = 0; k < n; k += 2) {
					for (const w of a.walls)
						expect(
							capDist(w, roll.pts[k] ?? 0, roll.pts[k + 1] ?? 0).d,
						).toBeGreaterThan(-0.05);
				}
				expect(rollPath(a, i, angle, 1000)).toBe(roll);
			});
		}
	});

	it('makes holes water and walls solid', () => {
		const a = makeArena('cove', 4);
		const h = a.holes[0];
		if (!h) throw new Error('no holes');
		expect(supportAt(a, h.ax, h.ay, 0).ok).toBe(false);
		expect(inHole(a, h.ax, h.ay)).toBe(true);
		expect(a.walls.length).toBeGreaterThan(0);
	});

	it('builds the same maze from the same seed, with loops and holes', () => {
		const a = makeArena('maze', 99);
		const b = makeArena('maze', 99);
		expect(a.walls).toEqual(b.walls);
		expect(a.holes).toEqual(b.holes);
		expect(a.walls.length).toBeGreaterThan(8);
		expect(a.holes.length).toBeGreaterThanOrEqual(4);
		expect(makeArena('maze', 100).walls).not.toEqual(a.walls);
	});

	it('lets you hide from a wave behind a snow wall, until the walls crumble', () => {
		const a = makeArena('cove', 4);
		const w = a.walls[0];
		if (!w) throw new Error('no walls');
		// Wave travelling along the wall's normal; stand just downwave of it.
		const mx = (w.ax + w.bx) / 2;
		const my = (w.ay + w.by) / 2;
		const nx = -(w.by - w.ay);
		const ny = w.bx - w.ax;
		const l = Math.hypot(nx, ny);
		const dir = Math.atan2(ny / l, nx / l);
		const px = mx + (nx / l) * 0.9;
		const py = my + (ny / l) * 0.9;
		expect(shelteredFrom(a, dir, px, py, 1000)).toBe(true);
		expect(wallsAt(a, WALLS_CRUMBLE_MS + 1)).toEqual([]);
		expect(shelteredFrom(a, dir, px, py, WALLS_CRUMBLE_MS + 1)).toBe(false);
	});
});
