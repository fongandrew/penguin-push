/**
 * Computer penguins. They run on whichever screen owns them (the host online,
 * you in solo), so plain `Math.random` is fine — nothing here is seed-derived.
 *
 * The plan, re-evaluated a few times a second: stay off the edge, dodge what
 * the map throws at you, grab nearby jars, and otherwise sneak round the
 * *inland* side of someone near the water and shove them in. Now and then,
 * line up a giant snowball on whoever's downhill.
 */

import { edginess, floeAt, jarAt, jarIndicesAround, shrinkAt, waveAt } from './arena.js';
import { BALL_R, PENGUIN_R, SHOVE_RANGE, SNOWBALL_RANGE } from './constants.js';
import { ballAt, jarAvailable } from './contest.js';
import { angleDiff, floeUnder } from './physics.js';

/** @typedef {import('./state.js').State} State */
/** @typedef {import('./state.js').Penguin} Penguin */
/** @typedef {import('./state.js').Input} Input */

/**
 * @typedef {object} Brain
 * @property {number} target Penguin id, -1 none.
 * @property {number} thinkMs Until the next re-plan.
 * @property {number} ball Giant snowball mission, -1 none.
 * @property {number} react Random shove reaction delay, ms.
 * @property {number} wobble Steering noise phase.
 * @property {number} skill 0..1
 * @property {number} calmMs After a shove: wander for a moment.
 */

/** @type {WeakMap<Penguin, Brain>} */
const brains = new WeakMap();

/**
 * @param {Penguin} p
 * @returns {Brain}
 */
function brainOf(p) {
	let b = brains.get(p);
	if (!b) {
		b = {
			target: -1,
			thinkMs: 0,
			ball: -1,
			react: 0,
			wobble: Math.random() * 10,
			skill: 0.45 + Math.random() * 0.35,
			calmMs: 0,
		};
		brains.set(p, b);
	}
	return b;
}

/**
 * @param {State} state
 * @param {Penguin} p
 * @param {number} t
 * @returns {Input}
 */
export function botInput(state, p, t) {
	/** @type {Input} */
	const none = { mx: 0, my: 0, shove: false, power: false };
	const arena = state.arena;
	if (!arena || p.mode !== 'play' || p.stunMs > 0) return none;
	const brain = brainOf(p);
	const dt = 1000 / 60;
	brain.thinkMs -= dt;
	brain.calmMs = Math.max(0, brain.calmMs - dt);
	brain.wobble += dt / 1000;

	const others = state.penguins.filter((q) => q !== p && q.mode === 'play');

	if (brain.thinkMs <= 0) {
		brain.thinkMs = 500 + Math.random() * 900;
		let best = -1;
		let bestScore = Infinity;
		for (const q of others) {
			const d = Math.hypot(q.x - p.x, q.y - p.y);
			const score = d - edginess(arena, q.x, q.y, t) * 4 + (q.invulnMs > 0 ? 6 : 0);
			if (score < bestScore) {
				bestScore = score;
				best = q.id;
			}
		}
		brain.target = best;
		brain.ball = -1;
		if (arena.balls.length && Math.random() < 0.35) {
			const i = Math.floor(Math.random() * arena.balls.length);
			const home = arena.balls[i];
			if (
				home &&
				ballAt(arena, state.contest, i, t).kind === 'rest' &&
				Math.hypot(home.x - p.x, home.y - p.y) < 6
			) {
				brain.ball = i;
			}
		}
	}

	let gx = 0;
	let gy = 0;
	let wantShove = false;
	let wantPower = false;

	// 1. Danger first: edges, sinking floes, waves, rolling snowballs.
	const edge = edginess(arena, p.x, p.y, t);
	const fi = floeUnder(arena, p.x, p.y, t);
	const floe = fi >= 0 ? arena.floes[fi] : undefined;
	const floeDanger = floe ? floeAt(floe, t).warn || floeAt(floe, t).sink > 0 : false;
	const wave = waveAt(arena, t);
	const shrinking = shrinkAt(t) < 1;

	if (edge > 0.78 || floeDanger || (floe && Math.random() < 0.02)) {
		gx = -p.x;
		gy = -p.y;
	} else if (
		wave &&
		(wave.phase === 'warn' || wave.front < p.x * Math.cos(wave.dir) + p.y * Math.sin(wave.dir))
	) {
		// Get behind the igloo if there is one, else upwave of centre.
		const ig = arena.igloo;
		const ux = Math.cos(wave.dir);
		const uy = Math.sin(wave.dir);
		if (ig) {
			gx = ig.x + ux * (ig.r + 0.7) - p.x;
			gy = ig.y + uy * (ig.r + 0.7) - p.y;
		} else {
			gx = -ux * 2 - p.x;
			gy = -uy * 2 - p.y;
		}
	} else {
		let dodged = false;
		arena.balls.forEach((_, i) => {
			const b = ballAt(arena, state.contest, i, t);
			if (b.kind !== 'roll' || dodged) return;
			const dx = p.x - b.x;
			const dy = p.y - b.y;
			const sp = Math.hypot(b.vx, b.vy);
			if (sp < 1 || Math.hypot(dx, dy) > 4.5) return;
			// Step sideways out of its path.
			const side = (-b.vy * dx + b.vx * dy) / sp >= 0 ? 1 : -1;
			gx = (-b.vy / sp) * side;
			gy = (b.vx / sp) * side;
			dodged = true;
		});

		if (!dodged) {
			const jar = nearestJar(state, p, t);
			const target = state.penguins[brain.target];
			const ballHome = brain.ball >= 0 ? arena.balls[brain.ball] : undefined;
			if (jar && (!target || jar.d < Math.hypot(target.x - p.x, target.y - p.y) * 0.8)) {
				gx = jar.x - p.x;
				gy = jar.y - p.y;
			} else if (
				ballHome &&
				ballAt(arena, state.contest, brain.ball, t).kind === 'rest' &&
				target
			) {
				// Line up uphill of the ball, opposite the victim, and charge.
				const vx = target.x - ballHome.x;
				const vy = target.y - ballHome.y;
				const vd = Math.hypot(vx, vy) || 1;
				const sx = ballHome.x - (vx / vd) * (BALL_R + PENGUIN_R + 0.5);
				const sy = ballHome.y - (vy / vd) * (BALL_R + PENGUIN_R + 0.5);
				const ds = Math.hypot(sx - p.x, sy - p.y);
				if (ds > 0.45) {
					gx = sx - p.x;
					gy = sy - p.y;
				} else {
					gx = ballHome.x - p.x;
					gy = ballHome.y - p.y;
				}
			} else if (target && target.mode === 'play' && brain.calmMs <= 0) {
				// Come at them from the inland side so the shove points seaward.
				const td = Math.hypot(target.x, target.y) || 1;
				const ox = target.x / td;
				const oy = target.y / td;
				const ax = target.x - ox * 0.95;
				const ay = target.y - oy * 0.95;
				const dist = Math.hypot(target.x - p.x, target.y - p.y);
				if (dist < 2.2) {
					gx = target.x - p.x;
					gy = target.y - p.y;
				} else {
					gx = ax - p.x;
					gy = ay - p.y;
				}
				const facing = Math.abs(
					angleDiff(Math.atan2(target.y - p.y, target.x - p.x), p.face),
				);
				if (dist < SHOVE_RANGE * 0.95 && facing < 0.8) {
					brain.react -= dt;
					if (brain.react <= 0) {
						wantShove = true;
						brain.react = 200 + Math.random() * 650 * (1.2 - brain.skill);
						if (Math.random() < 0.6) brain.calmMs = 500 + Math.random() * 1300;
					}
				}
				if (
					p.power === 'snowball' &&
					dist < SNOWBALL_RANGE * 0.7 &&
					Math.random() < 0.025
				) {
					wantPower = true;
				}
				if (
					p.power === 'slide' &&
					dist < 4.5 &&
					facing < 0.22 &&
					edginess(arena, target.x, target.y, t) > 0.45 &&
					Math.random() < 0.08
				) {
					wantPower = true;
				}
			} else {
				gx = -p.x * 0.3 + Math.cos(brain.wobble) * 2;
				gy = -p.y * 0.3 + Math.sin(brain.wobble * 0.7) * 2;
			}
		}
	}

	// Don't walk off the edge while chasing.
	const nd = Math.hypot(p.x, p.y) || 1;
	const outward = (gx * p.x + gy * p.y) / nd;
	if (outward > 0 && edge > (shrinking ? 0.55 : 0.65)) {
		gx -= (p.x / nd) * outward * 1.3;
		gy -= (p.y / nd) * outward * 1.3;
	}

	const gl = Math.hypot(gx, gy);
	if (gl < 0.05) return { ...none, shove: wantShove, power: wantPower };
	const noise = 0.25 * (1 - brain.skill);
	const ang = Math.atan2(gy, gx) + Math.sin(brain.wobble * 3) * noise;
	const sp = Math.min(1, gl / 0.6) * (0.75 + 0.25 * brain.skill);
	return { mx: Math.cos(ang) * sp, my: Math.sin(ang) * sp, shove: wantShove, power: wantPower };
}

/**
 * @param {State} state
 * @param {Penguin} p
 * @param {number} t
 */
function nearestJar(state, p, t) {
	const arena = state.arena;
	if (!arena) return null;
	/** @type {{ x: number, y: number, d: number } | null} */
	let best = null;
	for (const i of jarIndicesAround(t)) {
		if (!jarAvailable(arena, state.contest, i, t)) continue;
		const jar = jarAt(arena, i);
		const d = Math.hypot(jar.x - p.x, jar.y - p.y);
		if (d < 5.5 && (!best || d < best.d)) best = { x: jar.x, y: jar.y, d };
	}
	return best;
}
