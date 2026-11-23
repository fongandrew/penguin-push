/**
 * Everything you see, drawn with Three.js: the iceberg, the sea, the map's
 * features, the penguins, and a sprinkle of particles. Reads game state;
 * never changes it.
 */

import * as THREE from '../vendor/three.module.min.js';
import { CELL, heightAt, jarAt, jarIndicesAround, shrinkAt, tileCenter, waveAt } from './arena.js';
import { Board } from './board3d.js';
import { BALL_R, PLAYER_COLORS, SNOWBALL_R, WALLS_CRUMBLE_MS } from './constants.js';
import { ballAt, jarAvailable } from './contest.js';
import { throwPos } from './game.js';
import {
	animatePenguin,
	buildPenguin,
	makeFish,
	starGeometry,
	toon,
	toonGradient,
} from './penguin3d.js';

/** @typedef {import('./state.js').State} State */
/** @typedef {import('./state.js').Penguin} Penguin */
/** @typedef {import('./state.js').Fx} Fx */
/** @typedef {import('./arena.js').Arena} Arena */
/** @typedef {import('./penguin3d.js').Rig} Rig */
/** @typedef {import('./looks.js').Look} Look */

/**
 * @typedef {object} Particle
 * @property {THREE.Mesh} mesh
 * @property {THREE.Vector3} v
 * @property {number} life
 * @property {number} max
 * @property {number} gravity
 * @property {number} size
 * @property {number} spin
 * @property {boolean} grow Ripple rings grow instead of shrink.
 */

/**
 * @typedef {object} PenguinView
 * @property {Rig} rig
 * @property {THREE.Mesh} ring
 * @property {HTMLDivElement} label
 */

/** Ground (x, y, height) → Three (x, height, y). */
const v3 = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ h) =>
	new THREE.Vector3(x, h, y);

export class Renderer {
	/**
	 * @param {HTMLCanvasElement} canvas
	 * @param {HTMLElement} labels Container for name tags.
	 */
	constructor(canvas, labels) {
		this.canvas = canvas;
		this.labels = labels;
		const coarse = matchMedia('(pointer: coarse)').matches;
		this.renderer = new THREE.WebGLRenderer({
			canvas,
			antialias: !coarse || devicePixelRatio < 2,
		});
		this.renderer.setPixelRatio(Math.min(devicePixelRatio, coarse ? 2 : 2));
		this.renderer.shadowMap.enabled = true;
		this.renderer.shadowMap.type = THREE.PCFShadowMap;
		this.renderer.outputColorSpace = THREE.SRGBColorSpace;

		this.scene = new THREE.Scene();
		this.scene.background = skyTexture();
		this.scene.fog = new THREE.Fog(0xa8def9, 34, 80);
		this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
		this.camera.position.set(0, 16, 14);
		this.camTarget = new THREE.Vector3();
		this.camDist = 20;

		const hemi = new THREE.HemisphereLight(0xffffff, 0x7fb6d9, 1.4);
		this.scene.add(hemi);
		const sun = new THREE.DirectionalLight(0xffffff, 1.9);
		sun.position.set(-8, 18, 10);
		sun.castShadow = true;
		sun.shadow.mapSize.set(1024, 1024);
		sun.shadow.camera.left = -14;
		sun.shadow.camera.right = 14;
		sun.shadow.camera.top = 14;
		sun.shadow.camera.bottom = -14;
		sun.shadow.camera.near = 1;
		sun.shadow.camera.far = 50;
		sun.shadow.bias = -0.0015;
		sun.shadow.normalBias = 0.02;
		this.scene.add(sun);
		this.scene.add(sun.target);
		this.sun = sun;

		this.water = makeWater();
		this.scene.add(this.water);
		this.scene.add(makeDistantBergs());
		this.snow = makeSnowfall(400, 30);
		this.scene.add(this.snow);

		/** World content that belongs to one arena. */
		this.world = new THREE.Group();
		this.scene.add(this.world);
		/** @type {Arena | null} */
		this.arena = null;
		/** @type {THREE.Mesh[]} */
		this.balls = [];
		/** @type {string[]} */
		this.ballKinds = [];
		/** @type {Board | null} */
		this.board = null;
		this.prevT = 0;
		/** @type {THREE.Group | null} */
		this.wave = null;
		/** @type {THREE.Group | null} */
		this.arrows = null;

		/** @type {Map<number, PenguinView>} */
		this.penguins = new Map();
		/** @type {Map<number, THREE.Group>} */
		this.jars = new Map();
		/** @type {Map<number, THREE.Object3D>} */
		this.throws = new Map();
		/** @type {Particle[]} */
		this.particles = [];
		this.marker = makeMarker();
		this.scene.add(this.marker);

		// Changing station: its own little scene.
		this.station = makeStation();
		this.stationRig = buildPenguin({
			species: 0,
			hat: 0,
			hatColor: 0,
			scarf: 0,
			scarfColor: 0,
			glasses: 0,
		});
		this.station.scene.add(this.stationRig.root);
		this.stationSpin = 0.4;

		this.width = 1;
		this.height = 1;
		this.resize();
	}

	resize() {
		const w = this.canvas.clientWidth || innerWidth;
		const h = this.canvas.clientHeight || innerHeight;
		if (w === this.width && h === this.height) return;
		this.width = w;
		this.height = h;
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
		this.station.camera.aspect = w / h;
		this.station.camera.updateProjectionMatrix();
	}

	/**
	 * @param {Arena} arena
	 */
	setArena(arena) {
		if (this.arena === arena) return;
		this.arena = arena;
		this.world.clear();
		for (const v of this.penguins.values()) v.label.remove();
		this.penguins.clear();
		this.jars.clear();
		this.throws.clear();
		this.balls = [];
		this.ballKinds = [];
		this.wave = null;
		this.arrows = null;
		this.prevT = 0;

		this.board = new Board(arena);
		this.world.add(this.board.group);
		if (arena.igloo) this.world.add(makeIgloo(arena.igloo.x, arena.igloo.y, arena.igloo.r));
		arena.balls.forEach(() => {
			const m = makeGiantSnowball();
			this.balls.push(m);
			this.ballKinds.push('rest');
			this.world.add(m);
		});
		if (arena.waves) {
			this.wave = makeWave();
			this.wave.visible = false;
			this.world.add(this.wave);
			this.arrows = makeArrows();
			this.arrows.visible = false;
			this.world.add(this.arrows);
		}
		this.camTarget.set(0, 0, 0);
	}

	/**
	 * @param {State} state
	 * @param {number} time Seconds since load.
	 * @param {number} dt Seconds.
	 * @param {{ attract?: boolean }} [opts]
	 */
	renderGame(state, time, dt, opts = {}) {
		this.resize();
		const arena = state.arena;
		if (!arena) return;
		this.setArena(arena);
		const t = Math.max(0, state.t);
		animateWater(this.water, time);
		animateSnow(this.snow, dt);
		this.updateBalls(state, arena, t, dt);
		this.board?.update(t, time, this.ballKinds);
		this.boardFx(arena, t);
		this.updateWave(arena, t, time);
		this.updateJars(state, arena, t, time);
		this.updateThrows(state, t);
		this.updatePenguins(state, time, dt, !!opts.attract);
		for (const fx of state.fx) this.spawnFx(fx, arena);
		this.updateParticles(dt);
		this.updateCamera(state, dt, time, !!opts.attract);
		this.renderer.render(this.scene, this.camera);
	}

	/**
	 * @param {Look} look
	 * @param {number} time
	 * @param {number} dt
	 * @param {boolean} portrait Options panel at the bottom (else right).
	 */
	renderStation(look, time, dt, portrait) {
		this.resize();
		const rig = this.stationRig;
		/** @type {Penguin} */
		const fake = /** @type {any} */ ({
			look,
			speed: 0,
			shoveMs: 0,
			knockMs: 0,
			stunMs: 0,
			megaMs: 0,
			invulnMs: 0,
			mode: 'play',
			power: '',
			z: 0,
		});
		animatePenguin(rig, fake, time, dt);
		this.stationSpin += dt * 0.5;
		rig.root.rotation.y = Math.sin(this.stationSpin) * 0.7 + this.stationDrag;
		rig.root.position.y = 0.35;
		const cam = this.station.camera;
		const w = this.width;
		const h = this.height;
		const dist = portrait ? 7.2 : 4.4;
		cam.position.set(0, 0.95 + dist * 0.15, dist);
		cam.lookAt(0, 0.95, 0);
		if (portrait) {
			cam.setViewOffset(w, h, 0, h * 0.27, w, h);
		} else {
			cam.setViewOffset(w, h, w * 0.2, 0, w, h);
		}
		animateSnow(this.station.snow, dt);
		this.renderer.render(this.station.scene, cam);
	}

	stationDrag = 0;

	/**
	 * Splashes as tiles sink, snow puffs as ice blocks crumble.
	 *
	 * @param {Arena} arena
	 * @param {number} t
	 */
	boardFx(arena, t) {
		const prev = this.prevT;
		this.prevT = t;
		if (t <= prev || t - prev > 500) return;
		for (let k = 0; k < arena.crack.length; k++) {
			const c = arena.crack[k] ?? Infinity;
			if (c <= prev || c > t) continue;
			const p = tileCenter(arena, k);
			for (let i = 0; i < 5; i++) {
				this.spawnParticle(
					new THREE.Vector3(
						p.x + (Math.random() - 0.5) * CELL,
						WATER_Y + 0.1,
						p.y + (Math.random() - 0.5) * CELL,
					),
					new THREE.Vector3(
						(Math.random() - 0.5) * 2,
						2 + Math.random() * 2,
						(Math.random() - 0.5) * 2,
					),
					i % 2 ? 0xffffff : 0x5cc6ff,
					0.1,
					0.7,
					10,
				);
			}
			this.spawnRipple(new THREE.Vector3(p.x, WATER_Y + 0.05, p.y), 1.6);
		}
		if (prev < WALLS_CRUMBLE_MS && t >= WALLS_CRUMBLE_MS - 600) {
			for (const b of arena.blocks) {
				if (Math.random() > 0.35) continue;
				this.spawnParticle(
					new THREE.Vector3(b.x, 0.7, b.y),
					new THREE.Vector3(
						(Math.random() - 0.5) * 2.5,
						2.5,
						(Math.random() - 0.5) * 2.5,
					),
					0xe8f6ff,
					0.16,
					0.8,
					8,
				);
			}
		}
	}

	/**
	 * @param {State} state
	 * @param {Arena} arena
	 * @param {number} t
	 * @param {number} dt
	 */
	updateBalls(state, arena, t, dt) {
		arena.balls.forEach((home, i) => {
			const m = this.balls[i];
			if (!m) return;
			const b = ballAt(arena, state.contest, i, t);
			const prev = this.ballKinds[i];
			this.ballKinds[i] = b.kind;
			if (b.kind === 'rest') {
				const pop = m.userData['pop'] ?? 1;
				const next = prev === 'away' ? 0 : Math.min(1, pop + dt * 3);
				m.userData['pop'] = next;
				const s = easeBack(next);
				m.scale.setScalar(Math.max(0.01, s));
				m.position.copy(
					v3(home.x, home.y, heightAt(arena, home.x, home.y) + BALL_R * s - 0.1),
				);
				m.visible = true;
				return;
			}
			if (b.kind === 'roll') {
				if (prev === 'rest') {
					state.fx.push({ kind: 'kick', x: home.x, y: home.y });
				}
				const sp = Math.hypot(b.vx, b.vy);
				m.visible = true;
				m.scale.setScalar(1);
				// Bump down the steps smoothly rather than teleporting.
				const wantY = heightAt(arena, b.x, b.y) + BALL_R - 0.1;
				const y =
					m.position.y > wantY
						? m.position.y + (wantY - m.position.y) * Math.min(1, dt * 9)
						: wantY;
				m.position.set(b.x, y, b.y);
				if (sp > 0.01) {
					const axis = new THREE.Vector3(b.vy / sp, 0, -b.vx / sp);
					m.rotateOnWorldAxis(axis, -(sp * dt) / BALL_R);
				}
				if (Math.random() < sp * dt * 2) {
					this.spawnParticle(
						v3(b.x, b.y, heightAt(arena, b.x, b.y) + 0.1),
						new THREE.Vector3(
							(Math.random() - 0.5) * 2,
							1.5,
							(Math.random() - 0.5) * 2,
						),
						0xffffff,
						0.12,
						0.6,
						5,
					);
				}
				return;
			}
			if (b.kind === 'gone') {
				if (prev === 'roll' && b.end === 'splash') {
					this.spawnFx({ kind: 'splash', x: b.x, y: b.y, z: 2 }, arena);
				}
				if (prev === 'roll' && b.end === 'stop') {
					this.spawnFx({ kind: 'poof', x: b.x, y: b.y, z: 0.8 }, arena);
				}
				m.visible = true;
				if (b.end === 'splash') {
					m.position.copy(v3(b.x, b.y, BALL_R - 0.1 - b.k * 2.2));
				} else {
					m.scale.setScalar(Math.max(0.01, 1 - b.k));
				}
				return;
			}
			m.visible = false;
		});
	}

	/**
	 * @param {Arena} arena
	 * @param {number} t
	 * @param {number} time
	 */
	updateWave(arena, t, time) {
		if (!this.wave || !this.arrows) return;
		const w = waveAt(arena, t);
		this.wave.visible = !!w && w.phase === 'go';
		this.arrows.visible = !!w && w.phase === 'warn';
		if (!w) return;
		const ux = Math.cos(w.dir);
		const uy = Math.sin(w.dir);
		if (w.phase === 'go') {
			this.wave.position.set(ux * w.front, Math.sin(time * 5) * 0.04, uy * w.front);
			animateSpray(this.wave, time);
			this.wave.rotation.y = -w.dir;
		} else {
			const reach = (arena.R + 1.8) * shrinkAt(t);
			this.arrows.position.set(-ux * reach, WATER_Y + 0.12, -uy * reach);
			this.arrows.rotation.y = -w.dir;
			const pulse = 0.85 + Math.sin(time * 12) * 0.15;
			this.arrows.scale.setScalar(pulse);
		}
	}

	/**
	 * @param {State} state
	 * @param {Arena} arena
	 * @param {number} t
	 * @param {number} time
	 */
	updateJars(state, arena, t, time) {
		/** @type {Set<number>} */
		const live = new Set();
		for (const i of jarIndicesAround(t)) {
			if (!jarAvailable(arena, state.contest, i, t)) continue;
			live.add(i);
			const jar = jarAt(arena, i);
			let g = this.jars.get(i);
			if (!g) {
				g = makeJar(jar.kind);
				this.jars.set(i, g);
				this.world.add(g);
			}
			const age = t - jar.spawn;
			const s = easeBack(Math.min(1, age / 350));
			const ending = jar.expire - t < 2000 && Math.floor(time * 8) % 2 === 0;
			g.visible = !ending;
			g.scale.setScalar(Math.max(0.01, s));
			g.position.set(
				jar.x,
				heightAt(arena, jar.x, jar.y) + 0.12 + Math.sin(time * 3 + i) * 0.08,
				jar.y,
			);
			const inner = g.userData['inner'];
			if (inner instanceof THREE.Object3D) inner.rotation.y = time * 2;
			const spark = g.userData['spark'];
			if (spark instanceof THREE.Object3D) {
				spark.rotation.z = time * 3;
				spark.scale.setScalar(0.06 + 0.05 * Math.abs(Math.sin(time * 4 + i)));
			}
		}
		for (const [i, g] of this.jars) {
			if (live.has(i)) continue;
			this.world.remove(g);
			this.jars.delete(i);
		}
	}

	/**
	 * @param {State} state
	 * @param {number} t
	 */
	updateThrows(state, t) {
		/** @type {Set<number>} */
		const live = new Set();
		for (const th of state.throws) {
			if (th.dead) continue;
			live.add(th.id);
			let m = this.throws.get(th.id);
			if (!m) {
				if (th.kind === 'fish') {
					// A fish, tumbling end over end along its flight.
					m = new THREE.Group();
					const fish = makeFish(1.6);
					m.add(fish);
					m.rotation.y = -th.angle;
				} else {
					m = new THREE.Mesh(
						new THREE.SphereGeometry(SNOWBALL_R, 12, 10),
						toon(0xffffff),
					);
					m.castShadow = true;
				}
				this.throws.set(th.id, m);
				this.world.add(m);
			}
			const p = throwPos(th, t);
			m.position.set(p.x, p.z, p.y);
			const spin = m.children[0];
			if (th.kind === 'fish' && spin) spin.rotation.z = (t - th.t0) * -0.018;
		}
		for (const [id, m] of this.throws) {
			if (live.has(id)) continue;
			this.world.remove(m);
			this.throws.delete(id);
		}
	}

	/**
	 * @param {State} state
	 * @param {number} time
	 * @param {number} dt
	 * @param {boolean} attract
	 */
	updatePenguins(state, time, dt, attract) {
		const done = state.mode === 'done' && state.result;
		for (const p of state.penguins) {
			let view = this.penguins.get(p.id);
			if (!view) {
				const rig = buildPenguin(p.look);
				const color = new THREE.Color(PLAYER_COLORS[p.id] ?? '#ffffff');
				const ring = new THREE.Mesh(
					new THREE.RingGeometry(0.46, 0.6, 32),
					new THREE.MeshBasicMaterial({
						color,
						transparent: true,
						opacity: 0.85,
						depthWrite: false,
					}),
				);
				ring.rotation.x = -Math.PI / 2;
				const label = document.createElement('div');
				label.className = 'tag';
				label.style.setProperty('--c', PLAYER_COLORS[p.id] ?? '#fff');
				this.labels.append(label);
				view = { rig, ring, label };
				this.penguins.set(p.id, view);
				this.world.add(rig.root, ring);
			}
			const { rig, ring, label } = view;
			const out = p.mode === 'out';
			rig.root.visible = !out || (p.modeMs < 1500 && p.z > -1.5);
			const celebrate = !!done && state.result?.winner === p.id;
			animatePenguin(rig, p, time, dt, { celebrate, sad: !!done && !celebrate });
			if (out && p.z > -2.5) p.z -= dt * 0.6;
			// Hop smoothly up and down the stacked steps.
			const z0 = Number(rig.root.userData['z'] ?? p.z);
			const z =
				p.mode === 'play' && Math.abs(p.z - z0) < 1
					? z0 + (p.z - z0) * Math.min(1, dt * 14)
					: p.z;
			rig.root.userData['z'] = z;
			rig.root.position.set(p.x, z, p.y);
			const face = celebrate
				? Math.atan2(this.camera.position.z - p.y, this.camera.position.x - p.x)
				: p.face;
			rig.root.rotation.y = Math.PI / 2 - face;
			if (p.mode === 'fall' || (out && p.z < 0)) rig.root.rotation.y += time * 4;
			const ground = this.arena ? heightAt(this.arena, p.x, p.y) : 0;
			ring.visible = !out && p.mode !== 'fall' && !attract;
			ring.position.set(p.x, ground + 0.03, p.y);
			ring.scale.setScalar(
				p.mode === 'respawn' ? 0.6 + 0.4 * Math.min(1, p.modeMs / 1000) : 1,
			);
			label.textContent = p.id === state.myPid ? 'You' : p.name;
			label.classList.toggle('stale', p.stale);
			label.hidden = out || attract || !rig.root.visible;
			if (!label.hidden) {
				const v = new THREE.Vector3(p.x, p.z + 1.75, p.y).project(this.camera);
				label.style.transform = `translate(-50%, -100%) translate(${((v.x + 1) / 2) * this.width}px, ${((1 - v.y) / 2) * this.height}px)`;
			}
		}
		const me = state.penguins[state.myPid];
		this.marker.visible =
			!!me && me.mode !== 'out' && me.mode !== 'fall' && !attract && state.mode !== 'done';
		if (me && this.marker.visible) {
			this.marker.position.set(me.x, me.z + 2.25 + Math.sin(time * 5) * 0.08, me.y);
			this.marker.rotation.y = time * 2;
		}
	}

	/**
	 * @param {Fx} fx
	 * @param {Arena} arena
	 */
	spawnFx(fx, arena) {
		const h = heightAt(arena, fx.x, fx.y);
		const at = v3(fx.x, fx.y, (fx.z ?? 0) * 0 + h);
		const rnd = () => Math.random() - 0.5;
		switch (fx.kind) {
			case 'splash': {
				const big = (fx.z ?? 0) >= 2;
				const n = big ? 28 : fx.z ? 8 : 18;
				for (let i = 0; i < n; i++) {
					const c = i % 3 === 0 ? 0xffffff : 0x5cc6ff;
					this.spawnParticle(
						at.clone().setY(WATER_Y + 0.1),
						new THREE.Vector3(rnd() * 4, 3 + Math.random() * (big ? 6 : 4), rnd() * 4),
						c,
						0.1 + Math.random() * 0.1,
						0.9,
						12,
					);
				}
				this.spawnRipple(at.clone().setY(WATER_Y + 0.05), big ? 2.4 : 1.4);
				break;
			}
			case 'bonk':
				for (let i = 0; i < 6; i++) {
					this.spawnParticle(
						at.clone().setY(h + 0.9),
						new THREE.Vector3(rnd() * 4, 2 + Math.random() * 2, rnd() * 4),
						0xffe14d,
						0.07,
						0.5,
						9,
						true,
					);
				}
				break;
			case 'poof':
				for (let i = 0; i < 10; i++) {
					this.spawnParticle(
						new THREE.Vector3(fx.x, (fx.z ?? 0.9) + h * 0, fx.y),
						new THREE.Vector3(rnd() * 3, Math.random() * 2, rnd() * 3),
						0xffffff,
						0.1 + Math.random() * 0.06,
						0.55,
						4,
					);
				}
				break;
			case 'heart':
				for (let i = 0; i < 5; i++) {
					this.spawnParticle(
						at.clone().setY(h + 0.6),
						new THREE.Vector3(rnd() * 1.2, 2 + Math.random() * 1.5, rnd() * 1.2),
						0xff4d6d,
						0.12,
						1.1,
						-1,
						false,
						heartGeometry(),
					);
				}
				break;
			case 'fish':
				for (let i = 0; i < 8; i++) {
					this.spawnParticle(
						at.clone().setY(h + 0.6),
						new THREE.Vector3(rnd() * 2, 2 + Math.random() * 2, rnd() * 2),
						i % 2 ? 0xffd23f : 0x6fd3ff,
						0.07,
						0.9,
						4,
						true,
					);
				}
				break;
			case 'land':
			case 'kick':
				for (let i = 0; i < 12; i++) {
					const a = (i / 12) * Math.PI * 2;
					this.spawnParticle(
						at.clone().setY(h + 0.1),
						new THREE.Vector3(Math.cos(a) * 2.2, 0.8, Math.sin(a) * 2.2),
						0xffffff,
						0.12,
						0.5,
						3,
					);
				}
				break;
			case 'slap':
				if (fx.z) {
					for (let i = 0; i < 4; i++) {
						this.spawnParticle(
							at.clone().setY(h + 0.7),
							new THREE.Vector3(rnd() * 2, 1 + Math.random(), rnd() * 2),
							0xffffff,
							0.08,
							0.35,
							2,
						);
					}
				}
				break;
			default:
				break;
		}
	}

	/**
	 * @param {THREE.Vector3} pos
	 * @param {THREE.Vector3} vel
	 * @param {number} color
	 * @param {number} size
	 * @param {number} life
	 * @param {number} gravity
	 * @param {boolean} [star]
	 * @param {THREE.BufferGeometry} [geo]
	 */
	spawnParticle(pos, vel, color, size, life, gravity, star = false, geo) {
		if (this.particles.length > 220) return;
		const g = geo ?? (star ? STAR_GEO : PARTICLE_GEO);
		const mesh = new THREE.Mesh(g, toon(color));
		mesh.position.copy(pos);
		mesh.scale.setScalar(geo ? size * 2 : size);
		this.scene.add(mesh);
		this.particles.push({
			mesh,
			v: vel,
			life,
			max: life,
			gravity,
			size: geo ? size * 2 : size,
			spin: star ? 8 : 0,
			grow: false,
		});
	}

	/**
	 * @param {THREE.Vector3} pos
	 * @param {number} size
	 */
	spawnRipple(pos, size) {
		const mesh = new THREE.Mesh(
			RIPPLE_GEO,
			new THREE.MeshBasicMaterial({
				color: 0xffffff,
				transparent: true,
				opacity: 0.8,
				depthWrite: false,
			}),
		);
		mesh.rotation.x = -Math.PI / 2;
		mesh.position.copy(pos);
		mesh.scale.setScalar(0.3);
		this.scene.add(mesh);
		this.particles.push({
			mesh,
			v: new THREE.Vector3(),
			life: 0.9,
			max: 0.9,
			gravity: 0,
			size,
			spin: 0,
			grow: true,
		});
	}

	/** @param {number} dt */
	updateParticles(dt) {
		for (const p of this.particles) {
			p.life -= dt;
			const k = Math.max(0, p.life / p.max);
			if (p.grow) {
				p.mesh.scale.setScalar(p.size * (1 - k) + 0.3);
				const m = p.mesh.material;
				if (m instanceof THREE.MeshBasicMaterial) m.opacity = k * 0.8;
				continue;
			}
			p.v.y -= p.gravity * dt;
			p.mesh.position.addScaledVector(p.v, dt);
			p.mesh.scale.setScalar(p.size * (0.3 + 0.7 * k));
			if (p.spin) p.mesh.rotation.z += p.spin * dt;
			if (p.gravity < 0) p.v.multiplyScalar(1 - dt * 1.5);
		}
		const keep = [];
		for (const p of this.particles) {
			if (p.life > 0) keep.push(p);
			else {
				this.scene.remove(p.mesh);
				if (p.grow) /** @type {THREE.Material} */ (p.mesh.material).dispose();
			}
		}
		this.particles = keep;
	}

	/**
	 * @param {State} state
	 * @param {number} dt
	 * @param {number} time
	 * @param {boolean} attract
	 */
	updateCamera(state, dt, time, attract) {
		const arena = state.arena;
		if (!arena) return;
		const aspect = this.width / this.height;
		const portrait = aspect < 0.9;
		const k = shrinkAt(Math.max(0, state.t));
		const fitR = (arena.floes.length ? arena.R + 2.6 : arena.R) * Math.max(0.55, k) + 1.2;
		const fov = (this.camera.fov * Math.PI) / 180;
		const halfH = Math.tan(fov / 2);
		const halfW = halfH * aspect;
		const want = portrait ? fitR * 0.62 : fitR * 0.95;
		let dist = Math.max(want / halfW, (fitR * (portrait ? 0.75 : 0.85)) / halfH);
		const me = state.penguins[state.myPid];
		let fx = 0;
		let fz = 0;
		const follow = portrait ? 0.7 : 0.35;
		if (me && me.mode !== 'out') {
			fx = me.x * follow;
			fz = me.y * follow;
		}
		const winner = state.result ? state.penguins[state.result.winner] : undefined;
		if (state.mode === 'done' && winner) {
			fx = winner.x;
			fz = winner.y;
			dist = 7.5;
		}
		if (attract) {
			dist = Math.max(dist * 1.1, 15);
		}
		const lerp = 1 - Math.exp(-dt * (state.mode === 'done' ? 2 : 3));
		this.camTarget.x += (fx - this.camTarget.x) * lerp;
		this.camTarget.z += (fz - this.camTarget.z) * lerp;
		this.camDist += (dist - this.camDist) * lerp;
		const elev = 0.8;
		const yaw = attract ? time * 0.08 : 0;
		this.camera.position.set(
			this.camTarget.x + Math.sin(yaw) * Math.cos(elev) * this.camDist,
			Math.sin(elev) * this.camDist,
			this.camTarget.z + Math.cos(yaw) * Math.cos(elev) * this.camDist,
		);
		this.camera.lookAt(this.camTarget.x, 0.4, this.camTarget.z);
		this.sun.position.set(this.camTarget.x - 8, 18, this.camTarget.z + 10);
		this.sun.target.position.set(this.camTarget.x, 0, this.camTarget.z);
	}
}

const PARTICLE_GEO = new THREE.IcosahedronGeometry(1, 0);
const STAR_GEO = starGeometry(1, 0.45, 0.4);
const RIPPLE_GEO = new THREE.RingGeometry(0.8, 1, 32);

/** @type {THREE.BufferGeometry | null} */
let heartGeo = null;
function heartGeometry() {
	if (heartGeo) return heartGeo;
	const s = new THREE.Shape();
	s.moveTo(0, -0.6);
	s.bezierCurveTo(-0.1, -0.45, -0.75, -0.1, -0.6, 0.25);
	s.bezierCurveTo(-0.45, 0.6, -0.05, 0.55, 0, 0.2);
	s.bezierCurveTo(0.05, 0.55, 0.45, 0.6, 0.6, 0.25);
	s.bezierCurveTo(0.75, -0.1, 0.1, -0.45, 0, -0.6);
	heartGeo = new THREE.ExtrudeGeometry(s, {
		depth: 0.25,
		bevelEnabled: true,
		bevelSize: 0.06,
		bevelThickness: 0.06,
		bevelSegments: 2,
	});
	heartGeo.center();
	return heartGeo;
}

/** @param {number} k */
function easeBack(k) {
	const c = 1.9;
	const x = k - 1;
	return 1 + (c + 1) * x * x * x + c * x * x;
}

/** Mean sea level (ice tops are at 0). */
export const WATER_Y = -0.42;

function makeWater() {
	const geo = new THREE.PlaneGeometry(140, 140, 90, 90);
	geo.rotateX(-Math.PI / 2);
	const base = Float32Array.from(
		/** @type {Float32Array} */ (geo.attributes['position']?.array ?? []),
	);
	const mat = new THREE.MeshPhongMaterial({
		color: 0x2a9fe6,
		flatShading: true,
		shininess: 90,
		specular: 0x99ddff,
		transparent: true,
		opacity: 0.88,
	});
	const mesh = new THREE.Mesh(geo, mat);
	// Well below the ice tops so waves never poke up through the tiles.
	mesh.position.y = WATER_Y;
	mesh.receiveShadow = true;
	mesh.userData['base'] = base;
	return mesh;
}

/**
 * @param {THREE.Mesh} water
 * @param {number} time
 */
function animateWater(water, time) {
	const attr = water.geometry.attributes['position'];
	const base = water.userData['base'];
	if (!attr || !(base instanceof Float32Array)) return;
	const arr = /** @type {Float32Array} */ (attr.array);
	for (let i = 0; i < arr.length; i += 3) {
		const x = base[i] ?? 0;
		const z = base[i + 2] ?? 0;
		// Calm by the ice (the surf stays put), choppier out at sea.
		const d = Math.hypot(x, z);
		const amp = 0.35 + 0.65 * Math.min(1, Math.max(0, (d - 7) / 10));
		arr[i + 1] =
			amp *
			(Math.sin(x * 0.45 + time * 1.3) * 0.09 +
				Math.cos(z * 0.5 + time * 1.1) * 0.09 +
				Math.sin((x + z) * 0.9 + time * 2.2) * 0.04);
	}
	attr.needsUpdate = true;
}

function makeDistantBergs() {
	const g = new THREE.Group();
	const mat = toon(0xeaf7ff);
	for (let i = 0; i < 9; i++) {
		const a = (i / 9) * Math.PI * 2 + 0.3;
		const r = 32 + (i % 3) * 6;
		const m = new THREE.Mesh(new THREE.ConeGeometry(2 + (i % 4), 3 + (i % 3) * 2, 6), mat);
		m.position.set(Math.cos(a) * r, 0.5, Math.sin(a) * r - 6);
		m.rotation.y = i;
		g.add(m);
	}
	return g;
}

/**
 * @param {number} n
 * @param {number} spread
 */
function makeSnowfall(n, spread) {
	const pos = new Float32Array(n * 3);
	for (let i = 0; i < n; i++) {
		pos[i * 3] = (Math.random() - 0.5) * spread;
		pos[i * 3 + 1] = Math.random() * 16;
		pos[i * 3 + 2] = (Math.random() - 0.5) * spread;
	}
	const geo = new THREE.BufferGeometry();
	geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
	const pts = new THREE.Points(
		geo,
		new THREE.PointsMaterial({
			color: 0xffffff,
			size: 0.12,
			transparent: true,
			opacity: 0.85,
			depthWrite: false,
		}),
	);
	pts.userData['spread'] = spread;
	return pts;
}

/**
 * @param {THREE.Points} pts
 * @param {number} dt
 */
function animateSnow(pts, dt) {
	const attr = pts.geometry.attributes['position'];
	if (!attr) return;
	const arr = /** @type {Float32Array} */ (attr.array);
	const spread = Number(pts.userData['spread']) || 30;
	for (let i = 0; i < arr.length; i += 3) {
		arr[i + 1] = (arr[i + 1] ?? 0) - dt * 0.9;
		arr[i] = (arr[i] ?? 0) + Math.sin((arr[i + 1] ?? 0) * 0.7 + i) * dt * 0.2;
		if ((arr[i + 1] ?? 0) < 0) {
			arr[i + 1] = 16;
			arr[i] = (Math.random() - 0.5) * spread;
			arr[i + 2] = (Math.random() - 0.5) * spread;
		}
	}
	attr.needsUpdate = true;
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number} r
 */
function makeIgloo(x, y, r) {
	const g = new THREE.Group();
	const cv = document.createElement('canvas');
	cv.width = 256;
	cv.height = 128;
	const c = cv.getContext('2d');
	if (c) {
		c.fillStyle = '#f6fbff';
		c.fillRect(0, 0, 256, 128);
		c.strokeStyle = '#b9d9ee';
		c.lineWidth = 3;
		for (let row = 0; row < 6; row++) {
			const yy = row * 21;
			c.beginPath();
			c.moveTo(0, yy);
			c.lineTo(256, yy);
			c.stroke();
			for (let col = 0; col < 8; col++) {
				const xx = col * 32 + (row % 2) * 16;
				c.beginPath();
				c.moveTo(xx, yy);
				c.lineTo(xx, yy + 21);
				c.stroke();
			}
		}
	}
	const tex = new THREE.CanvasTexture(cv);
	tex.colorSpace = THREE.SRGBColorSpace;
	const mat = new THREE.MeshToonMaterial({ map: tex, gradientMap: toonGradient() });
	const dome = new THREE.Mesh(
		new THREE.SphereGeometry(r, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2),
		mat,
	);
	dome.castShadow = true;
	dome.receiveShadow = true;
	g.add(dome);
	const tunnel = new THREE.Mesh(
		new THREE.CylinderGeometry(0.55, 0.55, 0.9, 16, 1, false, 0, Math.PI),
		mat,
	);
	tunnel.rotation.set(Math.PI / 2, 0, Math.PI / 2);
	tunnel.position.set(0, 0, r - 0.05);
	tunnel.castShadow = true;
	g.add(tunnel);
	const door = new THREE.Mesh(
		new THREE.CircleGeometry(0.42, 16, 0, Math.PI),
		new THREE.MeshBasicMaterial({ color: 0x1d3447 }),
	);
	door.position.set(0, 0.01, r + 0.41);
	g.add(door);
	g.position.set(x, 0, y);
	return g;
}

function makeGiantSnowball() {
	const geo = new THREE.IcosahedronGeometry(BALL_R, 3);
	const p = geo.attributes['position'];
	if (p) {
		for (let i = 0; i < p.count; i++) {
			const v = new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i));
			const n = 1 + Math.sin(v.x * 9) * Math.cos(v.y * 7) * Math.sin(v.z * 8) * 0.05;
			v.multiplyScalar(n);
			p.setXYZ(i, v.x, v.y, v.z);
		}
		geo.computeVertexNormals();
	}
	const m = new THREE.Mesh(geo, toon(0xffffff));
	m.castShadow = true;
	m.receiveShadow = true;
	return m;
}

/**
 * @param {'heart' | 'fish'} kind
 */
function makeJar(kind) {
	const g = new THREE.Group();
	const tint = kind === 'heart' ? 0xff6f91 : 0x3d9bff;
	// A rounded jar: base, belly, shoulder, neck.
	const profile = [
		[0, 0],
		[0.24, 0],
		[0.31, 0.08],
		[0.34, 0.3],
		[0.3, 0.48],
		[0.21, 0.56],
		[0.21, 0.62],
	].map(([x, y]) => new THREE.Vector2(x ?? 0, y ?? 0));
	const jarGeo = new THREE.LatheGeometry(profile, 24);
	const glass = new THREE.Mesh(
		jarGeo,
		new THREE.MeshPhongMaterial({
			color: 0xdff6ff,
			emissive: 0x2a5a7a,
			transparent: true,
			opacity: 0.45,
			shininess: 140,
			specular: 0xffffff,
			depthWrite: false,
		}),
	);
	g.add(glass);
	// A pale rim drawn on the back faces: reads as glass against white snow.
	const rim = new THREE.Mesh(
		jarGeo,
		new THREE.MeshBasicMaterial({
			color: 0x9fd8f5,
			transparent: true,
			opacity: 0.55,
			side: THREE.BackSide,
			depthWrite: false,
		}),
	);
	rim.scale.setScalar(1.04);
	g.add(rim);
	const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.1, 20), toon(tint));
	lid.position.y = 0.66;
	lid.castShadow = true;
	g.add(lid);
	const knob = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), toon(0xffffff));
	knob.position.y = 0.74;
	g.add(knob);
	const inner = new THREE.Group();
	inner.position.y = 0.3;
	if (kind === 'heart') {
		const h = new THREE.Mesh(heartGeometry(), toon(0xff3d5e, { emissive: 0x551020 }));
		h.scale.setScalar(0.42);
		inner.add(h);
	} else {
		const fish = new THREE.Group();
		const orange = toon(0xff9a2a, { emissive: 0x331500 });
		const body = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), orange);
		body.scale.set(0.2, 0.12, 0.08);
		fish.add(body);
		const tail = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.15, 4), orange);
		tail.rotation.z = Math.PI / 2;
		tail.position.x = -0.24;
		fish.add(tail);
		for (const side of [1, -1]) {
			const eye = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), toon(0x111111));
			eye.position.set(0.12, 0.03, 0.065 * side);
			fish.add(eye);
		}
		inner.add(fish);
	}
	g.add(inner);
	g.userData['inner'] = inner;
	// A twinkle above, so jars catch the eye.
	const spark = new THREE.Mesh(STAR_GEO, toon(0xfff3a0, { emissive: 0x806a00 }));
	spark.scale.setScalar(0.09);
	spark.position.set(0.22, 0.95, 0);
	g.add(spark);
	g.userData['spark'] = spark;
	const glow = new THREE.Mesh(
		new THREE.CircleGeometry(0.55, 24),
		new THREE.MeshBasicMaterial({
			color: tint,
			transparent: true,
			opacity: 0.35,
			depthWrite: false,
		}),
	);
	glow.rotation.x = -Math.PI / 2;
	glow.position.y = -0.1;
	g.add(glow);
	return g;
}

/**
 * A curling wave: a cross-section (back slope, crest, curl, steep front)
 * extruded along the whole front, tapering away at the ends, with a foamy
 * white crest.
 */
function makeWave() {
	const g = new THREE.Group();
	const s = new THREE.Shape();
	// Deep below the sea surface so it never shows a gap, and tall enough
	// to tower over the ice as it sweeps across.
	const base = WATER_Y - 0.6;
	const H = (/** @type {number} */ y) => y * 1.55;
	s.moveTo(-3.0, base);
	s.bezierCurveTo(-1.8, base + 0.1, -0.9, H(0.35), -0.25, H(0.85));
	s.bezierCurveTo(0.1, H(1.15), 0.6, H(1.25), 0.9, H(1.05));
	s.bezierCurveTo(1.05, H(0.9), 0.95, H(0.72), 0.7, H(0.78));
	s.bezierCurveTo(0.5, H(0.8), 0.42, H(0.6), 0.46, H(0.3));
	s.bezierCurveTo(0.5, 0.0, 0.7, base + 0.2, 1.0, base);
	s.closePath();
	const len = 30;
	const geo = new THREE.ExtrudeGeometry(s, {
		depth: len,
		bevelEnabled: false,
		steps: 30,
		curveSegments: 10,
	});
	geo.translate(0, 0, -len / 2);
	// Taper the height toward both ends so it fades into the sea.
	const pos = geo.attributes['position'];
	if (pos) {
		for (let i = 0; i < pos.count; i++) {
			const z = Math.abs(pos.getZ(i));
			const f = Math.min(1, Math.max(0, (len / 2 - z) / 6));
			const k = f * f * (3 - 2 * f);
			pos.setY(i, base + (pos.getY(i) - base) * k);
		}
		geo.computeVertexNormals();
	}
	// Colour by height: deep blue at the bottom, turquoise up the face, and
	// the curling lip turning to white foam — one smooth surface, no blobs.
	if (pos) {
		const deep = new THREE.Color(0x1f7fd1);
		const mid = new THREE.Color(0x46c4ff);
		const foam = new THREE.Color(0xf4fbff);
		const top = 1.95;
		const col = [];
		const c = new THREE.Color();
		for (let i = 0; i < pos.count; i++) {
			const x = pos.getX(i);
			const z = Math.abs(pos.getZ(i));
			const fade = Math.min(1, Math.max(0, (len / 2 - z) / 6));
			const tt = Math.min(1, Math.max(0, (pos.getY(i) - base) / (top - base)));
			c.copy(deep).lerp(mid, Math.min(1, tt * 1.4));
			// Foam on the lip and the curl's underside.
			const lip = Math.max(0, (tt - 0.72) / 0.28) + (x > 0.45 && tt > 0.5 ? 0.6 : 0);
			c.lerp(foam, Math.min(1, lip) * fade);
			col.push(c.r, c.g, c.b);
		}
		geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
	}
	const water = new THREE.MeshPhongMaterial({
		vertexColors: true,
		transparent: true,
		opacity: 0.86,
		shininess: 110,
		specular: 0xe6f8ff,
		side: THREE.DoubleSide,
	});
	const body = new THREE.Mesh(geo, water);
	g.add(body);
	// Fine spray drifting off the crest: soft, small, see-through.
	const n = 260;
	const spray = new THREE.Points(
		new THREE.BufferGeometry().setAttribute(
			'position',
			new THREE.BufferAttribute(new Float32Array(n * 3), 3),
		),
		new THREE.PointsMaterial({
			color: 0xffffff,
			size: 0.16,
			transparent: true,
			opacity: 0.75,
			depthWrite: false,
		}),
	);
	spray.userData['seeds'] = Array.from({ length: n }, () => ({
		z: (Math.random() - 0.5) * (len - 8),
		phase: Math.random(),
		speed: 0.6 + Math.random() * 0.8,
		drift: Math.random(),
	}));
	spray.userData['base'] = base;
	g.add(spray);
	g.userData['spray'] = spray;
	return g;
}

/** Pulsing warning chevrons on the water, pointing the way the wave will go. */
function makeArrows() {
	const g = new THREE.Group();
	const s = new THREE.Shape();
	s.moveTo(-0.35, -0.55);
	s.lineTo(0.45, 0);
	s.lineTo(-0.35, 0.55);
	s.lineTo(-0.1, 0);
	s.closePath();
	const geo = new THREE.ShapeGeometry(s);
	geo.rotateX(-Math.PI / 2);
	const mat = new THREE.MeshBasicMaterial({ color: 0xff2d55, depthWrite: false, fog: false });
	const rim = new THREE.MeshBasicMaterial({
		color: 0xffffff,
		transparent: true,
		opacity: 0.9,
		depthWrite: false,
	});
	for (let i = -3; i <= 3; i++) {
		for (let j = 0; j < 2; j++) {
			const back = new THREE.Mesh(geo, rim);
			back.scale.setScalar(1.25);
			back.position.set(j * 0.9 - 0.05, -0.01, i * 2.0);
			g.add(back);
			const c = new THREE.Mesh(geo, mat);
			c.position.set(j * 0.9, 0, i * 2.0);
			g.add(c);
		}
	}
	return g;
}

function makeMarker() {
	const m = new THREE.Mesh(
		new THREE.ConeGeometry(0.16, 0.3, 4),
		new THREE.MeshBasicMaterial({ color: 0xffffff }),
	);
	m.rotation.x = Math.PI;
	return m;
}

function makeStation() {
	const scene = new THREE.Scene();
	scene.background = new THREE.Color(0xbfe6ff);
	scene.add(new THREE.HemisphereLight(0xffffff, 0x9cc8e6, 1.5));
	const key = new THREE.DirectionalLight(0xffffff, 1.8);
	key.position.set(2, 5, 4);
	key.castShadow = true;
	key.shadow.mapSize.set(512, 512);
	scene.add(key);
	// Ice pedestal.
	const ped = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.2, 0.35, 32), toon(0xe6f6ff));
	ped.position.y = 0.17;
	ped.receiveShadow = true;
	scene.add(ped);
	const rim = new THREE.Mesh(new THREE.TorusGeometry(1.12, 0.05, 8, 40), toon(0xffc0dd));
	rim.rotation.x = Math.PI / 2;
	rim.position.y = 0.35;
	scene.add(rim);
	// Curtains.
	const curtain = toon(0xff7eb0);
	for (let i = -7; i <= 7; i++) {
		const c = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 6, 10), curtain);
		c.position.set(i * 0.38, 2.5, -2.4 - (i % 2) * 0.1);
		scene.add(c);
	}
	const floor = new THREE.Mesh(new THREE.CircleGeometry(8, 32), toon(0xffffff));
	floor.rotation.x = -Math.PI / 2;
	floor.receiveShadow = true;
	scene.add(floor);
	// A little coat rack of hats either side.
	for (const side of [-1, 1]) {
		const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2, 8), toon(0x8a5a3a));
		pole.position.set(side * 2.3, 1, -1.2);
		scene.add(pole);
		const hat = new THREE.Mesh(
			new THREE.ConeGeometry(0.2, 0.45, 12),
			toon(side < 0 ? 0x3d7dff : 0xffd23f),
		);
		hat.position.set(side * 2.3, 2.15, -1.2);
		scene.add(hat);
		const scarf = new THREE.Mesh(
			new THREE.TorusGeometry(0.22, 0.06, 8, 20),
			toon(side < 0 ? 0x3fcf6e : 0xf0435a),
		);
		scarf.position.set(side * 2.3, 1.6, -1.2);
		scarf.rotation.x = 1.2;
		scene.add(scarf);
	}
	const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 50);
	camera.position.set(0, 1.5, 3.6);
	camera.lookAt(0, 0.95, 0);
	const snow = makeSnowfall(120, 10);
	scene.add(snow);
	return { scene, camera, snow };
}

/**
 * Little 3D penguin portraits (data URLs) for the HUD, lobby and leaderboard.
 * One small offscreen renderer, cached per look.
 */
export class Portraits {
	constructor() {
		this.size = 128;
		/** @type {Map<string, string>} */
		this.cache = new Map();
		/** @type {THREE.WebGLRenderer | null} */
		this.renderer = null;
		this.scene = new THREE.Scene();
		this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9cc8e6, 1.6));
		const key = new THREE.DirectionalLight(0xffffff, 1.6);
		key.position.set(2, 4, 5);
		this.scene.add(key);
		this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
		this.camera.position.set(0.9, 1.35, 3.1);
		this.camera.lookAt(0, 0.72, 0);
		/** @type {Rig | null} */
		this.rig = null;
	}

	/**
	 * @param {Look} look
	 * @returns {string}
	 */
	get(look) {
		const key = JSON.stringify(look);
		const hit = this.cache.get(key);
		if (hit) return hit;
		try {
			if (!this.renderer) {
				const canvas = document.createElement('canvas');
				this.renderer = new THREE.WebGLRenderer({
					canvas,
					alpha: true,
					antialias: true,
					preserveDrawingBuffer: true,
				});
				this.renderer.setSize(this.size, this.size, false);
				this.renderer.outputColorSpace = THREE.SRGBColorSpace;
			}
			if (!this.rig) {
				this.rig = buildPenguin(look);
				this.rig.root.rotation.y = 0.25;
				this.scene.add(this.rig.root);
			}
			/** @type {Penguin} */
			const fake = /** @type {any} */ ({
				look,
				speed: 0,
				shoveMs: 0,
				knockMs: 0,
				stunMs: 0,
				megaMs: 0,
				invulnMs: 0,
				mode: 'play',
				power: '',
				z: 0,
			});
			this.rig.blinkAt = 5;
			animatePenguin(this.rig, fake, 0, 0);
			this.renderer.render(this.scene, this.camera);
			const url = this.renderer.domElement.toDataURL('image/png');
			this.cache.set(key, url);
			return url;
		} catch {
			return '';
		}
	}
}

/** A soft vertical sky gradient for the background. */
function skyTexture() {
	const cv = document.createElement('canvas');
	cv.width = 4;
	cv.height = 256;
	const g = cv.getContext('2d');
	if (g) {
		const grad = g.createLinearGradient(0, 0, 0, 256);
		grad.addColorStop(0, '#6ec3f5');
		grad.addColorStop(0.55, '#a8def9');
		grad.addColorStop(1, '#d9f2ff');
		g.fillStyle = grad;
		g.fillRect(0, 0, 4, 256);
	}
	const tex = new THREE.CanvasTexture(cv);
	tex.colorSpace = THREE.SRGBColorSpace;
	return tex;
}

/**
 * Drift the wave's spray up and forward off the crest, looping.
 *
 * @param {THREE.Group} wave
 * @param {number} time
 */
function animateSpray(wave, time) {
	const spray = wave.userData['spray'];
	if (!(spray instanceof THREE.Points)) return;
	const seeds = /** @type {{ z: number, phase: number, speed: number, drift: number }[]} */ (
		spray.userData['seeds']
	);
	const attr = spray.geometry.attributes['position'];
	if (!attr) return;
	const arr = /** @type {Float32Array} */ (attr.array);
	seeds.forEach((s, i) => {
		const k = (time * s.speed + s.phase) % 1;
		const fade = Math.min(1, Math.max(0, (15 - Math.abs(s.z)) / 6));
		arr[i * 3] = 0.9 + k * (0.8 + s.drift * 0.6);
		arr[i * 3 + 1] =
			(1.75 + Math.sin(k * Math.PI) * (0.5 + s.drift * 0.4) - k * 0.6) * fade +
			(1 - fade) * -0.4;
		arr[i * 3 + 2] = s.z + Math.sin(time * 2 + i) * 0.1;
	});
	attr.needsUpdate = true;
}
