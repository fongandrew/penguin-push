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
		blurb: 'Big waves! Hide behind the igloo.',
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
 * @typedef {object} Hill
 * @property {number} x
 * @property {number} y
 * @property {number} h Peak height.
 * @property {number} s Spread (gaussian sigma).
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
 * @property {Circle[]} obstacles Solid things (igloo, rocks).
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
		igloo: null,
		slick: [],
		waves: null,
		jarCache: new Map(),
	};

	if (id === 'hill') {
		arena.R = 8.6;
		const hx = (rng() - 0.5) * 1.5;
		arena.hill = { x: hx, y: -2.5, h: 2.4, s: 2.2 };
		arena.balls = [
			{ x: hx - 1.05, y: -2.75, r: BALL_R },
			{ x: hx + 1.05, y: -2.75, r: BALL_R },
		];
	} else if (id === 'floes') {
		arena.R = 6.0;
		const n = 4;
		for (let i = 0; i < n; i++) {
			const shape = [];
			for (let j = 0; j < 9; j++) shape.push(0.85 + rng() * 0.25);
			arena.floes.push({
				orbit: 7.35,
				speed: 0.15,
				phase: (i / n) * Math.PI * 2 + rng() * 0.3,
				r: 1.95,
				offset: i * 3400 + Math.floor(rng() * 900),
				shape,
			});
		}
		arena.slick.push({ x: 0, y: 0, r: 1.6 });
	} else {
		arena.R = 8.3;
		arena.igloo = { x: 2.4, y: -1.6, r: 1.45 };
		arena.obstacles = [arena.igloo, { x: -3.4, y: 2.1, r: 0.55 }, { x: -0.7, y: -4.6, r: 0.5 }];
		arena.slick = [
			{ x: -2.4, y: -1.6, r: 1.8 },
			{ x: 2.4, y: 3.0, r: 1.5 },
		];
		arena.waves = { first: 9000, every: 8000, warn: 2600, travel: 2300, reach: 13 };
	}
	return arena;
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
	return h.h * Math.exp(-(dx * dx + dy * dy) / (2 * h.s * h.s));
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
	const k = -z / (h.s * h.s);
	return { x: k * (x - h.x), y: k * (y - h.y) };
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
	if (onIsland(arena, x, y, t)) return { ok: true, vx: 0, vy: 0, slick };
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
 * True when the igloo stands between a wave and the point (x, y).
 *
 * @param {Arena} arena
 * @param {number} dir
 * @param {number} x
 * @param {number} y
 */
export function shelteredFrom(arena, dir, x, y) {
	const ig = arena.igloo;
	if (!ig) return false;
	const ux = Math.cos(dir);
	const uy = Math.sin(dir);
	const along = (x - ig.x) * ux + (y - ig.y) * uy;
	const side = Math.abs(-(x - ig.x) * uy + (y - ig.y) * ux);
	return along > 0 && along < 4.5 && side < ig.r * 0.95;
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
		if (!blocked(arena, x, y, 0.7)) break;
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
		kind: roll < 0.3 ? 'heart' : 'fish',
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
		let a = Math.PI / 4 + (i / n) * Math.PI * 2;
		let x = 0;
		let y = 0;
		for (let tries = 0; tries < 12; tries++) {
			const r = edgeRadius(arena, a) * (arena.floes.length ? 0.5 : 0.52);
			x = Math.cos(a) * r;
			y = Math.sin(a) * r;
			if (!blocked(arena, x, y, 0.6)) break;
			a += 0.35;
		}
		out.push({ x, y, face: Math.atan2(-y, -x) });
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
		ms += 1000 / 60;
		pts.push(x, y);
		if (!onIsland(arena, x, y, t0 + ms)) {
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
