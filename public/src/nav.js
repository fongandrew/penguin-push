/**
 * Getting computer penguins around snow walls and holes: a coarse walkable
 * grid over the ice and a breadth-first route to wherever they want to go.
 * Rebuilt now and then as the ice cracks away in sudden death.
 */

import { blocksAt, inBlock, onIsland, shrinkAt } from './arena.js';
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
	const walls = blocksAt(arena, t);
	const hit = cache.get(arena);
	if (hit && Math.abs(hit.shrink - k) < 0.01 && hit.walls === walls.length) return hit;
	const ok = new Uint8Array(N * N);
	for (let j = 0; j < N; j++) {
		for (let i = 0; i < N; i++) {
			const x = -SPAN + (i + 0.5) * CELL;
			const y = -SPAN + (j + 0.5) * CELL;
			// Walkable: on the ice with a margin from the water, clear of blocks
			// and the igloo. Tiles about to sink count as water already.
			const soon = t + 2500;
			const m = 0.32;
			if (
				!onIsland(arena, x, y, soon) ||
				!onIsland(arena, x + m, y, soon) ||
				!onIsland(arena, x - m, y, soon) ||
				!onIsland(arena, x, y + m, soon) ||
				!onIsland(arena, x, y - m, soon)
			) {
				continue;
			}
			if (inBlock(arena, t, x, y, PENGUIN_R * 0.8)) continue;
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
 * Where to head next to get from (ax, ay) toward (bx, by): the goal itself if
 * there's a clear line, else the farthest visible cell along a shortest grid
 * route to the reachable cell nearest the goal (so a goal across the water
 * still gets you as close as you can get). Null only if you're boxed in.
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
	if (!nav.ok[start]) {
		// Standing in the margin by the water or a block: step to the nearest
		// walkable cell first.
		const near = nearestOk(nav, start, 4);
		if (near < 0) return null;
		return centre(near);
	}
	const goal = cellOf(bx, by);
	const g = centre(goal);
	// BFS out from where we are; remember the reachable cell nearest the goal.
	const parent = new Int32Array(N * N).fill(-2);
	const queue = new Int32Array(N * N);
	let head = 0;
	let tail = 0;
	parent[start] = -1;
	queue[tail++] = start;
	let best = start;
	let bestD = Infinity;
	while (head < tail) {
		const c = /** @type {number} */ (queue[head++]);
		const p = centre(c);
		const d = (p.x - g.x) ** 2 + (p.y - g.y) ** 2;
		if (d < bestD) {
			bestD = d;
			best = c;
			if (c === goal) break;
		}
		const i = c % N;
		for (const nb of [c - 1, c + 1, c - N, c + N]) {
			if (nb < 0 || nb >= N * N) continue;
			if ((nb === c - 1 && i === 0) || (nb === c + 1 && i === N - 1)) continue;
			if (parent[nb] !== -2 || !nav.ok[nb]) continue;
			parent[nb] = c;
			queue[tail++] = nb;
		}
	}
	if (best === start) return null;
	// Walk the path back from `best`, and aim at the farthest cell we can see.
	/** @type {number[]} */
	const path = [];
	for (let c = best; c !== -1 && c !== start; c = /** @type {number} */ (parent[c])) path.push(c);
	path.reverse();
	let target = centre(path[0] ?? best);
	for (const c of path.slice(0, 40)) {
		const p = centre(c);
		if (!clearLine(nav, ax, ay, p.x, p.y)) break;
		target = p;
	}
	return target;
}

/**
 * @param {Nav} nav
 * @param {number} c
 * @param {number} radius In cells.
 */
function nearestOk(nav, c, radius) {
	const ci = c % N;
	const cj = Math.floor(c / N);
	let best = -1;
	let bestD = Infinity;
	for (let j = cj - radius; j <= cj + radius; j++) {
		for (let i = ci - radius; i <= ci + radius; i++) {
			if (i < 0 || j < 0 || i >= N || j >= N || !nav.ok[j * N + i]) continue;
			const d = (i - ci) ** 2 + (j - cj) ** 2;
			if (d < bestD) {
				bestD = d;
				best = j * N + i;
			}
		}
	}
	return best;
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
