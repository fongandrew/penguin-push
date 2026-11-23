/**
 * The ice board, drawn: one instanced box per ice tile (snowy top, icy sides
 * going down into the sea), ice blocks on top, drifting rafts, surf along the
 * coast, and arrows showing which way each giant snowball can go. Tiles shake
 * and sink in sudden death.
 */

import * as THREE from '../vendor/three.module.min.js';
import {
	blocksAt,
	CELL,
	downhillDirs,
	floeAt,
	levelHeight,
	STEP_H,
	tileCenter,
	tileSink,
} from './arena.js';
import { WALLS_CRUMBLE_MS } from './constants.js';
import { toon, toonGradient } from './penguin3d.js';

/** Mean sea level (must match render.js). */
const WATER_Y = -0.42;

/** @typedef {import('./arena.js').Arena} Arena */

const DEPTH = 1.9;
const GAP = 0.035;

/** A box whose top is at y = 0 and bottom at y = -1, coloured snow-on-ice. */
function tileGeometry() {
	const geo = new THREE.BoxGeometry(CELL - GAP, 1, CELL - GAP);
	geo.translate(0, -0.5, 0);
	const pos = geo.attributes['position'];
	const nor = geo.attributes['normal'];
	if (!pos || !nor) return geo;
	const snow = new THREE.Color(0xf7fcff);
	const rim = new THREE.Color(0xc4e8fb);
	const deep = new THREE.Color(0x3f93c9);
	const col = [];
	const c = new THREE.Color();
	for (let i = 0; i < pos.count; i++) {
		if (nor.getY(i) > 0.5) c.copy(snow);
		else c.copy(rim).lerp(deep, Math.min(1, -pos.getY(i) * 1.2));
		col.push(c.r, c.g, c.b);
	}
	geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
	return geo;
}

/** @type {THREE.CanvasTexture | null} */
let brickTex = null;

/** Packed-ice brick lines for the blocks. */
function bricks() {
	if (brickTex) return brickTex;
	const cv = document.createElement('canvas');
	cv.width = 64;
	cv.height = 64;
	const g = cv.getContext('2d');
	if (g) {
		g.fillStyle = '#dff2fd';
		g.fillRect(0, 0, 64, 64);
		g.strokeStyle = '#a9d3ec';
		g.lineWidth = 3;
		for (const y of [1, 22, 43, 63]) {
			g.beginPath();
			g.moveTo(0, y);
			g.lineTo(64, y);
			g.stroke();
		}
		for (const [y, xs] of [
			[1, [0, 32]],
			[22, [16, 48]],
			[43, [0, 32]],
		]) {
			for (const x of /** @type {number[]} */ (xs)) {
				g.beginPath();
				g.moveTo(x, /** @type {number} */ (y));
				g.lineTo(x, /** @type {number} */ (y) + 21);
				g.stroke();
			}
		}
	}
	brickTex = new THREE.CanvasTexture(cv);
	brickTex.colorSpace = THREE.SRGBColorSpace;
	return brickTex;
}

export class Board {
	/**
	 * @param {Arena} arena
	 */
	constructor(arena) {
		this.arena = arena;
		this.group = new THREE.Group();
		/** Land tile indices, in instance order. */
		this.tiles = /** @type {number[]} */ ([]);
		for (let k = 0; k < arena.level.length; k++)
			if ((arena.level[k] ?? -1) >= 0) this.tiles.push(k);

		const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
		this.tileMesh = new THREE.InstancedMesh(tileGeometry(), mat, this.tiles.length);
		this.tileMesh.receiveShadow = true;
		this.tileMesh.castShadow = false;
		/** Per-instance base tint. */
		this.tints = /** @type {THREE.Color[]} */ ([]);
		const m = new THREE.Matrix4();
		const c = new THREE.Color();
		this.tiles.forEach((k, i) => {
			m.copy(this.tileMatrix(k, 0, 0, 0));
			this.tileMesh.setMatrixAt(i, m);
			// Slightly different whites so the blocks read as separate blocks.
			const n = Math.sin(k * 12.9898) * 43758.5453;
			const v = 0.93 + (n - Math.floor(n)) * 0.07;
			// Each step up the hill a touch bluer, so the terraces read.
			const lv = arena.level[k] ?? 0;
			if (arena.slick[k]) c.setRGB(0.78, 0.93, 1);
			else c.setRGB(v - lv * 0.06, v - lv * 0.035, Math.min(1, v + 0.03));
			this.tints.push(c.clone());
			this.tileMesh.setColorAt(i, c);
		});
		this.group.add(this.tileMesh);

		// A soft snow cap on every tile, overhanging a touch — the cosy look.
		const capGeo = new THREE.BoxGeometry(CELL - GAP + 0.04, 0.1, CELL - GAP + 0.04);
		capGeo.translate(0, -0.035, 0);
		this.snowMesh = new THREE.InstancedMesh(
			capGeo,
			new THREE.MeshLambertMaterial({ color: 0xffffff }),
			this.tiles.length,
		);
		this.snowMesh.receiveShadow = true;
		this.tiles.forEach((k, i) => {
			this.snowMesh.setMatrixAt(i, this.capMatrix(k, 0, 0, 0));
			this.snowMesh.setColorAt(i, this.tints[i] ?? new THREE.Color(1, 1, 1));
		});
		this.group.add(this.snowMesh);

		// Shine streaks on polished (slippery) tiles.
		const shine = new THREE.MeshBasicMaterial({
			color: 0xffffff,
			transparent: true,
			opacity: 0.85,
			depthWrite: false,
		});
		this.shines = /** @type {{ k: number, mesh: THREE.Group }[]} */ ([]);
		for (const k of this.tiles) {
			if (!arena.slick[k]) continue;
			const g = new THREE.Group();
			for (const [dx, dz, len] of [
				[-0.15, -0.12, 0.7],
				[0.15, 0.18, 0.4],
			]) {
				const s = new THREE.Mesh(new THREE.PlaneGeometry(len ?? 0.5, 0.06), shine);
				s.rotation.set(-Math.PI / 2, 0, 0.7);
				s.position.set(dx ?? 0, 0.02, dz ?? 0);
				g.add(s);
			}
			const p = tileCenter(arena, k);
			g.position.set(p.x, levelHeight(arena, k), p.y);
			this.group.add(g);
			this.shines.push({ k, mesh: g });
		}

		// Surf where the ice meets the water.
		/** @type {{ k: number, m: THREE.Matrix4 }[]} */
		const strips = [];
		const n = arena.n;
		for (const k of this.tiles) {
			const i = k % n;
			const j = Math.floor(k / n);
			const p = tileCenter(arena, k);
			for (const [di, dj] of [
				[1, 0],
				[-1, 0],
				[0, 1],
				[0, -1],
			]) {
				const ni = i + (di ?? 0);
				const nj = j + (dj ?? 0);
				const nk = ni >= 0 && nj >= 0 && ni < n && nj < n ? nj * n + ni : -1;
				if (nk >= 0 && (arena.level[nk] ?? -1) >= 0) continue;
				const sm = new THREE.Matrix4().compose(
					new THREE.Vector3(
						p.x + (di ?? 0) * (CELL / 2 + 0.16),
						WATER_Y + 0.06,
						p.y + (dj ?? 0) * (CELL / 2 + 0.16),
					),
					new THREE.Quaternion().setFromEuler(
						new THREE.Euler(-Math.PI / 2, 0, di ? Math.PI / 2 : 0),
					),
					new THREE.Vector3(1, 1, 1),
				);
				strips.push({ k, m: sm });
			}
		}
		this.strips = strips;
		this.foam = new THREE.InstancedMesh(
			new THREE.PlaneGeometry(CELL + 0.3, 0.32),
			new THREE.MeshBasicMaterial({
				color: 0xffffff,
				transparent: true,
				opacity: 0.6,
				depthWrite: false,
			}),
			Math.max(1, strips.length),
		);
		strips.forEach((s, i) => this.foam.setMatrixAt(i, s.m));
		this.foam.count = strips.length;
		this.group.add(this.foam);

		// Ice blocks: brick sides, a snowy cap.
		const blocks = arena.blocks;
		this.blockMesh = new THREE.InstancedMesh(
			(() => {
				const g = new THREE.BoxGeometry(CELL * 0.86, 0.95, CELL * 0.86);
				g.translate(0, 0.475, 0);
				return g;
			})(),
			new THREE.MeshToonMaterial({
				map: bricks(),
				gradientMap: toonGradient(),
				color: 0xe8f6ff,
			}),
			Math.max(1, blocks.length),
		);
		this.capMesh = new THREE.InstancedMesh(
			(() => {
				const g = new THREE.BoxGeometry(CELL * 0.92, 0.14, CELL * 0.92);
				g.translate(0, 0.98, 0);
				return g;
			})(),
			toon(0xffffff),
			Math.max(1, blocks.length),
		);
		this.blockMesh.count = blocks.length;
		this.capMesh.count = blocks.length;
		this.blockMesh.castShadow = true;
		this.capMesh.castShadow = true;
		this.blockMesh.receiveShadow = true;
		this.group.add(this.blockMesh, this.capMesh);
		this.updateBlocks(0, 0);

		// Rafts: 2×2 tiles that drift round the outside.
		this.rafts = arena.floes.map((f) => {
			const g = new THREE.Group();
			const geo = tileGeometry();
			const n2 = Math.round((f.half * 2) / CELL);
			for (let a = 0; a < n2; a++) {
				for (let b = 0; b < n2; b++) {
					const t = new THREE.Mesh(geo, mat);
					t.scale.y = 0.9;
					t.position.set((a - (n2 - 1) / 2) * CELL, 0, (b - (n2 - 1) / 2) * CELL);
					t.receiveShadow = true;
					g.add(t);
				}
			}
			this.group.add(g);
			return g;
		});

		// Which-way-down arrows for each giant snowball.
		this.chevrons = arena.balls.map((home, b) => {
			const g = new THREE.Group();
			for (const d of downhillDirs(arena, b)) {
				for (let s = 0; s < 3; s++) {
					const along = 1.1 + s * 0.55;
					const x = home.x + d.x * along;
					const y = home.y + d.y * along;
					const m = chevron();
					m.position.set(x, levelAt(arena, x, y) + 0.03, y);
					m.rotation.y = Math.atan2(-d.x, -d.y) + Math.PI;
					m.userData['step'] = s;
					g.add(m);
				}
			}
			this.group.add(g);
			return g;
		});

		// A flag on top of the stepped hill.
		if (arena.hill) {
			let top = -1;
			for (const k of this.tiles)
				if (top < 0 || (arena.level[k] ?? 0) > (arena.level[top] ?? 0)) top = k;
			if (top >= 0) {
				const p = tileCenter(arena, top);
				this.group.add(flag(p.x + CELL / 2, p.y - CELL / 2, levelHeight(arena, top)));
			}
		}
		this.lastT = -1;
	}

	/**
	 * Matrix for tile `k`, sunk by `sink` (0..1) and shaken by `shake`.
	 *
	 * @param {number} k
	 * @param {number} sink
	 * @param {number} shake
	 * @param {number} tilt
	 */
	tileMatrix(k, sink, shake, tilt) {
		const p = tileCenter(this.arena, k);
		const top = levelHeight(this.arena, k);
		const h = top + DEPTH;
		return new THREE.Matrix4().compose(
			new THREE.Vector3(p.x + shake, top - sink * (top + 1.4), p.y),
			new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, 0, tilt * 0.6)),
			new THREE.Vector3(1, h, 1),
		);
	}

	/**
	 * The snow cap's matrix for tile `k` (follows the tile when it sinks).
	 *
	 * @param {number} k
	 * @param {number} sink
	 * @param {number} shake
	 * @param {number} tilt
	 */
	capMatrix(k, sink, shake, tilt) {
		const p = tileCenter(this.arena, k);
		const top = levelHeight(this.arena, k);
		return new THREE.Matrix4().compose(
			new THREE.Vector3(p.x + shake, top - sink * (top + 1.4), p.y),
			new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, 0, tilt * 0.6)),
			new THREE.Vector3(1, 1, 1),
		);
	}

	/**
	 * @param {number} t Match time.
	 * @param {number} time Seconds since load.
	 * @param {string[]} ballKinds Each giant snowball's state.
	 */
	update(t, time, ballKinds) {
		const arena = this.arena;
		// Sudden death: only touch tiles that are shaking or sinking.
		let dirty = false;
		const c = new THREE.Color();
		this.tiles.forEach((k, i) => {
			const crack = arena.crack[k] ?? Infinity;
			if (t < crack - 1700 || (t > crack + 900 && this.lastT > crack + 900)) return;
			const s = tileSink(arena, k, t);
			const shake = s.warn ? Math.sin(time * 45 + k) * 0.05 : 0;
			this.tileMesh.setMatrixAt(i, this.tileMatrix(k, s.sink, shake, s.sink * 0.25));
			this.snowMesh.setMatrixAt(i, this.capMatrix(k, s.sink, shake, s.sink * 0.25));
			const base = this.tints[i] ?? c;
			c.copy(base);
			if (s.warn && Math.floor(time * 8) % 2 === 0) c.setRGB(0.7, 0.88, 1);
			this.tileMesh.setColorAt(i, c);
			this.snowMesh.setColorAt(i, c);
			dirty = true;
		});
		if (dirty) {
			this.tileMesh.instanceMatrix.needsUpdate = true;
			if (this.tileMesh.instanceColor) this.tileMesh.instanceColor.needsUpdate = true;
			this.snowMesh.instanceMatrix.needsUpdate = true;
			if (this.snowMesh.instanceColor) this.snowMesh.instanceColor.needsUpdate = true;
			// Surf and shine go with their tile.
			const zero = new THREE.Matrix4().makeScale(0, 0, 0);
			this.strips.forEach((s, i) => {
				this.foam.setMatrixAt(i, tileSink(arena, s.k, t).sink > 0 ? zero : s.m);
			});
			this.foam.instanceMatrix.needsUpdate = true;
			for (const s of this.shines) s.mesh.visible = tileSink(arena, s.k, t).sink === 0;
		}
		this.updateBlocks(t, time);
		arena.floes.forEach((f, i) => {
			const g = this.rafts[i];
			if (!g) return;
			const st = floeAt(f, t);
			const shake = st.warn ? Math.sin(time * 40) * 0.05 : 0;
			g.position.set(st.x + shake, -st.sink * 1.4, st.y);
			g.rotation.set(st.warn ? Math.sin(time * 23) * 0.03 : 0, 0, st.sink * 0.12);
		});
		this.chevrons.forEach((g, b) => {
			g.visible = ballKinds[b] === 'rest';
			for (const m of g.children) {
				const mat = /** @type {THREE.Mesh} */ (m).material;
				const step = Number(m.userData['step']) || 0;
				if (mat instanceof THREE.MeshBasicMaterial) {
					mat.opacity = 0.4 + 0.5 * Math.max(0, Math.sin(time * 4 - step * 0.9));
				}
			}
		});
		this.lastT = t;
	}

	/**
	 * @param {number} t
	 * @param {number} time
	 */
	updateBlocks(t, time) {
		const arena = this.arena;
		const crumble = Math.max(0, Math.min(1, (t - (WALLS_CRUMBLE_MS - 700)) / 700));
		const standing = blocksAt(arena, t).length > 0 || crumble < 1;
		const m = new THREE.Matrix4();
		arena.blocks.forEach((b, i) => {
			const s = tileSink(arena, b.k, t);
			const shake = s.warn ? Math.sin(time * 45 + b.k) * 0.05 : 0;
			const top = levelHeight(arena, b.k);
			const sy = standing ? Math.max(0.001, 1 - crumble) : 0.001;
			m.compose(
				new THREE.Vector3(b.x + shake, top - s.sink * (top + 2.4), b.y),
				new THREE.Quaternion(),
				new THREE.Vector3(1, sy, 1),
			);
			this.blockMesh.setMatrixAt(i, m);
			this.capMesh.setMatrixAt(i, m);
		});
		this.blockMesh.instanceMatrix.needsUpdate = true;
		this.capMesh.instanceMatrix.needsUpdate = true;
	}
}

/**
 * @param {Arena} arena
 * @param {number} x
 * @param {number} y
 */
function levelAt(arena, x, y) {
	const h = (arena.n * CELL) / 2;
	const i = Math.floor((x + h) / CELL);
	const j = Math.floor((y + h) / CELL);
	const k = i >= 0 && j >= 0 && i < arena.n && j < arena.n ? j * arena.n + i : -1;
	return k < 0 ? 0 : Math.max(0, arena.level[k] ?? 0) * STEP_H;
}

/** One arrow decal, pointing along +z after its group's rotation. */
function chevron() {
	const s = new THREE.Shape();
	s.moveTo(-0.42, -0.18);
	s.lineTo(0, 0.2);
	s.lineTo(0.42, -0.18);
	s.lineTo(0.42, -0.36);
	s.lineTo(0, 0.02);
	s.lineTo(-0.42, -0.36);
	s.closePath();
	const geo = new THREE.ShapeGeometry(s);
	geo.rotateX(-Math.PI / 2);
	geo.rotateY(Math.PI);
	const m = new THREE.Mesh(
		geo,
		new THREE.MeshBasicMaterial({
			color: 0x2f8fdc,
			transparent: true,
			opacity: 0.8,
			depthWrite: false,
		}),
	);
	return m;
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number} h
 */
function flag(x, y, h) {
	const g = new THREE.Group();
	const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.4, 6), toon(0x8a5a3a));
	pole.position.y = 0.7;
	g.add(pole);
	const cloth = new THREE.Mesh(
		new THREE.PlaneGeometry(0.5, 0.32),
		new THREE.MeshToonMaterial({
			color: 0xff5d73,
			side: THREE.DoubleSide,
			gradientMap: toonGradient(),
		}),
	);
	cloth.position.set(0.26, 1.22, 0);
	g.add(cloth);
	g.position.set(x, h, y);
	return g;
}
