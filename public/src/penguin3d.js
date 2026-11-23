/**
 * Cute 3D penguins, built from primitives with toon shading — no model files.
 * Model space: y up, facing +z, about 1.35 units tall.
 */

import * as THREE from '../vendor/three.module.min.js';
import { SHOVE_ANIM_MS } from './constants.js';
import { COLORS, SPECIES } from './looks.js';

/** @typedef {import('./looks.js').Look} Look */
/** @typedef {import('./state.js').Penguin} Penguin */

/** @type {THREE.DataTexture | null} */
let gradient = null;

/** A 4-step light ramp: the cel-shaded look. */
export function toonGradient() {
	if (gradient) return gradient;
	const data = new Uint8Array([
		90, 90, 90, 255, 160, 160, 160, 255, 220, 220, 220, 255, 255, 255, 255, 255,
	]);
	gradient = new THREE.DataTexture(data, 4, 1, THREE.RGBAFormat);
	gradient.minFilter = THREE.NearestFilter;
	gradient.magFilter = THREE.NearestFilter;
	gradient.needsUpdate = true;
	return gradient;
}

/** @type {Map<string, THREE.MeshToonMaterial>} */
const mats = new Map();

/**
 * @param {number} color
 * @param {{ emissive?: number, transparent?: boolean, opacity?: number }} [opts]
 */
export function toon(color, opts = {}) {
	const key = `${color}:${opts.emissive ?? 0}:${opts.opacity ?? 1}`;
	let m = mats.get(key);
	if (!m) {
		m = new THREE.MeshToonMaterial({ color, gradientMap: toonGradient() });
		if (opts.emissive) m.emissive = new THREE.Color(opts.emissive);
		if (opts.transparent) {
			m.transparent = true;
			m.opacity = opts.opacity ?? 1;
		}
		mats.set(key, m);
	}
	return m;
}

const SPHERE = new THREE.SphereGeometry(1, 24, 18);
const SPHERE_LO = new THREE.SphereGeometry(1, 12, 10);

/**
 * @param {THREE.Material} mat
 * @param {[number, number, number]} scale
 * @param {[number, number, number]} pos
 * @param {boolean} [lo]
 */
function blob(mat, scale, pos, lo = false) {
	const m = new THREE.Mesh(lo ? SPHERE_LO : SPHERE, mat);
	m.scale.set(...scale);
	m.position.set(...pos);
	m.castShadow = true;
	return m;
}

/**
 * @param {THREE.BufferGeometry} geo
 * @param {THREE.Material} mat
 * @param {[number, number, number]} pos
 * @param {[number, number, number]} [rot]
 */
function part(geo, mat, pos, rot = [0, 0, 0]) {
	const m = new THREE.Mesh(geo, mat);
	m.position.set(...pos);
	m.rotation.set(...rot);
	m.castShadow = true;
	return m;
}

/**
 * @typedef {object} Rig
 * @property {THREE.Group} root Positioned/rotated by the renderer.
 * @property {THREE.Group} body Waddle/lean pivot at the feet.
 * @property {THREE.Group} head
 * @property {THREE.Group} flipL
 * @property {THREE.Group} flipR
 * @property {THREE.Mesh} flipMeshL
 * @property {THREE.Mesh} flipMeshR
 * @property {THREE.Mesh} footL
 * @property {THREE.Mesh} footR
 * @property {THREE.Object3D[]} eyes
 * @property {THREE.Group} hatSlot
 * @property {THREE.Group} neckSlot
 * @property {THREE.Group} faceSlot
 * @property {THREE.Group} species
 * @property {THREE.Group} stars
 * @property {THREE.Mesh} handBall
 * @property {THREE.Object3D | null} spinner Propeller.
 * @property {THREE.Object3D | null} sway Scarf tail / cape.
 * @property {'tail' | 'cape'} swayKind
 * @property {string} lookKey
 * @property {number} phase
 * @property {number} blinkAt
 */

/**
 * @param {Look} look
 * @returns {Rig}
 */
export function buildPenguin(look) {
	const root = new THREE.Group();
	const body = new THREE.Group();
	root.add(body);
	const head = new THREE.Group();
	head.position.set(0, 1.0, 0.02);
	body.add(head);

	const flipL = new THREE.Group();
	const flipR = new THREE.Group();
	flipL.position.set(0.37, 0.74, -0.02);
	flipR.position.set(-0.37, 0.74, -0.02);
	body.add(flipL, flipR);

	const footMat = toon(0xff9b2f);
	const footL = blob(footMat, [0.12, 0.05, 0.17], [0.15, 0.04, 0.13], true);
	const footR = blob(footMat, [0.12, 0.05, 0.17], [-0.15, 0.04, 0.13], true);
	root.add(footL, footR);

	const hatSlot = new THREE.Group();
	hatSlot.position.set(0, 0.29, -0.01);
	head.add(hatSlot);
	const faceSlot = new THREE.Group();
	head.add(faceSlot);
	const neckSlot = new THREE.Group();
	neckSlot.position.set(0, 0.78, 0);
	body.add(neckSlot);
	const species = new THREE.Group();
	body.add(species);

	const stars = new THREE.Group();
	stars.position.set(0, 1.55, 0);
	const starGeo = starGeometry(0.09, 0.04, 0.03);
	for (let i = 0; i < 3; i++) {
		const s = new THREE.Mesh(starGeo, toon(0xffe14d, { emissive: 0x806000 }));
		const a = (i / 3) * Math.PI * 2;
		s.position.set(Math.cos(a) * 0.32, 0, Math.sin(a) * 0.32);
		stars.add(s);
	}
	stars.visible = false;
	root.add(stars);

	const handBall = blob(toon(0xffffff), [0.12, 0.12, 0.12], [0, -0.52, 0.05], true);
	handBall.visible = false;
	flipR.add(handBall);

	/** @type {Rig} */
	const rig = {
		root,
		body,
		head,
		flipL,
		flipR,
		flipMeshL: new THREE.Mesh(),
		flipMeshR: new THREE.Mesh(),
		footL,
		footR,
		eyes: [],
		hatSlot,
		neckSlot,
		faceSlot,
		species,
		stars,
		handBall,
		spinner: null,
		sway: null,
		swayKind: 'tail',
		lookKey: '',
		phase: Math.random() * 10,
		blinkAt: 1 + Math.random() * 3,
	};
	setLook(rig, look);
	return rig;
}

/**
 * Rebuild the bits that depend on the look (cheap; only when it changes).
 *
 * @param {Rig} rig
 * @param {Look} look
 */
export function setLook(rig, look) {
	const key = JSON.stringify(look);
	if (key === rig.lookKey) return;
	rig.lookKey = key;
	const sp = SPECIES[look.species] ?? SPECIES[0];
	if (!sp) return;
	for (const slot of [rig.species, rig.hatSlot, rig.neckSlot, rig.faceSlot, rig.head]) {
		for (const c of [...slot.children])
			if (c !== rig.hatSlot && c !== rig.faceSlot) slot.remove(c);
	}
	rig.flipL.clear();
	rig.flipR.clear();
	rig.flipR.add(rig.handBall);
	rig.spinner = null;
	rig.sway = null;
	rig.hatSlot.rotation.set(0, 0, 0);

	const back = toon(sp.back);
	const belly = toon(sp.belly);
	const white = toon(0xffffff);
	const black = toon(0x15151c);

	// Body + belly.
	rig.species.add(blob(back, [0.43, 0.5, 0.4], [0, 0.5, -0.02]));
	rig.species.add(blob(belly, [0.36, 0.42, 0.26], [0, 0.46, 0.15]));
	// Little tail.
	rig.species.add(
		part(new THREE.ConeGeometry(0.1, 0.22, 8), back, [0, 0.12, -0.36], [-2.1, 0, 0]),
	);

	// Head.
	const head = rig.head;
	head.add(blob(back, [0.34, 0.32, 0.32], [0, 0, 0]));
	const faceColor = sp.face === 'chick' ? toon(0xeceef3) : white;
	if (
		sp.face === 'mask' ||
		sp.face === 'chick' ||
		sp.face === 'rockhopper' ||
		sp.face === 'gentoo'
	) {
		head.add(blob(faceColor, [0.25, 0.21, 0.17], [0, -0.05, 0.18]));
	}
	if (sp.face === 'emperor') {
		const gold = toon(0xffb23d);
		// Golden ear patches, kept up on the head clear of any scarf.
		head.add(blob(gold, [0.06, 0.1, 0.05], [0.25, -0.03, 0.09], true));
		head.add(blob(gold, [0.06, 0.1, 0.05], [-0.25, -0.03, 0.09], true));
		rig.species.add(blob(toon(0xffe7a8), [0.16, 0.08, 0.06], [0, 0.66, 0.31], true));
		head.add(blob(white, [0.2, 0.15, 0.12], [0, -0.1, 0.2]));
	}
	if (sp.face === 'gentoo') {
		// The white "bonnet" patches above each eye.
		for (const side of [1, -1]) {
			const patch = blob(white, [0.075, 0.035, 0.045], [0.12 * side, 0.135, 0.24], true);
			patch.rotation.z = 0.45 * side;
			head.add(patch);
		}
	}
	if (sp.face === 'rockhopper') {
		const yellow = toon(0xffd400);
		for (const side of [1, -1]) {
			const tuft = new THREE.Group();
			// Low and swept back, so they peek out under any hat.
			tuft.position.set(0.15 * side, 0.09, 0.2);
			for (let i = 0; i < 3; i++) {
				const c = part(
					new THREE.ConeGeometry(0.022, 0.17, 6),
					yellow,
					[0.06 * side * i, 0.03 * i, -0.05 * i],
					[-0.6 - i * 0.2, 0, -1.1 * side],
				);
				tuft.add(c);
			}
			head.add(tuft);
		}
	}
	if (sp.face === 'chick') {
		const fluff = toon(sp.back);
		head.add(blob(fluff, [0.08, 0.1, 0.08], [0, 0.31, 0], true));
		head.add(blob(fluff, [0.06, 0.08, 0.06], [0.07, 0.29, -0.05], true));
		rig.species.add(blob(fluff, [0.47, 0.42, 0.44], [0, 0.48, -0.04]));
	}

	// Eyes, cheeks, beak.
	rig.eyes = [];
	for (const side of [1, -1]) {
		const eye = new THREE.Group();
		eye.position.set(0.11 * side, 0.03, 0.305);
		eye.add(
			blob(
				sp.face === 'rockhopper' ? toon(0x8a1020) : black,
				[0.055, 0.065, 0.035],
				[0, 0, 0],
				true,
			),
		);
		eye.add(blob(white, [0.02, 0.02, 0.015], [0.018, 0.022, 0.03], true));
		head.add(eye);
		rig.eyes.push(eye);
		head.add(blob(toon(0xff9fb5), [0.055, 0.03, 0.02], [0.19 * side, -0.07, 0.24], true));
	}
	const beak = part(
		new THREE.ConeGeometry(0.075, 0.17, 10),
		toon(sp.beak),
		[0, -0.05, 0.34],
		[Math.PI / 2, 0, 0],
	);
	beak.scale.set(1, 1, 0.7);
	head.add(beak);

	// Flippers & feet.
	rig.flipMeshL = blob(back, [0.07, 0.29, 0.15], [0.02, -0.24, 0]);
	rig.flipMeshR = blob(back, [0.07, 0.29, 0.15], [-0.02, -0.24, 0]);
	rig.flipL.add(rig.flipMeshL);
	rig.flipR.add(rig.flipMeshR);
	const feet = toon(sp.feet);
	rig.footL.material = feet;
	rig.footR.material = feet;

	addHat(rig, look);
	addNeck(rig, look);
	addGlasses(rig, look);
}

/**
 * @param {number} i
 */
function colorOf(i) {
	return COLORS[i]?.hex ?? 0xf0435a;
}

/**
 * @param {Rig} rig
 * @param {Look} look
 */
function addHat(rig, look) {
	const s = rig.hatSlot;
	const c = toon(colorOf(look.hatColor));
	const white = toon(0xffffff);
	switch (look.hat) {
		case 1: {
			// Beanie with a pom-pom.
			const cap = new THREE.Mesh(
				new THREE.SphereGeometry(0.31, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2),
				c,
			);
			cap.scale.y = 0.85;
			cap.position.y = -0.08;
			cap.castShadow = true;
			s.add(cap);
			s.add(
				part(
					new THREE.TorusGeometry(0.3, 0.055, 8, 24),
					c,
					[0, -0.08, 0],
					[Math.PI / 2, 0, 0],
				),
			);
			s.add(blob(white, [0.09, 0.09, 0.09], [0, 0.2, 0], true));
			break;
		}
		case 2: {
			const black = toon(0x22222a);
			s.rotation.z = 0.12;
			s.add(part(new THREE.CylinderGeometry(0.32, 0.32, 0.03, 24), black, [0, -0.02, 0]));
			s.add(part(new THREE.CylinderGeometry(0.19, 0.2, 0.34, 20), black, [0, 0.16, 0]));
			s.add(part(new THREE.CylinderGeometry(0.205, 0.205, 0.07, 20), c, [0, 0.05, 0]));
			break;
		}
		case 3: {
			s.rotation.z = -0.15;
			s.add(part(new THREE.ConeGeometry(0.16, 0.42, 16), c, [0, 0.17, 0]));
			s.add(
				part(
					new THREE.TorusGeometry(0.13, 0.025, 6, 16),
					white,
					[0, 0.05, 0],
					[Math.PI / 2, 0, 0],
				),
			);
			s.add(blob(toon(0xffe14d), [0.07, 0.07, 0.07], [0, 0.4, 0], true));
			break;
		}
		case 4: {
			const gold = toon(0xffcc33, { emissive: 0x332200 });
			s.add(
				part(new THREE.CylinderGeometry(0.19, 0.2, 0.12, 20, 1, true), gold, [0, 0.02, 0]),
			);
			for (let i = 0; i < 5; i++) {
				const a = (i / 5) * Math.PI * 2;
				s.add(
					part(new THREE.ConeGeometry(0.05, 0.12, 6), gold, [
						Math.sin(a) * 0.19,
						0.13,
						Math.cos(a) * 0.19,
					]),
				);
				s.add(
					blob(
						toon(colorOf(look.hatColor)),
						[0.03, 0.03, 0.03],
						[Math.sin(a) * 0.2, 0.02, Math.cos(a) * 0.2],
						true,
					),
				);
			}
			break;
		}
		case 5: {
			const bow = new THREE.Group();
			bow.position.set(0.16, 0.0, 0.05);
			bow.rotation.z = -0.5;
			bow.add(
				part(new THREE.ConeGeometry(0.09, 0.17, 10), c, [0.09, 0, 0], [0, 0, Math.PI / 2]),
			);
			bow.add(
				part(
					new THREE.ConeGeometry(0.09, 0.17, 10),
					c,
					[-0.09, 0, 0],
					[0, 0, -Math.PI / 2],
				),
			);
			bow.add(blob(c, [0.05, 0.05, 0.05], [0, 0, 0], true));
			s.add(bow);
			break;
		}
		case 6: {
			const steel = toon(0x9aa3b5);
			const cap = new THREE.Mesh(
				new THREE.SphereGeometry(0.32, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2),
				steel,
			);
			cap.position.y = -0.1;
			cap.castShadow = true;
			s.add(cap);
			s.add(
				part(
					new THREE.TorusGeometry(0.31, 0.04, 8, 24),
					c,
					[0, -0.1, 0],
					[Math.PI / 2, 0, 0],
				),
			);
			const horn = toon(0xfff3d6);
			s.add(part(new THREE.ConeGeometry(0.06, 0.3, 10), horn, [0.33, 0.06, 0], [0, 0, -0.9]));
			s.add(part(new THREE.ConeGeometry(0.06, 0.3, 10), horn, [-0.33, 0.06, 0], [0, 0, 0.9]));
			break;
		}
		case 7: {
			const cap = new THREE.Mesh(
				new THREE.SphereGeometry(0.31, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2),
				c,
			);
			cap.position.y = -0.08;
			cap.scale.y = 0.75;
			cap.castShadow = true;
			s.add(cap);
			s.add(
				part(
					new THREE.CylinderGeometry(0.2, 0.2, 0.02, 16, 1, false, 0, Math.PI),
					toon(0xffe14d),
					[0, -0.07, 0.2],
					[0, Math.PI / 2, 0],
				),
			);
			s.add(
				part(
					new THREE.CylinderGeometry(0.015, 0.015, 0.15, 6),
					toon(0x555555),
					[0, 0.22, 0],
				),
			);
			const prop = new THREE.Group();
			prop.position.y = 0.3;
			prop.add(
				part(
					new THREE.BoxGeometry(0.42, 0.015, 0.07),
					toon(0xff4d6d),
					[0, 0, 0],
					[0.25, 0, 0],
				),
			);
			prop.add(
				part(
					new THREE.BoxGeometry(0.07, 0.015, 0.42),
					toon(0x3d7dff),
					[0, 0, 0],
					[0, 0, 0.25],
				),
			);
			s.add(prop);
			rig.spinner = prop;
			break;
		}
		case 8: {
			const flower = new THREE.Group();
			flower.position.set(0.14, 0.02, 0.1);
			flower.rotation.set(0.5, 0, -0.5);
			for (let i = 0; i < 5; i++) {
				const a = (i / 5) * Math.PI * 2;
				flower.add(
					blob(
						c,
						[0.065, 0.025, 0.05],
						[Math.cos(a) * 0.07, 0, Math.sin(a) * 0.07],
						true,
					),
				);
			}
			flower.add(blob(toon(0xffe14d), [0.045, 0.035, 0.045], [0, 0.015, 0], true));
			s.add(flower);
			break;
		}
		default:
			break;
	}
}

/** @type {Map<number, THREE.CanvasTexture>} */
const stripeTex = new Map();

/**
 * @param {number} color
 */
function stripes(color) {
	let tex = stripeTex.get(color);
	if (tex) return tex;
	const cv = document.createElement('canvas');
	cv.width = 64;
	cv.height = 8;
	const g = cv.getContext('2d');
	if (g) {
		g.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
		g.fillRect(0, 0, 64, 8);
		g.fillStyle = '#ffffff';
		for (let i = 0; i < 8; i++) g.fillRect(i * 8, 0, 4, 8);
	}
	tex = new THREE.CanvasTexture(cv);
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.wrapS = THREE.RepeatWrapping;
	tex.wrapT = THREE.RepeatWrapping;
	stripeTex.set(color, tex);
	return tex;
}

/**
 * @param {Rig} rig
 * @param {Look} look
 */
function addNeck(rig, look) {
	const s = rig.neckSlot;
	const color = colorOf(look.scarfColor);
	const c = toon(color);
	if (look.scarf === 1 || look.scarf === 2) {
		/** @type {THREE.Material} */
		let mat = c;
		if (look.scarf === 2) {
			const m = new THREE.MeshToonMaterial({
				map: stripes(color),
				gradientMap: toonGradient(),
			});
			mat = m;
		}
		// A snug knitted scarf (squashed, not a pool ring).
		const ring = part(
			new THREE.TorusGeometry(0.335, 0.06, 10, 32),
			mat,
			[0, 0, 0.0],
			[Math.PI / 2, 0, 0],
		);
		ring.scale.set(1.0, 1.04, 0.72);
		s.add(ring);
		const tail = new THREE.Group();
		tail.position.set(0.17, -0.03, 0.31);
		const piece = part(new THREE.BoxGeometry(0.11, 0.28, 0.04), mat, [0, -0.13, 0]);
		tail.add(piece);
		tail.rotation.z = 0.15;
		s.add(tail);
		rig.sway = tail;
		rig.swayKind = 'tail';
	} else if (look.scarf === 3) {
		const bow = new THREE.Group();
		bow.position.set(0, -0.04, 0.3);
		bow.add(part(new THREE.ConeGeometry(0.07, 0.13, 10), c, [0.07, 0, 0], [0, 0, Math.PI / 2]));
		bow.add(
			part(new THREE.ConeGeometry(0.07, 0.13, 10), c, [-0.07, 0, 0], [0, 0, -Math.PI / 2]),
		);
		bow.add(blob(c, [0.04, 0.04, 0.04], [0, 0, 0.01], true));
		s.add(bow);
	} else if (look.scarf === 4) {
		s.add(
			part(new THREE.TorusGeometry(0.29, 0.035, 8, 24), c, [0, 0.02, 0], [Math.PI / 2, 0, 0]),
		);
		// A cape that wraps the back (an open cone shell), not a flat board.
		const cape = new THREE.Group();
		cape.position.set(0, 0.0, -0.02);
		const geo = new THREE.CylinderGeometry(0.37, 0.56, 0.66, 20, 3, true, Math.PI - 0.95, 1.9);
		geo.translate(0, -0.33, 0);
		const m = new THREE.MeshToonMaterial({
			color,
			gradientMap: toonGradient(),
			side: THREE.DoubleSide,
		});
		const mesh = new THREE.Mesh(geo, m);
		mesh.castShadow = true;
		cape.add(mesh);
		s.add(cape);
		rig.sway = cape;
		rig.swayKind = 'cape';
	}
}

/**
 * @param {Rig} rig
 * @param {Look} look
 */
function addGlasses(rig, look) {
	const s = rig.faceSlot;
	if (look.glasses === 1) {
		const frame = toon(0x3a2a20);
		for (const side of [1, -1]) {
			s.add(
				part(new THREE.TorusGeometry(0.075, 0.014, 6, 20), frame, [
					0.11 * side,
					0.03,
					0.36,
				]),
			);
		}
		s.add(part(new THREE.BoxGeometry(0.08, 0.015, 0.015), frame, [0, 0.05, 0.37]));
	} else if (look.glasses === 2) {
		const dark = toon(0x111118);
		for (const side of [1, -1]) {
			s.add(
				part(
					new THREE.CylinderGeometry(0.085, 0.085, 0.02, 16),
					dark,
					[0.11 * side, 0.03, 0.36],
					[Math.PI / 2, 0, 0],
				),
			);
		}
		s.add(part(new THREE.BoxGeometry(0.34, 0.025, 0.02), dark, [0, 0.07, 0.37]));
	} else if (look.glasses === 3) {
		const geo = starGeometry(0.1, 0.045, 0.02);
		const m = toon(0xff5fa8);
		for (const side of [1, -1]) s.add(part(geo, m, [0.115 * side, 0.03, 0.36]));
		s.add(part(new THREE.BoxGeometry(0.06, 0.02, 0.02), m, [0, 0.05, 0.37]));
	}
}

/**
 * @param {number} outer
 * @param {number} inner
 * @param {number} depth
 */
export function starGeometry(outer, inner, depth) {
	const shape = new THREE.Shape();
	for (let i = 0; i < 10; i++) {
		const r = i % 2 === 0 ? outer : inner;
		const a = Math.PI / 2 + (i / 10) * Math.PI * 2;
		if (i === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
		else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
	}
	shape.closePath();
	const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
	geo.translate(0, 0, -depth / 2);
	return geo;
}

/**
 * @typedef {object} AnimOpts
 * @property {boolean} [celebrate] Winner's dance.
 * @property {boolean} [sad] Knocked-out pout.
 */

/**
 * Pose a penguin for this frame.
 *
 * @param {Rig} rig
 * @param {Penguin} p
 * @param {number} time Seconds.
 * @param {number} dt Seconds.
 * @param {AnimOpts} [opts]
 */
export function animatePenguin(rig, p, time, dt, opts = {}) {
	setLook(rig, p.look);
	const walk = Math.min(1, p.speed / 3.2);
	rig.phase += Math.min(p.speed, 6) * dt * 4.4;
	const ph = rig.phase;

	const body = rig.body;
	body.rotation.set(0, 0, 0);
	body.position.set(0, 0, 0);
	body.scale.set(1, 1 + Math.sin(time * 2.4 + rig.phase * 0.1) * 0.015, 1);

	// Waddle.
	body.rotation.z = Math.sin(ph) * 0.17 * walk;
	body.position.y = Math.abs(Math.sin(ph)) * 0.05 * walk;
	rig.footL.position.y = 0.04 + Math.max(0, Math.sin(ph)) * 0.09 * walk;
	rig.footR.position.y = 0.04 + Math.max(0, -Math.sin(ph)) * 0.09 * walk;
	rig.footL.position.z = 0.13 + Math.sin(ph) * 0.06 * walk;
	rig.footR.position.z = 0.13 - Math.sin(ph) * 0.06 * walk;

	let flapL = 0.22 + Math.sin(ph + 1.5) * 0.2 * walk + Math.sin(time * 2) * 0.04;
	let flapR = flapL;
	let fwdL = 0;
	let fwdR = 0;

	if (p.shoveMs > 0) {
		const k = Math.sin((1 - p.shoveMs / SHOVE_ANIM_MS) * Math.PI);
		fwdL = -1.5 * k;
		fwdR = -1.5 * k;
		flapL = 0.5;
		flapR = 0.5;
		body.rotation.x = 0.3 * k;
	}
	if (p.knockMs > 0 && p.stunMs <= 0 && p.slideMs <= 0) {
		flapL = 1.5 + Math.sin(time * 30) * 0.4;
		flapR = 1.5 + Math.sin(time * 30 + 1) * 0.4;
		body.rotation.x = -0.2;
	}
	if (p.teeterMs > 0 && p.mode === 'play') {
		// Whoa-whoa-whoa: windmilling flippers, leaning back from the edge.
		flapL = 1.4 + Math.sin(time * 26) * 0.6;
		flapR = 1.4 + Math.sin(time * 26 + Math.PI) * 0.6;
		fwdL = Math.sin(time * 26) * 0.8;
		fwdR = -Math.sin(time * 26) * 0.8;
		body.rotation.x = -0.25 + Math.sin(time * 18) * 0.12;
	}
	rig.stars.visible = p.stunMs > 0 && p.mode === 'play';
	if (rig.stars.visible) {
		rig.stars.rotation.y = time * 5;
		body.rotation.z = Math.sin(time * 7) * 0.16;
		flapL = 0.6;
		flapR = 0.6;
	}
	if (p.slideMs > 0) {
		body.rotation.x = 1.3;
		body.position.y = 0.32;
		body.position.z = -0.1;
		flapL = 1.2;
		flapR = 1.2;
		fwdL = 1.2;
		fwdR = 1.2;
	}
	if (p.mode === 'fall') {
		flapL = 1.0 + Math.sin(time * 28) * 0.7;
		flapR = 1.0 + Math.sin(time * 28 + 2) * 0.7;
		body.rotation.x = -0.35;
	}
	if (p.mode === 'respawn' && p.z > 0.15) {
		flapL = 1.3 + Math.sin(time * 18) * 0.5;
		flapR = 1.3 + Math.sin(time * 18 + 1) * 0.5;
		rig.footL.position.y = -0.05;
		rig.footR.position.y = -0.05;
	}
	if (opts.celebrate) {
		const hop = Math.abs(Math.sin(time * 6));
		body.position.y = hop * 0.45;
		rig.footL.position.y = 0.04 + hop * 0.45;
		rig.footR.position.y = 0.04 + hop * 0.45;
		flapL = 1.8 + Math.sin(time * 12) * 0.5;
		flapR = 1.8 + Math.sin(time * 12 + Math.PI) * 0.5;
		body.rotation.z = Math.sin(time * 3) * 0.12;
	}
	if (opts.sad) {
		body.rotation.x = 0.25;
		flapL = 0.1;
		flapR = 0.1;
	}

	rig.flipL.rotation.set(fwdL, 0, flapL);
	rig.flipR.rotation.set(fwdR, 0, -flapR);
	const mega = p.megaMs > 0 ? 1.65 : 1;
	rig.flipMeshL.scale.set(0.07 * mega, 0.29 * mega, 0.15 * mega);
	rig.flipMeshR.scale.set(0.07 * mega, 0.29 * mega, 0.15 * mega);
	rig.flipMeshL.position.y = -0.24 * mega;
	rig.flipMeshR.position.y = -0.24 * mega;
	rig.handBall.visible = p.power === 'snowball' && p.mode === 'play';
	rig.handBall.position.y = -0.52 * mega;

	// Blink (or dizzy squint).
	rig.blinkAt -= dt;
	let eyeY = 1;
	if (rig.blinkAt < 0) {
		eyeY = 0.12;
		if (rig.blinkAt < -0.12) rig.blinkAt = 2 + Math.random() * 3;
	}
	if (rig.stars.visible || opts.sad) eyeY = 0.35;
	if (opts.celebrate) eyeY = 0.5 + Math.abs(Math.sin(time * 3)) * 0.5;
	for (const e of rig.eyes) e.scale.y = eyeY;

	if (rig.spinner) rig.spinner.rotation.y += dt * (7 + p.speed * 5);
	if (rig.sway) {
		const run = Math.min(1, p.speed / 4);
		const flutter = Math.sin(time * 6 + rig.phase);
		if (rig.swayKind === 'cape') {
			// Flares out behind as you run.
			rig.sway.rotation.x = 0.06 + run * 0.65 + flutter * (0.04 + run * 0.08);
		} else {
			// The scarf end flips up and out in front, never into the chest.
			rig.sway.rotation.x = -0.08 - run * 0.5 + flutter * 0.08;
			rig.sway.rotation.z = 0.15 + flutter * 0.05 * run;
		}
	}

	// Blink out while invulnerable after dropping back in.
	rig.root.visible = !(p.invulnMs > 0 && p.mode === 'play' && Math.floor(time * 12) % 2 === 0);
}
