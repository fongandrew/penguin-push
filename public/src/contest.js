/**
 * Contested state: things two penguins can try to take at the same instant —
 * a power-up jar, or the first shove on a resting giant snowball.
 *
 * `applyClaim` is a pure reducer. Online, every client replays the relay's
 * ordered claims through it (the first valid claim wins, later ones are
 * refused), then layers its own not-yet-confirmed claims on top for display.
 * Solo play runs the same reducer directly.
 */

import { jarAt, kickAllowed, onIsland, rollPath, tileSunk } from './arena.js';
import { BALL_GONE_MS, BALL_RESPAWN_MS } from './constants.js';

/** @typedef {import('./arena.js').Arena} Arena */
/** @typedef {import('./arena.js').Roll} Roll */

/**
 * @typedef {{ type: 'grab', jar: number, by: number, t: number }
 * 	| { type: 'kick', ball: number, angle: number, by: number, t: number }} Claim
 */

/**
 * @typedef {object} Kick
 * @property {number} t
 * @property {number} angle
 * @property {number} by
 *
 * @typedef {object} Contest
 * @property {Map<number, number>} jars Jar number → penguin who got it.
 * @property {Kick[][]} kicks Accepted kicks, per giant snowball.
 */

/**
 * @param {number} balls
 * @returns {Contest}
 */
export function freshContest(balls) {
	return { jars: new Map(), kicks: Array.from({ length: balls }, () => []) };
}

/**
 * @param {Contest} c
 * @returns {Contest}
 */
export function cloneContest(c) {
	return { jars: new Map(c.jars), kicks: c.kicks.map((k) => k.slice()) };
}

/**
 * @typedef {{ kind: 'rest' }
 * 	| { kind: 'roll', x: number, y: number, vx: number, vy: number, spin: number, kick: Kick, roll: Roll }
 * 	| { kind: 'gone', x: number, y: number, end: 'splash' | 'stop', k: number, kick: Kick }
 * 	| { kind: 'away' }} BallState
 */

/**
 * Where giant snowball `ball` is at time `t`, given its accepted kicks.
 *
 * @param {Arena} arena
 * @param {Contest} c
 * @param {number} ball
 * @param {number} t
 * @returns {BallState}
 */
export function ballAt(arena, c, ball, t) {
	const kicks = c.kicks[ball] ?? [];
	const home = arena.balls[ball];
	// Its step sank in sudden death: it went with it.
	if (!home || tileSunk(arena, home.k, t)) return { kind: 'away' };
	let last = null;
	for (const k of kicks) if (k.t <= t) last = k;
	if (!last) return { kind: 'rest' };
	const roll = rollPath(arena, ball, last.angle, last.t);
	const dt = t - last.t;
	if (dt < roll.ms) {
		const n = roll.pts.length / 2;
		const f = Math.min(n - 1, (dt / 1000) * 60);
		const i = Math.floor(f);
		const j = Math.min(n - 1, i + 1);
		const u = f - i;
		const ax = roll.pts[i * 2] ?? 0;
		const ay = roll.pts[i * 2 + 1] ?? 0;
		const bx = roll.pts[j * 2] ?? ax;
		const by = roll.pts[j * 2 + 1] ?? ay;
		return {
			kind: 'roll',
			x: ax + (bx - ax) * u,
			y: ay + (by - ay) * u,
			vx: (bx - ax) * 60,
			vy: (by - ay) * 60,
			spin: dt,
			kick: last,
			roll,
		};
	}
	const after = dt - roll.ms;
	if (after < BALL_GONE_MS) {
		const n = roll.pts.length;
		return {
			kind: 'gone',
			x: roll.pts[n - 2] ?? 0,
			y: roll.pts[n - 1] ?? 0,
			end: roll.end,
			k: after / BALL_GONE_MS,
			kick: last,
		};
	}
	if (after < BALL_GONE_MS + BALL_RESPAWN_MS) return { kind: 'away' };
	return { kind: 'rest' };
}

/**
 * Is jar `i` on the ice and up for grabs at time `t`?
 *
 * @param {Arena} arena
 * @param {Contest} c
 * @param {number} i
 * @param {number} t
 */
export function jarAvailable(arena, c, i, t) {
	if (c.jars.has(i)) return false;
	const jar = jarAt(arena, i);
	return t >= jar.spawn && t < jar.expire && onIsland(arena, jar.x, jar.y, t);
}

/**
 * Apply one claim. Returns false (and changes nothing) when it's refused —
 * somebody else got there first, or it was never valid.
 *
 * @param {Contest} c
 * @param {Arena} arena
 * @param {Claim} claim
 * @returns {boolean}
 */
export function applyClaim(c, arena, claim) {
	if (claim.type === 'grab') {
		if (!jarAvailable(arena, c, claim.jar, claim.t)) return false;
		c.jars.set(claim.jar, claim.by);
		return true;
	}
	const kicks = c.kicks[claim.ball];
	if (!kicks) return false;
	if (!kickAllowed(arena, claim.ball, claim.angle)) return false;
	if (ballAt(arena, c, claim.ball, claim.t).kind !== 'rest') return false;
	// Keep kicks time-ordered even if a claim arrives a little late.
	if (kicks.some((k) => k.t > claim.t)) return false;
	kicks.push({ t: claim.t, angle: claim.angle, by: claim.by });
	return true;
}
