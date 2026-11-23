/**
 * Computer penguins. They run on whichever screen owns them (the host online,
 * you in solo), so plain `Math.random` is fine — nothing here is seed-derived.
 *
 * The plan, re-evaluated a few times a second: stay off the edge, dodge what
 * the map throws at you, grab nearby jars, and otherwise sneak round the
 * *inland* side of someone near the water and shove them in. Now and then,
 * line up a giant snowball on whoever's downhill.
 */

import {
	blocksAt,
	CELL,
	downhillDirs,
	edginess,
	floeAt,
	jarAt,
	jarIndicesAround,
	waveAt,
} from './arena.js';
import { BALL_R, PENGUIN_R, SHOVE_RANGE, SNOWBALL_RANGE } from './constants.js';
import { ballAt, jarAvailable } from './contest.js';
import { clearLine, navFor, route, safeAhead } from './nav.js';
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
 * @property {number} lastX Where it was at the last progress check.
 * @property {number} lastY
 * @property {number} checkMs Until the next progress check.
 * @property {number} unstickMs Wandering to get unstuck.
 * @property {number} wanderA Which way to wander.
 * @property {boolean} sloppy Not watching its feet right now (can blunder in).
 * @property {number} daydreamMs Waddling off somewhere without looking.
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
			lastX: p.x,
			lastY: p.y,
			checkMs: 1500,
			unstickMs: 0,
			wanderA: Math.random() * Math.PI * 2,
			sloppy: false,
			daydreamMs: 0,
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
	brain.unstickMs = Math.max(0, brain.unstickMs - dt);
	brain.daydreamMs = Math.max(0, brain.daydreamMs - dt);
	// Progress check: barely moved in 1.5 s? Re-plan and wander a bit.
	brain.checkMs -= dt;
	if (brain.checkMs <= 0) {
		brain.checkMs = 1500;
		if (Math.hypot(p.x - brain.lastX, p.y - brain.lastY) < 0.6) {
			brain.unstickMs = 900 + Math.random() * 700;
			brain.wanderA = Math.random() * Math.PI * 2;
			brain.thinkMs = 0;
			brain.target = -1;
			brain.ball = -1;
		}
		brain.lastX = p.x;
		brain.lastY = p.y;
	}
	brain.wobble += dt / 1000;

	const others = state.penguins.filter((q) => q !== p && q.mode === 'play');

	if (brain.thinkMs <= 0) {
		brain.thinkMs = 500 + Math.random() * 900;
		// Now and then (more often for clumsier bots) it stops watching its
		// feet for a moment — that's how computer penguins fall in by mistake.
		brain.sloppy = Math.random() < 0.5 * (1 - brain.skill);
		if (brain.sloppy && Math.random() < 0.5) {
			brain.daydreamMs = 900 + Math.random() * 900;
			brain.wanderA = Math.random() * Math.PI * 2;
		}
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
	let charging = false;
	let wantPower = false;

	// 1. Danger first: edges, sinking floes, waves, rolling snowballs.
	const edge = edginess(arena, p.x, p.y, t);
	const fi = floeUnder(arena, p.x, p.y, t);
	/** @type {{ x: number, y: number, gain: number }} */
	let safe = { x: p.x, y: p.y, gain: 0 };
	const floe = fi >= 0 ? arena.floes[fi] : undefined;
	const floeDanger = floe ? floeAt(floe, t).warn || floeAt(floe, t).sink > 0 : false;
	const wave = waveAt(arena, t);

	if (floe && (floeDanger || Math.random() < 0.02)) {
		gx = -p.x;
		gy = -p.y;
	} else if (!brain.sloppy && edge > 0.9 && (safe = safestNear(state, p, t)).gain > 0.12) {
		// Right at the brink: step back to a clearly safer spot close by.
		gx = safe.x - p.x;
		gy = safe.y - p.y;
	} else if (brain.unstickMs > 0 || brain.daydreamMs > 0) {
		// Unsticking: wander somewhere walkable in a fresh direction.
		gx = Math.cos(brain.wanderA) * 3;
		gy = Math.sin(brain.wanderA) * 3;
	} else if (
		wave &&
		(wave.phase === 'warn' || wave.front < p.x * Math.cos(wave.dir) + p.y * Math.sin(wave.dir))
	) {
		// Get behind the nearest igloo / rock / snow wall, else upwave of centre.
		const ux = Math.cos(wave.dir);
		const uy = Math.sin(wave.dir);
		/** @type {{ x: number, y: number }[]} */
		const spots = [
			...arena.obstacles.map((o) => ({
				x: o.x + ux * (o.r + 0.6),
				y: o.y + uy * (o.r + 0.6),
			})),
			...blocksAt(arena, t).map((b) => ({
				x: b.x + ux * (CELL / 2 + 0.55),
				y: b.y + uy * (CELL / 2 + 0.55),
			})),
		];
		let best = null;
		let bestD = Infinity;
		for (const s of spots) {
			const d = Math.hypot(s.x - p.x, s.y - p.y);
			if (d < bestD && edginess(arena, s.x, s.y, t) < 0.8) {
				bestD = d;
				best = s;
			}
		}
		if (best) {
			gx = best.x - p.x;
			gy = best.y - p.y;
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
				// Pick the downhill lane that points best at the victim, get
				// behind the ball (uphill), and charge.
				let dir = { x: 0, y: 1 };
				let best = -Infinity;
				for (const d of downhillDirs(arena, brain.ball)) {
					const vx = target.x - ballHome.x;
					const vy = target.y - ballHome.y;
					const along = vx * d.x + vy * d.y;
					const off = Math.abs(vx * d.y - vy * d.x);
					const score = along > 0 ? along - off * 3 : -99;
					if (score > best) {
						best = score;
						dir = d;
					}
				}
				const sx = ballHome.x - dir.x * (BALL_R + PENGUIN_R + 0.45);
				const sy = ballHome.y - dir.y * (BALL_R + PENGUIN_R + 0.45);
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
				if (dist < 3.2) {
					// Lined up: charge, so the shove lands at full speed.
					gx = target.x - p.x;
					gy = target.y - p.y;
					charging = true;
				} else {
					gx = ax - p.x;
					gy = ay - p.y;
				}
				const facing = Math.abs(
					angleDiff(Math.atan2(target.y - p.y, target.x - p.x), p.face),
				);
				// Skilled bots wait until they're up to speed; any bot shoves at point blank.
				const atSpeed = p.speed > 2.5 * brain.skill || dist < 0.9;
				if (dist < SHOVE_RANGE * 0.95 && facing < 0.8 && atSpeed) {
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

	// Find a way around walls and holes rather than straight into them.
	const nav = navFor(arena, t);
	if (Math.hypot(gx, gy) > 0.05 && fi < 0 && !brain.sloppy) {
		const wp = route(nav, p.x, p.y, p.x + gx, p.y + gy);
		if (!wp) {
			// Boxed in (rare): pick a new direction next time round.
			brain.wanderA = Math.random() * Math.PI * 2;
			gx = 0;
			gy = 0;
		} else {
			const far = Math.hypot(gx, gy);
			gx = wp.x - p.x;
			gy = wp.y - p.y;
			const near = Math.hypot(gx, gy) || 1;
			// Keep the urgency of the original goal.
			gx *= Math.max(1, Math.min(far, 3) / near);
			gy *= Math.max(1, Math.min(far, 3) / near);
		}
		// Last-moment feelers: never step into a hole or off the edge.
		const look = 0.6 + p.speed * 0.2;
		if (!brain.sloppy && !safeAhead(nav, p.x, p.y, gx, gy, look)) {
			const base = Math.atan2(gy, gx);
			const mag = Math.hypot(gx, gy);
			for (const da of [0.5, -0.5, 1, -1, 1.6, -1.6, 2.4, -2.4]) {
				const ax = Math.cos(base + da);
				const ay = Math.sin(base + da);
				if (safeAhead(nav, p.x, p.y, ax, ay, look)) {
					gx = ax * mag;
					gy = ay * mag;
					break;
				}
			}
		}
		// Sliding toward the water? Brake against the slide.
		const drift = Math.hypot(p.vx, p.vy);
		if (
			!brain.sloppy &&
			drift > 1 &&
			!safeAhead(nav, p.x, p.y, p.vx, p.vy, drift * 0.35 + 0.3)
		) {
			gx = -p.vx / drift + gx * 0.2;
			gy = -p.vy / drift + gy * 0.2;
		}
	}
	// Tiptoe near the water: ice is slippery and turns are wide.
	const careful = edge > 0.92 ? 0.7 : 1;

	const gl = Math.hypot(gx, gy);
	if (gl < 0.05) return { ...none, shove: wantShove, power: wantPower };
	const noise = 0.25 * (1 - brain.skill);
	const ang = Math.atan2(gy, gx) + Math.sin(brain.wobble * 3) * noise;
	const sp = charging ? careful : Math.min(1, gl / 0.6) * (0.75 + 0.25 * brain.skill) * careful;
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

/**
 * The least edge-y walkable spot within a couple of tiles.
 *
 * @param {State} state
 * @param {Penguin} p
 * @param {number} t
 */
function safestNear(state, p, t) {
	const arena = /** @type {import('./arena.js').Arena} */ (state.arena);
	const nav = navFor(arena, t);
	const here = edginess(arena, p.x, p.y, t);
	let best = { x: p.x, y: p.y };
	let bestE = here;
	for (const r of [0.8, 1.5, 2.3]) {
		for (let s = 0; s < 12; s++) {
			const a = (s / 12) * Math.PI * 2;
			const x = p.x + Math.cos(a) * r;
			const y = p.y + Math.sin(a) * r;
			if (!clearLine(nav, p.x, p.y, x, y)) continue;
			const e = edginess(arena, x, y, t) + r * 0.05;
			if (e < bestE) {
				bestE = e;
				best = { x, y };
			}
		}
	}
	return { ...best, gain: here - bestE };
}
