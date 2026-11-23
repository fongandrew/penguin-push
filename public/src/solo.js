/**
 * Playing against computer penguins on one screen: the same rules as online,
 * with a link that owns every penguin and confirms every claim instantly.
 */

import { applyClaim } from './contest.js';
import { grant, onOut } from './game.js';

/** @typedef {import('./state.js').State} State */
/** @typedef {import('./game.js').GameEvent} GameEvent */
/** @typedef {import('./contest.js').Claim} Claim */
/** @typedef {import('./game.js').Link} Link */

/**
 * @implements {Link}
 */
export class SoloLink {
	/** @param {State} state */
	constructor(state) {
		this.state = state;
	}

	owns() {
		return true;
	}

	/** @param {GameEvent} ev */
	send(ev) {
		if (ev.type === 'out') onOut(this.state, ev.pid);
	}

	/** @param {Claim} claim */
	claim(claim) {
		const arena = this.state.arena;
		if (!arena) return;
		if (applyClaim(this.state.contest, arena, claim)) grant(this.state, this, claim);
	}
}
