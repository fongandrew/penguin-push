/**
 * Moving one penguin you own: steering on ice, hills, floes, obstacles, and
 * the fall-in / drop-back-in cycle. Pure apart from mutating the penguin.
 */

import {
	CELL,
	floeAt,
	heightAt,
	pushOutOfBlocks,
	respawnSpot,
	supportAt,
	tileAt,
	tileCenter,
} from './arena.js';
import {
	AXIS_SNAP,
	FALL_MS,
	GRIP_DRAG,
	ICE_DRAG,
	INVULN_MS,
	KNOCK_MS,
	LANE_ASSIST,
	PENGUIN_R,
	RESPAWN_HEIGHT,
	RESPAWN_MS,
	SLICK_DRAG,
	SLIDE_SPEED,
	TEETER_MS,
	TURN_GRIP,
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
		// Drop into the middle of the water square, never down through the
		// ice beside it.
		const k = tileAt(arena, p.x, p.y);
		if (k >= 0 && (arena.level[k] ?? -1) < 0) {
			const c = tileCenter(arena, k);
			const pull = Math.min(1, dt * 10);
			p.x += (c.x - p.x) * pull;
			p.y += (c.y - p.y) * pull;
		}
		pushClearOfIce(arena, p, t);
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

	let mx = input.mx;
	let my = input.my;
	const mag = Math.hypot(mx, my);
	if (mag > 1) {
		mx /= mag;
		my /= mag;
	}
	// A little snap to the grid: nearly-straight means straight.
	let axis = /** @type {'x' | 'y' | ''} */ ('');
	if (mag > 0.2) {
		const a = Math.atan2(my, mx);
		const q = Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
		if (Math.abs(a - q) < AXIS_SNAP) {
			const m = Math.min(1, Math.hypot(mx, my));
			mx = Math.round(Math.cos(q)) * m;
			my = Math.round(Math.sin(q)) * m;
			axis = mx !== 0 ? 'x' : 'y';
		}
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
		// Shoved and sliding faster than walking pace: that's ice. Otherwise
		// your feet grip.
		const flung = p.knockMs > 0 || Math.hypot(rvx, rvy) > WALK_SPEED * 1.1;
		const drag = here.slick ? SLICK_DRAG : flung ? ICE_DRAG : GRIP_DRAG;
		const control = p.knockMs > 0 ? 0.18 : here.slick ? 0.45 : 1;
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
			if (!flung && !here.slick) {
				// Kill sideways drift so turns are tight.
				const ux = mx / (Math.hypot(mx, my) || 1);
				const uy = my / (Math.hypot(mx, my) || 1);
				const along = rvx * ux + rvy * uy;
				const k = Math.exp(-TURN_GRIP * dt);
				rvx = ux * along + (rvx - ux * along) * k;
				rvy = uy * along + (rvy - uy * along) * k;
				// Walking straight: ease into the middle of your row/column.
				const tk = tileAt(arena, p.x, p.y);
				if (axis && tk >= 0) {
					const c = tileCenter(arena, tk);
					const off = axis === 'x' ? c.y - p.y : c.x - p.x;
					if (Math.abs(off) < CELL * 0.4) {
						const step = off * Math.min(1, LANE_ASSIST * dt);
						if (axis === 'x') p.y += step;
						else p.x += step;
					}
				}
			}
			if (p.stunMs <= 0 && p.knockMs <= 0)
				p.face = turnToward(p.face, Math.atan2(my, mx), 14 * dt);
		}
		const damp =
			mx !== 0 || my !== 0
				? flung || here.slick
					? Math.max(0, 1 - drag * 0.15 * dt)
					: 1
				: Math.exp(-drag * dt);
		rvx *= damp;
		rvy *= damp;
		p.vx = rvx + here.vx;
		p.vy = rvy + here.vy;
	}

	// Teeter: walking off the edge (rather than being shoved off) catches
	// you at the brink for a moment. Let go or turn away and you're fine;
	// keep pushing toward the water and in you go.
	const walking =
		p.knockMs <= 0 &&
		p.slideMs <= 0 &&
		!here.slick &&
		Math.hypot(p.vx - here.vx, p.vy - here.vy) < WALK_SPEED * 1.1;
	let teetering = false;
	let leaning = false;
	if (walking && here.ok && p.teeterMs < TEETER_MS) {
		const lead = PENGUIN_R * 0.35;
		const nx = p.x + p.vx * dt;
		const ny = p.y + p.vy * dt;
		if (p.vx !== 0 && !supportAt(arena, nx + Math.sign(p.vx) * lead, p.y, t).ok) {
			// Still steering that way? That's leaning over the edge.
			if (mx * Math.sign(p.vx) > 0.2) leaning = true;
			p.vx = here.vx;
			teetering = true;
		}
		if (p.vy !== 0 && !supportAt(arena, p.x, ny + Math.sign(p.vy) * lead, t).ok) {
			if (my * Math.sign(p.vy) > 0.2) leaning = true;
			p.vy = here.vy;
			teetering = true;
		}
	}
	// The wobble builds while you lean over the water, and fades when you don't.
	// Leaned too long: you're going in (unless you let go right now).
	const committed = p.teeterMs >= TEETER_MS && (mx !== 0 || my !== 0);
	if (leaning) p.teeterMs += ms;
	else if (!teetering && !committed) p.teeterMs = Math.max(0, p.teeterMs - ms * 2);

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

	const hitBlock = pushOutOfBlocks(arena, t, p, PENGUIN_R);
	if (hitBlock.nx || hitBlock.ny) {
		// Thud into the ice block: a little bounce, mostly stop.
		const vn = p.vx * hitBlock.nx + p.vy * hitBlock.ny;
		if (vn < 0) {
			p.vx -= 1.3 * vn * hitBlock.nx;
			p.vy -= 1.3 * vn * hitBlock.ny;
		}
		if (p.slideMs > 0) p.slideMs = 0;
	}

	p.z = footHeight(arena, p.x, p.y, t);
	p.speed = Math.hypot(p.vx - here.vx, p.vy - here.vy);

	if (!supportAt(arena, p.x, p.y, t).ok) {
		p.mode = 'fall';
		p.modeMs = 0;
		p.slideMs = 0;
		p.stunMs = 0;
		p.teeterMs = 0;
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
		if (Math.abs(x - st.x) < f.half && Math.abs(y - st.y) < f.half) return i;
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

/**
 * The highest ice under a penguin's feet (not just its centre), so it stands
 * up on a step's lip rather than sinking into the step.
 *
 * @param {Arena} arena
 * @param {number} x
 * @param {number} y
 * @param {number} t
 */
export function footHeight(arena, x, y, t) {
	let h = heightAt(arena, x, y);
	const r = PENGUIN_R * 0.6;
	for (const [dx, dy] of [
		[r, 0],
		[-r, 0],
		[0, r],
		[0, -r],
	]) {
		const sx = x + (dx ?? 0);
		const sy = y + (dy ?? 0);
		if (supportAt(arena, sx, sy, t).ok) h = Math.max(h, heightAt(arena, sx, sy));
	}
	return h;
}

/**
 * Keep a falling penguin's body out of the solid ice next to its hole (it
 * slides off the lip rather than sinking through the block).
 *
 * @param {Arena} arena
 * @param {Penguin} p
 * @param {number} t
 */
function pushClearOfIce(arena, p, t) {
	const r = PENGUIN_R * 0.85;
	for (const [dx, dy] of [
		[1, 0],
		[-1, 0],
		[0, 1],
		[0, -1],
	]) {
		const sx = p.x + (dx ?? 0) * r;
		const sy = p.y + (dy ?? 0) * r;
		const k = tileAt(arena, sx, sy);
		if (k < 0 || (arena.level[k] ?? -1) < 0 || !supportAt(arena, sx, sy, t).ok) continue;
		// Solid ice that way: back off until the edge of the body clears it.
		const c = tileCenter(arena, k);
		const edge = dx ? c.x - (dx ?? 0) * (CELL / 2) : c.y - (dy ?? 0) * (CELL / 2);
		if (dx) p.x = edge - (dx ?? 0) * r;
		else p.y = edge - (dy ?? 0) * r;
	}
}
