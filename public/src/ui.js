/**
 * The DOM side: screens, the changing station's option rows, lobby, HUD
 * cards and the leaderboard. Pure rendering of what main.js hands it.
 */

import { MAPS } from './arena.js';
import { PLAYER_COLORS } from './constants.js';
import { COLORS, GLASSES, HATS, LOOK_COUNTS, SCARVES, SPECIES } from './looks.js';

/** @typedef {import('./looks.js').Look} Look */
/** @typedef {import('./state.js').State} State */
/** @typedef {import('./state.js').TallyEntry} TallyEntry */
/** @typedef {import('./render.js').Portraits} Portraits */

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
export function $(id) {
	const el = document.getElementById(id);
	if (!el) throw new Error(`missing #${id}`);
	return el;
}

export const SCREENS = ['title', 'station', 'solo', 'friends', 'lobby', 'results'];

/**
 * @param {string} name A screen id, or 'game' for none (just the HUD).
 */
export function showScreen(name) {
	for (const s of SCREENS) $(s).hidden = s !== name;
	for (const s of [...SCREENS, 'game']) document.body.classList.toggle(`on-${s}`, s === name);
	$('hud').hidden = name !== 'game';
	document.body.classList.toggle('playing', name === 'game');
}

/**
 * @param {string} text
 * @param {(() => void) | null} onClick
 * @param {string} [cls]
 */
export function button(text, onClick, cls = 'big primary') {
	const b = document.createElement('button');
	b.className = cls;
	b.innerHTML = text;
	if (onClick) b.addEventListener('click', onClick);
	return b;
}

/**
 * @typedef {object} StationRow
 * @property {keyof Look} key
 * @property {string} label
 * @property {(i: number) => string} name
 * @property {(keyof Look)} [colorKey] Show colour swatches for this key below.
 * @property {string} emoji
 */

/** @type {StationRow[]} */
const ROWS = [
	{ key: 'species', label: 'Penguin', emoji: '🐧', name: (i) => SPECIES[i]?.name ?? '' },
	{ key: 'hat', label: 'Hat', emoji: '🎩', name: (i) => HATS[i] ?? '', colorKey: 'hatColor' },
	{
		key: 'scarf',
		label: 'Neck',
		emoji: '🧣',
		name: (i) => SCARVES[i] ?? '',
		colorKey: 'scarfColor',
	},
	{ key: 'glasses', label: 'Eyes', emoji: '🕶️', name: (i) => GLASSES[i] ?? '' },
];

/**
 * Build (or rebuild) the changing station's rows for the current look.
 *
 * @param {Look} look
 * @param {(look: Look) => void} onChange
 */
export function renderStation(look, onChange) {
	const host = $('station-rows');
	host.innerHTML = '';
	// Tabs: one option card at a time, so it's never cramped.
	const tabs = document.createElement('div');
	tabs.className = 'tabs';
	tabs.setAttribute('role', 'tablist');
	for (const row of ROWS) {
		const t = button(
			`<span class="em">${row.emoji}</span>${row.label}`,
			() => {
				stationTab = row.key;
				renderStation(look, onChange);
			},
			`tab${stationTab === row.key ? ' on' : ''}`,
		);
		t.dataset['tab'] = row.key;
		t.setAttribute('role', 'tab');
		t.setAttribute('aria-selected', String(stationTab === row.key));
		tabs.append(t);
	}
	host.append(tabs);
	const row = ROWS.find((r) => r.key === stationTab) ?? ROWS[0];
	if (!row) return;
	const group = document.createElement('div');
	group.className = 'group';
	const div = document.createElement('div');
	div.className = 'opt';
	const val = document.createElement('span');
	val.className = 'val';
	val.textContent = row.name(look[row.key]);
	const n = LOOK_COUNTS[row.key];
	const step = (/** @type {number} */ d) => () => {
		onChange({ ...look, [row.key]: (look[row.key] + d + n) % n });
	};
	const prev = button('◀', step(-1), '');
	prev.setAttribute('aria-label', `Previous ${row.label}`);
	const next = button('▶', step(1), '');
	next.setAttribute('aria-label', `Next ${row.label}`);
	next.dataset['row'] = row.key;
	div.append(prev, val, next);
	group.append(div);
	const ck = row.colorKey;
	if (ck) {
		const sw = document.createElement('div');
		sw.className = 'swatches';
		const off = look[row.key] === 0;
		COLORS.forEach((c, i) => {
			const b = button(
				'',
				() => onChange({ ...look, [ck]: i }),
				`swatch${look[ck] === i ? ' on' : ''}`,
			);
			b.style.background = `#${c.hex.toString(16).padStart(6, '0')}`;
			b.setAttribute('aria-label', c.name);
			b.disabled = off;
			sw.append(b);
		});
		// Keep the card the same height whether or not colours apply.
		sw.classList.toggle('off', off);
		group.append(sw);
	} else {
		// No colours for this one: a short hint instead of an empty gap.
		const hint = document.createElement('div');
		hint.className = 'hint st-hint';
		hint.textContent =
			row.key === 'species' ? 'Pick your kind of penguin' : 'Pick some eyewear';
		group.append(hint);
	}
	host.append(group);
}

/** Which changing-station tab is open. */
/** @type {keyof Look} */
let stationTab = 'species';

/**
 * Map + bot-count pickers (solo setup and the lobby).
 *
 * @param {HTMLElement} maps
 * @param {HTMLElement} bots
 * @param {{ map: string, bots: number }} settings
 * @param {boolean} editable
 * @param {(next: { map?: string, bots?: number }) => void} onChange
 * @param {number} minBots
 */
export function renderSettings(maps, bots, settings, editable, onChange, minBots) {
	maps.innerHTML = '';
	const opts = [{ id: 'mix', name: 'Mix it up', emoji: '🔀' }, ...MAPS];
	for (const m of opts) {
		const b = button(
			`<span class="em">${m.emoji}</span>${m.name}`,
			() => onChange({ map: m.id }),
			`choice${settings.map === m.id ? ' on' : ''}`,
		);
		b.disabled = !editable;
		b.dataset['map'] = m.id;
		maps.append(b);
	}
	bots.innerHTML = '';
	for (let n = minBots; n <= 3; n++) {
		const b = button(
			`<span class="em">${n === 0 ? '🚫' : '🤖'.repeat(n)}</span>${n === 0 ? 'None' : n}`,
			() => onChange({ bots: n }),
			`choice${settings.bots === n ? ' on' : ''}`,
		);
		b.disabled = !editable;
		b.dataset['bots'] = String(n);
		bots.append(b);
	}
}

/**
 * @typedef {object} LobbyCard
 * @property {string} name
 * @property {Look | null} look
 * @property {boolean} me
 * @property {boolean} connected
 * @property {boolean} host
 * @property {boolean} bot
 */

/**
 * @param {LobbyCard[]} cards
 * @param {Portraits} portraits
 */
export function renderLobbyPlayers(cards, portraits) {
	const host = $('lobby-players');
	host.innerHTML = '';
	cards.forEach((c, i) => {
		const div = document.createElement('div');
		div.className = `pl${c.connected ? '' : ' away'}${c.bot ? ' bot' : ''}`;
		div.style.setProperty('--c', PLAYER_COLORS[i] ?? '#ccc');
		const img = document.createElement('img');
		img.alt = '';
		img.src = c.look ? portraits.get(c.look) : '';
		div.append(img);
		div.append(`${c.host ? '👑 ' : ''}${c.name}${c.me ? ' (you)' : ''}`);
		host.append(div);
	});
}

/** @type {string} */
let lastHud = '';

/**
 * Player cards along the top of the screen.
 *
 * @param {State} state
 * @param {Portraits} portraits
 */
export function renderHud(state, portraits) {
	const parts = state.penguins.map((p) => {
		const out = p.mode === 'out';
		const lives = out
			? '💦'
			: p.lives > 5
				? `❤️×${p.lives}`
				: '❤️'.repeat(p.lives) + '🤍'.repeat(Math.max(0, 5 - p.lives));
		const power =
			p.power === 'snowball' ? `❄️${p.uses}` : p.power === 'slide' ? `🛷${p.uses}` : '';
		const mega = p.megaMs > 0 ? '💪' : '';
		const wins = state.tally.get(state.roster[p.id]?.key ?? '')?.wins ?? 0;
		return { p, out, lives, power: power + mega, wins };
	});
	const key = JSON.stringify(
		parts.map((x) => [x.p.id, x.p.name, x.out, x.lives, x.power, x.wins, x.p.look, x.p.stale]),
	);
	if (key === lastHud) return;
	lastHud = key;
	const host = $('cards');
	host.innerHTML = '';
	for (const { p, out, lives, power, wins } of parts) {
		const div = document.createElement('div');
		div.className = `pc${out ? ' out' : ''}${p.id === state.myPid ? ' me' : ''}`;
		div.style.setProperty('--c', PLAYER_COLORS[p.id] ?? '#ccc');
		const img = document.createElement('img');
		img.alt = '';
		img.src = portraits.get(p.look);
		const who = document.createElement('div');
		who.className = 'who';
		const nm = document.createElement('div');
		nm.className = 'nm';
		nm.textContent = `${p.id === state.myPid ? 'You' : p.name}${wins ? ` 🏆${wins}` : ''}`;
		const lv = document.createElement('div');
		lv.className = 'lv';
		lv.textContent = lives;
		who.append(nm, lv);
		const pw = document.createElement('div');
		pw.className = 'pw';
		pw.textContent = power;
		div.append(img, who, pw);
		host.append(div);
	}
}

export function resetHud() {
	lastHud = '';
}

/**
 * The leaderboard after a round: everyone this session, most wins first.
 *
 * @param {State} state
 * @param {Portraits} portraits
 * @param {string} myKey
 */
export function renderResults(state, portraits, myKey) {
	const res = state.result;
	const winner = res ? state.penguins[res.winner] : undefined;
	const winnerName = winner ? (winner.id === state.myPid ? 'You' : winner.name) : 'Nobody';
	$('results-title').textContent = `🏆 ${winnerName} ${winnerName === 'You' ? 'win' : 'wins'}!`;
	const rounds = Math.max(0, ...[...state.tally.values()].map((e) => e.played));
	$('results-sub').textContent = `Round ${rounds} — wins add up across rounds.`;
	/** @type {Map<string, number>} */
	const place = new Map();
	res?.order.forEach((pid, i) => {
		const key = state.roster[pid]?.key;
		if (key) place.set(key, i + 1);
	});
	const rows = [...state.tally.values()].sort(
		(a, b) => b.wins - a.wins || (place.get(a.key) ?? 9) - (place.get(b.key) ?? 9),
	);
	const body = /** @type {HTMLTableSectionElement} */ ($('board').querySelector('tbody'));
	body.innerHTML = '';
	const medals = ['🥇', '🥈', '🥉'];
	rows.forEach((e, i) => {
		const tr = document.createElement('tr');
		if (e.key === myKey) tr.className = 'me';
		const rank = document.createElement('td');
		rank.className = 'rank';
		rank.textContent = medals[i] ?? String(i + 1);
		const pn = document.createElement('td');
		const wrap = document.createElement('div');
		wrap.className = 'pn';
		const img = document.createElement('img');
		img.alt = '';
		img.src = portraits.get(e.look);
		wrap.append(img, `${e.name}${e.key === myKey ? ' (you)' : ''}${e.bot ? ' 🤖' : ''}`);
		pn.append(wrap);
		const round = document.createElement('td');
		const pl = place.get(e.key);
		round.textContent = pl ? (['1st 🎉', '2nd', '3rd', '4th'][pl - 1] ?? `${pl}th`) : '—';
		const wins = document.createElement('td');
		wins.className = 'wins';
		wins.textContent = e.wins ? (e.wins <= 5 ? '🏆'.repeat(e.wins) : `🏆×${e.wins}`) : '0';
		tr.append(rank, pn, round, wins);
		body.append(tr);
	});
}

/**
 * @param {string} text
 */
export function setNetStatus(text) {
	const el = $('netstatus');
	el.hidden = !text;
	el.textContent = text;
}
