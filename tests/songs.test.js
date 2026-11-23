import { describe, expect, it } from 'vitest';

import { freq, midi, notesBetween, SCALE, SONGS } from '../public/src/songs.js';

const DRUMS = new Set(['kick', 'snare', 'hat']);

describe('the soundtrack', () => {
	it('reads note names', () => {
		expect(midi('C4')).toBe(60);
		expect(midi('A4')).toBe(69);
		expect(freq(69)).toBeCloseTo(440);
		expect(freq(81)).toBeCloseTo(880);
	});

	it('keeps every pitched note in C major', () => {
		for (const song of Object.values(SONGS)) {
			for (const n of song.notes) {
				if (DRUMS.has(n.voice)) continue;
				expect(SCALE, `${song.id} step ${n.step} midi ${n.midi}`).toContain(n.midi % 12);
			}
		}
	});

	it('loops in whole bars with nothing hanging past the end', () => {
		for (const song of Object.values(SONGS)) {
			if (song.steps === 0) continue;
			expect(song.steps % 16).toBe(0);
			for (const n of song.notes) {
				expect(n.step).toBeGreaterThanOrEqual(0);
				expect(n.step + n.len).toBeLessThanOrEqual(song.steps);
			}
		}
	});

	it('starts each bar of the tunes on a note of that bar’s chord', () => {
		const chords = {
			match: ['C', 'Am', 'F', 'G', 'C', 'Am', 'F', 'G'],
			menu: ['C', 'Am', 'F', 'G', 'C', 'Em', 'F', 'G'],
		};
		/** @type {Record<string, number[]>} */
		const tones = { C: [0, 4, 7], Am: [9, 0, 4], F: [5, 9, 0], G: [7, 11, 2], Em: [4, 7, 11] };
		for (const [id, bars] of Object.entries(chords)) {
			const song = SONGS[id];
			if (!song) throw new Error(id);
			bars.forEach((c, b) => {
				const first = song.notes.find((n) => n.voice === 'bell' && n.step === b * 16);
				expect(first, `${id} bar ${b + 1}`).toBeDefined();
				expect(tones[c], `${id} bar ${b + 1}`).toContain((first?.midi ?? -1) % 12);
			});
		}
	});

	it('counts through loops: two passes give twice the notes, at the right times', () => {
		const song = SONGS['danger'];
		if (!song) throw new Error('danger');
		const one = notesBetween(song, 0, song.steps);
		const two = notesBetween(song, 0, song.steps * 2);
		expect(two).toHaveLength(one.length * 2);
		expect(two[one.length]?.at).toBe(song.steps + (one[0]?.note.step ?? 0));
		// A window across the loop point.
		const across = notesBetween(song, song.steps - 2, song.steps + 2);
		expect(across.every((e) => e.at >= song.steps - 2 && e.at < song.steps + 2)).toBe(true);
		expect(across.some((e) => e.at >= song.steps)).toBe(true);
	});

	it('stays calm but playful: easy tempos, a little swing, sudden death the quickest', () => {
		const bpm = (/** @type {string} */ id) => SONGS[id]?.bpm ?? 0;
		expect(bpm('menu')).toBeLessThanOrEqual(110);
		expect(bpm('match')).toBeLessThanOrEqual(110);
		expect(bpm('danger')).toBeGreaterThan(bpm('match'));
		expect(bpm('danger')).toBeLessThan(130);
		for (const song of Object.values(SONGS)) {
			expect(song.swing).toBeGreaterThanOrEqual(0);
			expect(song.swing).toBeLessThan(0.35);
		}
	});

	it('plays the fanfare once rather than looping it', () => {
		const win = SONGS['win'];
		if (!win) throw new Error('win');
		expect(win.steps).toBe(0);
		expect(notesBetween(win, 0, 32).length).toBe(win.notes.length);
		expect(notesBetween(win, 32, 64)).toHaveLength(0);
	});
});
