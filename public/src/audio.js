/**
 * Little synthesized sound effects — no audio files to download.
 */

/** @type {AudioContext | null} */
let ctx = null;
/** Sound effects and music each get their own volume control. */
/** @type {GainNode | null} */
let sfxBus = null;
/** @type {GainNode | null} */
let musicBus = null;
let muted = false;
try {
	muted = localStorage.getItem('penguin-push:muted') === '1';
} catch {
	// private mode
}

/** Must be called from a user gesture before sounds can play. */
export function unlockAudio() {
	if (ctx) {
		if (ctx.state === 'suspended') void ctx.resume();
		return;
	}
	const AC = window.AudioContext ?? /** @type {any} */ (window).webkitAudioContext;
	if (!AC) return;
	ctx = new AC();
	sfxBus = ctx.createGain();
	sfxBus.connect(ctx.destination);
	musicBus = ctx.createGain();
	musicBus.gain.value = muted ? 0 : MUSIC_LEVEL;
	musicBus.connect(ctx.destination);
	for (const fn of onUnlock) fn();
}

/** Music sits under the sound effects. */
const MUSIC_LEVEL = 0.28;

/** @type {(() => void)[]} */
const onUnlock = [];

/**
 * Run `fn` once audio is unlocked (now, if it already is).
 *
 * @param {() => void} fn
 */
export function whenAudioReady(fn) {
	if (ctx) fn();
	else onUnlock.push(fn);
}

/** The shared context and the music bus, for music.js. */
export function musicOutput() {
	return ctx && musicBus ? { ctx, bus: musicBus } : null;
}

/**
 * Dip the music for a moment so a big sound effect cuts through.
 *
 * @param {number} depth 0..1, how far to dip.
 */
function duck(depth) {
	if (!ctx || !musicBus || muted) return;
	const g = musicBus.gain;
	const t = ctx.currentTime;
	g.cancelScheduledValues(t);
	g.setValueAtTime(g.value, t);
	g.linearRampToValueAtTime(MUSIC_LEVEL * (1 - depth), t + 0.04);
	g.linearRampToValueAtTime(MUSIC_LEVEL, t + 0.6);
}

export function isMuted() {
	return muted;
}

/** @param {boolean} m */
export function setMuted(m) {
	muted = m;
	if (ctx && musicBus) {
		musicBus.gain.cancelScheduledValues(ctx.currentTime);
		musicBus.gain.value = m ? 0 : MUSIC_LEVEL;
	}
	try {
		localStorage.setItem('penguin-push:muted', m ? '1' : '0');
	} catch {
		// private mode
	}
}

/**
 * @param {number} freq
 * @param {number} dur
 * @param {OscillatorType} type
 * @param {number} vol
 * @param {number} [slide] Frequency to glide to.
 * @param {number} [delay]
 */
function tone(freq, dur, type, vol, slide, delay = 0) {
	if (!ctx || muted) return;
	const t = ctx.currentTime + delay;
	const o = ctx.createOscillator();
	const g = ctx.createGain();
	o.type = type;
	o.frequency.setValueAtTime(freq, t);
	if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
	g.gain.setValueAtTime(vol, t);
	g.gain.exponentialRampToValueAtTime(0.001, t + dur);
	o.connect(g).connect(sfxBus ?? ctx.destination);
	o.start(t);
	o.stop(t + dur + 0.02);
}

/**
 * @param {number} dur
 * @param {number} vol
 * @param {number} cutoff
 */
function noise(dur, vol, cutoff) {
	if (!ctx || muted) return;
	const t = ctx.currentTime;
	const len = Math.floor(ctx.sampleRate * dur);
	const buf = ctx.createBuffer(1, len, ctx.sampleRate);
	const data = buf.getChannelData(0);
	for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
	const src = ctx.createBufferSource();
	src.buffer = buf;
	const f = ctx.createBiquadFilter();
	f.type = 'lowpass';
	f.frequency.setValueAtTime(cutoff, t);
	f.frequency.exponentialRampToValueAtTime(cutoff / 6, t + dur);
	const g = ctx.createGain();
	g.gain.setValueAtTime(vol, t);
	g.gain.exponentialRampToValueAtTime(0.001, t + dur);
	src.connect(f)
		.connect(g)
		.connect(sfxBus ?? ctx.destination);
	src.start(t);
}

/** @type {Record<string, number>} */
const lastPlayed = {};

/**
 * @param {string} name
 */
export function sfx(name) {
	if (!ctx || muted) return;
	const now = performance.now();
	if (now - (lastPlayed[name] ?? 0) < 45) return;
	lastPlayed[name] = now;
	if (name === 'splash' || name === 'kick' || name === 'out') duck(0.5);
	switch (name) {
		case 'slap':
			noise(0.08, 0.25, 3000);
			tone(320, 0.08, 'square', 0.05, 200);
			break;
		case 'bonk':
			tone(520, 0.14, 'sine', 0.22, 180);
			tone(780, 0.08, 'triangle', 0.08, 300);
			break;
		case 'splash':
			noise(0.55, 0.35, 2400);
			tone(300, 0.3, 'sine', 0.1, 90);
			break;
		case 'pop':
			tone(600, 0.1, 'sine', 0.2, 1200);
			break;
		case 'heart':
			tone(660, 0.12, 'triangle', 0.18);
			tone(880, 0.12, 'triangle', 0.18, undefined, 0.1);
			tone(1320, 0.2, 'triangle', 0.15, undefined, 0.2);
			break;
		case 'fish':
			tone(500, 0.1, 'square', 0.08, 900);
			tone(900, 0.15, 'square', 0.08, 1400, 0.09);
			break;
		case 'throw':
			noise(0.15, 0.15, 5000);
			break;
		case 'whoosh':
			noise(0.12, 0.1, 3500);
			break;
		case 'poof':
			noise(0.2, 0.25, 1800);
			tone(200, 0.15, 'sine', 0.1, 120);
			break;
		case 'land':
			tone(160, 0.12, 'sine', 0.22, 90);
			break;
		case 'kick':
			tone(110, 0.4, 'sawtooth', 0.08, 60);
			noise(0.4, 0.15, 900);
			break;
		case 'beep':
			tone(660, 0.12, 'square', 0.08);
			break;
		case 'go':
			tone(990, 0.3, 'square', 0.09);
			break;
		case 'win':
			[523, 659, 784, 1046].forEach((f, i) =>
				tone(f, 0.25, 'triangle', 0.16, undefined, i * 0.13),
			);
			break;
		case 'out':
			tone(400, 0.5, 'sawtooth', 0.06, 120);
			break;
		case 'click':
			tone(800, 0.05, 'triangle', 0.08);
			break;
		default:
			break;
	}
}
