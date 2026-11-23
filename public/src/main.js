/**
 * Penguin Push — entry point. Wires the screens, the solo and online links,
 * the renderer and the fixed-step loop together. `start()` runs on load.
 */

import { MAPS, shrinkAt } from './arena.js';
import { isMuted, setMuted, sfx, unlockAudio } from './audio.js';
import { buildId, GAME_ID, serverUrl } from './config.js';
import { BOT_NAMES, COUNTDOWN_MS, STEP } from './constants.js';
import { celebrationOver, startMatch, tick } from './game.js';
import { Controls } from './input.js';
import { loadLook, randomLook, randomName, saveLook } from './looks.js';
import { botLook, makeRoster, MAP_CHOICES, Session } from './multi.js';
import { createRoom, NetClient } from './net/client.js';
import { isValidCode, normalizeCode } from './net/codes.js';
import { Portraits, Renderer } from './render.js';
import { SoloLink } from './solo.js';
import { makeState } from './state.js';
import {
	$,
	button,
	renderHud,
	renderLobbyPlayers,
	renderResults,
	renderSettings,
	renderStation,
	resetHud,
	setNetStatus,
	showScreen,
} from './ui.js';

/** @typedef {import('./state.js').State} State */
/** @typedef {import('./state.js').Input} Input */
/** @typedef {import('./state.js').RosterEntry} RosterEntry */
/** @typedef {import('./game.js').Link} Link */
/** @typedef {import('./looks.js').Look} Look */

/** @typedef {'title' | 'station' | 'solo' | 'friends' | 'lobby' | 'game' | 'results'} Screen */

const STEP_MS = STEP * 1000;
const SOLO_KEY = 'penguin-push:solo';
const NAME_KEY = 'penguin-push:name';
const JOIN_GIVE_UP_MS = 7000;

export function start() {
	const state = makeState();
	state.look = loadLook();
	state.name = loadName();

	const renderer = new Renderer(/** @type {HTMLCanvasElement} */ ($('view')), $('labels'));
	const portraits = new Portraits();
	const controls = new Controls({
		pad: $('pad'),
		stick: $('stick'),
		knob: $('knob'),
		push: $('btn-push'),
		power: $('btn-power'),
	});

	/** @type {Screen} */
	let screen = 'title';
	/** Where the changing station's main button leads. */
	/** @type {'new' | 'lobby' | 'results'} */
	let stationMode = 'new';
	/** @type {Link | null} */
	let link = null;
	/** @type {{ client: NetClient, session: Session, code: string } | null} */
	let online = null;
	let soloClock = 0;
	let soloMatch = 0;
	const solo = loadSolo();
	const soloBotLooks = [0, 1, 2].map(() => randomLook(Math.random));
	let lastCount = 99;
	/** Power + uses last frame, to spot a fresh pick-up. */
	let lastPower = '';
	const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;
	let wentGo = false;
	let announcedEnd = false;
	const pendingRoom = normalizeCode(new URLSearchParams(location.search).get('room') ?? '');

	// The attract-mode match playing behind the menus: four computer penguins.
	const demo = makeState();
	const demoLink = new SoloLink(demo);
	let demoRound = 0;
	const startDemo = () => {
		demoRound++;
		const roster = makeRoster([], 4);
		startMatch(
			demo,
			{
				matchNo: demoRound,
				mapId: MAPS[(demoRound - 1) % MAPS.length]?.id ?? 'hill',
				seed: (Math.random() * 2 ** 32) >>> 0,
				roster,
				names: roster.map((r) => BOT_NAMES[r.bot] ?? 'Pip'),
				looks: roster.map(() => randomLook(Math.random)),
				myPid: -1,
			},
			0,
		);
	};
	startDemo();

	// ---------- screens ----------

	/** @param {Screen} next */
	function go(next) {
		screen = next;
		showScreen(next);
		controls.setEnabled(next === 'game');
		if (next === 'station') drawStation();
		if (next === 'solo') drawSolo();
		if (next === 'lobby') drawLobby();
		reportRoom();
	}

	function drawStation() {
		/** @type {HTMLInputElement} */ ($('name')).value = state.name;
		renderStation(state.look, (look) => {
			state.look = look;
			saveLook(look);
			sfx('click');
			drawStation();
		});
		const host = $('station-go');
		host.innerHTML = '';
		if (stationMode === 'new') {
			if (pendingRoom && isValidCode(pendingRoom)) {
				host.append(button(`Join room ${pendingRoom}`, () => joinRoom(pendingRoom)));
				host.append(button('Play vs Computer', () => go('solo'), 'big alt'));
			} else {
				host.append(button('🤖 Play vs Computer', () => go('solo')));
				host.append(button('👫 Play with Friends', () => go('friends'), 'big alt'));
			}
			host.append(button('← Back', () => go('title'), 'link'));
		} else {
			host.append(
				button('Looking good! ✨', () => go(stationMode === 'lobby' ? 'lobby' : 'results')),
			);
		}
	}

	function drawSolo() {
		renderSettings(
			$('solo-maps'),
			$('solo-bots'),
			solo,
			true,
			(next) => {
				Object.assign(solo, next);
				saveSolo(solo);
				sfx('click');
				drawSolo();
			},
			1,
		);
	}

	function drawLobby() {
		if (!online) return;
		const s = online.session;
		$('lobby-code').textContent = online.code;
		const players = s.lobbyPlayers();
		const hostSlot = s.hostSlot();
		const humans = players.slice(0, 4).map((p) => ({
			name: p.name,
			look: p.look,
			me: p.me,
			connected: p.connected,
			host: p.slot === hostSlot,
			bot: false,
		}));
		const bots = Math.max(
			humans.length < 2 ? 2 - humans.length : 0,
			Math.min(s.settings.bots, 4 - humans.length),
		);
		const botLooks = [0, 1, 2].map((i) => botLook(s.roomSeed, i));
		for (let i = 0; i < bots; i++) {
			humans.push({
				name: BOT_NAMES[i] ?? 'Bot',
				look: botLooks[i] ?? null,
				me: false,
				connected: true,
				host: false,
				bot: true,
			});
		}
		renderLobbyPlayers(humans, portraits);
		renderSettings(
			$('lobby-maps'),
			$('lobby-bots'),
			s.settings,
			s.isHost(),
			(next) => {
				s.setSettings(next);
				sfx('click');
			},
			0,
		);
		const host = s.isHost();
		$('btn-lobby-start').hidden = !host;
		$('lobby-wait').hidden = host;
		$('lobby-wait').textContent = `Waiting for ${s.hostName()} to start…`;
		if (screen === 'results') drawResultsButtons();
	}

	function drawResultsButtons() {
		const isHost = !online || online.session.isHost();
		$('btn-again').hidden = !isHost;
		$('results-wait').hidden = isHost;
		if (online)
			$('results-wait').textContent =
				`Waiting for ${online.session.hostName()} to start the next round…`;
	}

	function showResults() {
		const myKey = state.roster[state.myPid]?.key ?? '';
		renderResults(state, portraits, myKey);
		drawResultsButtons();
		if (!online) saveSolo(solo, state);
		go('results');
	}

	// ---------- solo ----------

	function startSolo() {
		soloMatch++;
		/** @type {RosterEntry[]} */
		const roster = [{ kind: 'human', slot: -1, bot: -1, key: 'you' }];
		for (let i = 0; i < solo.bots; i++)
			roster.push({ kind: 'bot', slot: -1, bot: i, key: `b${i}` });
		const mapId =
			solo.map === 'mix' ? (MAPS[(soloMatch - 1) % MAPS.length]?.id ?? 'hill') : solo.map;
		startMatch(
			state,
			{
				matchNo: soloMatch,
				mapId,
				seed: (Math.random() * 2 ** 32) >>> 0,
				roster,
				names: [state.name, ...BOT_NAMES],
				looks: [state.look, ...soloBotLooks],
				myPid: 0,
			},
			-COUNTDOWN_MS,
		);
		link = new SoloLink(state);
		soloClock = -COUNTDOWN_MS;
		beginPlay();
	}

	function beginPlay() {
		lastCount = 99;
		wentGo = false;
		announcedEnd = false;
		resetHud();
		go('game');
	}

	// ---------- online ----------

	async function createAndJoin() {
		const err = $('friends-error');
		err.hidden = true;
		try {
			const room = await createRoom({
				serverUrl: serverUrl(),
				gameId: GAME_ID,
				buildId: await buildId(),
			});
			await joinRoom(room.code);
		} catch {
			err.hidden = false;
			err.textContent =
				'Couldn’t reach the game server. Check your connection and try again.';
		}
	}

	/** @param {string} raw */
	async function joinRoom(raw) {
		const code = normalizeCode(raw);
		const err = $('friends-error');
		if (!isValidCode(code)) {
			err.hidden = false;
			err.textContent = 'Room codes are 4 letters.';
			go('friends');
			return;
		}
		leaveRoom();
		let welcomed = false;
		const client = new NetClient({
			serverUrl: serverUrl(),
			gameId: GAME_ID,
			buildId: await buildId(),
			room: code,
			name: state.name,
			onStatus: (status) => {
				setNetStatus(
					status === 'reconnecting'
						? 'Reconnecting…'
						: status === 'connecting'
							? 'Connecting…'
							: '',
				);
			},
			onWelcome: (w) => {
				welcomed = true;
				online?.session.onWelcome(w);
				if (screen === 'friends' || screen === 'title' || screen === 'solo') go('lobby');
			},
			onPresence: (m) => online?.session.onPresence(m),
			onMessage: (env) => online?.session.onMessage(env),
			onNeedKeyframe: () => online?.session.keyframe(),
			onError: (e) => {
				const c = String(e?.code ?? '');
				if (c === 'version' && e?.reloading) return;
				const msg =
					c === 'no_room'
						? `There’s no room called ${code}.`
						: c === 'full'
							? 'That room is full.'
							: c === 'version_stuck'
								? 'This game is out of date. Close the tab and open it again.'
								: '';
				if (msg) failJoin(msg);
			},
		});
		const session = new Session({
			state,
			code,
			net: {
				get slot() {
					return client.slot;
				},
				serverNow: () => client.serverNow(),
				tick: (dt) => client.clock.step(dt),
				sendEvent: (b) => void client.sendEvent(b),
				sendSnapshot: (b) => void client.sendSnapshot(b),
				sendKeyframe: (b) => void client.sendKeyframe(b),
				sendControl: (v) => void client.sendControl(v),
			},
			onLobby: () => {
				if (screen === 'lobby' || screen === 'results') drawLobby();
			},
			onMatch: () => {
				link = session;
				beginPlay();
			},
		});
		online = { client, session, code };
		const url = new URL(location.href);
		url.searchParams.set('room', code);
		history.replaceState(null, '', url);
		client.connect();
		go('lobby');
		setTimeout(() => {
			if (!welcomed && online?.client === client) failJoin(`Couldn’t join room ${code}.`);
		}, JOIN_GIVE_UP_MS);
	}

	/** @param {string} msg */
	function failJoin(msg) {
		leaveRoom();
		go('friends');
		const err = $('friends-error');
		err.hidden = false;
		err.textContent = msg;
	}

	function leaveRoom() {
		if (!online) return;
		online.client.close();
		online = null;
		link = null;
		setNetStatus('');
		state.mode = 'idle';
		state.arena = null;
		state.tally.clear();
		const url = new URL(location.href);
		url.searchParams.delete('room');
		history.replaceState(null, '', url);
		reportRoom();
	}

	// ---------- buttons ----------

	const click = (/** @type {string} */ id, /** @type {() => void} */ fn) =>
		$(id).addEventListener('click', () => {
			unlockAudio();
			sfx('click');
			fn();
		});

	click('btn-play', () => {
		stationMode = 'new';
		go('station');
	});
	click('btn-howto', () => ($('howto').hidden = false));
	click('btn-howto-close', () => ($('howto').hidden = true));
	click('btn-random', () => {
		state.look = randomLook(Math.random);
		saveLook(state.look);
		drawStation();
	});
	$('name').addEventListener('input', () => {
		const v = /** @type {HTMLInputElement} */ ($('name')).value.trim().slice(0, 12);
		state.name = v || state.name;
		saveName(state.name);
	});
	click('btn-solo-start', startSolo);
	click('btn-solo-back', () => go('station'));
	click('btn-create', () => void createAndJoin());
	click('btn-join', () => void joinRoom(/** @type {HTMLInputElement} */ ($('join-code')).value));
	$('join-code').addEventListener('keydown', (e) => {
		if (e.key === 'Enter')
			void joinRoom(/** @type {HTMLInputElement} */ ($('join-code')).value);
	});
	click('btn-friends-back', () => go('station'));
	click('btn-lobby-start', () => online?.session.startNextMatch());
	click('btn-lobby-outfit', () => {
		stationMode = 'lobby';
		go('station');
	});
	click('btn-lobby-leave', () => {
		leaveRoom();
		go('title');
	});
	click('btn-share', () => {
		const url = new URL(location.href);
		url.searchParams.delete('server');
		void navigator.clipboard?.writeText(url.toString()).then(() => {
			$('btn-share').textContent = '✅ Copied!';
			setTimeout(() => ($('btn-share').textContent = '📋 Copy link'), 1500);
		});
	});
	click('btn-again', () => {
		if (online) online.session.startNextMatch();
		else startSolo();
	});
	click('btn-results-outfit', () => {
		stationMode = online ? 'lobby' : 'results';
		go('station');
	});
	click('btn-results-leave', () => {
		leaveRoom();
		link = null;
		state.arena = null;
		go('title');
	});
	click('btn-quit', () => {
		if (online) {
			leaveRoom();
			go('title');
		} else {
			link = null;
			state.arena = null;
			state.mode = 'idle';
			go('solo');
		}
	});
	const mute = $('btn-mute');
	const drawMute = () => (mute.textContent = isMuted() ? '🔇' : '🔊');
	drawMute();
	mute.addEventListener('click', () => {
		unlockAudio();
		setMuted(!isMuted());
		drawMute();
	});
	addEventListener('pointerdown', unlockAudio, { once: true });

	// ---------- loop ----------

	let last = performance.now();
	let time = 0;
	/** @type {Input} */
	const idle = { mx: 0, my: 0, shove: false, power: false };

	/**
	 * Step a match up to `target` ms in fixed steps.
	 *
	 * @param {State} s
	 * @param {Link} l
	 * @param {number} target
	 * @param {Input} input
	 */
	function advance(s, l, target, input) {
		if (target - s.t > STEP_MS * 12) s.t = target - STEP_MS * 12;
		let first = true;
		while (s.t + STEP_MS <= target + 0.001) {
			tick(
				s,
				l,
				s.t + STEP_MS,
				STEP,
				first ? input : { ...input, shove: false, power: false },
			);
			first = false;
		}
	}

	/** @param {number} now */
	function frame(now) {
		requestAnimationFrame(frame);
		const dtMs = Math.min(100, Math.max(0, now - last));
		last = now;
		const dt = dtMs / 1000;
		time += dt;
		online?.session.frame(dtMs);

		if (screen === 'station') {
			renderer.renderStation(state.look, time, dt, innerWidth / innerHeight < 0.9);
			return;
		}
		const live = (screen === 'game' || screen === 'results') && state.arena && link;
		if (live && link) {
			const input = controls.read();
			let target;
			if (online) target = online.session.matchTime();
			else target = soloClock += dtMs;
			advance(state, link, target, input);
			playFx(state);
			drawHud();
			renderer.renderGame(state, time, dt);
			state.fx.length = 0;
			if (screen === 'game' && celebrationOver(state)) showResults();
			return;
		}
		advance(demo, demoLink, demo.t + dtMs, idle);
		renderer.renderGame(demo, time, dt, { attract: true });
		demo.fx.length = 0;
		if (celebrationOver(demo)) startDemo();
	}

	/** @param {State} s */
	function playFx(s) {
		for (const fx of s.fx) {
			if (fx.kind === 'slap') {
				if (fx.z) sfx('slap');
			} else if (fx.kind === 'heart' || fx.kind === 'fish') sfx(fx.kind);
			else sfx(fx.kind);
		}
	}

	function drawHud() {
		renderHud(state, portraits);
		const t = state.t;
		const big = $('big');
		if (t < 0) {
			const n = Math.ceil(-t / 1000);
			if (n !== lastCount) {
				lastCount = n;
				big.hidden = false;
				big.textContent = String(n);
				big.style.animation = 'none';
				void big.offsetWidth;
				big.style.animation = '';
				sfx('beep');
			}
		} else if (t < 900) {
			if (!wentGo) {
				wentGo = true;
				big.hidden = false;
				big.textContent = 'PUSH!';
				sfx('go');
			}
		} else big.hidden = true;
		const secs = Math.max(0, Math.floor(t / 1000));
		$('clock').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
		const banner = $('banner');
		const cracking = shrinkAt(t) < 1 && state.mode === 'play';
		banner.hidden = !cracking;
		if (cracking) banner.textContent = '🧊 The ice is cracking!';
		const toast = $('toast');
		if (state.toastMs > 0) {
			// On a keyboard, say which key uses the power.
			const text =
				finePointer && /Snowballs|Belly/.test(state.toast)
					? `${state.toast} Press E`
					: state.toast;
			if (toast.hidden || toast.textContent !== text) {
				toast.textContent = text;
				toast.hidden = false;
			}
		} else toast.hidden = true;
		const me = state.penguins[state.myPid];
		$('spectate').hidden = !(state.mode === 'play' && (!me || me.mode === 'out'));
		$('btn-push').hidden = !me || me.mode === 'out' || state.mode !== 'play';
		const pw = $('btn-power');
		pw.hidden = !me || !me.power || me.mode === 'out' || state.mode !== 'play';
		// Pulse the power button until the first use of each new power.
		const powerKey = me && me.power ? `${me.power}:${me.uses}` : '';
		if (powerKey !== lastPower) {
			const fresh = !!me?.power && (!lastPower || lastPower.split(':')[0] !== me.power);
			pw.classList.toggle('fresh', fresh);
			lastPower = powerKey;
		}
		if (me && me.power) {
			const icon = me.power === 'snowball' ? '❄️' : '🛷';
			const ic = /** @type {HTMLElement} */ (pw.querySelector('.icon'));
			const us = /** @type {HTMLElement} */ (pw.querySelector('.uses'));
			if (ic.textContent !== icon) ic.textContent = icon;
			if (us.textContent !== `×${me.uses}`) us.textContent = `×${me.uses}`;
		}
		if (state.mode === 'done' && !announcedEnd) {
			announcedEnd = true;
			sfx('win');
		}
	}

	/** Tell the service worker not to swap the bundle mid-match. */
	function reportRoom() {
		navigator.serviceWorker?.controller?.postMessage({ type: 'ROOM_ACTIVE', active: !!online });
	}

	registerServiceWorker();
	setInterval(reportRoom, 1000);
	if (pendingRoom && isValidCode(pendingRoom)) {
		stationMode = 'new';
		go('station');
	} else go('title');
	requestAnimationFrame(frame);

	// Test/debug hook — read state, drive deterministic scenarios.
	/** @type {any} */ (window).__game = {
		state,
		demo,
		screen: () => screen,
		online: () => online,
		startSolo: (/** @type {{ map?: string, bots?: number }} */ opts = {}) => {
			if (opts.map && MAP_CHOICES.includes(opts.map)) solo.map = opts.map;
			if (opts.bots) solo.bots = opts.bots;
			startSolo();
		},
		/** Skip the countdown. */
		skipCountdown: () => {
			if (!online) soloClock = Math.max(soloClock, 0);
		},
		teleport: (/** @type {number} */ pid, /** @type {number} */ x, /** @type {number} */ y) => {
			const p = state.penguins[pid];
			if (!p) return;
			p.x = x;
			p.y = y;
			p.vx = 0;
			p.vy = 0;
		},
		/** Shove giant snowball `ball` toward `angle` (radians), as penguin `by`. */
		kickBall: (/** @type {number} */ ball, /** @type {number} */ angle, by = 0) =>
			link?.claim({ type: 'kick', ball, angle, by, t: Math.round(state.t) }),
		/** Jump match time forward (solo only), e.g. to the next wave. */
		skipTo: (/** @type {number} */ t) => {
			if (!online) {
				soloClock = t;
				state.t = t;
			}
		},
		joinRoom: (/** @type {string} */ code) => joinRoom(code),
		createRoom: () => createAndJoin(),
	};
}

/** @returns {string} */
function loadName() {
	try {
		const saved = localStorage.getItem(NAME_KEY);
		if (saved) return saved;
		// First visit: a random penguin name, kept from now on.
		const name = randomName();
		localStorage.setItem(NAME_KEY, name);
		return name;
	} catch {
		return randomName();
	}
}

/** @param {string} name */
function saveName(name) {
	try {
		localStorage.setItem(NAME_KEY, name);
	} catch {
		// private mode
	}
}

/**
 * @returns {{ map: string, bots: number }}
 */
function loadSolo() {
	try {
		const raw = JSON.parse(localStorage.getItem(SOLO_KEY) ?? '{}');
		return {
			map: MAP_CHOICES.includes(raw.map) ? raw.map : 'mix',
			bots: Math.max(1, Math.min(3, Number(raw.bots) || 3)),
		};
	} catch {
		return { map: 'mix', bots: 3 };
	}
}

/**
 * @param {{ map: string, bots: number }} s
 * @param {State} [_state]
 */
function saveSolo(s, _state) {
	try {
		localStorage.setItem(SOLO_KEY, JSON.stringify(s));
	} catch {
		// private mode
	}
}

function registerServiceWorker() {
	const host = location.hostname;
	if (!('serviceWorker' in navigator) || host === 'localhost' || host === '127.0.0.1') return;
	navigator.serviceWorker.register('./sw.js').catch(() => {
		// Works without a worker; just not offline.
	});
}

start();
