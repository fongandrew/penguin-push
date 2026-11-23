import { describe, expect, it } from 'vitest';

import {
	blocksAt,
	CELL,
	downhillDirs,
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
	tileAt,
	tileCenter,
	tileSunk,
	waveAt,
} from '../public/src/arena.js';
import { SHRINK_END_MS, SHRINK_START_MS, WALLS_CRUMBLE_MS } from '../public/src/constants.js';

describe('the ice board', () => {
	it('is seed-derived: same seed, same board and jars', () => {
		for (const m of MAPS) {
			const a = makeArena(m.id, 1234);
			const b = makeArena(m.id, 1234);
			expect(a.level).toEqual(b.level);
			expect(a.block).toEqual(b.block);
			expect(a.crack).toEqual(b.crack);
			for (let i = 0; i < 10; i++) expect(jarAt(a, i)).toEqual(jarAt(b, i));
		}
	});

	it('maps points to tiles and back', () => {
		const a = makeArena('grid', 1);
		for (let k = 0; k < a.level.length; k += 7) {
			const c = tileCenter(a, k);
			expect(tileAt(a, c.x, c.y)).toBe(k);
			expect(tileAt(a, c.x + CELL * 0.45, c.y - CELL * 0.45)).toBe(k);
		}
	});

	it('has water squares in a regular pattern on the Ice Grid', () => {
		const a = makeArena('grid', 5);
		let water = 0;
		let checked = 0;
		for (let j = 1; j < a.n - 1; j += 2) {
			for (let i = 1; i < a.n - 1; i += 2) {
				const c = tileCenter(a, j * a.n + i);
				if (Math.hypot(c.x, c.y) > a.R * 0.8 || Math.hypot(c.x, c.y) < CELL * 1.5) continue;
				checked++;
				if ((a.level[j * a.n + i] ?? 0) < 0) water++;
			}
		}
		expect(water / checked).toBeGreaterThan(0.6);
		expect(a.blocks.length).toBeGreaterThan(5);
	});

	it('puts every start spot and jar on free ice', () => {
		for (const m of MAPS) {
			for (let seed = 1; seed < 20; seed++) {
				const a = makeArena(m.id, seed);
				for (const s of startSpots(a, 4)) {
					expect(supportAt(a, s.x, s.y, 0).ok).toBe(true);
					expect(a.block[tileAt(a, s.x, s.y)]).toBe(0);
				}
				for (let i = 0; i < 6; i++) {
					const j = jarAt(a, i);
					expect(onIsland(a, j.x, j.y, j.spawn)).toBe(true);
				}
			}
		}
	});

	it('sinks tiles outside-in in sudden death, leaving a connected patch', () => {
		for (const m of MAPS) {
			const a = makeArena(m.id, 3);
			const left = [];
			for (let k = 0; k < a.level.length; k++) {
				if ((a.level[k] ?? -1) < 0) continue;
				expect(tileSunk(a, k, SHRINK_START_MS - 1)).toBe(false);
				if (!tileSunk(a, k, SHRINK_END_MS + 1)) left.push(k);
			}
			expect(left.length).toBeGreaterThan(2);
			expect(left.length).toBeLessThan(10);
			// Connected: flood fill from one reaches them all.
			const seen = new Set([left[0]]);
			const queue = [left[0]];
			while (queue.length) {
				const k = /** @type {number} */ (queue.shift());
				for (const nk of [k - 1, k + 1, k - a.n, k + a.n]) {
					if (left.includes(nk) && !seen.has(nk)) {
						seen.add(nk);
						queue.push(nk);
					}
				}
			}
			expect(seen.size).toBe(left.length);
		}
		expect(shrinkAt(0)).toBe(1);
		expect(shrinkAt(SHRINK_END_MS)).toBeLessThan(0.5);
	});

	it('warns before each wave, then sweeps it across', () => {
		const a = makeArena('cove', 3);
		const w = a.waves;
		if (!w) throw new Error('no waves');
		expect(waveAt(a, 0)).toBeNull();
		expect(waveAt(a, w.first - 100)?.phase).toBe('warn');
		expect(waveAt(a, w.first + w.travel / 2)?.phase).toBe('go');
	});

	it('lets you hide from a wave behind an ice block, until they crumble', () => {
		const a = makeArena('cove', 4);
		const b = a.blocks[0];
		if (!b) throw new Error('no blocks');
		const dir = 0; // wave travelling +x; stand just east of the block
		expect(shelteredFrom(a, dir, b.x + CELL, b.y, 1000)).toBe(true);
		expect(blocksAt(a, WALLS_CRUMBLE_MS + 1)).toEqual([]);
		expect(shelteredFrom(a, dir, b.x + CELL, b.y, WALLS_CRUMBLE_MS + 1)).toBe(false);
	});
});

describe('giant snowballs on the stepped hill', () => {
	it('can only be pushed downhill, and roll along a row or column', () => {
		for (let seed = 1; seed < 10; seed++) {
			const a = makeArena('hill', seed);
			expect(a.balls.length).toBe(2);
			a.balls.forEach((home, i) => {
				const dirs = downhillDirs(a, i);
				expect(dirs.length).toBeGreaterThan(0);
				for (const d of dirs) {
					const angle = Math.atan2(d.y, d.x);
					expect(kickAllowed(a, i, angle)).toBe(true);
					expect(kickAllowed(a, i, angle + Math.PI)).toBe(false);
					const roll = rollPath(a, i, angle + 0.2, 1000);
					// Straight along the axis.
					for (let k = 0; k < roll.pts.length; k += 2) {
						const off = d.x
							? (roll.pts[k + 1] ?? 0) - home.y
							: (roll.pts[k] ?? 0) - home.x;
						expect(Math.abs(off)).toBeLessThan(1e-6);
					}
					// It gets well away from the top.
					const n = roll.pts.length;
					const dist = Math.hypot(
						(roll.pts[n - 2] ?? 0) - home.x,
						(roll.pts[n - 1] ?? 0) - home.y,
					);
					// Down the wide, clear lane all the way to the sea.
					expect(d.y).toBe(1);
					expect(roll.end).toBe('splash');
					expect(dist).toBeGreaterThan(CELL * 6);
					expect(rollPath(a, i, angle + 0.2, 1000)).toBe(roll);
				}
			});
		}
	});
});
