import { beforeEach, describe, expect, it } from 'vitest';

import {
	defaultLook,
	loadLook,
	LOOK_COUNTS,
	lookFromBytes,
	lookToBytes,
	randomLook,
	randomName,
	sanitizeLook,
	STARTER_NAMES,
} from '../public/src/looks.js';

describe('looks', () => {
	it('round-trips through bytes', () => {
		for (let i = 0; i < 20; i++) {
			const look = randomLook(Math.random);
			expect(lookFromBytes(lookToBytes(look))).toEqual(look);
		}
	});

	it('clamps junk to something drawable', () => {
		expect(sanitizeLook({ species: 999, hat: -1 })).toEqual(defaultLook());
		expect(sanitizeLook(null)).toEqual(defaultLook());
		const l = lookFromBytes([255, 255, 255, 255, 255, 255]);
		for (const [k, n] of Object.entries(LOOK_COUNTS)) {
			expect(l[/** @type {keyof typeof l} */ (k)]).toBeLessThan(n);
		}
	});
});

describe('a brand-new player', () => {
	beforeEach(() => localStorage.clear());

	it('gets a random outfit on the first visit, kept from then on', () => {
		const first = loadLook();
		expect(localStorage.getItem('penguin-push:look')).toBe(JSON.stringify(first));
		expect(loadLook()).toEqual(first);
	});

	it('gets a random name that is not a computer penguin name', () => {
		const name = randomName();
		expect(STARTER_NAMES).toContain(name);
		for (const bot of ['Pebble', 'Waddles', 'Sprinkles'])
			expect(STARTER_NAMES).not.toContain(bot);
	});
});
