/**
 * Match rules: who moves, who gets shoved, who falls in, who wins.
 *
 * Every penguin has exactly one **owner** — the screen that simulates it. A
 * player owns their own penguin; computer penguins (and anyone who dropped
 * off the network) belong to the host. You only ever move, hurt or kill
 * penguins you own. Shoving someone else's penguin *sends* them a push; their
 * owner applies it. That's the "owned state" rule from the netplay engine,
 * and it means nobody waits on a round trip to see their own penguin move.
 *
 * Solo play is the same code with one screen owning everything.
 */

import { botInput } from './ai.js';
import {
	inBlock,
	jarAt,
	jarIndicesAround,
	kickAllowed,
	makeArena,
	shelteredFrom,
	startSpots,
	waveAt,
} from './arena.js';
import {
	BALL_HIT,
	BALL_R,
	BUMP_COOLDOWN_MS,
	BUMP_POWER,
	CELEBRATE_MS,
	FISH_HIT,
	FISH_USES,
	JAR_R,
	MAX_LIVES,
	MEGA_FACTOR,
	MEGA_MS,
	PENGUIN_R,
	SHOVE_ANIM_MS,
	SHOVE_BUFFER_MS,
	SHOVE_CONE,
	SHOVE_COOLDOWN_MS,
	SHOVE_EDGE,
	SHOVE_FULL,
	SHOVE_POWER,
	SHOVE_RANGE,
	SHOVE_RUN,
	SHOVE_TURN,
	SNOWBALL_R,
	SNOWBALL_RANGE,
	SNOWBALL_SPEED,
	SNOWBALL_USES,
	STUN_MS,
	WALK_SPEED,
} from './constants.js';
import { ballAt, freshContest, jarAvailable } from './contest.js';
import { angleDiff, beginRespawn, knock, movePenguin } from './physics.js';
import { makePenguin } from './state.js';

/** @typedef {import('./state.js').State} State */
/** @typedef {import('./state.js').Penguin} Penguin */
/** @typedef {import('./state.js').Input} Input */
/** @typedef {import('./state.js').RosterEntry} RosterEntry */
/** @typedef {import('./state.js').Throw} Throw */
/** @typedef {import('./contest.js').Claim} Claim */
/** @typedef {import('./looks.js').Look} Look */

/** Wave shove strength. */
export const WAVE_PUSH = 8.5;

/**
 * Fire-and-forget game events. (Contested grabs/kicks go through `claim`.)
 *
 * @typedef {{ type: 'push', target: number, ix: number, iy: number, stun: number }
 * 	| { type: 'throw', id: number, by: number, x: number, y: number, angle: number, t: number, kind: 'snowball' | 'fish' }
 * 	| { type: 'hit', id: number, target: number }
 * 	| { type: 'out', pid: number, t: number }} GameEvent
 */

/**
 * What the rules need from the network (or from solo play).
 *
 * @typedef {object} Link
 * @property {(pid: number) => boolean} owns Do we simulate this penguin?
 * @property {(ev: GameEvent) => void} send
 * @property {(claim: Claim) => void} claim
 */

/**
 * @typedef {object} MatchSetup
 * @property {number} matchNo
 * @property {string} mapId
 * @property {number} seed
 * @property {RosterEntry[]} roster
 * @property {string[]} names Per roster position.
 * @property {Look[]} looks Per roster position.
 * @property {number} myPid
 */

/**
 * @param {State} state
 * @param {MatchSetup} setup
 * @param {number} t Starting match time (negative = countdown).
 */
export function startMatch(state, setup, t) {
	const arena = makeArena(setup.mapId, setup.seed);
	state.matchNo = setup.matchNo;
	state.mapId = setup.mapId;
	state.seed = setup.seed;
	state.arena = arena;
	state.roster = setup.roster;
	state.myPid = setup.myPid;
	const spots = startSpots(arena, setup.roster.length);
	state.penguins = setup.roster.map((r, i) =>
		makePenguin(
			i,
			setup.names[i] ?? 'Penguin',
			/** @type {Look} */ (setup.looks[i]),
			spots[i] ?? { x: 0, y: 0, face: 0 },
			r.kind === 'bot',
		),
	);
	state.contest = freshContest(arena.balls.length);
	state.throws = [];
	state.fx = [];
	state.outs = [];
	state.result = null;
	state.doneMs = 0;
	state.lastWave = -1;
	state.t = t;
	state.mode = t < 0 ? 'countdown' : 'play';
	for (const r of setup.roster) {
		if (!state.tally.has(r.key)) {
			const i = setup.roster.indexOf(r);
			state.tally.set(r.key, {
				key: r.key,
				name: setup.names[i] ?? 'Penguin',
				look: /** @type {Look} */ (setup.looks[i]),
				wins: 0,
				played: 0,
				bot: r.kind === 'bot',
			});
		}
	}
}

/**
 * One fixed simulation step.
 *
 * @param {State} state
 * @param {Link} link
 * @param {number} t Match time after this step, ms.
 * @param {number} dt Seconds.
 * @param {Input} myInput
 */
export function tick(state, link, t, dt, myInput) {
	const arena = state.arena;
	if (!arena) return;
	state.t = t;
	state.toastMs = Math.max(0, state.toastMs - dt * 1000);
	if (state.mode === 'countdown') {
		if (t < 0) return;
		state.mode = 'play';
	}
	if (state.mode === 'done') {
		state.doneMs += dt * 1000;
		for (const p of state.penguins) p.shoveMs = Math.max(0, p.shoveMs - dt * 1000);
		stepThrows(state, link, t);
		return;
	}
	if (state.mode !== 'play') return;

	const solids = restingBalls(state);
	for (const p of state.penguins) {
		if (!link.owns(p.id)) continue;
		p.remote = false;
		p.stale = false;
		const input = p.id === state.myPid ? myInput : botInput(state, p, t);
		stepOwned(state, link, p, input, t, dt, solids);
	}
	stepThrows(state, link, t);
}

/**
 * @param {State} state
 */
function restingBalls(state) {
	const arena = state.arena;
	/** @type {{ x: number, y: number, r: number }[]} */
	const out = [];
	if (!arena) return out;
	arena.balls.forEach((home, i) => {
		if (ballAt(arena, state.contest, i, state.t).kind === 'rest') out.push(home);
	});
	return out;
}

/**
 * @param {State} state
 * @param {Link} link
 * @param {Penguin} p
 * @param {Input} input
 * @param {number} t
 * @param {number} dt
 * @param {{ x: number, y: number, r: number }[]} solids
 */
function stepOwned(state, link, p, input, t, dt, solids) {
	const arena = /** @type {import('./arena.js').Arena} */ (state.arena);
	const others = state.penguins.filter((q) => q !== p && q.mode !== 'out');
	const wasPlaying = p.mode === 'play';
	const res = movePenguin(p, input, arena, t, dt, others, solids);

	if (res.fell) {
		p.lives = Math.max(0, p.lives - 1);
		state.fx.push({ kind: 'splash', x: p.x, y: p.y, pid: p.id });
	}
	if (res.landed) state.fx.push({ kind: 'land', x: p.x, y: p.y, pid: p.id });
	if (res.done) {
		if (p.lives > 0) beginRespawn(p, arena, t, others);
		else {
			p.mode = 'out';
			p.modeMs = 0;
			link.send({ type: 'out', pid: p.id, t: Math.round(t) });
		}
	}
	if (!wasPlaying || p.mode !== 'play') return;

	// A press during the cooldown isn't lost: it fires as soon as it can.
	if (input.shove) p.shoveQueuedMs = SHOVE_BUFFER_MS;
	if (p.shoveQueuedMs > 0 && p.cooldownMs <= 0 && p.stunMs <= 0) {
		p.shoveQueuedMs = 0;
		shove(state, link, p);
	}
	p.shoveQueuedMs = Math.max(0, p.shoveQueuedMs - dt * 1000);
	if (input.power && p.stunMs <= 0) usePower(state, link, p, t);
	bumps(state, link, p, t);
	giantSnowballs(state, link, p, t);
	waves(state, p, t);
	jars(state, link, p, t);
}

/**
 * Flipper slap: everyone in front of you gets shoved away.
 *
 * @param {State} state
 * @param {Link} link
 * @param {Penguin} p
 */
function shove(state, link, p) {
	p.shoveMs = SHOVE_ANIM_MS;
	p.cooldownMs = SHOVE_COOLDOWN_MS;
	const mega = p.megaMs > 0;
	const range = SHOVE_RANGE + (mega ? 0.35 : 0);
	const targets = state.penguins.filter((q) => {
		if (q === p || q.mode !== 'play') return false;
		const d = Math.hypot(q.x - p.x, q.y - p.y);
		return d <= range && d > 1e-6;
	});
	const off = (/** @type {Penguin} */ q) =>
		Math.abs(angleDiff(Math.atan2(q.y - p.y, q.x - p.x), p.face));
	// Nobody in front, but someone close at your side? Turn and slap them.
	if (!targets.some((q) => off(q) <= SHOVE_CONE)) {
		const side = targets.filter((q) => off(q) <= SHOVE_TURN).sort((a, b) => off(a) - off(b))[0];
		if (side) p.face = Math.atan2(side.y - p.y, side.x - p.x);
	}
	let hit = false;
	for (const q of targets) {
		const a = off(q);
		if (a > SHOVE_CONE) continue;
		const dx = q.x - p.x;
		const dy = q.y - p.y;
		const d = Math.hypot(dx, dy);
		// Dead ahead: full strength. Off to the side: still a push, a softer one.
		const align =
			a <= SHOVE_FULL
				? 1
				: 1 - (1 - SHOVE_EDGE) * ((a - SHOVE_FULL) / (SHOVE_CONE - SHOVE_FULL));
		// A running shove hits much harder than a standing one.
		const closing = Math.max(
			0,
			Math.min(WALK_SPEED * 1.1, ((p.vx - q.vx) * dx + (p.vy - q.vy) * dy) / d),
		);
		const power = (SHOVE_POWER + SHOVE_RUN * closing) * align * (mega ? MEGA_FACTOR : 1);
		// Mostly away from the shover, a bit along their facing.
		const nx = (dx / d) * 0.75 + Math.cos(p.face) * 0.25;
		const ny = (dy / d) * 0.75 + Math.sin(p.face) * 0.25;
		const n = Math.hypot(nx, ny) || 1;
		push(state, link, q, (nx / n) * power, (ny / n) * power, 0);
		hit = true;
	}
	// A little lunge into the slap, hit or miss.
	p.vx += Math.cos(p.face) * 1.6;
	p.vy += Math.sin(p.face) * 1.6;
	state.fx.push({ kind: 'slap', x: p.x, y: p.y, pid: p.id, z: hit ? 1 : 0 });
}

/**
 * @param {State} state
 * @param {Link} link
 * @param {Penguin} q
 * @param {number} ix
 * @param {number} iy
 * @param {number} stun
 */
export function push(state, link, q, ix, iy, stun) {
	if (link.owns(q.id)) {
		if (knock(q, ix, iy, stun)) state.fx.push({ kind: 'bonk', x: q.x, y: q.y, pid: q.id });
	} else {
		link.send({ type: 'push', target: q.id, ix, iy, stun });
		state.fx.push({ kind: 'bonk', x: q.x, y: q.y, pid: q.id });
	}
}

/**
 * @param {State} state
 * @param {Link} link
 * @param {Penguin} p
 * @param {number} t
 */
function usePower(state, link, p, t) {
	if ((p.power !== 'snowball' && p.power !== 'fish') || p.uses <= 0) return;
	// Auto-aim at whoever's roughly in front.
	let angle = p.face;
	let best = 0.55;
	for (const q of state.penguins) {
		if (q === p || q.mode !== 'play') continue;
		const d = Math.hypot(q.x - p.x, q.y - p.y);
		if (d > SNOWBALL_RANGE) continue;
		const a = Math.atan2(q.y - p.y, q.x - p.x);
		const diff = Math.abs(angleDiff(a, p.face));
		if (diff < best) {
			best = diff;
			angle = a;
		}
	}
	p.face = angle;
	const id = ((p.id & 0xf) << 12) | (state.throwSeq++ & 0xfff);
	const ev = {
		type: /** @type {const} */ ('throw'),
		id,
		by: p.id,
		x: p.x + Math.cos(angle) * 0.5,
		y: p.y + Math.sin(angle) * 0.5,
		angle,
		t: Math.round(t),
		kind: p.power,
	};
	addThrow(state, ev);
	link.send(ev);
	p.shoveMs = SHOVE_ANIM_MS;
	usedOne(p);
}

/** @param {Penguin} p */
function usedOne(p) {
	p.uses--;
	if (p.uses <= 0) {
		p.power = '';
		p.uses = 0;
	}
}

/**
 * Running into each other. Each owner only moves its own penguin and sends
 * the other one a push, so a collision seen from both sides ends up roughly
 * as an elastic swap.
 *
 * @param {State} state
 * @param {Link} link
 * @param {Penguin} p
 * @param {number} t
 */
function bumps(state, link, p, t) {
	for (const q of state.penguins) {
		if (q === p || (q.mode !== 'play' && q.mode !== 'respawn')) continue;
		if (q.mode === 'respawn' && q.z > 0.8) continue;
		const dx = q.x - p.x;
		const dy = q.y - p.y;
		const d = Math.hypot(dx, dy);
		const min = PENGUIN_R * 2;
		if (d >= min) continue;
		const nx = d > 1e-6 ? dx / d : Math.cos(p.face);
		const ny = d > 1e-6 ? dy / d : Math.sin(p.face);
		const both = link.owns(q.id);
		const overlap = min - d;
		const share = both ? 0.5 : 1;
		p.x -= nx * overlap * share;
		p.y -= ny * overlap * share;
		if (both) {
			q.x += nx * overlap * 0.5;
			q.y += ny * overlap * 0.5;
		}
		const closing = (p.vx - q.vx) * nx + (p.vy - q.vy) * ny;
		const last = p.bumpAt.get(q.id) ?? -Infinity;
		if (t - last < BUMP_COOLDOWN_MS) continue;
		if (closing < 0.9) continue;
		p.bumpAt.set(q.id, t);
		if (both) q.bumpAt.set(p.id, t);
		const power = Math.max(0, closing) * BUMP_POWER;
		push(state, link, q, nx * power, ny * power, 0);
		const recoil = Math.max(0, closing) * 0.45;
		p.vx -= nx * recoil;
		p.vy -= ny * recoil;
	}
}

/**
 * Giant snowballs: a resting one gets shoved by walking into it (a contested
 * claim — the first shove wins), a rolling one bowls you over.
 *
 * @param {State} state
 * @param {Link} link
 * @param {Penguin} p
 * @param {number} t
 */
function giantSnowballs(state, link, p, t) {
	const arena = state.arena;
	if (!arena) return;
	arena.balls.forEach((home, i) => {
		const b = ballAt(arena, state.contest, i, t);
		if (b.kind === 'rest') {
			const dx = home.x - p.x;
			const dy = home.y - p.y;
			const d = Math.hypot(dx, dy);
			if (d > BALL_R + PENGUIN_R + 0.12) return;
			const toward = (p.vx * dx + p.vy * dy) / (d || 1);
			if (toward < 0.6 && !(p.shoveMs > SHOVE_ANIM_MS - 20)) return;
			const angle = Math.atan2(dy, dx);
			// Snowballs only go downhill: shoving from below does nothing.
			if (!kickAllowed(arena, i, angle)) return;
			link.claim({ type: 'kick', ball: i, angle, by: p.id, t: Math.round(t) });
			return;
		}
		if (b.kind !== 'roll') return;
		const key = `ball:${i}:${b.kick.t}`;
		const dx = p.x - b.x;
		const dy = p.y - b.y;
		const d = Math.hypot(dx, dy);
		const reach = BALL_R + PENGUIN_R;
		if (d > reach || p.z > 1.5 || p.invulnMs > 0) return;
		const sp = Math.hypot(b.vx, b.vy);
		if (sp < 0.8) return;
		const ux = b.vx / sp;
		const uy = b.vy / sp;
		const along = dx * ux + dy * uy;
		const side = -dx * uy + dy * ux;
		if (along < -0.2) return; // it's already rolled past you
		const first = !p.hitBy.has(key);
		if (Math.abs(side) > reach * 0.75) {
			// A glancing blow: spun out sideways, once.
			if (!first) return;
			p.hitBy.add(key);
			const power = BALL_HIT * 0.6;
			const nx = dx / (d || 1);
			const ny = dy / (d || 1);
			if (knock(p, nx * power, ny * power, 400))
				state.fx.push({ kind: 'bonk', x: p.x, y: p.y, pid: p.id });
			return;
		}
		// Square on: the snowball ploughs you along in front of it until you
		// go over the edge.
		if (first) {
			p.hitBy.add(key);
			knock(p, 0, 0, 500);
			state.fx.push({ kind: 'bonk', x: p.x, y: p.y, pid: p.id });
		}
		const keep = side;
		p.x = b.x + ux * (reach + 0.02) - uy * keep;
		p.y = b.y + uy * (reach + 0.02) + ux * keep;
		const pv = p.vx * ux + p.vy * uy;
		const push = Math.max(pv, sp * 1.1 + 0.6);
		const lat = (-p.vx * uy + p.vy * ux) * 0.5;
		p.vx = ux * push - uy * lat;
		p.vy = uy * push + ux * lat;
		p.knockMs = Math.max(p.knockMs, 250);
	});
}

/**
 * Igloo Cove's waves: when the front sweeps past, you get shoved along with
 * it — unless you're tucked in behind the igloo.
 *
 * @param {State} state
 * @param {Penguin} p
 * @param {number} t
 */
function waves(state, p, t) {
	const arena = state.arena;
	if (!arena) return;
	const w = waveAt(arena, t);
	if (!w || w.phase !== 'go') return;
	const key = `wave:${w.i}`;
	if (p.hitBy.has(key)) return;
	const along = p.x * Math.cos(w.dir) + p.y * Math.sin(w.dir);
	if (w.front < along) return;
	p.hitBy.add(key);
	if (shelteredFrom(arena, w.dir, p.x, p.y, t)) return;
	if (knock(p, Math.cos(w.dir) * WAVE_PUSH, Math.sin(w.dir) * WAVE_PUSH, 0)) {
		state.fx.push({ kind: 'splash', x: p.x, y: p.y, pid: p.id, z: 1 });
	}
}

/**
 * Waddling into a jar claims it. The goodies arrive once the claim is
 * confirmed (`grant`).
 *
 * @param {State} state
 * @param {Link} link
 * @param {Penguin} p
 * @param {number} t
 */
function jars(state, link, p, t) {
	const arena = state.arena;
	if (!arena) return;
	for (const i of jarIndicesAround(t)) {
		if (!jarAvailable(arena, state.contest, i, t)) continue;
		const jar = jarAt(arena, i);
		if (Math.hypot(jar.x - p.x, jar.y - p.y) > PENGUIN_R + JAR_R) continue;
		link.claim({ type: 'grab', jar: i, by: p.id, t: Math.round(t) });
	}
}

/**
 * A confirmed claim's reward, applied by the grabber's owner.
 *
 * @param {State} state
 * @param {Link} link
 * @param {Claim} claim
 */
export function grant(state, link, claim) {
	if (claim.type !== 'grab' || !state.arena) return;
	const p = state.penguins[claim.by];
	const jar = jarAt(state.arena, claim.jar);
	state.fx.push({
		kind: jar.kind === 'heart' ? 'heart' : 'fish',
		x: jar.x,
		y: jar.y,
		pid: claim.by,
	});
	if (!p || !link.owns(p.id)) return;
	if (jar.kind === 'heart') {
		p.lives = Math.min(MAX_LIVES, p.lives + 1);
	} else if (jar.power === 'mega') {
		p.megaMs = MEGA_MS;
	} else {
		p.power = jar.power;
		p.uses = jar.power === 'snowball' ? SNOWBALL_USES : FISH_USES;
	}
	if (p.id === state.myPid) {
		state.toast =
			jar.kind === 'heart'
				? '+1 life! ❤️'
				: jar.power === 'snowball'
					? 'Snowballs! ❄️'
					: jar.power === 'fish'
						? 'A fish to throw! 🐟'
						: 'Mega flippers! 💪';
		state.toastMs = 1600;
	}
}

/**
 * @param {State} state
 * @param {GameEvent & { type: 'throw' }} ev
 */
export function addThrow(state, ev) {
	if (state.throws.some((th) => th.id === ev.id)) return;
	state.throws.push({
		id: ev.id,
		by: ev.by,
		x0: ev.x,
		y0: ev.y,
		angle: ev.angle,
		t0: ev.t,
		kind: ev.kind,
		dead: false,
	});
	state.fx.push({ kind: 'throw', x: ev.x, y: ev.y, pid: ev.by });
}

/**
 * @param {Throw} th
 * @param {number} t
 */
export function throwPos(th, t) {
	const s = Math.max(0, (t - th.t0) / 1000);
	const d = s * SNOWBALL_SPEED;
	const k = Math.min(1, d / SNOWBALL_RANGE);
	return {
		x: th.x0 + Math.cos(th.angle) * d,
		y: th.y0 + Math.sin(th.angle) * d,
		z: 0.9 + 1.4 * k * (1 - k) * 2,
		d,
	};
}

/**
 * Advance snowballs. Each owner checks its own penguins for hits.
 *
 * @param {State} state
 * @param {Link} link
 * @param {number} t
 */
function stepThrows(state, link, t) {
	const arena = state.arena;
	for (const th of state.throws) {
		if (th.dead) continue;
		const pos = throwPos(th, t);
		if (pos.d > SNOWBALL_RANGE) {
			th.dead = true;
			state.fx.push({ kind: 'poof', x: pos.x, y: pos.y, z: 0.2 });
			continue;
		}
		if (
			arena?.obstacles.some((o) => Math.hypot(pos.x - o.x, pos.y - o.y) < o.r) ||
			(pos.z < 1.1 && !!arena && pos.z < 1.05 && inBlock(arena, t, pos.x, pos.y, 0))
		) {
			th.dead = true;
			state.fx.push({ kind: 'poof', x: pos.x, y: pos.y, z: pos.z });
			continue;
		}
		for (const p of state.penguins) {
			if (p.id === th.by || p.mode !== 'play') continue;
			if (Math.hypot(p.x - pos.x, p.y - pos.y) > PENGUIN_R + SNOWBALL_R + 0.1) continue;
			if (!link.owns(p.id)) continue;
			th.dead = true;
			// A snowball makes you dizzy; a fish just bowls you over.
			if (th.kind === 'fish')
				knock(p, Math.cos(th.angle) * FISH_HIT, Math.sin(th.angle) * FISH_HIT, 0);
			else knock(p, Math.cos(th.angle) * 2.5, Math.sin(th.angle) * 2.5, STUN_MS);
			state.fx.push({ kind: 'poof', x: pos.x, y: pos.y, z: pos.z, pid: p.id });
			link.send({ type: 'hit', id: th.id, target: p.id });
			break;
		}
	}
	state.throws = state.throws.filter((th) => !th.dead || t - th.t0 < 200);
}

/**
 * Someone (not us) says a snowball hit.
 *
 * @param {State} state
 * @param {number} id
 * @param {number} target
 */
export function onHit(state, id, target) {
	const th = state.throws.find((x) => x.id === id);
	const p = state.penguins[target];
	if (th && !th.dead) {
		th.dead = true;
		const pos = throwPos(th, state.t);
		state.fx.push({ kind: 'poof', x: p?.x ?? pos.x, y: p?.y ?? pos.y, z: pos.z, pid: target });
	}
}

/**
 * A penguin is out of lives — in confirmed order, so every screen agrees on
 * the finishing places.
 *
 * @param {State} state
 * @param {number} pid
 * @returns {boolean} True if this ended the match.
 */
export function onOut(state, pid) {
	if (state.mode === 'done' || state.outs.includes(pid)) return false;
	const p = state.penguins[pid];
	if (!p) return false;
	state.outs.push(pid);
	p.mode = 'out';
	p.lives = 0;
	const alive = state.penguins.filter((q) => !state.outs.includes(q.id));
	p.place = alive.length + 1;
	if (alive.length > 1) return false;
	const winner = alive[0]?.id ?? pid;
	const w = state.penguins[winner];
	if (w) w.place = 1;
	finish(state, winner);
	return true;
}

/**
 * @param {State} state
 * @param {number} winner
 */
function finish(state, winner) {
	const order = [
		winner,
		...state.outs
			.slice()
			.reverse()
			.filter((id) => id !== winner),
	];
	state.result = { winner, order };
	state.mode = 'done';
	state.doneMs = 0;
	state.roster.forEach((r, i) => {
		const entry = state.tally.get(r.key);
		if (!entry) return;
		entry.played++;
		if (i === winner) entry.wins++;
		const p = state.penguins[i];
		if (p) {
			entry.name = p.name;
			entry.look = p.look;
		}
	});
}

/** @param {State} state */
export function celebrationOver(state) {
	return state.mode === 'done' && state.doneMs >= CELEBRATE_MS;
}
