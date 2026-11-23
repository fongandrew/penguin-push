/**
 * Everything you see, drawn with Three.js: the iceberg, the sea, the map's
 * features, the penguins, and a sprinkle of particles. Reads game state;
 * never changes it.
 */

import * as THREE from '../vendor/three.module.min.js';
import {
	capDist,
	downhillAt,
	edgeRadius,
	floeAt,
	heightAt,
	jarAt,
	jarIndicesAround,
	shrinkAt,
	wallsAt,
	waveAt,
} from './arena.js';
import { BALL_R, PLAYER_COLORS, SNOWBALL_R, WALLS_CRUMBLE_MS } from './constants.js';
import { ballAt, jarAvailable } from './contest.js';
import { throwPos } from './game.js';
import { animatePenguin, buildPenguin, starGeometry, toon, toonGradient } from './penguin3d.js';

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
		this.scene.background = new THREE.Color(0x9fdcff);
		this.scene.fog = new THREE.Fog(0x9fdcff, 30, 70);
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
		this.islandShrink = -1;
		/** @type {THREE.Mesh | null} */
		this.island = null;
		/** @type {THREE.Mesh | null} */
		this.foam = null;
		/** @type {THREE.Group[]} */
		this.floes = [];
		/** @type {THREE.Mesh[]} */
		this.balls = [];
		/** @type {string[]} */
		this.ballKinds = [];
		/** @type {THREE.Group[]} */
		this.chevrons = [];
		/** @type {THREE.Group[]} */
		this.wallMeshes = [];
		/** @type {THREE.Group | null} */
		this.wave = null;
		/** @type {THREE.Group | null} */
		this.arrows = null;

		/** @type {Map<number, PenguinView>} */
		this.penguins = new Map();
		/** @type {Map<number, THREE.Group>} */
		this.jars = new Map();
		/** @type {Map<number, THREE.Mesh>} */
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
		this.floes = [];
		this.balls = [];
		this.ballKinds = [];
		this.chevrons = [];
		this.wallMeshes = [];
		this.wave = null;
		this.arrows = null;
		this.islandShrink = -1;
		this.island = null;
		this.foam = null;

		for (const f of arena.floes) {
			const g = makeFloe(f.r, f.shape);
			this.floes.push(g);
			this.world.add(g);
		}
		for (const o of arena.obstacles) {
			if (o === arena.igloo) this.world.add(makeIgloo(o.x, o.y, o.r));
			else this.world.add(makeRock(o.x, o.y, o.r));
		}
		for (const c of arena.slick) this.world.add(makeSlickShine(c, arena));
		for (const w of arena.walls) {
			const m = makeWall(w, arena);
			this.wallMeshes.push(m);
			this.world.add(m);
		}
		for (const home of arena.balls) {
			const down = downhillAt(arena, home.x, home.y);
			const ch = makeChevrons();
			ch.position.set(home.x, 0, home.y);
			if (down) ch.rotation.y = Math.atan2(-down.x, -down.y);
			// Lay each arrow on the slope.
			for (const m of ch.children) {
				const wp = m.position.clone().applyEuler(ch.rotation);
				m.position.y = heightAt(arena, home.x + wp.x, home.y + wp.z) + 0.04;
			}
			this.chevrons.push(ch);
			this.world.add(ch);
		}
		arena.balls.forEach(() => {
			const m = makeGiantSnowball();
			this.balls.push(m);
			this.ballKinds.push('rest');
			this.world.add(m);
		});
		if (arena.hill)
			this.world.add(
				makeFlag(
					arena.hill.x,
					arena.hill.y + 0.2,
					heightAt(arena, arena.hill.x, arena.hill.y + 0.2),
				),
			);
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
		this.updateIsland(arena, t);
		animateWater(this.water, time);
		animateSnow(this.snow, dt);
		this.updateFloes(arena, t, time);
		this.updateBalls(state, arena, t, dt);
		this.updateWalls(arena, t);
		this.chevrons.forEach((ch, i) => {
			ch.visible = this.ballKinds[i] === 'rest';
			ch.children.forEach((m, j) => {
				const mat = /** @type {THREE.Mesh} */ (m).material;
				if (mat instanceof THREE.MeshBasicMaterial)
					mat.opacity = 0.45 + 0.45 * Math.max(0, Math.sin(time * 4 - j * 0.9));
			});
		});
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
			slideMs: 0,
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
	 * @param {Arena} arena
	 * @param {number} t
	 */
	updateIsland(arena, t) {
		const k = shrinkAt(t);
		if (this.island && Math.abs(k - this.islandShrink) < 0.004) return;
		const crumbling = this.islandShrink > 0 && k < this.islandShrink;
		this.islandShrink = k;
		if (this.island) {
			this.world.remove(this.island);
			this.island.geometry.dispose();
		}
		if (this.foam) {
			this.world.remove(this.foam);
			this.foam.geometry.dispose();
		}
		this.island = makeIsland(arena, k);
		this.world.add(this.island);
		this.foam = makeFoam(arena, k);
		this.world.add(this.foam);
		if (crumbling) {
			// Chunks breaking off the edge.
			for (let i = 0; i < 6; i++) {
				const a = Math.random() * Math.PI * 2;
				const r = edgeRadius(arena, a) * k;
				this.spawnParticle(
					v3(Math.cos(a) * r, Math.sin(a) * r, 0.1),
					new THREE.Vector3(Math.cos(a) * 1.5, 1.5, Math.sin(a) * 1.5),
					0xe8f6ff,
					0.18,
					1.1,
					6,
				);
			}
		}
	}

	/**
	 * Snow walls sink into the ice when sudden death gets going.
	 *
	 * @param {Arena} arena
	 * @param {number} t
	 */
	updateWalls(arena, t) {
		const gone = wallsAt(arena, t).length === 0;
		const k = Math.max(0, Math.min(1, (t - (WALLS_CRUMBLE_MS - 700)) / 700));
		this.wallMeshes.forEach((m, i) => {
			if (!gone && k <= 0) {
				m.visible = true;
				m.scale.y = 1;
				return;
			}
			if (m.visible && Math.random() < 0.3) {
				const w = arena.walls[i];
				if (w) {
					const u = Math.random();
					const x = w.ax + (w.bx - w.ax) * u;
					const y = w.ay + (w.by - w.ay) * u;
					this.spawnParticle(
						new THREE.Vector3(x, 0.6, y),
						new THREE.Vector3((Math.random() - 0.5) * 2, 2, (Math.random() - 0.5) * 2),
						0xffffff,
						0.12,
						0.6,
						6,
					);
				}
			}
			m.scale.y = Math.max(0.01, 1 - k);
			m.visible = k < 1;
		});
	}

	/**
	 * @param {Arena} arena
	 * @param {number} t
	 * @param {number} time
	 */
	updateFloes(arena, t, time) {
		arena.floes.forEach((f, i) => {
			const g = this.floes[i];
			if (!g) return;
			const st = floeAt(f, t);
			const shake = st.warn ? Math.sin(time * 40) * 0.05 : 0;
			g.position.set(st.x + shake, -st.sink * 1.1, st.y);
			g.rotation.set(st.warn ? Math.sin(time * 23) * 0.03 : 0, -st.angle, st.sink * 0.15);
			const crack = g.userData['crack'];
			if (crack instanceof THREE.Object3D) crack.visible = st.warn || st.sink > 0;
		});
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
				m.position.copy(v3(b.x, b.y, heightAt(arena, b.x, b.y) + BALL_R - 0.1));
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
			this.wave.position.set(ux * w.front, Math.sin(time * 6) * 0.05, uy * w.front);
			this.wave.rotation.y = -w.dir;
		} else {
			const reach = (arena.R + 1.8) * shrinkAt(t);
			this.arrows.position.set(-ux * reach, 0.15, -uy * reach);
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
				m = new THREE.Mesh(new THREE.SphereGeometry(SNOWBALL_R, 12, 10), toon(0xffffff));
				m.castShadow = true;
				this.throws.set(th.id, m);
				this.world.add(m);
			}
			const p = throwPos(th, t);
			m.position.set(p.x, p.z, p.y);
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
			rig.root.position.set(p.x, p.z, p.y);
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
						at.clone().setY(0.1),
						new THREE.Vector3(rnd() * 4, 3 + Math.random() * (big ? 6 : 4), rnd() * 4),
						c,
						0.1 + Math.random() * 0.1,
						0.9,
						12,
					);
				}
				this.spawnRipple(at.clone().setY(0.05), big ? 2.4 : 1.4);
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

/**
 * The iceberg's top and cliffs, following the (shrinking) edge.
 *
 * @param {Arena} arena
 * @param {number} k Shrink factor.
 */
function makeIsland(arena, k) {
	const rings = 44;
	const segs = 160;
	/** @type {number[]} */
	const pos = [];
	/** @type {number[]} */
	const col = [];
	/** @type {number[]} */
	const idx = [];
	const snow = new THREE.Color(0xf7fcff);
	const blue = new THREE.Color(0xcfe9fb);
	const slick = new THREE.Color(0xe2f6ff);
	const cliff = new THREE.Color(0x8fd3f5);
	const deep = new THREE.Color(0x4aa8d8);
	const tmp = new THREE.Color();
	const vert = (
		/** @type {number} */ x,
		/** @type {number} */ y,
		/** @type {number} */ z,
		/** @type {THREE.Color} */ c,
	) => {
		pos.push(x, y, z);
		col.push(c.r, c.g, c.b);
		return pos.length / 3 - 1;
	};
	// Centre + rings.
	vert(0, heightAt(arena, 0, 0), 0, snow);
	for (let i = 1; i <= rings; i++) {
		for (let j = 0; j < segs; j++) {
			const a = (j / segs) * Math.PI * 2;
			const r = (i / rings) * edgeRadius(arena, a) * k;
			let x = Math.cos(a) * r;
			let y = Math.sin(a) * r;
			// Snap grid points near a hole onto its outline so holes look round.
			for (const h of arena.holes) {
				const c = capDist(h, x, y);
				if (Math.abs(c.d) < 0.2) {
					x = c.px + c.nx * h.r;
					y = c.py + c.ny * h.r;
				}
			}
			const bump = Math.sin(x * 2.1 + y * 0.7) * Math.cos(y * 1.7 - x * 0.4) * 0.03;
			tmp.copy(snow).lerp(blue, Math.pow(i / rings, 3));
			if (arena.holes.some((h) => capDist(h, x, y).d < 0.35)) tmp.copy(blue);
			if (arena.slick.some((c) => (x - c.x) ** 2 + (y - c.y) ** 2 < c.r * c.r))
				tmp.copy(slick);
			vert(x, heightAt(arena, x, y) + bump + (i === rings ? -0.04 : 0), y, tmp);
		}
	}
	const ringStart = (/** @type {number} */ i) => 1 + (i - 1) * segs;
	/** Add a top triangle unless it's over a hole. */
	const tri = (/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ c) => {
		const cx = ((pos[a * 3] ?? 0) + (pos[b * 3] ?? 0) + (pos[c * 3] ?? 0)) / 3;
		const cy = ((pos[a * 3 + 2] ?? 0) + (pos[b * 3 + 2] ?? 0) + (pos[c * 3 + 2] ?? 0)) / 3;
		if (arena.holes.some((h) => capDist(h, cx, cy).d < -0.01)) return;
		idx.push(a, b, c);
	};
	for (let j = 0; j < segs; j++) {
		tri(0, ringStart(1) + ((j + 1) % segs), ringStart(1) + j);
	}
	for (let i = 1; i < rings; i++) {
		for (let j = 0; j < segs; j++) {
			const a = ringStart(i) + j;
			const b = ringStart(i) + ((j + 1) % segs);
			const c = ringStart(i + 1) + j;
			const d = ringStart(i + 1) + ((j + 1) % segs);
			tri(a, b, c);
			tri(b, d, c);
		}
	}
	// Holes: icy walls going down into the water.
	for (const h of arena.holes) {
		const m = 48;
		const top = pos.length / 3;
		for (let s = 0; s < m; s++) {
			const p = holeOutline(h, (s / m) * Math.PI * 2);
			vert(p.x, heightAt(arena, p.x, p.y) - 0.02, p.y, cliff);
		}
		const bottom = pos.length / 3;
		for (let s = 0; s < m; s++) {
			const p = holeOutline(h, (s / m) * Math.PI * 2);
			vert(p.x, -1.8, p.y, deep);
		}
		for (let s = 0; s < m; s++) {
			const a = top + s;
			const b = top + ((s + 1) % m);
			const c = bottom + s;
			const d = bottom + ((s + 1) % m);
			idx.push(a, c, b, b, c, d);
		}
	}
	// Cliffs: a lip, then down under the water.
	const layers = [
		{ r: 1.0, y: -0.25, c: cliff },
		{ r: 0.96, y: -0.9, c: cliff },
		{ r: 0.85, y: -2.6, c: deep },
	];
	let prevStart = ringStart(rings);
	for (const L of layers) {
		const start = pos.length / 3;
		for (let j = 0; j < segs; j++) {
			const a = (j / segs) * Math.PI * 2;
			const r = edgeRadius(arena, a) * k * L.r + Math.sin(j * 1.7) * 0.04;
			vert(Math.cos(a) * r, L.y, Math.sin(a) * r, L.c);
		}
		for (let j = 0; j < segs; j++) {
			const a = prevStart + j;
			const b = prevStart + ((j + 1) % segs);
			const c = start + j;
			const d = start + ((j + 1) % segs);
			idx.push(a, b, c, b, d, c);
		}
		prevStart = start;
	}
	const geo = new THREE.BufferGeometry();
	geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
	geo.setIndex(idx);
	geo.computeVertexNormals();
	const mesh = new THREE.Mesh(
		geo,
		new THREE.MeshToonMaterial({
			vertexColors: true,
			gradientMap: toonGradient(),
			side: THREE.DoubleSide,
		}),
	);
	mesh.receiveShadow = true;
	return mesh;
}

/**
 * A point on a hole's outline, by direction (support point of the capsule).
 *
 * @param {import('./arena.js').Capsule} h
 * @param {number} a
 */
function holeOutline(h, a) {
	const ux = Math.cos(a);
	const uy = Math.sin(a);
	const useB = h.bx * ux + h.by * uy > h.ax * ux + h.ay * uy;
	const cx = useB ? h.bx : h.ax;
	const cy = useB ? h.by : h.ay;
	return { x: cx + ux * h.r, y: cy + uy * h.r };
}

/**
 * A snow wall: packed snow blocks with a rounded white top.
 *
 * @param {import('./arena.js').Capsule} w
 * @param {Arena} arena
 */
function makeWall(w, arena) {
	const g = new THREE.Group();
	const len = Math.hypot(w.bx - w.ax, w.by - w.ay);
	const h = 0.78;
	const side = new THREE.MeshToonMaterial({
		map: blockTexture(len),
		gradientMap: toonGradient(),
	});
	const body = new THREE.Mesh(new THREE.BoxGeometry(len, h, w.r * 2), side);
	body.position.y = h / 2;
	body.castShadow = true;
	body.receiveShadow = true;
	g.add(body);
	const capMat = toon(0xffffff);
	for (const end of [-len / 2, len / 2]) {
		const post = new THREE.Mesh(
			new THREE.CylinderGeometry(w.r, w.r * 1.05, h, 14),
			toon(0xe4f2fc),
		);
		post.position.set(end, h / 2, 0);
		post.castShadow = true;
		g.add(post);
		const knob = new THREE.Mesh(new THREE.SphereGeometry(w.r * 1.08, 12, 8), capMat);
		knob.position.set(end, h, 0);
		knob.scale.y = 0.6;
		g.add(knob);
	}
	const cap = new THREE.Mesh(new THREE.CylinderGeometry(w.r * 1.08, w.r * 1.08, len, 12), capMat);
	cap.rotation.z = Math.PI / 2;
	cap.scale.set(1, 1, 0.6);
	cap.position.y = h;
	cap.castShadow = true;
	g.add(cap);
	const mx = (w.ax + w.bx) / 2;
	const my = (w.ay + w.by) / 2;
	g.position.set(mx, heightAt(arena, mx, my) - 0.02, my);
	g.rotation.y = -Math.atan2(w.by - w.ay, w.bx - w.ax);
	return g;
}

/** @type {Map<number, THREE.CanvasTexture>} */
const blockTex = new Map();

/** @param {number} len */
function blockTexture(len) {
	const reps = Math.max(1, Math.round(len / 0.9));
	let tex = blockTex.get(reps);
	if (tex) return tex;
	const cv = document.createElement('canvas');
	cv.width = 64 * reps;
	cv.height = 64;
	const c = cv.getContext('2d');
	if (c) {
		c.fillStyle = '#eaf5fd';
		c.fillRect(0, 0, cv.width, 64);
		c.strokeStyle = '#b4d6ec';
		c.lineWidth = 3;
		for (const yy of [2, 32, 62]) {
			c.beginPath();
			c.moveTo(0, yy);
			c.lineTo(cv.width, yy);
			c.stroke();
		}
		for (let i = 0; i <= reps * 2; i++) {
			for (const [y0, off] of [
				[2, 0],
				[32, 16],
			]) {
				const xx = i * 32 + (off ?? 0);
				c.beginPath();
				c.moveTo(xx, y0 ?? 0);
				c.lineTo(xx, (y0 ?? 0) + 30);
				c.stroke();
			}
		}
	}
	tex = new THREE.CanvasTexture(cv);
	tex.colorSpace = THREE.SRGBColorSpace;
	blockTex.set(reps, tex);
	return tex;
}

/**
 * Glossy streaks over a slippery patch, so it reads as ice, not water.
 *
 * @param {{ x: number, y: number, r: number }} c
 * @param {Arena} arena
 */
function makeSlickShine(c, arena) {
	const g = new THREE.Group();
	const ring = new THREE.Mesh(
		new THREE.RingGeometry(c.r - 0.08, c.r, 40),
		new THREE.MeshBasicMaterial({
			color: 0xffffff,
			transparent: true,
			opacity: 0.8,
			depthWrite: false,
		}),
	);
	ring.rotation.x = -Math.PI / 2;
	g.add(ring);
	const streak = new THREE.MeshBasicMaterial({
		color: 0xffffff,
		transparent: true,
		opacity: 0.85,
		depthWrite: false,
	});
	for (const [dx, dz, len] of [
		[-0.3, -0.2, 0.9],
		[0.1, 0.15, 0.6],
		[0.35, -0.35, 0.4],
	]) {
		const m = new THREE.Mesh(new THREE.PlaneGeometry(len ?? 0.5, 0.07), streak);
		m.rotation.set(-Math.PI / 2, 0, 0.7);
		m.position.set((dx ?? 0) * c.r, 0, (dz ?? 0) * c.r);
		g.add(m);
	}
	g.position.set(c.x, heightAt(arena, c.x, c.y) + 0.03, c.y);
	return g;
}

/**
 * Pale arrows painted on the snow below a resting giant snowball: this way down.
 */
function makeChevrons() {
	const g = new THREE.Group();
	const shape = new THREE.Shape();
	shape.moveTo(-0.45, -0.18);
	shape.lineTo(0, 0.22);
	shape.lineTo(0.45, -0.18);
	shape.lineTo(0.45, -0.38);
	shape.lineTo(0, 0.02);
	shape.lineTo(-0.45, -0.38);
	shape.closePath();
	const geo = new THREE.ShapeGeometry(shape);
	const mat = new THREE.MeshBasicMaterial({
		color: 0x3d9bdf,
		transparent: true,
		opacity: 0.7,
		depthWrite: false,
	});
	for (let i = 0; i < 3; i++) {
		const m = new THREE.Mesh(geo, mat.clone());
		m.rotation.x = -Math.PI / 2;
		m.position.z = -(1.55 + i * 0.55);
		g.add(m);
	}
	return g;
}

/**
 * White surf hugging the iceberg's edge.
 *
 * @param {Arena} arena
 * @param {number} k
 */
function makeFoam(arena, k) {
	const segs = 96;
	/** @type {number[]} */
	const pos = [];
	/** @type {number[]} */
	const idx = [];
	for (let j = 0; j < segs; j++) {
		const a = (j / segs) * Math.PI * 2;
		const r = edgeRadius(arena, a) * k;
		pos.push(Math.cos(a) * (r + 0.05), 0.02, Math.sin(a) * (r + 0.05));
		pos.push(Math.cos(a) * (r + 0.55), 0.02, Math.sin(a) * (r + 0.55));
	}
	for (let j = 0; j < segs; j++) {
		const a = j * 2;
		const b = ((j + 1) % segs) * 2;
		idx.push(a, b, a + 1, b, b + 1, a + 1);
	}
	const geo = new THREE.BufferGeometry();
	geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	geo.setIndex(idx);
	return new THREE.Mesh(
		geo,
		new THREE.MeshBasicMaterial({
			color: 0xffffff,
			transparent: true,
			opacity: 0.55,
			depthWrite: false,
			side: THREE.DoubleSide,
		}),
	);
}

function makeWater() {
	const geo = new THREE.PlaneGeometry(140, 140, 90, 90);
	geo.rotateX(-Math.PI / 2);
	const base = Float32Array.from(
		/** @type {Float32Array} */ (geo.attributes['position']?.array ?? []),
	);
	const mat = new THREE.MeshPhongMaterial({
		color: 0x2b9be0,
		flatShading: true,
		shininess: 90,
		specular: 0x99ddff,
		transparent: true,
		opacity: 0.88,
	});
	const mesh = new THREE.Mesh(geo, mat);
	mesh.position.y = -0.18;
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
		arr[i + 1] =
			Math.sin(x * 0.45 + time * 1.3) * 0.09 +
			Math.cos(z * 0.5 + time * 1.1) * 0.09 +
			Math.sin((x + z) * 0.9 + time * 2.2) * 0.04;
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
 * @param {number} r
 * @param {number[]} shape
 */
function makeFloe(r, shape) {
	const s = new THREE.Shape();
	shape.forEach((k, i) => {
		const a = (i / shape.length) * Math.PI * 2;
		const x = Math.cos(a) * r * k;
		const y = Math.sin(a) * r * k;
		if (i === 0) s.moveTo(x, y);
		else s.lineTo(x, y);
	});
	s.closePath();
	const geo = new THREE.ExtrudeGeometry(s, {
		depth: 0.45,
		bevelEnabled: true,
		bevelSize: 0.12,
		bevelThickness: 0.1,
		bevelSegments: 2,
	});
	geo.rotateX(-Math.PI / 2);
	geo.translate(0, -0.5, 0);
	const g = new THREE.Group();
	const top = new THREE.Mesh(geo, toon(0xf4fbff));
	top.receiveShadow = true;
	top.castShadow = true;
	g.add(top);
	// Cracks shown while it's about to sink.
	const crack = new THREE.Group();
	const cmat = new THREE.MeshBasicMaterial({ color: 0x4a90c0 });
	for (let i = 0; i < 4; i++) {
		const m = new THREE.Mesh(new THREE.BoxGeometry(r * 1.1, 0.02, 0.05), cmat);
		m.position.y = 0.08;
		m.rotation.y = i * 0.8 + 0.3;
		crack.add(m);
	}
	crack.visible = false;
	g.add(crack);
	g.userData['crack'] = crack;
	return g;
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

/**
 * @param {number} x
 * @param {number} y
 * @param {number} r
 */
function makeRock(x, y, r) {
	const m = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 0), toon(0x7d8796));
	m.position.set(x, r * 0.45, y);
	m.scale.y = 0.75;
	m.rotation.y = x;
	m.castShadow = true;
	const cap = new THREE.Mesh(
		new THREE.SphereGeometry(r * 0.75, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2.5),
		toon(0xffffff),
	);
	cap.position.y = r * 0.45;
	m.add(cap);
	return m;
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
 * @param {number} x
 * @param {number} y
 * @param {number} h
 */
function makeFlag(x, y, h) {
	const g = new THREE.Group();
	const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.4, 6), toon(0x8a5a3a));
	pole.position.y = 0.7;
	g.add(pole);
	const flag = new THREE.Mesh(
		new THREE.PlaneGeometry(0.5, 0.32),
		new THREE.MeshToonMaterial({
			color: 0xff5d73,
			side: THREE.DoubleSide,
			gradientMap: toonGradient(),
		}),
	);
	flag.position.set(0.26, 1.22, 0);
	g.add(flag);
	g.position.set(x, h - 0.05, y);
	return g;
}

/**
 * @param {'heart' | 'fish'} kind
 */
function makeJar(kind) {
	const g = new THREE.Group();
	const glass = new THREE.Mesh(
		new THREE.CylinderGeometry(0.3, 0.27, 0.5, 18),
		new THREE.MeshPhongMaterial({
			color: 0xbfe9ff,
			transparent: true,
			opacity: 0.38,
			shininess: 120,
			depthWrite: false,
		}),
	);
	glass.position.y = 0.3;
	g.add(glass);
	const lid = new THREE.Mesh(
		new THREE.CylinderGeometry(0.32, 0.32, 0.09, 18),
		toon(kind === 'heart' ? 0xff6f91 : 0x3d9bff),
	);
	lid.position.y = 0.58;
	lid.castShadow = true;
	g.add(lid);
	const knob = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), toon(0xffffff));
	knob.position.y = 0.65;
	g.add(knob);
	const inner = new THREE.Group();
	inner.position.y = 0.3;
	if (kind === 'heart') {
		const h = new THREE.Mesh(heartGeometry(), toon(0xff3d5e, { emissive: 0x440010 }));
		h.scale.setScalar(0.3);
		inner.add(h);
	} else {
		const body = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), toon(0xffa53a));
		body.scale.set(0.16, 0.09, 0.06);
		inner.add(body);
		const tail = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.12, 4), toon(0xffa53a));
		tail.rotation.z = Math.PI / 2;
		tail.position.x = -0.19;
		inner.add(tail);
		const eye = new THREE.Mesh(new THREE.SphereGeometry(0.02, 6, 4), toon(0x111111));
		eye.position.set(0.1, 0.025, 0.05);
		inner.add(eye);
	}
	g.add(inner);
	g.userData['inner'] = inner;
	const glow = new THREE.Mesh(
		new THREE.CircleGeometry(0.5, 24),
		new THREE.MeshBasicMaterial({
			color: kind === 'heart' ? 0xff8fb0 : 0x8fd0ff,
			transparent: true,
			opacity: 0.45,
			depthWrite: false,
		}),
	);
	glow.rotation.x = -Math.PI / 2;
	glow.position.y = -0.1;
	g.add(glow);
	return g;
}

function makeWave() {
	const g = new THREE.Group();
	const body = new THREE.Mesh(
		new THREE.CapsuleGeometry(0.55, 26, 6, 12),
		new THREE.MeshPhongMaterial({
			color: 0x3fb3ff,
			transparent: true,
			opacity: 0.85,
			shininess: 80,
			flatShading: true,
		}),
	);
	body.rotation.x = Math.PI / 2;
	body.scale.set(1, 1, 1.4);
	body.position.y = 0.2;
	g.add(body);
	const crest = new THREE.Mesh(
		new THREE.CapsuleGeometry(0.28, 26, 4, 8),
		new THREE.MeshPhongMaterial({ color: 0xffffff, flatShading: true }),
	);
	crest.rotation.x = Math.PI / 2;
	crest.position.set(0.25, 0.75, 0);
	g.add(crest);
	return g;
}

function makeArrows() {
	const g = new THREE.Group();
	const mat = new THREE.MeshBasicMaterial({ color: 0xff3d5e });
	for (let i = -2; i <= 2; i++) {
		const c = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.9, 3), mat);
		c.rotation.z = -Math.PI / 2;
		c.position.set(0, 0, i * 2.2);
		g.add(c);
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
				slideMs: 0,
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
