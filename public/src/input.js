/**
 * Controls. Phones: a floating virtual stick (put your thumb down anywhere on
 * the left/middle of the screen and drag) plus big Push and Power buttons.
 * Keyboards: WASD/arrows to move, Space to push, Shift/E to use a power.
 */

/** @typedef {import('./state.js').Input} Input */

const STICK_R = 56;

export class Controls {
	/**
	 * @param {object} els
	 * @param {HTMLElement} els.pad Touch surface for the stick.
	 * @param {HTMLElement} els.stick Ring drawn where the thumb landed.
	 * @param {HTMLElement} els.knob
	 * @param {HTMLElement} els.push
	 * @param {HTMLElement} els.power
	 */
	constructor(els) {
		this.els = els;
		/** @type {Set<string>} */
		this.keys = new Set();
		this.stick = { id: -1, ox: 0, oy: 0, x: 0, y: 0 };
		this.shove = false;
		this.power = false;
		this.enabled = false;

		addEventListener('keydown', (e) => {
			if (e.target instanceof HTMLInputElement) return;
			this.keys.add(e.code);
			if (!this.enabled) return;
			if (e.code === 'Space' || e.code === 'KeyJ') {
				this.shove = true;
				e.preventDefault();
			}
			if (
				e.code === 'ShiftLeft' ||
				e.code === 'ShiftRight' ||
				e.code === 'KeyE' ||
				e.code === 'KeyK'
			) {
				this.power = true;
			}
		});
		addEventListener('keyup', (e) => this.keys.delete(e.code));
		addEventListener('blur', () => this.keys.clear());

		const { pad, push, power } = els;
		pad.addEventListener('pointerdown', (e) => {
			if (this.stick.id !== -1) return;
			this.stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: 0, y: 0 };
			pad.setPointerCapture?.(e.pointerId);
			this.drawStick(true);
			e.preventDefault();
		});
		pad.addEventListener('pointermove', (e) => {
			if (e.pointerId !== this.stick.id) return;
			let dx = e.clientX - this.stick.ox;
			let dy = e.clientY - this.stick.oy;
			const d = Math.hypot(dx, dy);
			// Drag past the rim and the ring follows the thumb.
			if (d > STICK_R) {
				this.stick.ox += (dx / d) * (d - STICK_R);
				this.stick.oy += (dy / d) * (d - STICK_R);
				dx = (dx / d) * STICK_R;
				dy = (dy / d) * STICK_R;
			}
			this.stick.x = dx / STICK_R;
			this.stick.y = dy / STICK_R;
			this.drawStick(true);
		});
		const end = (/** @type {PointerEvent} */ e) => {
			if (e.pointerId !== this.stick.id) return;
			this.stick = { id: -1, ox: 0, oy: 0, x: 0, y: 0 };
			this.drawStick(false);
		};
		pad.addEventListener('pointerup', end);
		pad.addEventListener('pointercancel', end);

		const tap = (/** @type {HTMLElement} */ el, /** @type {() => void} */ fn) => {
			el.addEventListener('pointerdown', (e) => {
				e.preventDefault();
				e.stopPropagation();
				el.classList.add('down');
				fn();
			});
			const up = () => el.classList.remove('down');
			el.addEventListener('pointerup', up);
			el.addEventListener('pointercancel', up);
			el.addEventListener('pointerleave', up);
		};
		tap(push, () => (this.shove = true));
		tap(power, () => (this.power = true));
	}

	/** @param {boolean} on */
	drawStick(on) {
		const { stick, knob } = this.els;
		stick.hidden = !on;
		if (!on) return;
		stick.style.transform = `translate(${this.stick.ox}px, ${this.stick.oy}px)`;
		knob.style.transform = `translate(${this.stick.x * STICK_R}px, ${this.stick.y * STICK_R}px)`;
	}

	/**
	 * This frame's input. Button presses are edges: read once, then cleared.
	 *
	 * @returns {Input}
	 */
	read() {
		let mx = this.stick.x;
		let my = this.stick.y;
		const k = this.keys;
		if (k.has('KeyA') || k.has('ArrowLeft')) mx -= 1;
		if (k.has('KeyD') || k.has('ArrowRight')) mx += 1;
		if (k.has('KeyW') || k.has('ArrowUp')) my -= 1;
		if (k.has('KeyS') || k.has('ArrowDown')) my += 1;
		const m = Math.hypot(mx, my);
		if (m > 1) {
			mx /= m;
			my /= m;
		}
		if (m < 0.12) {
			mx = 0;
			my = 0;
		}
		const out = { mx, my, shove: this.shove, power: this.power };
		this.shove = false;
		this.power = false;
		if (!this.enabled) return { mx: 0, my: 0, shove: false, power: false };
		return out;
	}

	/** @param {boolean} on */
	setEnabled(on) {
		this.enabled = on;
		if (!on) {
			this.stick = { id: -1, ox: 0, oy: 0, x: 0, y: 0 };
			this.drawStick(false);
			this.shove = false;
			this.power = false;
		}
	}
}
