/**
 * Getting computer penguins around snow walls and holes: a coarse walkable
 * grid over the ice and a breadth-first route to wherever they want to go.
 * Rebuilt now and then as the ice cracks away in sudden death.
 */

import { capDist, edgeRadius, inHole, shrinkAt, wallsAt } from './arena.js';
import { PENGUIN_R } from './constants.js';

/** @typedef {import('./arena.js').Arena} Arena */

const CELL = 0.5;
const SPAN = 12;
const N = Math.round((SPAN * 2) / CELL);

/**
 * @typedef {object} Nav
 * @property {Uint8Array} ok Walkable cells.
 * @property {number} shrink The shrink factor it was built for.
 * @property {number} walls How many walls were standing.
 */

/** @type {WeakMap<Arena, Nav>} */
const cache = new WeakMap();

/**
 * @param {Arena} arena
 * @param {number} t
 * @returns {Nav}
 */
export function navFor(arena, t) {
	const k = shrinkAt(t);
	const walls = wallsAt(arena, t);
	const hit = cache.get(arena);
	if (hit && Math.abs(hit.shrink - k) < 0.02 && hit.walls === walls.length) return hit;
	const ok = new Uint8Array(N * N);
	for (let j = 0; j < N; j++) {
		for (let i = 0; i < N; i++) {
			const x = -SPAN + (i + 0.5) * CELL;
			const y = -SPAN + (j + 0.5) * CELL;
			const edge = edgeRadius(arena, Math.atan2(y, x)) * k - 0.45;
			if (Math.hypot(x, y) > edge) continue;
			if (inHole(arena, x, y, 0.35)) continue;
			if (walls.some((w) => capDist(w, x, y).d < PENGUIN_R * 0.8)) continue;
			if (arena.obstacles.some((o) => Math.hypot(x - o.x, y - o.y) < o.r + PENGUIN_R * 0.8))
				continue;
			ok[j * N + i] = 1;
		}
	}
	const nav = { ok, shrink: k, walls: walls.length };
	cache.set(arena, nav);
	return nav;
}

/**
 * @param {number} x
 * @param {number} y
 */
function cellOf(x, y) {
	const i = Math.max(0, Math.min(N - 1, Math.floor((x + SPAN) / CELL)));
	const j = Math.max(0, Math.min(N - 1, Math.floor((y + SPAN) / CELL)));
	return j * N + i;
}

/**
 * @param {number} c
 */
function centre(c) {
	return { x: -SPAN + ((c % N) + 0.5) * CELL, y: -SPAN + (Math.floor(c / N) + 0.5) * CELL };
}

/**
 * Is the straight line between two points walkable?
 *
 * @param {Nav} nav
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 */
export function clearLine(nav, ax, ay, bx, by) {
	const d = Math.hypot(bx - ax, by - ay);
	const steps = Math.ceil(d / (CELL * 0.5));
	for (let s = 1; s <= steps; s++) {
		const u = s / steps;
		if (!nav.ok[cellOf(ax + (bx - ax) * u, ay + (by - ay) * u)]) return false;
	}
	return true;
}

/**
 * Where to head next to get from (ax, ay) to (bx, by): the goal itself if
 * there's a clear line, else the farthest visible cell along a shortest
 * grid route. Null if there's no way there.
 *
 * @param {Nav} nav
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @returns {{ x: number, y: number } | null}
 */
export function route(nav, ax, ay, bx, by) {
	if (clearLine(nav, ax, ay, bx, by)) return { x: bx, y: by };
	const start = cellOf(ax, ay);
	let goal = cellOf(bx, by);
	if (!nav.ok[goal]) {
		// Aim for the nearest walkable cell to the goal instead.
		let best = -1;
		let bestD = Infinity;
		const g = centre(goal);
		for (let c = 0; c < N * N; c++) {
			if (!nav.ok[c]) continue;
			const p = centre(c);
			const d = (p.x - g.x) ** 2 + (p.y - g.y) ** 2;
			if (d < bestD) {
				bestD = d;
				best = c;
			}
		}
		if (best < 0) return null;
		goal = best;
	}
	// BFS from the goal; then walk downhill in distance from the start.
	const dist = new Int16Array(N * N).fill(-1);
	const queue = new Int32Array(N * N);
	let head = 0;
	let tail = 0;
	dist[goal] = 0;
	queue[tail++] = goal;
	while (head < tail) {
		const c = /** @type {number} */ (queue[head++]);
		if (c === start) break;
		const i = c % N;
		const nd = /** @type {number} */ (dist[c]) + 1;
		for (const n of [c - 1, c + 1, c - N, c + N]) {
			if (n < 0 || n >= N * N) continue;
			if ((n === c - 1 && i === 0) || (n === c + 1 && i === N - 1)) continue;
			if (dist[n] !== -1 || (!nav.ok[n] && n !== start)) continue;
			dist[n] = nd;
			queue[tail++] = n;
		}
	}
	if (dist[start] === -1) return null;
	let c = start;
	let target = centre(c);
	for (let steps = 0; steps < 40 && c !== goal; steps++) {
		const i = c % N;
		let next = -1;
		for (const n of [c - 1, c + 1, c - N, c + N]) {
			if (n < 0 || n >= N * N) continue;
			if ((n === c - 1 && i === 0) || (n === c + 1 && i === N - 1)) continue;
			if (dist[n] === -1) continue;
			if (next === -1 || /** @type {number} */ (dist[n]) < /** @type {number} */ (dist[next]))
				next = n;
		}
		if (next === -1 || /** @type {number} */ (dist[next]) >= /** @type {number} */ (dist[c]))
			break;
		const p = centre(next);
		if (!clearLine(nav, ax, ay, p.x, p.y)) break;
		target = p;
		c = next;
	}
	return target;
}

/**
 * True if a step from (x, y) in direction (dx, dy) lands somewhere walkable.
 *
 * @param {Nav} nav
 * @param {number} x
 * @param {number} y
 * @param {number} dx
 * @param {number} dy
 * @param {number} look
 */
export function safeAhead(nav, x, y, dx, dy, look) {
	const l = Math.hypot(dx, dy) || 1;
	return !!nav.ok[cellOf(x + (dx / l) * look, y + (dy / l) * look)];
}
