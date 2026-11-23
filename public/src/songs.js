/**
 * The soundtrack, as data: tempo, chords and note patterns on a 16th-note
 * grid. Pure — no audio here — so it can be checked mechanically (in key,
 * in time, loops cleanly). `music.js` turns it into sound.
 *
 * Everything is in C major over a I–vi–IV–V style progression, so any
 * part can sit on top of any other without clashing.
 */

/**
 * @typedef {'bell' | 'pluck' | 'bass' | 'stab' | 'kick' | 'snare' | 'hat'} Voice
 *
 * @typedef {object} Note
 * @property {number} step 16th-note step within the loop.
 * @property {number} midi MIDI note (drums ignore it).
 * @property {number} len Length in 16ths.
 * @property {Voice} voice
 * @property {number} vel 0..1
 *
 * @typedef {object} Song
 * @property {string} id
 * @property {number} bpm
 * @property {number} swing 0 straight … ~0.3 lilting: how late the offbeat 16ths land.
 * @property {number} steps Loop length in 16ths (0 = play once).
 * @property {Note[]} notes Sorted by step.
 */

/** Note names → MIDI, octave 4 = middle C (60). */
const NAMES = /** @type {const} */ ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 });

/**
 * @param {string} name e.g. 'E5', 'C#4'
 * @returns {number}
 */
export function midi(name) {
	const m = /^([A-G])(#?)(\d)$/.exec(name);
	if (!m) throw new Error(`bad note ${name}`);
	const letter = /** @type {keyof typeof NAMES} */ (m[1]);
	return 12 * (Number(m[3]) + 1) + NAMES[letter] + (m[2] ? 1 : 0);
}

/** C major pitch classes. */
export const SCALE = [0, 2, 4, 5, 7, 9, 11];

/**
 * Chord roots per bar, as note names an octave below the bass register.
 *
 * @typedef {{ root: string, tones: string[] }} Chord
 */

/** @type {Record<string, Chord>} */
const CHORDS = {
	C: { root: 'C3', tones: ['C4', 'E4', 'G4'] },
	Am: { root: 'A2', tones: ['A3', 'C4', 'E4'] },
	F: { root: 'F2', tones: ['F3', 'A3', 'C4'] },
	G: { root: 'G2', tones: ['G3', 'B3', 'D4'] },
	Dm: { root: 'D3', tones: ['D4', 'F4', 'A4'] },
	Em: { root: 'E3', tones: ['E4', 'G4', 'B4'] },
};

/**
 * @param {string} chord
 */
function chord(chord) {
	const c = CHORDS[chord];
	if (!c) throw new Error(`no chord ${chord}`);
	return c;
}

/**
 * A melody line from 'note:len' tokens; '-' is a rest of that length.
 *
 * @param {number} start Step to start at.
 * @param {string} line e.g. 'E5:2 G5:2 C6:4 -:2'
 * @param {Voice} voice
 * @param {number} vel
 * @returns {Note[]}
 */
function line(start, line, voice, vel) {
	/** @type {Note[]} */
	const out = [];
	let step = start;
	for (const tok of line.trim().split(/\s+/)) {
		const [n, l] = tok.split(':');
		const len = Number(l ?? 1);
		if (n && n !== '-') out.push({ step, midi: midi(n), len, voice, vel });
		step += len;
	}
	return out;
}

/**
 * Bass, chord stabs and drums for a list of chords (one per bar).
 *
 * @param {string[]} bars
 * @param {object} feel
 * @param {'walk' | 'eighths' | 'long'} feel.bass
 * @param {boolean} feel.stabs
 * @param {'none' | 'soft' | 'light' | 'full' | 'drive'} feel.drums
 * @returns {Note[]}
 */
function band(bars, feel) {
	/** @type {Note[]} */
	const out = [];
	bars.forEach((name, b) => {
		const c = chord(name);
		const s = b * 16;
		const root = midi(c.root);
		if (feel.bass === 'long') {
			out.push({ step: s, midi: root, len: 14, voice: 'bass', vel: 0.7 });
		} else if (feel.bass === 'walk') {
			// Root, fifth, octave, fifth: the bouncy one.
			for (const [o, iv, v] of /** @type {[number, number, number][]} */ ([
				[0, 0, 0.9],
				[4, 7, 0.6],
				[8, 12, 0.75],
				[12, 7, 0.6],
			])) {
				out.push({ step: s + o, midi: root + iv, len: 3, voice: 'bass', vel: v });
			}
		} else {
			for (let e = 0; e < 8; e++) {
				const iv = e % 4 === 3 ? 7 : e % 2 ? 12 : 0;
				out.push({
					step: s + e * 2,
					midi: root + iv,
					len: 2,
					voice: 'bass',
					vel: e % 2 ? 0.55 : 0.8,
				});
			}
		}
		if (feel.stabs) {
			for (const o of [2, 6, 10, 14]) {
				for (const t of c.tones)
					out.push({ step: s + o, midi: midi(t), len: 1, voice: 'stab', vel: 0.25 });
			}
		}
		if (feel.drums === 'light') {
			// Gentle: a soft kick, a quiet snap on 2 and 4, faint hats.
			for (const o of [0, 8])
				out.push({ step: s + o, midi: 0, len: 1, voice: 'kick', vel: 0.55 });
			out.push({ step: s + 10, midi: 0, len: 1, voice: 'kick', vel: 0.35 });
			for (const o of [4, 12])
				out.push({ step: s + o, midi: 0, len: 1, voice: 'snare', vel: 0.32 });
			for (let h = 0; h < 8; h++) {
				out.push({
					step: s + h * 2,
					midi: 0,
					len: 1,
					voice: 'hat',
					vel: h % 2 ? 0.16 : 0.24,
				});
			}
		} else if (feel.drums === 'soft') {
			for (const o of [2, 6, 10, 14])
				out.push({ step: s + o, midi: 0, len: 1, voice: 'hat', vel: 0.35 });
		} else if (feel.drums === 'full' || feel.drums === 'drive') {
			const kicks = feel.drums === 'drive' ? [0, 4, 8, 12] : [0, 8, 10];
			for (const o of kicks)
				out.push({ step: s + o, midi: 0, len: 1, voice: 'kick', vel: 0.9 });
			for (const o of [4, 12])
				out.push({ step: s + o, midi: 0, len: 1, voice: 'snare', vel: 0.7 });
			const hats = feel.drums === 'drive' ? 16 : 8;
			for (let h = 0; h < hats; h++) {
				const o = h * (16 / hats);
				out.push({
					step: s + o,
					midi: 0,
					len: 1,
					voice: 'hat',
					vel: o % 4 === 0 ? 0.5 : 0.3,
				});
			}
		}
	});
	return out;
}

/**
 * Up-and-down chord arpeggio in 16ths, for the frantic sudden-death theme.
 *
 * @param {string[]} bars
 * @returns {Note[]}
 */
function arpeggios(bars) {
	/** @type {Note[]} */
	const out = [];
	bars.forEach((name, b) => {
		const tones = chord(name).tones.map((t) => midi(t) + 24);
		const pattern = [0, 1, 2, 3, 2, 1, 0, 1];
		for (let i = 0; i < 8; i++) {
			const idx = /** @type {number} */ (pattern[i]);
			const m =
				idx === 3
					? /** @type {number} */ (tones[0]) + 12
					: /** @type {number} */ (tones[idx]);
			out.push({
				step: b * 16 + i * 2,
				midi: m,
				len: 2,
				voice: 'pluck',
				vel: i % 2 === 0 ? 0.5 : 0.35,
			});
		}
	});
	return out;
}

/** @param {Note[]} notes */
function sorted(notes) {
	return notes.sort((a, b) => a.step - b.step);
}

const MATCH_BARS = ['C', 'Am', 'F', 'G', 'C', 'Am', 'F', 'G'];

/** Title screen, changing station, lobby: gentle and twinkly. */
const MENU = {
	id: 'menu',
	bpm: 88,
	swing: 0.18,
	steps: 128,
	notes: sorted([
		...band(['C', 'Am', 'F', 'G', 'C', 'Em', 'F', 'G'], {
			bass: 'long',
			stabs: false,
			drums: 'soft',
		}),
		...line(0, 'E5:4 G5:4 C6:6 B5:2', 'bell', 0.5),
		...line(16, 'A5:4 C6:4 E6:6 D6:2', 'bell', 0.5),
		...line(32, 'C6:4 A5:4 F5:6 G5:2', 'bell', 0.5),
		...line(48, 'B5:4 G5:4 D5:8', 'bell', 0.5),
		...line(64, 'E5:4 G5:4 C6:6 D6:2', 'bell', 0.5),
		...line(80, 'E6:4 D6:4 B5:6 G5:2', 'bell', 0.5),
		...line(96, 'A5:4 C6:4 F6:4 E6:4', 'bell', 0.5),
		...line(112, 'D6:4 B5:4 G5:8', 'bell', 0.5),
	]),
};

/** During a match: bouncy. */
const MATCH = {
	id: 'match',
	bpm: 108,
	swing: 0.22,
	steps: 128,
	notes: sorted([
		...band(MATCH_BARS, { bass: 'walk', stabs: true, drums: 'light' }),
		...line(0, 'E5:2 G5:2 C6:4 B5:2 G5:2 E5:4', 'bell', 0.6),
		...line(16, 'A5:2 C6:2 E6:4 D6:2 C6:2 A5:4', 'bell', 0.6),
		...line(32, 'F5:2 A5:2 C6:4 A5:2 F5:2 A5:4', 'bell', 0.6),
		...line(48, 'G5:2 B5:2 D6:4 B5:2 G5:2 D5:4', 'bell', 0.6),
		...line(64, 'E5:2 G5:2 C6:4 D6:2 E6:2 C6:4', 'bell', 0.6),
		...line(80, 'C6:2 B5:2 A5:4 E5:2 A5:2 C6:4', 'bell', 0.6),
		...line(96, 'A5:2 G5:2 F5:4 A5:2 C6:2 F6:4', 'bell', 0.6),
		...line(112, 'D6:2 C6:2 B5:2 G5:2 D6:4 -:4', 'bell', 0.6),
	]),
};

/** Sudden death: faster, driving, arpeggios instead of a tune. */
const DANGER = {
	id: 'danger',
	bpm: 124,
	swing: 0.12,
	steps: 64,
	notes: sorted([
		...band(['Am', 'F', 'C', 'G'], { bass: 'eighths', stabs: false, drums: 'full' }),
		...arpeggios(['Am', 'F', 'C', 'G']),
	]),
};

/** Somebody won: a one-shot fanfare. */
const WIN = {
	id: 'win',
	bpm: 120,
	swing: 0,
	steps: 0,
	notes: sorted([
		...line(0, 'C5:1 E5:1 G5:1 C6:3 G5:1 C6:1 E6:8', 'bell', 0.75),
		...line(0, 'C4:6 G3:2 C4:8', 'bass', 0.8),
		{ step: 8, midi: midi('C4'), len: 8, voice: 'stab', vel: 0.4 },
		{ step: 8, midi: midi('E4'), len: 8, voice: 'stab', vel: 0.4 },
		{ step: 8, midi: midi('G4'), len: 8, voice: 'stab', vel: 0.4 },
		{ step: 0, midi: 0, len: 1, voice: 'kick', vel: 0.8 },
		{ step: 8, midi: 0, len: 1, voice: 'kick', vel: 0.9 },
		{ step: 8, midi: 0, len: 1, voice: 'snare', vel: 0.6 },
	]),
};

/** @type {Record<string, Song>} */
export const SONGS = { menu: MENU, match: MATCH, danger: DANGER, win: WIN };

/** @param {number} m */
export function freq(m) {
	return 440 * 2 ** ((m - 69) / 12);
}

/**
 * Notes that start in steps [from, to) of a song's timeline (counting
 * through loops). Returns each with its absolute step.
 *
 * @param {Song} song
 * @param {number} from
 * @param {number} to
 * @returns {{ at: number, note: Note }[]}
 */
export function notesBetween(song, from, to) {
	/** @type {{ at: number, note: Note }[]} */
	const out = [];
	if (song.steps === 0) {
		for (const note of song.notes)
			if (note.step >= from && note.step < to) out.push({ at: note.step, note });
		return out;
	}
	const first = Math.floor(from / song.steps);
	const last = Math.floor((to - 1) / song.steps);
	for (let loop = first; loop <= last; loop++) {
		const base = loop * song.steps;
		for (const note of song.notes) {
			const at = base + note.step;
			if (at >= from && at < to) out.push({ at, note });
		}
	}
	return out;
}
