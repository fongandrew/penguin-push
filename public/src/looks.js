/**
 * Penguin appearance: species, accessories and colours. Purely cosmetic — a
 * look travels as six bytes so friends see each other's outfits.
 */

/**
 * @typedef {object} Look
 * @property {number} species Index into SPECIES.
 * @property {number} hat Index into HATS.
 * @property {number} hatColor Index into COLORS.
 * @property {number} scarf Index into SCARVES.
 * @property {number} scarfColor Index into COLORS.
 * @property {number} glasses Index into GLASSES.
 */

/**
 * @typedef {object} Species
 * @property {string} id
 * @property {string} name
 * @property {number} back Back/head colour.
 * @property {number} belly
 * @property {number} beak
 * @property {number} feet
 * @property {'mask' | 'emperor' | 'rockhopper' | 'gentoo' | 'chick' | 'plain'} face
 */

/** @type {Species[]} */
export const SPECIES = [
	{
		id: 'classic',
		name: 'Classic',
		back: 0x23252e,
		belly: 0xffffff,
		beak: 0xff9b2f,
		feet: 0xff9b2f,
		face: 'mask',
	},
	{
		id: 'emperor',
		name: 'Emperor',
		back: 0x2c3648,
		belly: 0xfff8ea,
		beak: 0x3a3030,
		feet: 0x3a3a44,
		face: 'emperor',
	},
	{
		id: 'rockhopper',
		name: 'Rockhopper',
		back: 0x2d2f3a,
		belly: 0xffffff,
		beak: 0xe2442f,
		feet: 0xff9ab0,
		face: 'rockhopper',
	},
	{
		id: 'gentoo',
		name: 'Gentoo',
		back: 0x33363f,
		belly: 0xffffff,
		beak: 0xff6a1a,
		feet: 0xff8a2a,
		face: 'gentoo',
	},
	{
		id: 'fairy',
		name: 'Little Blue',
		back: 0x4f7fb8,
		belly: 0xf4f8ff,
		beak: 0x2d2d38,
		feet: 0xffc7d6,
		face: 'plain',
	},
	{
		id: 'chick',
		name: 'Fluffy Chick',
		back: 0x8c8f99,
		belly: 0xd9dbe3,
		beak: 0x2d2d38,
		feet: 0x5b5d66,
		face: 'chick',
	},
	{
		id: 'pink',
		name: 'Bubblegum',
		back: 0xff7eb6,
		belly: 0xfff0f6,
		beak: 0xffb52f,
		feet: 0xffb52f,
		face: 'mask',
	},
];

export const HATS = [
	'None',
	'Beanie',
	'Top Hat',
	'Party Hat',
	'Crown',
	'Bow',
	'Viking',
	'Propeller',
	'Flower',
];
export const SCARVES = ['None', 'Scarf', 'Stripy Scarf', 'Bow Tie', 'Cape'];
export const GLASSES = ['None', 'Round Specs', 'Sunglasses', 'Star Shades'];

/** Accessory colours. */
export const COLORS = [
	{ name: 'Red', hex: 0xf0435a },
	{ name: 'Orange', hex: 0xff9124 },
	{ name: 'Yellow', hex: 0xffd23f },
	{ name: 'Green', hex: 0x3fcf6e },
	{ name: 'Teal', hex: 0x22c1c3 },
	{ name: 'Blue', hex: 0x3d7dff },
	{ name: 'Purple', hex: 0x9b5cf6 },
	{ name: 'Pink', hex: 0xff6fb5 },
];

/** @returns {Look} */
export function defaultLook() {
	return { species: 0, hat: 1, hatColor: 0, scarf: 1, scarfColor: 0, glasses: 0 };
}

/** @type {(keyof Look)[]} */
export const LOOK_KEYS = ['species', 'hat', 'hatColor', 'scarf', 'scarfColor', 'glasses'];

/** @type {Record<keyof Look, number>} */
export const LOOK_COUNTS = {
	species: SPECIES.length,
	hat: HATS.length,
	hatColor: COLORS.length,
	scarf: SCARVES.length,
	scarfColor: COLORS.length,
	glasses: GLASSES.length,
};

/**
 * Bring any decoded/stored value into range so a bad byte can't crash the
 * renderer.
 *
 * @param {Partial<Record<keyof Look, unknown>> | null | undefined} raw
 * @returns {Look}
 */
export function sanitizeLook(raw) {
	const base = defaultLook();
	if (!raw || typeof raw !== 'object') return base;
	for (const key of LOOK_KEYS) {
		const v = Number(raw[key]);
		if (Number.isInteger(v) && v >= 0 && v < LOOK_COUNTS[key]) base[key] = v;
	}
	return base;
}

/**
 * @param {Look} look
 * @returns {number[]}
 */
export function lookToBytes(look) {
	return LOOK_KEYS.map((k) => look[k]);
}

/**
 * @param {ArrayLike<number>} bytes
 * @returns {Look}
 */
export function lookFromBytes(bytes) {
	/** @type {Partial<Record<keyof Look, number>>} */
	const raw = {};
	LOOK_KEYS.forEach((k, i) => (raw[k] = bytes[i] ?? 0));
	return sanitizeLook(raw);
}

/**
 * A look for a computer penguin: random but cheerful.
 *
 * @param {() => number} rng
 * @returns {Look}
 */
export function randomLook(rng) {
	const pick = (/** @type {number} */ n) => Math.floor(rng() * n);
	return {
		species: pick(SPECIES.length),
		hat: 1 + pick(HATS.length - 1),
		hatColor: pick(COLORS.length),
		scarf: pick(SCARVES.length),
		scarfColor: pick(COLORS.length),
		glasses: rng() < 0.3 ? 1 + pick(GLASSES.length - 1) : 0,
	};
}

const STORE_KEY = 'penguin-push:look';

/** @returns {Look} */
export function loadLook() {
	try {
		const raw = localStorage.getItem(STORE_KEY);
		if (raw) return sanitizeLook(JSON.parse(raw));
	} catch {
		// private mode or bad JSON
	}
	// First visit: a surprise outfit, kept from now on.
	const look = randomLook(Math.random);
	saveLook(look);
	return look;
}

/** Names for a brand-new player (all different from the computer penguins'). */
export const STARTER_NAMES = [
	'Pip',
	'Mochi',
	'Noodle',
	'Peanut',
	'Pickle',
	'Dumpling',
	'Frosty',
	'Popsicle',
	'Biscuit',
	'Waffles',
	'Bubbles',
	'Nugget',
	'Sprout',
	'Jellybean',
	'Cocoa',
	'Maple',
	'Blizzard',
	'Snowdrop',
	'Tofu',
	'Marshmallow',
];

/** @returns {string} */
export function randomName() {
	return STARTER_NAMES[Math.floor(Math.random() * STARTER_NAMES.length)] ?? 'Pip';
}

/** @param {Look} look */
export function saveLook(look) {
	try {
		localStorage.setItem(STORE_KEY, JSON.stringify(look));
	} catch {
		// private mode
	}
}
