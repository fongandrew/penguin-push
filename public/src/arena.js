/**
 * The maps. Everything here is **seed-derived**: built from the match seed and
 * read as a pure function of match time, so every screen agrees on where the
 * ice edge is, where the floes have drifted and when the next wave comes —
 * without a byte of it crossing the wire.
 */

import {
	BALL_DRAG,
	BALL_GRAVITY,
	BALL_KICK_SPEED,
	BALL_MAX_ROLL_MS,
	BALL_R,
	JAR_EVERY_MS,
	JAR_FIRST_MS,
	JAR_LIFE_MS,
	SHRINK_END_MS,
	SHRINK_MIN,
	SHRINK_START_MS,
	WALLS_CRUMBLE_MS,
} from './constants.js';
import { makeRng, streamFor } from './net/rng.js';

/**
 * @typedef {object} MapInfo
 * @property {string} id
 * @property {string} name
 * @property {string} blurb
 * @property {string} emoji
 */

/** @type {MapInfo[]} */
export const MAPS = [
	{
		id: 'hill',
		name: 'Snowball Hill',
		emoji: '⛄',
		blurb: 'Push the giant snowballs down the hill!',
	},
	{
		id: 'floes',
		name: 'Floe Frenzy',
		emoji: '🧊',
		blurb: 'Drifting ice floes sink now and then.',
	},
	{
		id: 'cove',
		name: 'Igloo Cove',
		emoji: '🌊',
		blurb: 'Big waves! Hide behind the igloo or a snow wall.',
	},
	{
		id: 'maze',
		name: 'Ice Maze',
		emoji: '🧩',
		blurb: 'Snow-wall corridors with holes in the ice.',
	},
];

/**
 * @typedef {object} Lobe
 * @property {number} k
 * @property {number} a
 * @property {number} phi
 *
 * @typedef {object} Circle
 * @property {number} x
 * @property {number} y
 * @property {number} r
 *
 * @typedef {object} Capsule A line segment with thickness (a circle when a = b).
 * @property {number} ax
 * @property {number} ay
 * @property {number} bx
 * @property {number} by
 * @property {number} r
 *
 * @typedef {object} Hill
 * @property {number} x
 * @property {number} y
 * @property {number} h Peak height.
 * @property {number} s Spread north–south (gaussian sigma).
 * @property {number} sx Spread east–west (a long ridge when larger).
 *
 * @typedef {object} Floe
 * @property {number} orbit Orbit radius around the island centre.
 * @property {number} speed Radians per second.
 * @property {number} phase
 * @property {number} r
 * @property {number} offset Sink-cycle offset, ms.
 * @property {number[]} shape Radius wobble per vertex (for drawing).
 *
 * @typedef {object} Waves
 * @property {number} first ms
 * @property {number} every ms
 * @property {number} warn ms of warning before the front arrives
 * @property {number} travel ms for the front to cross the whole arena
 * @property {number} reach Half-length of the travel path.
 *
 * @typedef {object} Arena
 * @property {string} id
 * @property {number} seed
 * @property {number} R Nominal island radius.
 * @property {Lobe[]} lobes
 * @property {Hill | null} hill
 * @property {Circle[]} balls Giant snowball home spots.
 * @property {Floe[]} floes
 * @property {Circle[]} obstacles Solid round things (igloo, rocks).
 * @property {Capsule[]} walls Snow walls: solid, block snowballs, shelter from waves.
 * @property {Capsule[]} holes Holes and cracks in the ice: water.
 * @property {Circle | null} igloo
 * @property {Circle[]} slick Extra-slippery patches.
 * @property {Waves | null} waves
 * @property {Map<number, Jar>} jarCache
 */

/**
 * @param {string} id
 * @param {number} seed
 * @returns {Arena}
 */
export function makeArena(id, seed) {
	const rng = makeRng(seed);
	/** @type {Lobe[]} */
	const lobes = [
		{ k: 2, a: 0.03 + rng() * 0.03, phi: rng() * Math.PI * 2 },
		{ k: 3, a: 0.025 + rng() * 0.03, phi: rng() * Math.PI * 2 },
		{ k: 5, a: 0.012 + rng() * 0.015, phi: rng() * Math.PI * 2 },
	];
	/** @type {Arena} */
	const arena = {
		id,
		seed,
		R: 8.4,
		lobes,
		hill: null,
		balls: [],
		floes: [],
		obstacles: [],
		walls: [],
		holes: [],
		igloo: null,
		slick: [],
		waves: null,
		jarCache: new Map(),
	};

	if (id === 'hill') {
		// One big hill to the north. Two snowballs sit just below its crest,
		// each in a lane between snow walls, aimed at the holes and the shore
		// below. They only roll downhill.
		arena.R = 9;
		const hx = (rng() - 0.5) * 0.8;
		arena.hill = { x: hx, y: -3.7, h: 3.0, s: 2.2, sx: 5.5 };
		arena.balls = [
			{ x: hx - 1.75, y: -2.55, r: BALL_R },
			{ x: hx + 1.75, y: -2.55, r: BALL_R },
		];
		arena.walls = [
			wall(hx, -2.3, hx, 1.3, 0.3),
			wall(hx - 3.7, -3.0, hx - 3.3, 1.0, 0.3),
			wall(hx + 3.7, -3.0, hx + 3.3, 1.0, 0.3),
		];
		arena.holes = [
			wall(-2.1 + rng() * 0.6, 4.3, -2.1 + rng() * 0.6, 4.3, 1.0),
			wall(2.3 - rng() * 0.6, 4.4, 2.3 - rng() * 0.6, 4.4, 0.9),
			wall(-0.5, 2.9, 0.7, 3.2, 0.42),
			wall(-5.6, -0.4, -5.6, -0.4, 0.7),
			wall(5.7, -0.2, 5.7, -0.2, 0.7),
		];
	} else if (id === 'floes') {
		arena.R = 6.4;
		const n = 4;
		for (let i = 0; i < n; i++) {
			const shape = [];
			for (let j = 0; j < 9; j++) shape.push(0.85 + rng() * 0.25);
			arena.floes.push({
				orbit: 7.8,
				speed: 0.15,
				phase: (i / n) * Math.PI * 2 + rng() * 0.3,
				r: 2.0,
				offset: i * 3400 + Math.floor(rng() * 900),
				shape,
			});
		}
		arena.slick.push({ x: 0, y: 0, r: 1.4 });
		// Fishing holes, and a crack across the middle.
		const a0 = rng() * Math.PI * 2;
		for (let i = 0; i < 3; i++) {
			const a = a0 + (i / 3) * Math.PI * 2;
			const x = Math.cos(a) * 3.5;
			const y = Math.sin(a) * 3.5;
			arena.holes.push(wall(x, y, x, y, 0.72));
		}
		const c = a0 + Math.PI / 3;
		arena.holes.push(
			wall(Math.cos(c) * 1.9, Math.sin(c) * 1.9, Math.cos(c) * 3.0, Math.sin(c) * 3.0, 0.3),
		);
	} else if (id === 'cove') {
		arena.R = 8.6;
		arena.igloo = { x: 2.4, y: -1.6, r: 1.45 };
		arena.obstacles = [arena.igloo, { x: -0.6, y: -5.0, r: 0.5 }];
		arena.walls = [
			wall(-4.6, -3.0, -2.5, -3.7, 0.3),
			wall(-1.1, 2.7, 1.5, 3.5, 0.3),
			wall(4.5, 1.4, 4.9, 3.4, 0.3),
			wall(-5.0, 0.4, -4.4, 2.5, 0.3),
		];
		arena.holes = [
			wall(-2.2, 0.0, -2.2, 0.0, 0.85),
			wall(1.0, 5.4, 2.3, 5.2, 0.45),
			wall(5.6, -1.6, 5.6, -1.6, 0.7),
		];
		arena.slick = [
			{ x: -2.6, y: -2.0, r: 1.3 },
			{ x: 1.4, y: 1.4, r: 1.2 },
		];
		arena.waves = { first: 9000, every: 8000, warn: 2600, travel: 2300, reach: 13 };
	} else {
		buildMaze(arena, rng);
	}
	return arena;
}

/**
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @param {number} r
 * @returns {Capsule}
 */
function wall(ax, ay, bx, by, r) {
	return { ax, ay, bx, by, r };
}

const MAZE_CELL = 2.6;
const MAZE_N = 7;

/**
 * Ice Maze: a seeded maze of snow walls (a random spanning tree, then extra
 * gaps knocked through so there are always loops — nobody gets cornered for
 * ever), with holes in the ice in some of the dead ends.
 *
 * @param {Arena} arena
 * @param {() => number} rng
 */
function buildMaze(arena, rng) {
	arena.R = 9.6;
	const n = MAZE_N;
	const c = MAZE_CELL;
	const at = (/** @type {number} */ i) => (i - (n - 1) / 2) * c;
	// Walls between cells: right[i][j] separates (i,j)/(i+1,j); down[i][j] (i,j)/(i,j+1).
	const right = Array.from({ length: n }, () => Array(n).fill(true));
	const down = Array.from({ length: n }, () => Array(n).fill(true));
	const seen = Array.from({ length: n }, () => Array(n).fill(false));
	/** @type {[number, number][]} */
	const stack = [[(n - 1) / 2, (n - 1) / 2]];
	/** @type {boolean[]} */ (seen[(n - 1) / 2])[(n - 1) / 2] = true;
	while (stack.length) {
		const top = stack[stack.length - 1];
		if (!top) break;
		const [i, j] = top;
		/** @type {[number, number][]} */
		const next = [];
		for (const [di, dj] of [
			[1, 0],
			[-1, 0],
			[0, 1],
			[0, -1],
		]) {
			const ni = i + (di ?? 0);
			const nj = j + (dj ?? 0);
			if (ni >= 0 && nj >= 0 && ni < n && nj < n && !seen[ni]?.[nj]) next.push([ni, nj]);
		}
		if (!next.length) {
			stack.pop();
			continue;
		}
		const pick = next[Math.floor(rng() * next.length)];
		if (!pick) break;
		const [ni, nj] = pick;
		if (ni !== i) /** @type {boolean[]} */ (right[Math.min(i, ni)])[j] = false;
		else /** @type {boolean[]} */ (down[i])[Math.min(j, nj)] = false;
		/** @type {boolean[]} */ (seen[ni])[nj] = true;
		stack.push([ni, nj]);
	}
	// Knock extra gaps through: loops make for chases, not traps.
	for (let i = 0; i < n; i++) {
		for (let j = 0; j < n; j++) {
			if (rng() < 0.42) /** @type {boolean[]} */ (right[i])[j] = false;
			if (rng() < 0.42) /** @type {boolean[]} */ (down[i])[j] = false;
		}
	}
	const inside = (/** @type {number} */ x, /** @type {number} */ y) =>
		Math.hypot(x, y) < edgeRadius(arena, Math.atan2(y, x)) * 0.86;
	const centre = (n - 1) / 2;
	for (let i = 0; i < n - 1; i++) {
		for (let j = 0; j < n; j++) {
			if (!right[i]?.[j]) continue;
			const x = at(i) + c / 2;
			const y0 = at(j) - c / 2;
			const y1 = at(j) + c / 2;
			if (inside(x, y0) && inside(x, y1)) arena.walls.push(wall(x, y0, x, y1, 0.26));
		}
	}
	for (let i = 0; i < n; i++) {
		for (let j = 0; j < n - 1; j++) {
			if (!down[i]?.[j]) continue;
			const y = at(j) + c / 2;
			const x0 = at(i) - c / 2;
			const x1 = at(i) + c / 2;
			if (inside(x0, y) && inside(x1, y)) arena.walls.push(wall(x0, y, x1, y, 0.26));
		}
	}
	// Holes: in cells boxed in on three sides first (dead ends), never the
	// middle (that's where penguins drop back in).
	/** @type {{ i: number, j: number, sides: number, r: number }[]} */
	const cells = [];
	for (let i = 0; i < n; i++) {
		for (let j = 0; j < n; j++) {
			if (Math.abs(i - centre) <= 1 && Math.abs(j - centre) <= 1) continue;
			if (!inside(at(i), at(j))) continue;
			const sides =
				(i > 0 && right[i - 1]?.[j] ? 1 : 0) +
				(i < n - 1 && right[i]?.[j] ? 1 : 0) +
				(j > 0 && down[i]?.[j - 1] ? 1 : 0) +
				(j < n - 1 && down[i]?.[j] ? 1 : 0);
			cells.push({ i, j, sides, r: rng() });
		}
	}
	cells.sort((a, b) => b.sides - a.sides || a.r - b.r);
	for (const cell of cells.slice(0, 6)) {
		const x = at(cell.i) + (rng() - 0.5) * 0.5;
		const y = at(cell.j) + (rng() - 0.5) * 0.5;
		arena.holes.push(wall(x, y, x, y, 0.72 + rng() * 0.15));
	}
}

/**
 * The snow walls still standing at time `t` (they crumble in sudden death).
 *
 * @param {Arena} arena
 * @param {number} t
 * @returns {Capsule[]}
 */
export function wallsAt(arena, t) {
	return t < WALLS_CRUMBLE_MS ? arena.walls : [];
}

/**
 * Distance from a point to a capsule's surface (negative = inside), plus the
 * outward normal there.
 *
 * @param {Capsule} c
 * @param {number} x
 * @param {number} y
 * @returns {{ d: number, nx: number, ny: number, px: number, py: number }}
 */
export function capDist(c, x, y) {
	const dx = c.bx - c.ax;
	const dy = c.by - c.ay;
	const len2 = dx * dx + dy * dy;
	const u = len2 > 0 ? Math.max(0, Math.min(1, ((x - c.ax) * dx + (y - c.ay) * dy) / len2)) : 0;
	const px = c.ax + dx * u;
	const py = c.ay + dy * u;
	const ex = x - px;
	const ey = y - py;
	const e = Math.hypot(ex, ey);
	if (e < 1e-6) {
		// Exactly on the spine: push out sideways.
		const l = Math.sqrt(len2) || 1;
		return { d: -c.r, nx: -dy / l || 1, ny: dx / l, px, py };
	}
	return { d: e - c.r, nx: ex / e, ny: ey / e, px, py };
}

/**
 * @param {Arena} arena
 * @param {number} x
 * @param {number} y
 * @param {number} [pad]
 */
export function inHole(arena, x, y, pad = 0) {
	return arena.holes.some((h) => capDist(h, x, y).d < pad);
}

/**
 * Downhill direction at a point (unit vector), or null on the flat.
 *
 * @param {Arena} arena
 * @param {number} x
 * @param {number} y
 */
export function downhillAt(arena, x, y) {
	const g = gradientAt(arena, x, y);
	const m = Math.hypot(g.x, g.y);
	if (m < 0.05) return null;
	return { x: -g.x / m, y: -g.y / m };
}

/**
 * Giant snowballs only go downhill: a shove has to come from the uphill side.
 *
 * @param {Arena} arena
 * @param {number} ball
 * @param {number} angle Direction of the shove.
 */
export function kickAllowed(arena, ball, angle) {
	const home = arena.balls[ball];
	if (!home) return false;
	const down = downhillAt(arena, home.x, home.y);
	if (!down) return true;
	return Math.cos(angle) * down.x + Math.sin(angle) * down.y > 0.35;
}

/**
 * Nominal edge radius in direction `theta` (no sudden-death shrink).
 *
 * @param {Arena} arena
 * @param {number} theta
 */
export function edgeRadius(arena, theta) {
	let f = 1;
	for (const l of arena.lobes) f += l.a * Math.cos(l.k * theta + l.phi);
	return arena.R * f;
}

/**
 * Sudden-death factor: 1 until the ice starts cracking, then down to SHRINK_MIN.
 *
 * @param {number} t Match time, ms.
 */
export function shrinkAt(t) {
	if (t <= SHRINK_START_MS) return 1;
	const k = Math.min(1, (t - SHRINK_START_MS) / (SHRINK_END_MS - SHRINK_START_MS));
	return 1 - (1 - SHRINK_MIN) * k;
}

/**
 * @param {Arena} arena
 * @param {number} x
 * @param {number} y
 * @param {number} t
 */
export function onIsland(arena, x, y, t) {
	const d = Math.hypot(x, y);
	return d <= edgeRadius(arena, Math.atan2(y, x)) * shrinkAt(t);
}

/**
 * Ground height (only the hill has any).
 *
 * @param {Arena} arena
 * @param {number} x
 * @param {number} y
 */
export function heightAt(arena, x, y) {
	const h = arena.hill;
	if (!h) return 0;
	const dx = x - h.x;
	const dy = y - h.y;
	return h.h * Math.exp(-((dx * dx) / (h.sx * h.sx) + (dy * dy) / (h.s * h.s)) / 2);
}

/**
 * Uphill gradient of the ground.
 *
 * @param {Arena} arena
 * @param {number} x
 * @param {number} y
 * @returns {{ x: number, y: number }}
 */
export function gradientAt(arena, x, y) {
	const h = arena.hill;
	if (!h) return { x: 0, y: 0 };
	const z = heightAt(arena, x, y);
	return { x: (-z * (x - h.x)) / (h.sx * h.sx), y: (-z * (y - h.y)) / (h.s * h.s) };
}

/**
 * @typedef {object} FloeState
 * @property {number} x
 * @property {number} y
 * @property {number} vx
 * @property {number} vy
 * @property {number} angle Spin, for drawing.
 * @property {number} sink 0 floating … 1 fully under.
 * @property {boolean} warn Cracking: about to sink.
 */

const FLOE_PERIOD = 13000;
const FLOE_SAFE_MS = 9000;

/**
 * @param {Floe} f
 * @param {number} t
 * @returns {FloeState}
 */
export function floeAt(f, t) {
	const s = t / 1000;
	const a = f.phase + f.speed * s;
	const x = Math.cos(a) * f.orbit;
	const y = Math.sin(a) * f.orbit;
	const vx = -Math.sin(a) * f.orbit * f.speed;
	const vy = Math.cos(a) * f.orbit * f.speed;
	let sink = 0;
	let warn = false;
	if (t > FLOE_SAFE_MS) {
		const c = (((t - FLOE_SAFE_MS + f.offset) % FLOE_PERIOD) + FLOE_PERIOD) % FLOE_PERIOD;
		if (c >= 8000 && c < 10200) warn = true;
		else if (c >= 10200 && c < 11000) sink = (c - 10200) / 800;
		else if (c >= 11000 && c < 12000) sink = 1;
		else if (c >= 12000) sink = 1 - (c - 12000) / 1000;
	}
	return { x, y, vx, vy, angle: a * 0.6, sink, warn };
}

/**
 * @typedef {object} Support
 * @property {boolean} ok Standing on something.
 * @property {number} vx Velocity of what you're standing on (a floe drifts).
 * @property {number} vy
 * @property {boolean} slick
 */

/**
 * What's under a point at time `t`.
 *
 * @param {Arena} arena
 * @param {number} x
 * @param {number} y
 * @param {number} t
 * @returns {Support}
 */
export function supportAt(arena, x, y, t) {
	const slick = arena.slick.some((c) => (x - c.x) ** 2 + (y - c.y) ** 2 < c.r * c.r);
	if (onIsland(arena, x, y, t) && !inHole(arena, x, y)) return { ok: true, vx: 0, vy: 0, slick };
	for (const f of arena.floes) {
		const st = floeAt(f, t);
		if (st.sink > 0.45) continue;
		if ((x - st.x) ** 2 + (y - st.y) ** 2 < f.r * f.r) {
			return { ok: true, vx: st.vx, vy: st.vy, slick: false };
		}
	}
	return { ok: false, vx: 0, vy: 0, slick: false };
}

/**
 * @typedef {object} Wave
 * @property {number} i Wave number.
 * @property {number} dir Travel direction, radians.
 * @property {number} start ms when the front leaves the far side.
 * @property {number} front Signed distance of the front along `dir`.
 * @property {'warn' | 'go'} phase
 */

/**
 * The wave (if any) live at time `t`: warning arrows, then a front sweeping
 * across the arena.
 *
 * @param {Arena} arena
 * @param {number} t
 * @returns {Wave | null}
 */
export function waveAt(arena, t) {
	const w = arena.waves;
	if (!w || t < w.first - w.warn) return null;
	const i = Math.floor((t - (w.first - w.warn)) / w.every);
	const start = w.first + i * w.every;
	const dir = streamFor(arena.seed, 7000 + i)() * Math.PI * 2;
	if (t < start) return { i, dir, start, front: -w.reach, phase: 'warn' };
	if (t > start + w.travel) return null;
	const front = -w.reach + (2 * w.reach * (t - start)) / w.travel;
	return { i, dir, start, front, phase: 'go' };
}

/**
 * True when the igloo, a rock or a snow wall stands between a wave and the
 * point (x, y) — i.e. something solid just upwave of it.
 *
 * @param {Arena} arena
 * @param {number} dir
 * @param {number} x
 * @param {number} y
 * @param {number} t
 */
export function shelteredFrom(arena, dir, x, y, t) {
	const ux = Math.cos(dir);
	const uy = Math.sin(dir);
	for (let s = 0.3; s <= 3.6; s += 0.25) {
		const px = x - ux * s;
		const py = y - uy * s;
		if (arena.obstacles.some((o) => (px - o.x) ** 2 + (py - o.y) ** 2 < o.r * o.r)) return true;
		if (wallsAt(arena, t).some((w) => capDist(w, px, py).d < 0.05)) return true;
	}
	return false;
}

/**
 * @typedef {object} Jar
 * @property {number} i
 * @property {number} x
 * @property {number} y
 * @property {number} spawn ms
 * @property {number} expire ms
 * @property {'heart' | 'fish'} kind
 * @property {'snowball' | 'slide' | 'mega'} power What a fish jar gives.
 */

/**
 * Jar number `i`: when and where it appears and what's inside. Pure function
 * of the seed — cached because the renderer asks every frame.
 *
 * @param {Arena} arena
 * @param {number} i
 * @returns {Jar}
 */
export function jarAt(arena, i) {
	const hit = arena.jarCache.get(i);
	if (hit) return hit;
	const rng = streamFor(arena.seed, 1000 + i);
	const spawn = JAR_FIRST_MS + i * JAR_EVERY_MS + Math.floor(rng() * 1200);
	let x = 0;
	let y = 0;
	for (let tries = 0; tries < 30; tries++) {
		const a = rng() * Math.PI * 2;
		const d = Math.sqrt(rng()) * 0.72;
		x = Math.cos(a) * d * edgeRadius(arena, a) * shrinkAt(spawn + 4000);
		y = Math.sin(a) * d * edgeRadius(arena, a) * shrinkAt(spawn + 4000);
		if (!blocked(arena, x, y, 0.7) && onIsland(arena, x, y, spawn)) break;
	}
	const roll = rng();
	const p = rng();
	/** @type {Jar} */
	const jar = {
		i,
		x,
		y,
		spawn,
		expire: spawn + JAR_LIFE_MS,
		kind: roll < 0.3 && spawn < SHRINK_START_MS ? 'heart' : 'fish',
		power: p < 0.45 ? 'snowball' : p < 0.75 ? 'slide' : 'mega',
	};
	arena.jarCache.set(i, jar);
	return jar;
}

/**
 * Jar numbers that could be on the ice at time `t`.
 *
 * @param {number} t
 * @returns {number[]}
 */
export function jarIndicesAround(t) {
	const hi = Math.floor((t - JAR_FIRST_MS) / JAR_EVERY_MS) + 1;
	const lo = Math.max(0, Math.floor((t - JAR_FIRST_MS - JAR_LIFE_MS - 1200) / JAR_EVERY_MS));
	/** @type {number[]} */
	const out = [];
	for (let i = lo; i <= hi; i++) if (i >= 0) out.push(i);
	return out;
}

/**
 * Inside an obstacle, a resting snowball or on the hill's crown.
 *
 * @param {Arena} arena
 * @param {number} x
 * @param {number} y
 * @param {number} pad
 */
export function blocked(arena, x, y, pad) {
	for (const o of [...arena.obstacles, ...arena.balls]) {
		if ((x - o.x) ** 2 + (y - o.y) ** 2 < (o.r + pad) ** 2) return true;
	}
	if (arena.walls.some((w) => capDist(w, x, y).d < pad)) return true;
	if (inHole(arena, x, y, pad)) return true;
	return heightAt(arena, x, y) > 1.2;
}

/**
 * Start positions for `n` penguins, spread around the ice.
 *
 * @param {Arena} arena
 * @param {number} n
 * @returns {{ x: number, y: number, face: number }[]}
 */
export function startSpots(arena, n) {
	const out = [];
	for (let i = 0; i < n; i++) {
		const base = Math.PI / 4 + (i / n) * Math.PI * 2;
		let best = { x: 0, y: 0 };
		search: for (const f of [0.5, 0.42, 0.58, 0.34, 0.66, 0.26]) {
			for (const da of [0, 0.25, -0.25, 0.5, -0.5, 0.8, -0.8]) {
				const a = base + da;
				const r = edgeRadius(arena, a) * f;
				const x = Math.cos(a) * r;
				const y = Math.sin(a) * r;
				if (supportAt(arena, x, y, 0).ok && !blocked(arena, x, y, 0.65)) {
					best = { x, y };
					break search;
				}
			}
		}
		out.push({ ...best, face: Math.atan2(-best.y, -best.x) });
	}
	return out;
}

/**
 * Somewhere safe to drop a penguin back in: well inside the current ice, away
 * from everyone else. Not seed-derived — only the respawning penguin's owner
 * asks.
 *
 * @param {Arena} arena
 * @param {number} t
 * @param {{ x: number, y: number }[]} others
 * @returns {{ x: number, y: number }}
 */
export function respawnSpot(arena, t, others) {
	let best = { x: 0, y: 0 };
	let bestScore = -Infinity;
	const k = shrinkAt(t);
	for (let ring = 0; ring <= 4; ring++) {
		const steps = ring === 0 ? 1 : ring * 7;
		for (let s = 0; s < steps; s++) {
			const a = (s / steps) * Math.PI * 2 + ring;
			const d = (ring / 4) * 0.55;
			const x = Math.cos(a) * d * edgeRadius(arena, a) * k;
			const y = Math.sin(a) * d * edgeRadius(arena, a) * k;
			if (blocked(arena, x, y, 0.5) && ring > 0) continue;
			let near = 6;
			for (const o of others) near = Math.min(near, Math.hypot(o.x - x, o.y - y));
			const score = near - d * 2;
			if (score > bestScore) {
				bestScore = score;
				best = { x, y };
			}
		}
	}
	return best;
}

/**
 * @typedef {object} Roll
 * @property {number} t0 Kick time, ms.
 * @property {Float32Array} pts x,y per 1/60 s step.
 * @property {number} ms Duration of the roll.
 * @property {'splash' | 'stop'} end
 */

/** @type {Map<string, Roll>} */
const rollCache = new Map();

/**
 * Simulate a giant snowball rolling from its home after a kick. Deterministic
 * from (arena, ball, angle, t0), so every client draws the same roll.
 *
 * @param {Arena} arena
 * @param {number} ball
 * @param {number} angle
 * @param {number} t0
 * @returns {Roll}
 */
export function rollPath(arena, ball, angle, t0) {
	const key = `${arena.seed}:${arena.id}:${ball}:${angle.toFixed(4)}:${t0}`;
	const hit = rollCache.get(key);
	if (hit) return hit;
	const home = arena.balls[ball] ?? { x: 0, y: 0, r: BALL_R };
	let x = home.x;
	let y = home.y;
	let vx = Math.cos(angle) * BALL_KICK_SPEED;
	let vy = Math.sin(angle) * BALL_KICK_SPEED;
	const dt = 1 / 60;
	/** @type {number[]} */
	const pts = [x, y];
	/** @type {'splash' | 'stop'} */
	let end = 'stop';
	let ms = 0;
	while (ms < BALL_MAX_ROLL_MS) {
		const g = gradientAt(arena, x, y);
		vx -= g.x * BALL_GRAVITY * dt;
		vy -= g.y * BALL_GRAVITY * dt;
		vx *= 1 - BALL_DRAG * dt;
		vy *= 1 - BALL_DRAG * dt;
		x += vx * dt;
		y += vy * dt;
		for (const w of wallsAt(arena, t0 + ms)) {
			const c = capDist(w, x, y);
			if (c.d >= BALL_R) continue;
			// Bounce off snow walls (they funnel the ball down its lane).
			x += c.nx * (BALL_R - c.d);
			y += c.ny * (BALL_R - c.d);
			const vn = vx * c.nx + vy * c.ny;
			if (vn < 0) {
				vx -= 1.6 * vn * c.nx;
				vy -= 1.6 * vn * c.ny;
			}
		}
		ms += 1000 / 60;
		pts.push(x, y);
		if (!onIsland(arena, x, y, t0 + ms) || inHole(arena, x, y)) {
			end = 'splash';
			break;
		}
		if (ms > 700 && Math.hypot(vx, vy) < 0.3) break;
	}
	const roll = { t0, pts: new Float32Array(pts), ms, end };
	if (rollCache.size > 64) rollCache.clear();
	rollCache.set(key, roll);
	return roll;
}

/**
 * How close to the edge a point is: 0 centre … 1 on the edge.
 *
 * @param {Arena} arena
 * @param {number} x
 * @param {number} y
 * @param {number} t
 */
export function edginess(arena, x, y, t) {
	return Math.hypot(x, y) / (edgeRadius(arena, Math.atan2(y, x)) * shrinkAt(t));
}
