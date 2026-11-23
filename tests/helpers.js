/**
 * Shared test helpers (not a test file).
 */

import { startMatch } from '../public/src/game.js';
import { defaultLook } from '../public/src/looks.js';
import { makeRoster } from '../public/src/multi.js';
import { makeState } from '../public/src/state.js';

/** @typedef {import('../public/src/state.js').Input} Input */

/** @type {Input} */
export const IDLE = { mx: 0, my: 0, shove: false, power: false };

/**
 * A started all-bot solo match (or with `myPid` set, one human).
 *
 * @param {string} mapId
 * @param {number} [seed]
 * @param {number} [myPid]
 */
export function soloMatch(mapId, seed = 42, myPid = -1) {
	const state = makeState();
	const roster = makeRoster([], 4);
	startMatch(
		state,
		{
			matchNo: 1,
			mapId,
			seed,
			roster,
			names: ['A', 'B', 'C', 'D'],
			looks: roster.map(() => defaultLook()),
			myPid,
		},
		0,
	);
	return state;
}
