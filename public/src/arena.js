/**
 * The maps — built from a grid of ice blocks, like a Bomberman board turned
 * inside out: the board is ice, the "pillars" are water.
 *
 * Every tile is a square ice block. A tile is water (missing), ice at some
 * level (stacked blocks make a stepped hill), and may carry a solid ice block
 * on top (an obstacle). Everything here is **seed-derived**: built from the
 * match seed and read as a pure function of match time, so every screen
 * agrees on the board, the floes, the waves, which tiles crack in sudden
 * death and every jar — without a byte of it crossing the wire.
 */

import {
	BALL_KICK_SPEED,
	BALL_MAX_ROLL_MS,
	BALL_R,
	JAR_EVERY_MS,
	JAR_FIRST_MS,
	JAR_LIFE_MS,
	SHRINK_END_MS,
	SHRINK_START_MS,
	WALLS_CRUMBLE_MS,
} from './constants.js';
import { makeRng, streamFor } from './net/rng.js';

/** Tile size, world units. */
export const CELL = 1.25;
/** Height of one stacked level. */
export const STEP_H = 0.6;
/** How long a tile shakes before it sinks in sudden death. */
export const CRACK_WARN_MS = 1600;
/** How long a tile takes to sink. */
export const SINK_MS = 700;

/**
 * @typedef {object} MapInfo
 * @property {string} id
 * @property {string} name
 * @property {string} blurb
 * @property {string} emoji
 */

/** @type {MapInfo[]} */
export const MAPS = [
	{ id: 'hill', name: 'Snowball Hill', emoji: '⛄', blurb: 'Push snowballs down the steps!' },
	{
		id: 'floes',
		name: 'Floe Frenzy',
		emoji: '🧊',
		blurb: 'Four islands, narrow bridges, sinking rafts.',
	},
	{
		id: 'cove',
		name: 'Igloo Cove',
		emoji: '🌊',
		blurb: 'Big waves! Hide behind the igloo or a block.',
	},
	{
		id: 'grid',
		name: 'Ice Grid',
		emoji: '🔲',
		blurb: 'A checkerboard of water holes and ice blocks.',
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
 * @typedef {object} Ball A giant snowball's home tile.
 * @property {number} k Tile index.
 * @property {number} x
 * @property {number} y
 * @property {number} r
 *
 * @typedef {object} Floe A drifting raft of ice tiles.
 * @property {number} orbit Orbit radius around the centre.
 * @property {number} speed Radians per second.
 * @property {number} phase
 * @property {number} half Half the raft's side length.
 * @property {number} offset Sink-cycle offset, ms.
 *
 * @typedef {object} Waves
 * @property {number} first ms
 * @property {number} every ms
 * @property {number} warn ms of warning before the front arrives
 * @property {number} travel ms for the front to cross the whole arena
 * @property {number} reach Half-length of the travel path.
 *
 * @typedef {object} Block A solid ice block sitting on a tile.
 * @property {number} k
 * @property {number} x
 * @property {number} y
 * @property {number} top Height of its top.
 *
 * @typedef {object} Arena
 * @property {string} id
 * @property {number} seed
 * @property {number} R Rough radius, for framing the camera.
 * @property {number} n Grid size (n × n tiles).
 * @property {Lobe[]} lobes Coastline wobble.
 * @property {Int8Array} level Per tile: -1 water, else stacked height 0..3.
 * @property {Uint8Array} block Per tile: 1 if a solid ice block sits on it.
 * @property {Uint8Array} slick Per tile: 1 if it's polished slippery ice.
 * @property {Float64Array} crack Per tile: when it sinks in sudden death (Infinity = never).
 * @property {Block[]} blocks
 * @property {boolean} hill Has stacked levels.
 * @property {Ball[]} balls Giant snowball home tiles.
 * @property {Floe[]} floes
 * @property {Circle[]} obstacles Round solid things (the igloo).
 * @property {Circle | null} igloo
 * @property {Waves | null} waves
 * @property {Map<number, Jar>} jarCache
 */

/**
 * @param {Arena} arena
 * @param {number} i
 * @param {number} j
 */
export function idx(arena, i, j) {
	return i >= 0 && j >= 0 && i < arena.n && j < arena.n ? j * arena.n + i : -1;
}

/**
 * Tile index under a point, or -1 off the board.
 *
 * @param {Arena} arena
 * @param {number} x
 * @param {number} y
 */
export function tileAt(arena, x, y) {
	const h = (arena.n * CELL) / 2;
	return idx(arena, Math.floor((x + h) / CELL), Math.floor((y + h) / CELL));
}

/**
 * @param {Arena} arena
 * @param {number} k
 */
export function tileCenter(arena, k) {
	const h = ((arena.n - 1) * CELL) / 2;
	return { x: (k % arena.n) * CELL - h, y: Math.floor(k / arena.n) * CELL - h };
}

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
	const n = id === 'floes' ? 13 : 15;
	const N = n * n;
	/** @type {Arena} */
	const arena = {
		id,
		seed,
		R: id === 'floes' ? 7.6 : 9,
		n,
		lobes,
		level: new Int8Array(N).fill(-1),
		block: new Uint8Array(N),
		slick: new Uint8Array(N),
		crack: new Float64Array(N).fill(Infinity),
		blocks: [],
		hill: false,
		balls: [],
		floes: [],
		obstacles: [],
		igloo: null,
		waves: null,
		jarCache: new Map(),
	};
	// The coastline: every tile whose centre is inside a wobbly circle.
	for (let k = 0; k < N; k++) {
		const c = tileCenter(arena, k);
		if (Math.hypot(c.x, c.y) <= edgeRadius(arena, Math.atan2(c.y, c.x))) arena.level[k] = 0;
	}
	const mid = (n - 1) / 2;
	const odd = (/** @type {number} */ i, /** @type {number} */ j) => i % 2 === 1 && j % 2 === 1;
	/** Tiles kept clear for the start positions (and next to them). */
	const starts = startTiles(arena, 4);
	/** Within a step of a start tile (a plus shape, so water squares on the diagonals stay). */
	const nearStart = (/** @type {number} */ i, /** @type {number} */ j) =>
		starts.some((k) => Math.abs((k % n) - i) + Math.abs(Math.floor(k / n) - j) <= 1);
	const set = (/** @type {number} */ i, /** @type {number} */ j, /** @type {number} */ v) => {
		const k = idx(arena, i, j);
		if (k >= 0) arena.level[k] = v;
	};
	const land = (/** @type {number} */ i, /** @type {number} */ j) => {
		const k = idx(arena, i, j);
		return k >= 0 && (arena.level[k] ?? -1) >= 0;
	};

	if (id === 'hill') {
		// A stepped ice pyramid to the north. Two snowballs sit on the middle
		// of its front edge, where the only way down is south — into a wide
		// lane of clear ice that runs all the way to the shore.
		arena.hill = true;
		const core = { i0: 5, i1: 9, j0: 3, j1: 5 };
		/** The snowball lane: the pyramid's width, from its foot to the sea. */
		const inLane = (/** @type {number} */ i, /** @type {number} */ j) =>
			i >= core.i0 && i <= core.i1 && j > core.j1;
		for (let j = 0; j < n; j++) {
			for (let i = 0; i < n; i++) {
				if (!land(i, j)) continue;
				const d = Math.max(core.i0 - i, i - core.i1, core.j0 - j, j - core.j1, 0);
				set(i, j, Math.max(0, 3 - d));
				// Water pillars across the lowlands, but never in the lane.
				if (d >= 4 && odd(i, j) && !nearStart(i, j) && !inLane(i, j)) set(i, j, -1);
			}
		}
		for (const [i, j] of [
			[core.i0 + 1, core.j1],
			[core.i1 - 1, core.j1],
		]) {
			const k = idx(arena, i ?? 0, j ?? 0);
			const c = tileCenter(arena, k);
			arena.balls.push({ k, x: c.x, y: c.y, r: BALL_R });
		}
		// A few ice blocks, kept out of the lane.
		scatterBlocks(arena, rng, 0.08, (i, j) => inLane(i, j) || j === core.j1 || nearStart(i, j));
	} else if (id === 'floes') {
		// Four little islands split by a cross of water, joined by one-tile
		// bridges, with rafts drifting round the outside.
		for (let j = 0; j < n; j++) {
			for (let i = 0; i < n; i++) {
				if (!land(i, j)) continue;
				if (i === mid || j === mid) set(i, j, -1);
			}
		}
		const bridges = [
			[mid, 2],
			[mid, 4],
			[mid, n - 3],
			[mid, n - 5],
			[2, mid],
			[4, mid],
			[n - 3, mid],
			[n - 5, mid],
		];
		for (const [i, j] of bridges) set(i ?? 0, j ?? 0, 0);
		// A patch of polished (slippery) ice in the middle of each island.
		for (const [ci, cj] of [
			[3, 3],
			[n - 4, 3],
			[3, n - 4],
			[n - 4, n - 4],
		]) {
			for (const [di, dj] of [
				[0, 0],
				[1, 0],
				[0, 1],
				[1, 1],
			]) {
				const k = idx(arena, (ci ?? 0) + (di ?? 0) - 1, (cj ?? 0) + (dj ?? 0) - 1);
				if (k >= 0 && (arena.level[k] ?? -1) >= 0) arena.slick[k] = 1;
			}
		}
		for (let f = 0; f < 4; f++) {
			arena.floes.push({
				orbit: arena.R + 1.9,
				speed: 0.14,
				phase: (f / 4) * Math.PI * 2 + Math.PI / 4 + rng() * 0.3,
				half: CELL,
				offset: f * 3400 + Math.floor(rng() * 900),
			});
		}
		scatterBlocks(
			arena,
			rng,
			0.06,
			(i, j) => Math.abs(i - mid) <= 1 || Math.abs(j - mid) <= 1 || nearStart(i, j),
		);
	} else if (id === 'cove') {
		// An igloo, scattered ice blocks and holes — and big waves.
		arena.igloo = { x: CELL * 2, y: -CELL * 1.5, r: 1.45 };
		arena.obstacles = [arena.igloo];
		for (let t = 0; t < 7; t++) {
			const i = 1 + Math.floor(rng() * (n - 2));
			const j = 1 + Math.floor(rng() * (n - 2));
			if (nearStart(i, j) || (Math.abs(i - mid) <= 1 && Math.abs(j - mid) <= 1)) continue;
			set(i, j, -1);
			if (rng() < 0.5) set(i + (rng() < 0.5 ? 1 : 0), j + (rng() < 0.5 ? 0 : 1), -1);
		}
		for (const [ci, cj] of [
			[4, 5],
			[9, 10],
		]) {
			for (const [di, dj] of [
				[0, 0],
				[1, 0],
				[-1, 0],
				[0, 1],
				[0, -1],
			]) {
				const k = idx(arena, (ci ?? 0) + (di ?? 0), (cj ?? 0) + (dj ?? 0));
				if (k >= 0 && (arena.level[k] ?? -1) >= 0) arena.slick[k] = 1;
			}
		}
		const ig = arena.igloo;
		scatterBlocks(arena, rng, 0.11, (i, j) => {
			const c = tileCenter(arena, j * n + i);
			return nearStart(i, j) || Math.hypot(c.x - ig.x, c.y - ig.y) < ig.r + 0.8;
		});
		arena.waves = { first: 9000, every: 8000, warn: 2600, travel: 2300, reach: 13 };
	} else {
		// The full inside-out Bomberman board: water at every odd/odd tile,
		// ice blocks scattered on the rest.
		for (let j = 0; j < n; j++) {
			for (let i = 0; i < n; i++) {
				if (!land(i, j)) continue;
				const centre = Math.abs(i - mid) <= 1 && Math.abs(j - mid) <= 1;
				if (odd(i, j) && !centre && !nearStart(i, j)) set(i, j, -1);
			}
		}
		scatterBlocks(
			arena,
			rng,
			0.2,
			(i, j) => nearStart(i, j) || (Math.abs(i - mid) <= 1 && Math.abs(j - mid) <= 1),
		);
	}

	for (let k = 0; k < N; k++) {
		if (!arena.block[k] || (arena.level[k] ?? -1) < 0) {
			arena.block[k] = 0;
			continue;
		}
		const c = tileCenter(arena, k);
		arena.blocks.push({ k, x: c.x, y: c.y, top: levelHeight(arena, k) + 0.95 });
	}
	planCracks(arena, rng);
	return arena;
}

/**
 * Put ice blocks on a share of the free land tiles.
 *
 * @param {Arena} arena
 * @param {() => number} rng
 * @param {number} share
 * @param {(i: number, j: number) => boolean} keepClear
 */
function scatterBlocks(arena, rng, share, keepClear) {
	const n = arena.n;
	for (let j = 0; j < n; j++) {
		for (let i = 0; i < n; i++) {
			const k = j * n + i;
			const r = rng();
			if ((arena.level[k] ?? -1) !== 0 || keepClear(i, j)) continue;
			if (arena.balls.some((b) => b.k === k)) continue;
			if (r < share) arena.block[k] = 1;
		}
	}
}

/**
 * Sudden death: tiles sink from the outside in, a few at a time, leaving a
 * handful in the middle that never go.
 *
 * @param {Arena} arena
 * @param {() => number} rng
 */
function planCracks(arena, rng) {
	// The last tiles standing: a small connected patch (flood-filled from the
	// land tile nearest the middle), so the final penguins can always reach
	// each other.
	let anchor = -1;
	let bestD = Infinity;
	for (let k = 0; k < arena.level.length; k++) {
		if ((arena.level[k] ?? -1) < 0 || arena.block[k]) continue;
		const c = tileCenter(arena, k);
		const d = Math.hypot(c.x, c.y);
		if (d < bestD) {
			bestD = d;
			anchor = k;
		}
	}
	/** @type {Set<number>} */
	const keep = new Set();
	const queue = anchor >= 0 ? [anchor] : [];
	while (queue.length && keep.size < 6) {
		const k = /** @type {number} */ (queue.shift());
		if (keep.has(k)) continue;
		keep.add(k);
		const i = k % arena.n;
		const j = Math.floor(k / arena.n);
		for (const [di, dj] of [
			[1, 0],
			[-1, 0],
			[0, 1],
			[0, -1],
		]) {
			const nk = idx(arena, i + (di ?? 0), j + (dj ?? 0));
			if (nk >= 0 && (arena.level[nk] ?? -1) >= 0 && !keep.has(nk)) queue.push(nk);
		}
	}
	/** @type {{ k: number, d: number }[]} */
	const tiles = [];
	for (let k = 0; k < arena.level.length; k++) {
		if ((arena.level[k] ?? -1) < 0 || keep.has(k)) continue;
		const c = tileCenter(arena, k);
		tiles.push({ k, d: Math.hypot(c.x, c.y) + rng() * 1.2 });
	}
	tiles.sort((a, b) => b.d - a.d);
	const span = SHRINK_END_MS - SHRINK_START_MS;
	tiles.forEach((tile, rank) => {
		arena.crack[tile.k] = Math.round(
			SHRINK_START_MS + (rank / Math.max(1, tiles.length - 1)) * span,
		);
	});
}

/**
 * Tiles near where the penguins start (one per player, spread out).
 *
 * @param {Arena} arena
 * @param {number} count
 * @returns {number[]}
 */
function startTiles(arena, count) {
	/** @type {number[]} */
	const out = [];
	for (let s = 0; s < count; s++) {
		const a = Math.PI / 4 + (s / count) * Math.PI * 2;
		const r = arena.R * 0.52;
		out.push(tileAt(arena, Math.cos(a) * r, Math.sin(a) * r));
	}
	return out;
}

/**
 * Nominal coast radius in direction `theta`.
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
 * How far sudden death has got: 1 until the ice starts cracking, then down
 * toward 0. (The cracking itself is per tile: see `arena.crack`.)
 *
 * @param {number} t Match time, ms.
 */
export function shrinkAt(t) {
	if (t <= SHRINK_START_MS) return 1;
	const k = Math.min(1, (t - SHRINK_START_MS) / (SHRINK_END_MS - SHRINK_START_MS));
	return 1 - 0.85 * k;
}

/**
 * Has tile `k` sunk by time `t`?
 *
 * @param {Arena} arena
 * @param {number} k
 * @param {number} t
 */
export function tileSunk(arena, k, t) {
	return t >= (arena.crack[k] ?? Infinity);
}

/**
 * 0 = solid … 1 = fully under, for drawing a sinking tile; plus a "shaking"
 * flag for the warning before it goes.
 *
 * @param {Arena} arena
 * @param {number} k
 * @param {number} t
 */
export function tileSink(arena, k, t) {
	const c = arena.crack[k] ?? Infinity;
	if (t < c - CRACK_WARN_MS) return { sink: 0, warn: false };
	if (t < c) return { sink: 0, warn: true };
	return { sink: Math.min(1, (t - c) / SINK_MS), warn: false };
}

/**
 * @param {Arena} arena
 * @param {number} k
 */
export function levelHeight(arena, k) {
	return Math.max(0, arena.level[k] ?? 0) * STEP_H;
}

/**
 * Solid ice under a point (ignores floes)?
 *
 * @param {Arena} arena
 * @param {number} x
 * @param {number} y
 * @param {number} t
 */
export function onIsland(arena, x, y, t) {
	const k = tileAt(arena, x, y);
	return k >= 0 && (arena.level[k] ?? -1) >= 0 && !tileSunk(arena, k, t);
}

/**
 * Height of the ice at a point (stacked levels on the hill).
 *
 * @param {Arena} arena
 * @param {number} x
 * @param {number} y
 */
export function heightAt(arena, x, y) {
	const k = tileAt(arena, x, y);
	return k < 0 ? 0 : levelHeight(arena, k);
}

/**
 * @typedef {object} FloeState
 * @property {number} x
 * @property {number} y
 * @property {number} vx
 * @property {number} vy
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
	return { x, y, vx, vy, sink, warn };
}

/**
 * @typedef {object} Support
 * @property {boolean} ok Standing on something.
 * @property {number} vx Velocity of what you're standing on (a raft drifts).
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
	const k = tileAt(arena, x, y);
	if (k >= 0 && (arena.level[k] ?? -1) >= 0 && !tileSunk(arena, k, t)) {
		return { ok: true, vx: 0, vy: 0, slick: arena.slick[k] === 1 };
	}
	for (const f of arena.floes) {
		const st = floeAt(f, t);
		if (st.sink > 0.45) continue;
		if (Math.abs(x - st.x) < f.half && Math.abs(y - st.y) < f.half) {
			return { ok: true, vx: st.vx, vy: st.vy, slick: false };
		}
	}
	return { ok: false, vx: 0, vy: 0, slick: false };
}

/**
 * The ice blocks still standing at time `t` (they crumble in sudden death,
 * and go down with their tile).
 *
 * @param {Arena} arena
 * @param {number} t
 * @returns {Block[]}
 */
export function blocksAt(arena, t) {
	if (t >= WALLS_CRUMBLE_MS) return [];
	return arena.blocks;
}

/**
 * Push a circle out of any ice block it overlaps. Returns the push normal
 * (0, 0 if it touched nothing).
 *
 * @param {Arena} arena
 * @param {number} t
 * @param {{ x: number, y: number }} p Moved in place.
 * @param {number} r
 */
export function pushOutOfBlocks(arena, t, p, r) {
	let nx = 0;
	let ny = 0;
	const half = CELL / 2 - 0.04;
	for (const b of blocksAt(arena, t)) {
		const cx = Math.max(b.x - half, Math.min(b.x + half, p.x));
		const cy = Math.max(b.y - half, Math.min(b.y + half, p.y));
		let dx = p.x - cx;
		let dy = p.y - cy;
		let d = Math.hypot(dx, dy);
		if (d >= r) continue;
		if (d < 1e-6) {
			// Centre inside the block: shove out along the shallow axis.
			const ox = p.x - b.x;
			const oy = p.y - b.y;
			if (Math.abs(ox) > Math.abs(oy)) {
				dx = Math.sign(ox) || 1;
				dy = 0;
			} else {
				dx = 0;
				dy = Math.sign(oy) || 1;
			}
			d = 0;
			p.x = Math.abs(ox) > Math.abs(oy) ? b.x + dx * (half + r) : p.x;
			p.y = Math.abs(ox) > Math.abs(oy) ? p.y : b.y + dy * (half + r);
		} else {
			dx /= d;
			dy /= d;
			p.x += dx * (r - d);
			p.y += dy * (r - d);
		}
		nx = dx;
		ny = dy;
	}
	return { nx, ny };
}

/**
 * Is (x, y) inside an ice block (with padding)?
 *
 * @param {Arena} arena
 * @param {number} t
 * @param {number} x
 * @param {number} y
 * @param {number} pad
 */
export function inBlock(arena, t, x, y, pad) {
	const half = CELL / 2 + pad;
	return blocksAt(arena, t).some((b) => Math.abs(x - b.x) < half && Math.abs(y - b.y) < half);
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
 * True when the igloo or an ice block stands just upwave of (x, y).
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
	for (let s = 0.3; s <= 3.2; s += 0.25) {
		const px = x - ux * s;
		const py = y - uy * s;
		if (arena.obstacles.some((o) => (px - o.x) ** 2 + (py - o.y) ** 2 < o.r * o.r)) return true;
		if (inBlock(arena, t, px, py, -0.05)) return true;
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
 * Jar number `i`: when and where it appears and what's inside. Always on a
 * free tile's centre.
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
	for (let tries = 0; tries < 40; tries++) {
		const k = Math.floor(rng() * arena.level.length);
		const c = tileCenter(arena, k);
		if (
			(arena.level[k] ?? -1) < 0 ||
			arena.block[k] ||
			(arena.crack[k] ?? Infinity) < spawn + JAR_LIFE_MS
		)
			continue;
		if (arena.balls.some((b) => b.k === k)) continue;
		if (arena.obstacles.some((o) => Math.hypot(c.x - o.x, c.y - o.y) < o.r + 0.6)) continue;
		x = c.x;
		y = c.y;
		break;
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
 * Can't stand here: water, an ice block, the igloo or a resting snowball.
 *
 * @param {Arena} arena
 * @param {number} x
 * @param {number} y
 * @param {number} pad
 * @param {number} [t]
 */
export function blocked(arena, x, y, pad, t = 0) {
	if (!onIsland(arena, x, y, t)) return true;
	for (const o of [...arena.obstacles, ...arena.balls]) {
		if ((x - o.x) ** 2 + (y - o.y) ** 2 < (o.r + pad) ** 2) return true;
	}
	return inBlock(arena, t, x, y, pad - CELL / 2 + 0.1);
}

/**
 * Start positions for `n` penguins, spread around the board on tile centres.
 *
 * @param {Arena} arena
 * @param {number} n
 * @returns {{ x: number, y: number, face: number }[]}
 */
export function startSpots(arena, n) {
	const out = [];
	for (let s = 0; s < n; s++) {
		const a = Math.PI / 4 + (s / n) * Math.PI * 2;
		const want = arena.R * 0.52;
		let best = { x: 0, y: 0 };
		let bestScore = Infinity;
		for (let k = 0; k < arena.level.length; k++) {
			if ((arena.level[k] ?? -1) !== 0 || arena.block[k]) continue;
			const c = tileCenter(arena, k);
			if (arena.obstacles.some((o) => Math.hypot(c.x - o.x, c.y - o.y) < o.r + 0.7)) continue;
			const da = Math.abs(
				Math.atan2(Math.sin(Math.atan2(c.y, c.x) - a), Math.cos(Math.atan2(c.y, c.x) - a)),
			);
			const score = da * 4 + Math.abs(Math.hypot(c.x, c.y) - want);
			if (score < bestScore) {
				bestScore = score;
				best = c;
			}
		}
		out.push({ ...best, face: Math.atan2(-best.y, -best.x) });
	}
	return out;
}

/**
 * Somewhere safe to drop a penguin back in: a free tile that won't sink
 * soon, away from everyone else and from the water. Not seed-derived — only
 * the respawning penguin's owner asks.
 *
 * @param {Arena} arena
 * @param {number} t
 * @param {{ x: number, y: number }[]} others
 * @returns {{ x: number, y: number }}
 */
export function respawnSpot(arena, t, others) {
	let best = { x: 0, y: 0 };
	let bestScore = -Infinity;
	for (let k = 0; k < arena.level.length; k++) {
		if ((arena.level[k] ?? -1) < 0 || (arena.crack[k] ?? Infinity) < t + 4000) continue;
		const c = tileCenter(arena, k);
		if (blocked(arena, c.x, c.y, 0.5, t)) continue;
		let near = 6;
		for (const o of others) near = Math.min(near, Math.hypot(o.x - c.x, o.y - c.y));
		const score =
			Math.min(near, 4) - edginess(arena, c.x, c.y, t) * 3 - Math.hypot(c.x, c.y) * 0.1;
		if (score > bestScore) {
			bestScore = score;
			best = c;
		}
	}
	return best;
}

/**
 * How close to falling in a point is: 0 well inland … 1 right at the water.
 *
 * @param {Arena} arena
 * @param {number} x
 * @param {number} y
 * @param {number} t
 */
export function edginess(arena, x, y, t) {
	let d = 3;
	const ci = Math.floor((x + (arena.n * CELL) / 2) / CELL);
	const cj = Math.floor((y + (arena.n * CELL) / 2) / CELL);
	const half = CELL / 2;
	for (let j = cj - 3; j <= cj + 3; j++) {
		for (let i = ci - 3; i <= ci + 3; i++) {
			const k = idx(arena, i, j);
			if (k >= 0 && (arena.level[k] ?? -1) >= 0 && !tileSunk(arena, k, t)) continue;
			const h = ((arena.n - 1) * CELL) / 2;
			const tx = i * CELL - h;
			const ty = j * CELL - h;
			const dx = Math.max(0, Math.abs(x - tx) - half);
			const dy = Math.max(0, Math.abs(y - ty) - half);
			d = Math.min(d, Math.hypot(dx, dy));
		}
	}
	return Math.max(0, 1 - d / 2.5);
}

/** The four grid directions. */
const AXES = [
	{ x: 1, y: 0 },
	{ x: 0, y: 1 },
	{ x: -1, y: 0 },
	{ x: 0, y: -1 },
];

/**
 * Snap a direction to the nearest grid axis — snowballs roll along rows and
 * columns.
 *
 * @param {number} angle
 */
export function axisOf(angle) {
	const q = ((Math.round(angle / (Math.PI / 2)) % 4) + 4) % 4;
	return /** @type {{ x: number, y: number }} */ (AXES[q]);
}

/**
 * The directions a giant snowball can be pushed: only downhill, i.e. toward
 * a lower step.
 *
 * @param {Arena} arena
 * @param {number} ball
 * @returns {{ x: number, y: number }[]}
 */
export function downhillDirs(arena, ball) {
	const home = arena.balls[ball];
	if (!home) return [];
	const lv = arena.level[home.k] ?? 0;
	return AXES.filter((a) => {
		const k = tileAt(arena, home.x + a.x * CELL, home.y + a.y * CELL);
		return k >= 0 && (arena.level[k] ?? -1) >= 0 && (arena.level[k] ?? 0) < lv;
	});
}

/**
 * Giant snowballs only go downhill: a shove has to come from the uphill side.
 *
 * @param {Arena} arena
 * @param {number} ball
 * @param {number} angle Direction of the shove.
 */
export function kickAllowed(arena, ball, angle) {
	const a = axisOf(angle);
	return downhillDirs(arena, ball).some((d) => d.x === a.x && d.y === a.y);
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
 * A giant snowball's roll after a kick: straight along a row or column,
 * speeding up at every step down, slowing on the flat. It splashes into the
 * first water it meets, or stops (and crumbles) against an ice block, the
 * igloo, a step up or when it runs out of speed. Deterministic, so every
 * client draws the same roll.
 *
 * @param {Arena} arena
 * @param {number} ball
 * @param {number} angle
 * @param {number} t0
 * @returns {Roll}
 */
export function rollPath(arena, ball, angle, t0) {
	const dir = axisOf(angle);
	const key = `${arena.seed}:${arena.id}:${ball}:${dir.x},${dir.y}:${t0}`;
	const hit = rollCache.get(key);
	if (hit) return hit;
	const home = arena.balls[ball] ?? { k: 0, x: 0, y: 0, r: BALL_R };
	let x = home.x;
	let y = home.y;
	let v = BALL_KICK_SPEED;
	let lv = arena.level[home.k] ?? 0;
	const dt = 1 / 60;
	/** @type {number[]} */
	const pts = [x, y];
	/** @type {'splash' | 'stop'} */
	let end = 'stop';
	let ms = 0;
	while (ms < BALL_MAX_ROLL_MS) {
		v -= 1.1 * dt;
		const nx = x + dir.x * v * dt;
		const ny = y + dir.y * v * dt;
		ms += 1000 / 60;
		// Look at the tile the ball's leading edge is entering.
		const k = tileAt(arena, nx + dir.x * 0.2, ny + dir.y * 0.2);
		const water = k < 0 || (arena.level[k] ?? -1) < 0 || tileSunk(arena, k, t0 + ms);
		if (water) {
			// Over the edge: let the centre roll onto the water and drop.
			x = nx;
			y = ny;
			pts.push(x, y);
			if (!onIsland(arena, x, y, t0 + ms)) {
				end = 'splash';
				break;
			}
			continue;
		}
		const nl = arena.level[k] ?? 0;
		const lead = { x: nx + dir.x * BALL_R * 0.9, y: ny + dir.y * BALL_R * 0.9 };
		const kl = tileAt(arena, lead.x, lead.y);
		const wall =
			(kl >= 0 && arena.block[kl] === 1 && t0 + ms < WALLS_CRUMBLE_MS) ||
			(kl >= 0 && (arena.level[kl] ?? -1) > lv) ||
			arena.obstacles.some((o) => Math.hypot(lead.x - o.x, lead.y - o.y) < o.r);
		if (wall) break;
		if (nl < lv) {
			v += 2.4 * (lv - nl);
			lv = nl;
		}
		x = nx;
		y = ny;
		pts.push(x, y);
		if (v < 0.35) break;
	}
	const roll = { t0, pts: new Float32Array(pts), ms, end };
	if (rollCache.size > 64) rollCache.clear();
	rollCache.set(key, roll);
	return roll;
}
