import { describe, expect, it } from 'vitest';

import {
	defaultLook,
	LOOK_COUNTS,
	lookFromBytes,
	lookToBytes,
	randomLook,
	sanitizeLook,
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
