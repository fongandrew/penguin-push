import { describe, expect, it } from 'vitest';

import { jarAt, makeArena } from '../public/src/arena.js';
import { BALL_GONE_MS, BALL_RESPAWN_MS } from '../public/src/constants.js';
import {
	applyClaim,
	ballAt,
	cloneContest,
	freshContest,
	jarAvailable,
} from '../public/src/contest.js';

describe('contested claims', () => {
	it('gives a jar to the first grab only', () => {
		const a = makeArena('cove', 11);
		const c = freshContest(0);
		const jar = jarAt(a, 0);
		const t = jar.spawn + 10;
		expect(applyClaim(c, a, { type: 'grab', jar: 0, by: 2, t })).toBe(true);
		expect(applyClaim(c, a, { type: 'grab', jar: 0, by: 1, t: t + 5 })).toBe(false);
		expect(c.jars.get(0)).toBe(2);
		expect(jarAvailable(a, c, 0, t + 10)).toBe(false);
	});

	it('refuses jars before they appear or after they melt', () => {
		const a = makeArena('cove', 11);
		const c = freshContest(0);
		const jar = jarAt(a, 1);
		expect(applyClaim(c, a, { type: 'grab', jar: 1, by: 0, t: jar.spawn - 1 })).toBe(false);
		expect(applyClaim(c, a, { type: 'grab', jar: 1, by: 0, t: jar.expire + 1 })).toBe(false);
	});

	it('lets one penguin shove a resting giant snowball, then it respawns', () => {
		const a = makeArena('hill', 2);
		const c = freshContest(a.balls.length);
		expect(ballAt(a, c, 0, 500).kind).toBe('rest');
		expect(applyClaim(c, a, { type: 'kick', ball: 0, angle: 2, by: 0, t: 1000 })).toBe(true);
		// A second shove a moment later loses: the ball is already rolling.
		expect(applyClaim(c, a, { type: 'kick', ball: 0, angle: 1, by: 1, t: 1050 })).toBe(false);
		expect(ballAt(a, c, 0, 1500).kind).toBe('roll');
		const kick = c.kicks[0]?.[0];
		if (!kick) throw new Error('no kick');
		let t = 1500;
		while (ballAt(a, c, 0, t).kind === 'roll') t += 50;
		expect(['gone', 'away']).toContain(ballAt(a, c, 0, t).kind);
		expect(ballAt(a, c, 0, t + BALL_GONE_MS + BALL_RESPAWN_MS + 100).kind).toBe('rest');
	});

	it('clones independently', () => {
		const c = freshContest(1);
		const d = cloneContest(c);
		d.jars.set(3, 1);
		d.kicks[0]?.push({ t: 1, angle: 0, by: 0 });
		expect(c.jars.size).toBe(0);
		expect(c.kicks[0]?.length).toBe(0);
	});
});
