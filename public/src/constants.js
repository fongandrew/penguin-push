/**
 * Tuning knobs. World units are roughly "one penguin is a metre tall"; the
 * ground is the x/y plane (y grows toward the camera), height is z.
 */

/** Fixed simulation step, seconds. */
export const STEP = 1 / 60;

export const MAX_PENGUINS = 4;
export const START_LIVES = 5;
export const MAX_LIVES = 9;

/** Penguin body radius for collisions. */
export const PENGUIN_R = 0.42;
/** Top walking speed, units/s. */
export const WALK_SPEED = 4.4;
/** How fast a penguin reaches walking speed (units/s²). Ice: not instant. */
export const WALK_ACCEL = 20;
/** Velocity damping per second when nobody's steering. Low = slippery. */
export const ICE_DRAG = 2.4;
/** Even slipperier on the shiny patches. */
export const SLICK_DRAG = 0.5;
/** How long a knock leaves you mostly out of control, ms. */
export const KNOCK_MS = 420;
/** Hill pull on penguins (they slide down slopes a little). */
export const PENGUIN_GRAVITY = 3.2;

/** Flipper shove. */
export const SHOVE_RANGE = 1.35;
export const SHOVE_CONE = 1.1; // radians either side of facing
export const SHOVE_POWER = 9.5;
export const SHOVE_COOLDOWN_MS = 520;
export const SHOVE_ANIM_MS = 260;
export const MEGA_FACTOR = 1.75;
export const MEGA_MS = 9000;

/** Body bump when two penguins run into each other. */
export const BUMP_POWER = 2.2;
export const BUMP_COOLDOWN_MS = 300;

/** Belly slide (fish power). */
export const SLIDE_SPEED = 10.5;
export const SLIDE_MS = 650;
export const SLIDE_HIT = 12;
export const SLIDE_USES = 3;

/** Snowballs (fish power). */
export const SNOWBALL_USES = 3;
export const SNOWBALL_SPEED = 12;
export const SNOWBALL_RANGE = 10;
export const SNOWBALL_R = 0.22;
export const STUN_MS = 1600;

/** Falling in, coming back. */
export const FALL_MS = 1200;
export const RESPAWN_MS = 1000;
export const RESPAWN_HEIGHT = 7;
export const INVULN_MS = 1600;

/** Giant snowballs on Snowball Hill. */
export const BALL_R = 0.95;
export const BALL_KICK_SPEED = 4.2;
export const BALL_GRAVITY = 10;
export const BALL_DRAG = 0.18;
export const BALL_HIT = 15;
export const BALL_GONE_MS = 900;
export const BALL_RESPAWN_MS = 5000;
export const BALL_MAX_ROLL_MS = 9000;

/** Power-up jars. */
export const JAR_FIRST_MS = 2500;
export const JAR_EVERY_MS = 4200;
export const JAR_LIFE_MS = 15000;
export const JAR_R = 0.55;

/** Sudden death: the ice starts cracking off. */
export const SHRINK_START_MS = 90000;
export const SHRINK_END_MS = 150000;
export const SHRINK_MIN = 0.16;
/** Snow walls crumble a little after sudden death starts (no hiding forever). */
export const WALLS_CRUMBLE_MS = SHRINK_START_MS + 8000;

/** Pre-match countdown. */
export const COUNTDOWN_MS = 3200;
/** Winner dance before the leaderboard. */
export const CELEBRATE_MS = 3800;

/** One colour per roster position: rings, HUD cards, name tags. */
export const PLAYER_COLORS = ['#ff5d73', '#3fa7ff', '#ffc21a', '#4fd67a'];

/** Names for computer penguins, by bot index. */
export const BOT_NAMES = ['Pebble', 'Waddles', 'Sprinkles'];
