/**
 * Background music: plays the song sheets in songs.js on little synthesized
 * instruments, scheduled a fraction of a second ahead on the Web Audio clock
 * so timing stays tight even when the game's frame rate dips.
 *
 * Songs change at the next bar line, so a switch never lands mid-phrase.
 */

import { musicOutput, whenAudioReady } from './audio.js';
import { freq, notesBetween, SONGS } from './songs.js';

/** @typedef {import('./songs.js').Song} Song */
/** @typedef {import('./songs.js').Note} Note */

const LOOKAHEAD_S = 0.15;
const TICK_MS = 30;

let enabled = true;
try {
	enabled = localStorage.getItem('penguin-push:music') !== '0';
} catch {
	// private mode
}

/** @type {Song | null} */
let song = null;
/** @type {Song | null} */
let queued = null;
/** Next step to schedule, and the audio time it falls at. */
let step = 0;
let stepTime = 0;
/** @type {ReturnType<typeof setInterval> | null} */
let timer = null;
/** @type {AudioBuffer | null} */
let noiseBuf = null;
/** The loop the game last asked for (kept while muted). */
let wanted = '';
/** A one-shot (the win fanfare) is playing; then back to `wanted`. */
let jingle = false;

export function musicOn() {
	return enabled;
}

/** @param {boolean} on */
export function setMusic(on) {
	enabled = on;
	try {
		localStorage.setItem('penguin-push:music', on ? '1' : '0');
	} catch {
		// private mode
	}
	if (!on) stop();
	else if (wanted) {
		const id = wanted;
		wanted = '';
		playSong(id);
	}
}

/**
 * Ask for a song by id ('menu', 'match', 'danger', 'win', or '' for silence).
 * Cheap to call every frame: only a change does anything.
 *
 * @param {string} id
 */
export function playSong(id) {
	if (id === wanted) return;
	wanted = id;
	if (!enabled || jingle) return;
	whenAudioReady(() => start(id));
}

/**
 * Play a one-shot (e.g. 'win') at the next bar line, then carry on with
 * whatever loop is wanted.
 *
 * @param {string} id
 */
export function playJingle(id) {
	if (!enabled) return;
	whenAudioReady(() => {
		const out = musicOutput();
		const next = SONGS[id];
		if (!out || !next) return;
		jingle = true;
		if (!song || !timer) {
			song = next;
			step = 0;
			stepTime = out.ctx.currentTime + 0.05;
			timer = setInterval(schedule, TICK_MS);
			schedule();
		} else queued = next;
	});
}

/** @param {string} id */
function start(id) {
	const out = musicOutput();
	if (!out || wanted !== id || jingle) return;
	const next = SONGS[id] ?? null;
	if (!next) {
		stop();
		return;
	}
	if (!song || !timer) {
		song = next;
		step = 0;
		stepTime = out.ctx.currentTime + 0.05;
		timer = setInterval(schedule, TICK_MS);
		schedule();
		return;
	}
	// Change at the next bar line.
	queued = next;
}

function stop() {
	if (timer !== null) clearInterval(timer);
	timer = null;
	song = null;
	queued = null;
	jingle = false;
}

/** Seconds per 16th note. */
function stepLen(/** @type {Song} */ s) {
	return 60 / s.bpm / 4;
}

function schedule() {
	const out = musicOutput();
	if (!out || !song) return;
	const { ctx } = out;
	// A tab that was in the background: don't try to catch up, just resume.
	if (stepTime < ctx.currentTime - 0.25) stepTime = ctx.currentTime + 0.05;
	while (song && stepTime < ctx.currentTime + LOOKAHEAD_S) {
		if (queued && step % 16 === 0) {
			song = queued;
			queued = null;
			step = 0;
		}
		const s = /** @type {Song} */ (song);
		if (s.steps === 0 && step >= 32) {
			// The one-shot has finished: back to the wanted loop (or quiet).
			jingle = false;
			song = SONGS[wanted] ?? null;
			step = 0;
			if (!song) stop();
			continue;
		}
		const len = stepLen(s);
		for (const { note } of notesBetween(s, step, step + 1)) play(note, stepTime, len);
		step++;
		stepTime += len;
	}
}

/**
 * @param {Note} n
 * @param {number} t Audio time.
 * @param {number} sixteenth Seconds per 16th.
 */
function play(n, t, sixteenth) {
	const out = musicOutput();
	if (out) voice(out.ctx, out.bus, n, t, sixteenth);
}

/**
 * One note on one instrument.
 *
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} bus
 * @param {Note} n
 * @param {number} t
 * @param {number} sixteenth
 */
function voice(ctx, bus, n, t, sixteenth) {
	const dur = n.len * sixteenth;
	switch (n.voice) {
		case 'bell': {
			// Sine plus a quiet octave: a soft glockenspiel.
			tone(ctx, bus, 'sine', freq(n.midi), t, dur * 0.9 + 0.25, 0.32 * n.vel, 0.005);
			tone(ctx, bus, 'sine', freq(n.midi) * 2, t, 0.25, 0.08 * n.vel, 0.003);
			break;
		}
		case 'pluck':
			tone(ctx, bus, 'triangle', freq(n.midi), t, 0.16, 0.22 * n.vel, 0.003);
			break;
		case 'bass':
			tone(
				ctx,
				bus,
				'triangle',
				freq(n.midi),
				t,
				Math.max(0.12, dur * 0.85),
				0.55 * n.vel,
				0.008,
				900,
			);
			break;
		case 'stab':
			tone(
				ctx,
				bus,
				'square',
				freq(n.midi),
				t,
				Math.max(0.08, dur * 0.6),
				0.05 * n.vel,
				0.004,
				1600,
			);
			break;
		case 'kick': {
			const o = ctx.createOscillator();
			const g = ctx.createGain();
			o.frequency.setValueAtTime(140, t);
			o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
			g.gain.setValueAtTime(0.9 * n.vel, t);
			g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
			o.connect(g).connect(bus);
			o.start(t);
			o.stop(t + 0.2);
			break;
		}
		case 'snare':
			noise(ctx, bus, t, 0.12, 0.35 * n.vel, 'bandpass', 1800);
			break;
		case 'hat':
			noise(ctx, bus, t, 0.04, 0.18 * n.vel, 'highpass', 7000);
			break;
	}
}

/**
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} bus
 * @param {OscillatorType} type
 * @param {number} f
 * @param {number} t
 * @param {number} dur
 * @param {number} vol
 * @param {number} attack
 * @param {number} [cutoff] Optional lowpass.
 */
function tone(ctx, bus, type, f, t, dur, vol, attack, cutoff) {
	const o = ctx.createOscillator();
	const g = ctx.createGain();
	o.type = type;
	o.frequency.setValueAtTime(f, t);
	g.gain.setValueAtTime(0.0001, t);
	g.gain.linearRampToValueAtTime(vol, t + attack);
	g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
	let node = /** @type {AudioNode} */ (o);
	if (cutoff) {
		const lp = ctx.createBiquadFilter();
		lp.type = 'lowpass';
		lp.frequency.value = cutoff;
		node = node.connect(lp);
	}
	node.connect(g).connect(bus);
	o.start(t);
	o.stop(t + dur + 0.05);
}

/**
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} bus
 * @param {number} t
 * @param {number} dur
 * @param {number} vol
 * @param {BiquadFilterType} type
 * @param {number} f
 */
function noise(ctx, bus, t, dur, vol, type, f) {
	if (!noiseBuf) {
		const len = Math.floor(ctx.sampleRate * 0.5);
		noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
		const data = noiseBuf.getChannelData(0);
		for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
	}
	const src = ctx.createBufferSource();
	src.buffer = noiseBuf;
	const fl = ctx.createBiquadFilter();
	fl.type = type;
	fl.frequency.value = f;
	const g = ctx.createGain();
	g.gain.setValueAtTime(vol, t);
	g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
	src.connect(fl).connect(g).connect(bus);
	src.start(t);
	src.stop(t + dur + 0.02);
}

/**
 * Render a song into any audio context (an OfflineAudioContext, to make a
 * WAV). Not used by the game itself.
 *
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} bus
 * @param {string} id
 * @param {number} loops
 * @returns {number} Seconds of audio scheduled.
 */
export function renderSong(ctx, bus, id, loops) {
	const s = SONGS[id];
	if (!s) return 0;
	const len = stepLen(s);
	const steps = s.steps ? s.steps * loops : 32;
	for (const { at, note } of notesBetween(s, 0, steps))
		voice(ctx, bus, note, 0.05 + at * len, len);
	return 0.05 + steps * len + 0.6;
}
