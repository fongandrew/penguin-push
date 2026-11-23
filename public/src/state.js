/**
 * The game's threaded state object and its shapes.
 */

import { START_LIVES } from './constants.js';
import { freshContest } from './contest.js';
import { defaultLook } from './looks.js';

/** @typedef {import('./looks.js').Look} Look */
/** @typedef {import('./arena.js').Arena} Arena */
/** @typedef {import('./contest.js').Contest} Contest */
/** @typedef {import('./contest.js').Claim} Claim */

/**
 * @typedef {object} Input
 * @property {number} mx Stick x, -1..1 (screen right).
 * @property {number} my Stick y, -1..1 (screen down = toward the camera).
 * @property {boolean} shove Pressed this frame.
 * @property {boolean} power Pressed this frame.
 */

/** @typedef {'play' | 'fall' | 'respawn' | 'out'} PenguinMode */
/** @typedef {'' | 'snowball' | 'slide'} PowerKind */

/**
 * @typedef {object} Penguin
 * @property {number} id Roster position (0..3).
 * @property {string} name
 * @property {Look} look
 * @property {number} x
 * @property {number} y
 * @property {number} z Height (hill, falling, dropping back in).
 * @property {number} vx
 * @property {number} vy
 * @property {number} face Facing, radians (0 = +x).
 * @property {number} speed For the waddle.
 * @property {number} lives
 * @property {PenguinMode} mode
 * @property {number} modeMs Time in the current mode.
 * @property {number} stunMs
 * @property {number} invulnMs
 * @property {number} knockMs
 * @property {number} shoveMs Flipper-slap animation.
 * @property {number} cooldownMs Until the next shove.
 * @property {number} slideMs Belly slide remaining.
 * @property {number} megaMs Mega flippers remaining.
 * @property {PowerKind} power
 * @property {number} uses Power uses left.
 * @property {boolean} remote Drawn from snapshots, not simulated here.
 * @property {boolean} stale Remote and not heard from lately.
 * @property {boolean} bot
 * @property {number} place Finishing place once out (1 = winner), else 0.
 * @property {Map<number, number>} bumpAt Per-other-penguin bump cooldown (ms of match time).
 * @property {Set<string>} hitBy Giant-snowball rolls / waves already taken.
 */

/**
 * @typedef {object} RosterEntry
 * @property {'human' | 'bot'} kind
 * @property {number} slot Relay slot for humans (-1 solo human / bots).
 * @property {number} bot Bot index for bots, else -1.
 * @property {string} key Leaderboard key.
 */

/**
 * @typedef {object} Throw
 * @property {number} id
 * @property {number} by
 * @property {number} x0
 * @property {number} y0
 * @property {number} angle
 * @property {number} t0
 * @property {boolean} dead
 */

/**
 * @typedef {object} Fx One-shot visual/audio effect for the renderer.
 * @property {'splash' | 'pop' | 'heart' | 'fish' | 'bonk' | 'poof' | 'land' | 'kick' | 'crack' | 'throw' | 'slap'} kind
 * @property {number} x
 * @property {number} y
 * @property {number} [z]
 * @property {number} [pid]
 */

/**
 * @typedef {object} TallyEntry
 * @property {string} key
 * @property {string} name
 * @property {Look} look
 * @property {number} wins
 * @property {number} played
 * @property {boolean} bot
 */

/**
 * @typedef {object} Result
 * @property {number} winner Penguin id, or -1 for nobody.
 * @property {number[]} order Penguin ids, first place first.
 */

/**
 * @typedef {object} State
 * @property {'idle' | 'countdown' | 'play' | 'done'} mode
 * @property {Look} look This player's own look.
 * @property {string} name
 * @property {number} matchNo
 * @property {string} mapId
 * @property {Arena | null} arena
 * @property {number} seed
 * @property {RosterEntry[]} roster
 * @property {Penguin[]} penguins Index = roster position.
 * @property {number} myPid Our own penguin, -1 when spectating.
 * @property {number} t Match time, ms (negative during the countdown).
 * @property {Contest} contest What we show: confirmed + our pending claims.
 * @property {Throw[]} throws
 * @property {Fx[]} fx Drained by the renderer each frame.
 * @property {number[]} outs Penguins knocked out, in confirmed order.
 * @property {Result | null} result
 * @property {number} doneMs Time since the match ended.
 * @property {Map<string, TallyEntry>} tally Wins across this session.
 * @property {number} lastWave Wave already applied to our own penguins.
 * @property {number} throwSeq
 * @property {string} toast
 * @property {number} toastMs
 */

/** @returns {State} */
export function makeState() {
	return {
		mode: 'idle',
		look: defaultLook(),
		name: 'Penguin',
		matchNo: 0,
		mapId: 'hill',
		arena: null,
		seed: 1,
		roster: [],
		penguins: [],
		myPid: -1,
		t: 0,
		contest: freshContest(0),
		throws: [],
		fx: [],
		outs: [],
		result: null,
		doneMs: 0,
		tally: new Map(),
		lastWave: -1,
		throwSeq: 0,
		toast: '',
		toastMs: 0,
	};
}

/**
 * @param {number} id
 * @param {string} name
 * @param {Look} look
 * @param {{ x: number, y: number, face: number }} spot
 * @param {boolean} bot
 * @returns {Penguin}
 */
export function makePenguin(id, name, look, spot, bot) {
	return {
		id,
		name,
		look,
		x: spot.x,
		y: spot.y,
		z: 0,
		vx: 0,
		vy: 0,
		face: spot.face,
		speed: 0,
		lives: START_LIVES,
		mode: 'play',
		modeMs: 0,
		stunMs: 0,
		invulnMs: 0,
		knockMs: 0,
		shoveMs: 0,
		cooldownMs: 0,
		slideMs: 0,
		megaMs: 0,
		power: '',
		uses: 0,
		remote: false,
		stale: false,
		bot,
		place: 0,
		bumpAt: new Map(),
		hitBy: new Set(),
	};
}
