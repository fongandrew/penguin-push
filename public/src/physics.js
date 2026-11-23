/**
 * Moving one penguin you own: steering on ice, hills, floes, obstacles, and
 * the fall-in / drop-back-in cycle. Pure apart from mutating the penguin.
 */

import { floeAt, gradientAt, heightAt, respawnSpot, supportAt } from './arena.js';
import {
	FALL_MS,
	ICE_DRAG,
	INVULN_MS,
	KNOCK_MS,
	PENGUIN_GRAVITY,
	PENGUIN_R,
	RESPAWN_HEIGHT,
	RESPAWN_MS,
	SLICK_DRAG,
	SLIDE_SPEED,
	WALK_ACCEL,
	WALK_SPEED,
} from './constants.js';

/** @typedef {import('./arena.js').Arena} Arena */
/** @typedef {import('./state.js').Penguin} Penguin */
/** @typedef {import('./state.js').Input} Input */

/**
 * @typedef {object} MoveResult
 * @property {boolean} fell Just went over the edge.
 * @property {boolean} landed Just landed from a respawn drop.
 * @property {boolean} done Finished falling (lose a life now).
 */

/**
 * @param {Penguin} p
 * @param {Input} input
 * @param {Arena} arena
 * @param {number} t Match time, ms.
 * @param {number} dt Seconds.
 * @param {{ x: number, y: number }[]} others Where everyone else is (for respawn).
 * @param {{ x: number, y: number, r: number }[]} solids Extra solid circles (resting snowballs).
 * @returns {MoveResult}
 */
export function movePenguin(p, input, arena, t, dt, others, solids) {
	const ms = dt * 1000;
	const res = { fell: false, landed: false, done: false };
	p.stunMs = Math.max(0, p.stunMs - ms);
	p.invulnMs = Math.max(0, p.invulnMs - ms);
	p.knockMs = Math.max(0, p.knockMs - ms);
	p.shoveMs = Math.max(0, p.shoveMs - ms);
	p.cooldownMs = Math.max(0, p.cooldownMs - ms);
	p.megaMs = Math.max(0, p.megaMs - ms);
	p.slideMs = Math.max(0, p.slideMs - ms);
	p.modeMs += ms;

	if (p.mode === 'out') return res;

	if (p.mode === 'fall') {
		p.vx *= 1 - 2 * dt;
		p.vy *= 1 - 2 * dt;
		p.x += p.vx * dt;
		p.y += p.vy * dt;
		p.z = -1.6 * Math.min(1, p.modeMs / FALL_MS) - 0.3;
		if (p.modeMs >= FALL_MS) res.done = true;
		return res;
	}

	if (p.mode === 'respawn') {
		const k = Math.min(1, p.modeMs / RESPAWN_MS);
		p.z = heightAt(arena, p.x, p.y) + RESPAWN_HEIGHT * (1 - k * k);
		p.vx = 0;
		p.vy = 0;
		if (k >= 1) {
			p.mode = 'play';
			p.modeMs = 0;
			p.invulnMs = INVULN_MS;
			res.landed = true;
		}
		return res;
	}

	const here = supportAt(arena, p.x, p.y, t);
	const drag = here.slick ? SLICK_DRAG : ICE_DRAG;

	let mx = input.mx;
	let my = input.my;
	const mag = Math.hypot(mx, my);
	if (mag > 1) {
		mx /= mag;
		my /= mag;
	}
	if (p.stunMs > 0) {
		mx = 0;
		my = 0;
	}

	if (p.slideMs > 0) {
		// Belly slide: locked to the facing direction, no steering.
		const sp = SLIDE_SPEED * (0.55 + 0.45 * (p.slideMs / 650));
		p.vx = Math.cos(p.face) * sp;
		p.vy = Math.sin(p.face) * sp;
	} else {
		// Relative to whatever we're standing on, so a drifting floe carries us.
		let rvx = p.vx - here.vx;
		let rvy = p.vy - here.vy;
		const control = p.knockMs > 0 ? 0.18 : here.slick ? 0.35 : 1;
		if (mx !== 0 || my !== 0) {
			const tx = mx * WALK_SPEED;
			const ty = my * WALK_SPEED;
			let ax = tx - rvx;
			let ay = ty - rvy;
			const al = Math.hypot(ax, ay);
			const max = WALK_ACCEL * control * dt;
			if (al > max) {
				ax = (ax / al) * max;
				ay = (ay / al) * max;
			}
			// Faster than walking (just got shoved): let drag do the slowing.
			if (Math.hypot(rvx, rvy) > WALK_SPEED * 1.05) {
				ax *= 0.3;
				ay *= 0.3;
			}
			rvx += ax;
			rvy += ay;
			if (p.stunMs <= 0 && p.knockMs <= 0)
				p.face = turnToward(p.face, Math.atan2(my, mx), 14 * dt);
		}
		const damp =
			mx !== 0 || my !== 0 ? Math.max(0, 1 - drag * 0.15 * dt) : Math.exp(-drag * dt);
		rvx *= damp;
		rvy *= damp;
		p.vx = rvx + here.vx;
		p.vy = rvy + here.vy;
	}

	// The hill pulls you downhill a little.
	const g = gradientAt(arena, p.x, p.y);
	p.vx -= g.x * PENGUIN_GRAVITY * dt;
	p.vy -= g.y * PENGUIN_GRAVITY * dt;

	p.x += p.vx * dt;
	p.y += p.vy * dt;

	for (const o of [...arena.obstacles, ...solids]) {
		const dx = p.x - o.x;
		const dy = p.y - o.y;
		const d = Math.hypot(dx, dy);
		const min = o.r + PENGUIN_R;
		if (d < min && d > 1e-6) {
			const nx = dx / d;
			const ny = dy / d;
			p.x = o.x + nx * min;
			p.y = o.y + ny * min;
			const vn = p.vx * nx + p.vy * ny;
			if (vn < 0) {
				p.vx -= 1.4 * vn * nx;
				p.vy -= 1.4 * vn * ny;
			}
		}
	}

	p.z = heightAt(arena, p.x, p.y);
	p.speed = Math.hypot(p.vx - here.vx, p.vy - here.vy);

	if (!supportAt(arena, p.x, p.y, t).ok) {
		p.mode = 'fall';
		p.modeMs = 0;
		p.slideMs = 0;
		p.stunMs = 0;
		res.fell = true;
	}
	void others;
	return res;
}

/**
 * Put a penguin back on the ice from the sky.
 *
 * @param {Penguin} p
 * @param {Arena} arena
 * @param {number} t
 * @param {{ x: number, y: number }[]} others
 */
export function beginRespawn(p, arena, t, others) {
	const spot = respawnSpot(arena, t, others);
	p.x = spot.x;
	p.y = spot.y;
	p.vx = 0;
	p.vy = 0;
	p.mode = 'respawn';
	p.modeMs = 0;
	p.z = RESPAWN_HEIGHT;
	p.invulnMs = INVULN_MS + RESPAWN_MS;
	p.knockMs = 0;
	p.stunMs = 0;
}

/**
 * Knock a penguin you own (shove, bump, wave, giant snowball…).
 *
 * @param {Penguin} p
 * @param {number} ix
 * @param {number} iy
 * @param {number} stunMs
 * @returns {boolean} False if it bounced off invulnerability.
 */
export function knock(p, ix, iy, stunMs) {
	if (p.mode !== 'play' || p.invulnMs > 0) return false;
	p.vx += ix;
	p.vy += iy;
	p.knockMs = Math.max(p.knockMs, KNOCK_MS * Math.min(1.6, Math.hypot(ix, iy) / 8 + 0.4));
	if (stunMs > 0) p.stunMs = Math.max(p.stunMs, stunMs);
	p.slideMs = 0;
	return true;
}

/**
 * @param {number} from
 * @param {number} to
 * @param {number} maxStep
 */
export function turnToward(from, to, maxStep) {
	let d = (to - from) % (Math.PI * 2);
	if (d > Math.PI) d -= Math.PI * 2;
	if (d < -Math.PI) d += Math.PI * 2;
	if (Math.abs(d) <= maxStep) return to;
	return from + Math.sign(d) * maxStep;
}

/**
 * Where a penguin's floe is, if it's standing on one (for camera/FX).
 *
 * @param {Arena} arena
 * @param {number} x
 * @param {number} y
 * @param {number} t
 */
export function floeUnder(arena, x, y, t) {
	for (let i = 0; i < arena.floes.length; i++) {
		const f = arena.floes[i];
		if (!f) continue;
		const st = floeAt(f, t);
		if ((x - st.x) ** 2 + (y - st.y) ** 2 < f.r * f.r) return i;
	}
	return -1;
}

/**
 * Signed smallest difference between two angles.
 *
 * @param {number} a
 * @param {number} b
 */
export function angleDiff(a, b) {
	let d = (a - b) % (Math.PI * 2);
	if (d > Math.PI) d -= Math.PI * 2;
	if (d < -Math.PI) d += Math.PI * 2;
	return d;
}
