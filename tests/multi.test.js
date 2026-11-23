import { describe, expect, it } from 'vitest';

import { jarAt } from '../public/src/arena.js';
import { STEP } from '../public/src/constants.js';
import { jarAvailable } from '../public/src/contest.js';
import { tick } from '../public/src/game.js';
import { defaultLook } from '../public/src/looks.js';
import {
	decodeEvent,
	decodeSnaps,
	encodeEvent,
	encodeSnaps,
	makeRoster,
	Session,
	toSnap,
} from '../public/src/multi.js';
import { encodeJson, KIND } from '../public/src/net/protocol.js';
import { makePenguin, makeState } from '../public/src/state.js';
import { IDLE } from './helpers.js';

/**
 * A pretend relay: stamps order and time, delivers to everyone in order. Events
 * are queued until `flush()` so tests can stage "both claimed at once".
 */
class FakeRelay {
	constructor() {
		this.now = 10000;
		this.order = 0;
		/** @type {Session[]} */
		this.sessions = [];
		/** @type {(() => void)[]} */
		this.queue = [];
	}

	/**
	 * @param {number} slot
	 * @param {string} name
	 */
	join(slot, name) {
		const relay = this;
		const state = makeState();
		state.name = name;
		state.look = defaultLook();
		const session = new Session({
			state,
			code: 'TEST',
			net: {
				slot,
				serverNow: () => relay.now,
				tick: () => {},
				sendEvent: (b) => relay.post(slot, KIND.EVENT, b),
				sendSnapshot: (b) => relay.post(slot, KIND.SNAPSHOT, b),
				sendKeyframe: () => {},
				sendControl: (v) =>
					relay.post(slot, KIND.CONTROL, encodeJson({ kind: KIND.CONTROL }, v).slice(16)),
			},
		});
		this.sessions.push(session);
		const players = this.sessions.map((s) => ({
			slot: s.net.slot,
			name: s.state.name,
			connected: true,
		}));
		for (const s of this.sessions) {
			if (s === session) s.onWelcome({ seed: 777, players });
			else s.onPresence({ slot, state: 'join', name });
		}
		return session;
	}

	/**
	 * @param {number} slot
	 * @param {number} kind
	 * @param {Uint8Array} payload
	 */
	post(slot, kind, payload) {
		const order = kind === KIND.EVENT ? ++this.order : 0;
		const serverTick = this.now;
		this.queue.push(() => {
			for (const s of this.sessions) {
				if (kind === KIND.SNAPSHOT && s.net.slot === slot) continue;
				s.onMessage({
					kind,
					slot,
					serverTick,
					order,
					payload,
					seq: 0,
					flags: 0,
					protoVersion: 1,
				});
			}
		});
	}

	flush() {
		while (this.queue.length) this.queue.shift()?.();
	}

	/** @param {number} ms */
	advance(ms) {
		const end = this.now + ms;
		while (this.now < end) {
			this.now += STEP * 1000;
			for (const s of this.sessions) {
				s.frame(STEP * 1000);
				if (s.match) tick(s.state, s, s.matchTime(), STEP, IDLE);
			}
			this.flush();
		}
	}
}

describe('wire format', () => {
	it('round-trips snapshots', () => {
		const p = makePenguin(2, 'X', defaultLook(), { x: 3.5, y: -2.25, face: 1 }, false);
		p.lives = 4;
		p.power = 'snowball';
		p.uses = 2;
		p.stunMs = 100;
		const { match, snaps } = decodeSnaps(encodeSnaps(7, [toSnap(p)]));
		expect(match).toBe(7);
		const s = snaps[0];
		expect(s?.pid).toBe(2);
		expect(s?.x).toBeCloseTo(3.5, 2);
		expect(s?.y).toBeCloseTo(-2.25, 2);
		expect(s?.face).toBeCloseTo(1, 1);
		expect(s?.lives).toBe(4);
		expect(s?.power).toBe('snowball');
		expect((s?.flags ?? 0) & 1).toBe(1);
	});

	it('round-trips events', () => {
		const evs = [
			{ type: 'push', target: 1, ix: 3.25, iy: -1.5, stun: 300 },
			{ type: 'out', pid: 3, t: 4567 },
			{ type: 'hit', id: 4097, target: 2 },
			{ type: 'claim', nonce: 5, claim: { type: 'grab', jar: 3, by: 1, t: 999 } },
			{
				type: 'match',
				info: {
					match: 2,
					startAt: 123456,
					map: 1,
					humans: [0, 3],
					bots: 2,
					tally: [{ key: 's0', wins: 3, played: 4 }],
				},
			},
		];
		for (const ev of evs) expect(decodeEvent(encodeEvent(/** @type {any} */ (ev)))).toEqual(ev);
	});

	it('round-trips a throw, fish or snowball (positions are quantized)', () => {
		for (const kind of /** @type {const} */ (['fish', 'snowball'])) {
			const ev = { type: 'throw', id: 12, by: 1, x: 1.5, y: -2.5, angle: 0.5, t: 3000, kind };
			const back = /** @type {any} */ (decodeEvent(encodeEvent(/** @type {any} */ (ev))));
			expect(back).toMatchObject({ type: 'throw', id: 12, by: 1, t: 3000, kind });
			expect(back.x).toBeCloseTo(1.5, 2);
			expect(back.y).toBeCloseTo(-2.5, 2);
			expect(back.angle).toBeCloseTo(0.5, 5);
		}
	});

	it('builds rosters: humans first, bots to fill, never fewer than two', () => {
		expect(makeRoster([0], 0).map((r) => r.kind)).toEqual(['human', 'bot']);
		expect(makeRoster([0, 1, 2], 3)).toHaveLength(4);
		expect(makeRoster([0, 1, 2, 3, 4], 0)).toHaveLength(4);
	});
});

describe('two players through a relay', () => {
	it('start the same match, see each other, and agree on contested jars', () => {
		const relay = new FakeRelay();
		const a = relay.join(0, 'Ana');
		const b = relay.join(1, 'Ben');
		relay.flush();
		expect(a.isHost()).toBe(true);
		expect(b.isHost()).toBe(false);
		a.setSettings({ map: 'cove', bots: 2 });
		a.startNextMatch();
		relay.flush();
		expect(a.state.roster).toEqual(b.state.roster);
		expect(a.state.mapId).toBe('cove');
		expect(a.state.myPid).toBe(0);
		expect(b.state.myPid).toBe(1);
		// Bots belong to the host.
		expect(a.owns(2) && a.owns(3)).toBe(true);
		expect(b.owns(2) || b.owns(3)).toBe(false);

		relay.advance(4000);
		// Ben's penguin as Ana sees it tracks where Ben has it (bots aside).
		const benA = a.state.penguins[1];
		const benB = b.state.penguins[1];
		if (!benA || !benB) throw new Error('roster');
		for (const p of b.state.penguins.slice(2)) p.x = 50;
		benB.x = 1.5;
		benB.y = 1.5;
		benB.vx = 0;
		benB.vy = 0;
		benB.invulnMs = 99999;
		relay.advance(400);
		expect(benA.remote).toBe(true);
		expect(
			Math.hypot((benA?.x ?? 0) - (benB?.x ?? 9), (benA?.y ?? 0) - (benB?.y ?? 9)),
		).toBeLessThan(0.5);
	});

	it('agree on who got a jar when both grab it at once', () => {
		const relay = new FakeRelay();
		const a = relay.join(0, 'Ana');
		const b = relay.join(1, 'Ben');
		relay.flush();
		a.setSettings({ map: 'cove', bots: 0 });
		a.startNextMatch();
		relay.flush();
		const arena = a.state.arena;
		if (!arena) throw new Error('arena');
		// Both grab the same jar "at once": relay order decides, both agree.
		relay.advance(8000);
		const t = Math.round(a.matchTime());
		let i = 0;
		while (!jarAvailable(arena, a.confirmed, i, t) && i < 10) i++;
		expect(jarAt(arena, i).spawn).toBeLessThanOrEqual(t);
		a.claim({ type: 'grab', jar: i, by: 0, t });
		b.claim({ type: 'grab', jar: i, by: 1, t });
		relay.flush();
		expect(a.confirmed.jars.get(i)).toBe(0);
		expect(b.confirmed.jars.get(i)).toBe(0);
		expect(b.state.contest.jars.get(i)).toBe(0);
	});

	it('applies a shove on the owner’s screen and ends the match in relay order', () => {
		const relay = new FakeRelay();
		const a = relay.join(0, 'Ana');
		const b = relay.join(1, 'Ben');
		relay.flush();
		a.setSettings({ bots: 0 });
		a.startNextMatch();
		relay.flush();
		relay.advance(4500);
		const benOnB = b.state.penguins[1];
		if (!benOnB) throw new Error('roster');
		const before = benOnB.vx;
		a.send({ type: 'push', target: 1, ix: 6, iy: 0, stun: 0 });
		relay.flush();
		expect(benOnB.vx).toBeGreaterThan(before + 4);

		// Ben runs out of lives.
		benOnB.lives = 1;
		benOnB.invulnMs = 0;
		benOnB.x = 40;
		relay.advance(2000);
		expect(a.state.mode).toBe('done');
		expect(b.state.mode).toBe('done');
		expect(a.state.result?.winner).toBe(0);
		expect(b.state.result?.winner).toBe(0);
		expect(a.state.tally.get('s0')?.wins).toBe(1);
		expect(b.state.tally.get('s0')?.wins).toBe(1);
	});
});
