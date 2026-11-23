/**
 * Playing with friends: one room on the netplay relay, as the game sees it.
 *
 * The three state categories of the engine map like this:
 * - **seed-derived** — the map: island shape, hill, floe drift and sinking,
 *   wave timing, and every power-up jar's time/place/contents. Each match's
 *   seed is the room seed mixed with the match number, so none of it ever
 *   crosses the wire. Match time is relay time minus the start.
 * - **owned** — penguins. Each player simulates their own; the host simulates
 *   the computer penguins (and anyone whose phone dropped off). Owners send
 *   ~20 Hz snapshots; everyone else draws them ~120 ms in the past. A shove on
 *   someone else's penguin is sent as a `push` event that its owner applies.
 * - **contested** — power-up jars and resting giant snowballs. Claims go out
 *   as relay events; every client replays them in relay order through
 *   `applyClaim`, with our own unconfirmed claims layered on top. A refused
 *   claim just drops out of that layer.
 *
 * The match start and each knock-out are events too, because the relay
 * replays events to a rejoiner and because relay order is what decides
 * finishing places when two penguins splash at once.
 */

import { MAPS } from './arena.js';
import { BOT_NAMES, COUNTDOWN_MS, MAX_PENGUINS, SHOVE_ANIM_MS } from './constants.js';
import { applyClaim, cloneContest, freshContest } from './contest.js';
import { addThrow, grant, onHit, onOut, startMatch } from './game.js';
import { lookFromBytes, lookToBytes, randomLook } from './looks.js';
import { lerpAngle, lerpNumber, OwnedBuffer } from './net/owned.js';
import { Reader, Writer } from './net/pack.js';
import { KIND } from './net/protocol.js';
import { makeRng } from './net/rng.js';
import { knock } from './physics.js';

/** @typedef {import('./state.js').State} State */
/** @typedef {import('./state.js').Penguin} Penguin */
/** @typedef {import('./state.js').RosterEntry} RosterEntry */
/** @typedef {import('./state.js').PenguinMode} PenguinMode */
/** @typedef {import('./state.js').PowerKind} PowerKind */
/** @typedef {import('./looks.js').Look} Look */
/** @typedef {import('./contest.js').Claim} Claim */
/** @typedef {import('./contest.js').Contest} Contest */
/** @typedef {import('./game.js').GameEvent} GameEvent */
/** @typedef {import('./game.js').Link} Link */
/** @typedef {import('./net/protocol.js').Envelope} Envelope */

/**
 * What the session needs from a `NetClient` — narrow so tests can use a fake.
 *
 * @typedef {object} Net
 * @property {number} slot
 * @property {() => number} serverNow
 * @property {(dtSeconds: number) => void} tick
 * @property {(bytes: Uint8Array) => void} sendEvent
 * @property {(bytes: Uint8Array) => void} sendSnapshot
 * @property {(bytes: Uint8Array) => void} sendKeyframe
 * @property {(value: unknown) => void} sendControl
 */

export const SNAPSHOT_HZ = 20;
const LOBBY_SNAPSHOT_HZ = 3;
const START_SLACK_MS = 700;
const PENDING_TIMEOUT_MS = 5000;
/** Our own penguin's snapshot pid while in the lobby (no roster yet). */
const LOBBY_PID = 255;

const XY = 24;
const Z_MIN = -4;
const Z_MAX = 12;
const MODES = /** @type {PenguinMode[]} */ (['play', 'fall', 'respawn', 'out']);
const POWERS = /** @type {PowerKind[]} */ (['', 'snowball', 'fish']);

/** Map choices in the lobby; 'mix' rotates through every map. */
export const MAP_CHOICES = ['mix', ...MAPS.map((m) => m.id)];

/**
 * @typedef {object} Snap
 * @property {number} pid
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {number} face
 * @property {number} vx
 * @property {number} vy
 * @property {number} speed
 * @property {number} lives
 * @property {PenguinMode} mode
 * @property {number} flags bit0 stun, 1 invuln, 2 shove, (3 unused), 4 mega, 5 knock, 6 teeter
 * @property {PowerKind} power
 * @property {number} uses
 * @property {Look} look
 */

/**
 * @param {number} match
 * @param {Snap[]} snaps
 * @returns {Uint8Array}
 */
export function encodeSnaps(match, snaps) {
	const w = new Writer(8 + snaps.length * 24).u16(match).u8(snaps.length);
	for (const s of snaps) {
		w.u8(s.pid)
			.q16(s.x, -XY, XY)
			.q16(s.y, -XY, XY)
			.q16(s.z, Z_MIN, Z_MAX)
			.u8(
				Math.round(
					(((s.face % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) *
						(256 / (Math.PI * 2)),
				) & 255,
			)
			.i8(Math.max(-127, Math.min(127, Math.round(s.vx * 6))))
			.i8(Math.max(-127, Math.min(127, Math.round(s.vy * 6))))
			.u8(Math.min(255, Math.round(s.speed * 20)))
			.u8(s.lives)
			.u8(Math.max(0, MODES.indexOf(s.mode)))
			.u8(s.flags)
			.u8(Math.max(0, POWERS.indexOf(s.power)))
			.u8(s.uses);
		for (const b of lookToBytes(s.look)) w.u8(b);
	}
	return w.done();
}

/**
 * @param {Uint8Array} bytes
 * @returns {{ match: number, snaps: Snap[] }}
 */
export function decodeSnaps(bytes) {
	const r = new Reader(bytes);
	const match = r.u16();
	const n = r.u8();
	/** @type {Snap[]} */
	const snaps = [];
	for (let i = 0; i < n; i++) {
		const pid = r.u8();
		const x = r.q16(-XY, XY);
		const y = r.q16(-XY, XY);
		const z = r.q16(Z_MIN, Z_MAX);
		const face = r.u8() * ((Math.PI * 2) / 256);
		const vx = r.i8() / 6;
		const vy = r.i8() / 6;
		const speed = r.u8() / 20;
		const lives = r.u8();
		const mode = MODES[r.u8()] ?? 'play';
		const flags = r.u8();
		const power = POWERS[r.u8()] ?? '';
		const uses = r.u8();
		const lb = [r.u8(), r.u8(), r.u8(), r.u8(), r.u8(), r.u8()];
		snaps.push({
			pid,
			x,
			y,
			z,
			face,
			vx,
			vy,
			speed,
			lives,
			mode,
			flags,
			power,
			uses,
			look: lookFromBytes(lb),
		});
	}
	return { match, snaps };
}

/**
 * @typedef {object} TallyWire
 * @property {string} key
 * @property {number} wins
 * @property {number} played
 *
 * @typedef {object} MatchInfo
 * @property {number} match
 * @property {number} startAt Relay time.
 * @property {number} map Index into MAPS.
 * @property {number[]} humans Relay slots, roster order.
 * @property {number} bots
 * @property {TallyWire[]} tally
 */

/**
 * @typedef {{ type: 'match', info: MatchInfo }
 * 	| { type: 'claim', claim: Claim, nonce: number }
 * 	| GameEvent} NetEvent
 */

const EV = { match: 1, push: 2, throw: 3, hit: 4, out: 5, grab: 6, kick: 7 };

/**
 * @param {Writer} w
 * @param {MatchInfo} m
 */
function writeMatch(w, m) {
	w.u16(m.match)
		.u32(m.startAt >>> 0)
		.u8(m.map)
		.u8(m.humans.length);
	for (const s of m.humans) w.u8(s);
	w.u8(m.bots).u8(m.tally.length);
	for (const e of m.tally) w.str(e.key).u16(e.wins).u16(e.played);
	return w;
}

/**
 * @param {Reader} r
 * @returns {MatchInfo}
 */
function readMatch(r) {
	const match = r.u16();
	const startAt = r.u32();
	const map = r.u8();
	const nh = r.u8();
	const humans = [];
	for (let i = 0; i < nh; i++) humans.push(r.u8());
	const bots = r.u8();
	const nt = r.u8();
	const tally = [];
	for (let i = 0; i < nt; i++) tally.push({ key: r.str(), wins: r.u16(), played: r.u16() });
	return { match, startAt, map, humans, bots, tally };
}

/**
 * @param {NetEvent} ev
 * @returns {Uint8Array}
 */
export function encodeEvent(ev) {
	const w = new Writer(32);
	switch (ev.type) {
		case 'match':
			return writeMatch(w.u8(EV.match), ev.info).done();
		case 'push':
			return w
				.u8(EV.push)
				.u8(ev.target)
				.i16(Math.round(ev.ix * 100))
				.i16(Math.round(ev.iy * 100))
				.u16(Math.round(ev.stun))
				.done();
		case 'throw':
			return w
				.u8(EV.throw)
				.u16(ev.id)
				.u8(ev.by)
				.q16(ev.x, -XY, XY)
				.q16(ev.y, -XY, XY)
				.f32(ev.angle)
				.u32(Math.max(0, ev.t))
				.u8(ev.kind === 'fish' ? 1 : 0)
				.done();
		case 'hit':
			return w.u8(EV.hit).u16(ev.id).u8(ev.target).done();
		case 'out':
			return w.u8(EV.out).u8(ev.pid).u32(Math.max(0, ev.t)).done();
		case 'claim': {
			const c = ev.claim;
			if (c.type === 'grab') {
				return w.u8(EV.grab).u16(ev.nonce).u8(c.by).u16(c.jar).u32(Math.max(0, c.t)).done();
			}
			return w
				.u8(EV.kick)
				.u16(ev.nonce)
				.u8(c.by)
				.u8(c.ball)
				.f32(c.angle)
				.u32(Math.max(0, c.t))
				.done();
		}
	}
}

/**
 * @param {Uint8Array} bytes
 * @returns {NetEvent | null}
 */
export function decodeEvent(bytes) {
	const r = new Reader(bytes);
	switch (r.u8()) {
		case EV.match:
			return { type: 'match', info: readMatch(r) };
		case EV.push:
			return {
				type: 'push',
				target: r.u8(),
				ix: r.i16() / 100,
				iy: r.i16() / 100,
				stun: r.u16(),
			};
		case EV.throw:
			return {
				type: 'throw',
				id: r.u16(),
				by: r.u8(),
				x: r.q16(-XY, XY),
				y: r.q16(-XY, XY),
				angle: r.f32(),
				t: r.u32(),
				kind: r.u8() === 1 ? 'fish' : 'snowball',
			};
		case EV.hit:
			return { type: 'hit', id: r.u16(), target: r.u8() };
		case EV.out:
			return { type: 'out', pid: r.u8(), t: r.u32() };
		case EV.grab: {
			const nonce = r.u16();
			return {
				type: 'claim',
				nonce,
				claim: { type: 'grab', by: r.u8(), jar: r.u16(), t: r.u32() },
			};
		}
		case EV.kick: {
			const nonce = r.u16();
			const by = r.u8();
			const ball = r.u8();
			return {
				type: 'claim',
				nonce,
				claim: { type: 'kick', by, ball, angle: r.f32(), t: r.u32() },
			};
		}
		default:
			return null;
	}
}

/**
 * A match's seed: the room seed mixed with the match number (integer-only, so
 * every JS engine agrees).
 *
 * @param {number} roomSeed
 * @param {number} match
 */
export function matchSeed(roomSeed, match) {
	return (Math.imul(roomSeed >>> 0, 0x9e3779b1) ^ Math.imul(match + 1, 0x85ebca6b)) >>> 0;
}

/**
 * Build the roster for a match: humans in slot order (at most four), then
 * computer penguins to fill. Always at least two penguins.
 *
 * @param {number[]} humans
 * @param {number} bots
 * @returns {RosterEntry[]}
 */
export function makeRoster(humans, bots) {
	/** @type {RosterEntry[]} */
	const roster = humans
		.slice(0, MAX_PENGUINS)
		.map((slot) => ({ kind: 'human', slot, bot: -1, key: `s${slot}` }));
	const nb = Math.max(
		roster.length < 2 ? 2 - roster.length : 0,
		Math.min(bots, MAX_PENGUINS - roster.length),
	);
	for (let i = 0; i < nb; i++) roster.push({ kind: 'bot', slot: -1, bot: i, key: `b${i}` });
	return roster;
}

/**
 * @param {number} seed
 * @param {number} bot
 * @returns {Look}
 */
export function botLook(seed, bot) {
	return randomLook(makeRng((seed ^ Math.imul(bot + 7, 0x2545f491)) >>> 0));
}

/**
 * @typedef {object} Pending
 * @property {number} nonce
 * @property {Claim} claim
 * @property {number} sentAt
 */

/**
 * @typedef {object} LobbyPlayer
 * @property {number} slot
 * @property {string} name
 * @property {Look | null} look
 * @property {boolean} me
 * @property {boolean} connected
 */

/**
 * @implements {Link}
 */
export class Session {
	/**
	 * @param {object} opts
	 * @param {State} opts.state
	 * @param {Net} opts.net
	 * @param {string} opts.code
	 * @param {() => void} [opts.onLobby] Lobby view changed.
	 * @param {() => void} [opts.onMatch] A match just started (or we rejoined one).
	 */
	constructor({ state, net, code, onLobby, onMatch }) {
		this.state = state;
		this.net = net;
		this.code = code;
		this.onLobby = onLobby ?? (() => {});
		this.onMatch = onMatch ?? (() => {});
		this.roomSeed = 0;
		/** @type {Map<number, { slot: number, name: string, connected: boolean }>} */
		this.players = new Map();
		/** @type {Map<number, Look>} */
		this.looks = new Map();
		/** @type {OwnedBuffer<Snap>} */
		this.remote = this.makeBuffer();
		this.match = 0;
		this.startAt = 0;
		/** @type {MatchInfo | null} */
		this.info = null;
		/** @type {Contest} */
		this.confirmed = freshContest(0);
		/** @type {Pending[]} */
		this.pending = [];
		this.nonce = 0;
		this.sendAccum = 0;
		/** Lobby settings, chosen by the host and mirrored to everyone. */
		this.settings = { map: 'mix', bots: 2 };
		/** Rejoined mid-match: take our penguin from the host's copy. */
		this.adoptMs = 0;
	}

	/** @returns {OwnedBuffer<Snap>} */
	makeBuffer() {
		return new OwnedBuffer((a, b, t) => ({
			...b,
			x: lerpNumber(a.x, b.x, t),
			y: lerpNumber(a.y, b.y, t),
			z: lerpNumber(a.z, b.z, t),
			face: lerpAngle(a.face, b.face, t),
			speed: lerpNumber(a.speed, b.speed, t),
		}));
	}

	// ---- Link ----

	/** @param {number} pid */
	owns(pid) {
		return this.ownerOf(pid) === this.net.slot;
	}

	/**
	 * Humans own themselves while connected; everything else is the host's.
	 *
	 * @param {number} pid
	 */
	ownerOf(pid) {
		const r = this.state.roster[pid];
		if (!r) return -1;
		if (r.kind === 'human' && this.players.get(r.slot)?.connected) return r.slot;
		return this.hostSlot();
	}

	/** @param {GameEvent} ev */
	send(ev) {
		this.net.sendEvent(encodeEvent(ev));
	}

	/** @param {Claim} claim */
	claim(claim) {
		if (!this.match) return;
		const c = claim.type === 'kick' ? { ...claim, angle: Math.fround(claim.angle) } : claim;
		const key = claimKey(c);
		if (this.pending.some((p) => claimKey(p.claim) === key)) return;
		const nonce = (this.nonce = (this.nonce + 1) & 0xffff);
		this.pending.push({ nonce, claim: c, sentAt: Date.now() });
		this.net.sendEvent(encodeEvent({ type: 'claim', claim: c, nonce }));
		this.rebuild();
	}

	// ---- per frame ----

	/** Match time now, ms. */
	matchTime() {
		return this.match ? this.net.serverNow() - this.startAt : 0;
	}

	/** @param {number} dtMs */
	frame(dtMs) {
		this.net.tick(dtMs / 1000);
		const now = Date.now();
		const before = this.pending.length;
		this.pending = this.pending.filter((p) => now - p.sentAt < PENDING_TIMEOUT_MS);
		if (this.pending.length !== before) this.rebuild();
		this.syncRemotes(dtMs);
		this.sendSnapshot(dtMs);
	}

	// ---- lobby ----

	hostSlot() {
		let host = this.net.slot;
		for (const p of this.players.values()) {
			if (p.connected && p.slot < host) host = p.slot;
		}
		return host;
	}

	isHost() {
		return this.net.slot >= 0 && this.hostSlot() === this.net.slot;
	}

	/** @returns {LobbyPlayer[]} */
	lobbyPlayers() {
		return [...this.players.values()]
			.sort((a, b) => a.slot - b.slot)
			.map((p) => ({
				slot: p.slot,
				name: p.name,
				look: p.slot === this.net.slot ? this.state.look : (this.looks.get(p.slot) ?? null),
				me: p.slot === this.net.slot,
				connected: p.connected,
			}));
	}

	hostName() {
		return this.players.get(this.hostSlot())?.name ?? 'the host';
	}

	/**
	 * Host: change the lobby settings for everyone.
	 *
	 * @param {{ map?: string, bots?: number }} next
	 */
	setSettings(next) {
		if (!this.isHost()) return;
		this.settings = { ...this.settings, ...next };
		this.net.sendControl({ type: 'settings', ...this.settings });
		this.onLobby();
	}

	/**
	 * Host: start the next match a few seconds from now.
	 *
	 * @returns {boolean}
	 */
	startNextMatch() {
		if (!this.isHost()) return false;
		const match = this.match + 1;
		const humans = [...this.players.values()]
			.filter((p) => p.connected)
			.map((p) => p.slot)
			.sort((a, b) => a - b);
		const choice = this.settings.map;
		const map =
			choice === 'mix'
				? (match - 1) % MAPS.length
				: Math.max(
						0,
						MAPS.findIndex((m) => m.id === choice),
					);
		const tally = [...this.state.tally.values()].map((e) => ({
			key: e.key,
			wins: e.wins,
			played: e.played,
		}));
		const startAt = Math.round(this.net.serverNow() + COUNTDOWN_MS + START_SLACK_MS);
		// A rematch resets the relay's replay log so it starts at this match.
		if (this.match) this.net.sendControl({ type: 'lobby' });
		this.net.sendEvent(
			encodeEvent({
				type: 'match',
				info: { match, startAt, map, humans, bots: this.settings.bots, tally },
			}),
		);
		this.net.sendControl({ type: 'start' });
		return true;
	}

	// ---- relay callbacks ----

	/** @param {any} welcome */
	onWelcome(welcome) {
		this.roomSeed = Number(welcome?.seed) >>> 0;
		this.players.clear();
		for (const p of welcome?.players ?? []) {
			this.players.set(p.slot, {
				slot: p.slot,
				name: String(p.name),
				connected: !!p.connected,
			});
		}
		const me = this.players.get(this.net.slot);
		if (me) me.connected = true;
		this.confirmed = freshContest(this.state.arena?.balls.length ?? 0);
		this.pending = [];
		this.rebuild();
		this.onLobby();
	}

	/** @param {any} msg */
	onPresence(msg) {
		const slot = Number(msg?.slot);
		if (msg?.state === 'gone') {
			this.players.delete(slot);
		} else {
			this.players.set(slot, {
				slot,
				name: String(msg?.name ?? 'Penguin'),
				connected: msg?.state === 'join',
			});
		}
		// Tell a newcomer what the lobby is set to.
		if (msg?.state === 'join' && this.isHost()) {
			this.net.sendControl({ type: 'settings', ...this.settings });
		}
		this.onLobby();
	}

	/** @param {Envelope} env */
	onMessage(env) {
		if (env.kind === KIND.SNAPSHOT) {
			if (env.slot === this.net.slot) return;
			this.onSnapshot(env);
			return;
		}
		if (env.kind === KIND.KEYFRAME) {
			this.applyKeyframe(env.payload, env.serverTick);
			return;
		}
		if (env.kind === KIND.CONTROL) {
			const msg = decodeControl(env.payload);
			if (msg?.type === 'settings' && env.slot !== this.net.slot) {
				this.settings = {
					map: MAP_CHOICES.includes(String(msg.map)) ? String(msg.map) : 'mix',
					bots: Math.max(0, Math.min(3, Number(msg.bots) || 0)),
				};
				this.onLobby();
			}
			return;
		}
		if (env.kind !== KIND.EVENT) return;
		const ev = decodeEvent(env.payload);
		if (!ev) return;
		const mine = env.slot === this.net.slot;
		switch (ev.type) {
			case 'match':
				this.beginMatch(ev.info);
				return;
			case 'claim':
				this.confirm(env, ev.claim, ev.nonce);
				return;
			case 'push': {
				if (mine) return;
				const p = this.state.penguins[ev.target];
				if (p && this.owns(p.id) && knock(p, ev.ix, ev.iy, ev.stun)) {
					this.state.fx.push({ kind: 'bonk', x: p.x, y: p.y, pid: p.id });
				}
				return;
			}
			case 'throw':
				if (!mine && this.match) addThrow(this.state, ev);
				return;
			case 'hit':
				if (!mine) onHit(this.state, ev.id, ev.target);
				return;
			case 'out':
				if (this.match) onOut(this.state, ev.pid);
				return;
		}
	}

	/** The relay wants a checkpoint (its replay log is full). */
	keyframe() {
		if (!this.info) return;
		this.net.sendKeyframe(this.encodeKeyframe());
	}

	// ---- internals ----

	/** @param {Envelope} env */
	onSnapshot(env) {
		const { match, snaps } = decodeSnaps(env.payload);
		let lobbyChanged = false;
		for (const s of snaps) {
			const r = this.state.roster[s.pid];
			const lookSlot = s.pid === LOBBY_PID ? env.slot : r?.kind === 'human' ? r.slot : -1;
			if (lookSlot >= 0) {
				const old = this.looks.get(lookSlot);
				if (!old || JSON.stringify(old) !== JSON.stringify(s.look)) lobbyChanged = true;
				this.looks.set(lookSlot, s.look);
				const p = this.state.penguins[s.pid];
				if (p && r?.kind === 'human' && match === this.match) p.look = s.look;
			}
			if (s.pid !== LOBBY_PID && match === this.match && this.match) {
				this.remote.push(s.pid, env.serverTick, s);
			}
		}
		if (lobbyChanged) this.onLobby();
	}

	/**
	 * @param {MatchInfo} info
	 */
	beginMatch(info) {
		if (info.match <= this.match) return;
		this.match = info.match;
		this.startAt = info.startAt;
		this.info = info;
		this.remote = this.makeBuffer();
		const seed = matchSeed(this.roomSeed, info.match);
		const roster = makeRoster(info.humans, info.bots);
		const names = roster.map((r) =>
			r.kind === 'bot'
				? (BOT_NAMES[r.bot] ?? 'Bot')
				: (this.players.get(r.slot)?.name ?? 'Penguin'),
		);
		const looks = roster.map((r) =>
			r.kind === 'bot'
				? botLook(this.roomSeed, r.bot)
				: r.slot === this.net.slot
					? this.state.look
					: (this.looks.get(r.slot) ?? botLook(seed, 10 + r.slot)),
		);
		const myPid = roster.findIndex((r) => r.kind === 'human' && r.slot === this.net.slot);
		const t = this.net.serverNow() - info.startAt;
		startMatch(
			this.state,
			{
				matchNo: info.match,
				mapId: MAPS[info.map]?.id ?? 'hill',
				seed,
				roster,
				names,
				looks,
				myPid,
			},
			t,
		);
		// The host's tally is the room's tally.
		for (const e of info.tally) {
			const mine = this.state.tally.get(e.key);
			if (mine) {
				mine.wins = e.wins;
				mine.played = e.played;
			}
		}
		roster.forEach((r, i) => {
			const entry = this.state.tally.get(r.key);
			if (entry) entry.name = names[i] ?? entry.name;
		});
		// Joining a match already under way: our penguin may have been kept
		// alive by the host; take its copy if one turns up.
		this.adoptMs = t > 500 && myPid >= 0 ? 1500 : 0;
		if (this.adoptMs) {
			const me = this.state.penguins[myPid];
			if (me) me.remote = true;
		}
		this.confirmed = freshContest(this.state.arena?.balls.length ?? 0);
		this.pending = [];
		this.rebuild();
		this.onMatch();
		this.onLobby();
	}

	/**
	 * @param {Envelope} env
	 * @param {Claim} claim
	 * @param {number} nonce
	 */
	confirm(env, claim, nonce) {
		const arena = this.state.arena;
		if (!this.match || !arena) return;
		// Trust the claimed time, but only within a second of when it reached
		// the relay — enough for any honest phone's lag.
		const relayT = env.serverTick - this.startAt;
		const t = Math.min(relayT, Math.max(relayT - 1000, claim.t));
		const fixed = /** @type {Claim} */ ({ ...claim, t });
		const ok = applyClaim(this.confirmed, arena, fixed);
		if (env.slot === this.net.slot)
			this.pending = this.pending.filter((p) => p.nonce !== nonce);
		this.rebuild();
		if (ok) grant(this.state, this, fixed);
	}

	/** What we show: confirmed, plus our own claims still in flight. */
	rebuild() {
		const arena = this.state.arena;
		const next = cloneContest(this.confirmed);
		if (arena) for (const p of this.pending) applyClaim(next, arena, p.claim);
		this.state.contest = next;
	}

	/** @param {number} dtMs */
	syncRemotes(dtMs) {
		if (!this.match) return;
		const now = this.net.serverNow();
		for (const p of this.state.penguins) {
			const adopting = p.id === this.state.myPid && this.adoptMs > 0;
			if (this.owns(p.id) && !adopting) continue;
			const sample = this.remote.sample(p.id, now);
			if (adopting) {
				this.adoptMs = Math.max(0, this.adoptMs - dtMs);
				if (sample && this.ownerOf(p.id) !== this.net.slot) {
					// Ours, but someone else kept it going while we were away.
					applySnap(p, sample.value);
					p.remote = false;
					this.adoptMs = 0;
				} else if (sample) {
					applySnap(p, sample.value);
					this.adoptMs = 0;
					p.remote = false;
				} else if (this.adoptMs <= 0) {
					p.remote = false;
				}
				continue;
			}
			if (!sample) {
				p.remote = true;
				continue;
			}
			applySnap(p, sample.value);
			p.remote = true;
			const r = this.state.roster[p.id];
			p.stale = sample.stale || (r?.kind === 'human' && !this.players.get(r.slot)?.connected);
		}
	}

	/** @param {number} dtMs */
	sendSnapshot(dtMs) {
		const s = this.state;
		const racing = this.match > 0 && s.mode !== 'idle';
		const hz = racing ? SNAPSHOT_HZ : LOBBY_SNAPSHOT_HZ;
		this.sendAccum += dtMs;
		if (this.sendAccum < 1000 / hz) return;
		this.sendAccum = 0;
		/** @type {Snap[]} */
		const snaps = [];
		if (racing) {
			for (const p of s.penguins) {
				if (!this.owns(p.id) || (p.id === s.myPid && this.adoptMs > 0)) continue;
				snaps.push(toSnap(p));
			}
		}
		if (!snaps.some((x) => x.pid === s.myPid)) {
			const me = s.penguins[s.myPid];
			snaps.push({
				...(me && racing ? toSnap(me) : blankSnap()),
				pid: LOBBY_PID,
				look: s.look,
			});
		}
		this.net.sendSnapshot(encodeSnaps(racing ? this.match : 0, snaps));
	}

	/**
	 * Everything a rejoiner needs once the event log is gone: the match itself,
	 * confirmed claims and knock-outs.
	 *
	 * @returns {Uint8Array}
	 */
	encodeKeyframe() {
		const info = /** @type {MatchInfo} */ (this.info);
		const w = writeMatch(new Writer(256), info);
		const jars = [...this.confirmed.jars];
		w.u16(jars.length);
		for (const [jar, by] of jars) w.u16(jar).u8(by);
		w.u8(this.confirmed.kicks.length);
		for (const ks of this.confirmed.kicks) {
			w.u16(ks.length);
			for (const k of ks) w.u32(Math.max(0, k.t)).f32(k.angle).u8(k.by);
		}
		w.u8(this.state.outs.length);
		for (const pid of this.state.outs) w.u8(pid);
		return w.done();
	}

	/**
	 * @param {Uint8Array} bytes
	 * @param {number} _serverTick
	 */
	applyKeyframe(bytes, _serverTick) {
		const r = new Reader(bytes);
		const info = readMatch(r);
		this.beginMatch(info);
		if (info.match !== this.match) return;
		const c = freshContest(this.state.arena?.balls.length ?? 0);
		const nj = r.u16();
		for (let i = 0; i < nj; i++) {
			const jar = r.u16();
			c.jars.set(jar, r.u8());
		}
		const nb = r.u8();
		for (let b = 0; b < nb; b++) {
			const nk = r.u16();
			const ks = [];
			for (let i = 0; i < nk; i++) ks.push({ t: r.u32(), angle: r.f32(), by: r.u8() });
			if (c.kicks[b]) c.kicks[b] = ks;
		}
		this.confirmed = c;
		const no = r.u8();
		for (let i = 0; i < no; i++) onOut(this.state, r.u8());
		this.rebuild();
	}
}

/**
 * @param {Claim} c
 */
function claimKey(c) {
	return c.type === 'grab' ? `j${c.jar}` : `b${c.ball}`;
}

/**
 * @param {Uint8Array} payload
 * @returns {any}
 */
function decodeControl(payload) {
	try {
		return JSON.parse(new TextDecoder().decode(payload));
	} catch {
		return null;
	}
}

/**
 * @param {Penguin} p
 * @returns {Snap}
 */
export function toSnap(p) {
	const flags =
		(p.stunMs > 0 ? 1 : 0) |
		(p.invulnMs > 0 ? 2 : 0) |
		(p.shoveMs > 0 ? 4 : 0) |
		(p.megaMs > 0 ? 16 : 0) |
		(p.knockMs > 0 ? 32 : 0) |
		(p.teeterMs > 0 ? 64 : 0);
	return {
		pid: p.id,
		x: p.x,
		y: p.y,
		z: p.z,
		face: p.face,
		vx: p.vx,
		vy: p.vy,
		speed: p.speed,
		lives: p.lives,
		mode: p.mode,
		flags,
		power: p.power,
		uses: p.uses,
		look: p.look,
	};
}

/** @returns {Snap} */
function blankSnap() {
	return {
		pid: LOBBY_PID,
		x: 0,
		y: 0,
		z: 0,
		face: 0,
		vx: 0,
		vy: 0,
		speed: 0,
		lives: 0,
		mode: 'play',
		flags: 0,
		power: '',
		uses: 0,
		look: { species: 0, hat: 0, hatColor: 0, scarf: 0, scarfColor: 0, glasses: 0 },
	};
}

/**
 * Write a remote sample into the penguin we draw.
 *
 * @param {Penguin} p
 * @param {Snap} s
 */
export function applySnap(p, s) {
	p.x = s.x;
	p.y = s.y;
	p.z = s.z;
	p.face = s.face;
	p.vx = s.vx;
	p.vy = s.vy;
	p.speed = s.speed;
	p.lives = s.lives;
	if (p.mode !== s.mode) p.modeMs = 0;
	// 'out' only ever comes from a confirmed event, never a snapshot.
	if (p.mode !== 'out') p.mode = s.mode === 'out' ? 'fall' : s.mode;
	p.stunMs = s.flags & 1 ? Math.max(p.stunMs, 200) : 0;
	p.invulnMs = s.flags & 2 ? Math.max(p.invulnMs, 200) : 0;
	p.shoveMs = s.flags & 4 ? Math.max(p.shoveMs, SHOVE_ANIM_MS * 0.6) : 0;
	p.megaMs = s.flags & 16 ? Math.max(p.megaMs, 200) : 0;
	p.knockMs = s.flags & 32 ? Math.max(p.knockMs, 200) : 0;
	p.teeterMs = s.flags & 64 ? Math.max(p.teeterMs, 100) : 0;
	p.power = s.power;
	p.uses = s.uses;
	p.look = s.look;
}
