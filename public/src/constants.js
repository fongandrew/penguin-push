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
/** How fast a penguin reaches walking speed (units/s²). */
export const WALK_ACCEL = 34;
/** Grip when you're walking or standing: let go and you stop in ~0.3 s. */
export const GRIP_DRAG = 9;
/** Sideways grip while steering, so turns are tight (per second). */
export const TURN_GRIP = 10;
/** Drag while you've been shoved and are sliding faster than you can walk. */
export const ICE_DRAG = 2.4;
/** Polished tiles: properly slippery. */
export const SLICK_DRAG = 0.9;
/** Stick directions this close to a grid axis snap to it (radians). */
export const AXIS_SNAP = 0.25;
/** How firmly walking straight centres you in your row/column. */
export const LANE_ASSIST = 5;
/** How long a knock leaves you mostly out of control, ms. */
export const KNOCK_MS = 420;

/** Flipper shove. */
export const SHOVE_RANGE = 1.6;
export const SHOVE_CONE = 1.25; // radians either side of facing
/** Within this of dead ahead the shove is full strength; it tapers to SHOVE_EDGE at the cone's edge. */
export const SHOVE_FULL = 0.45;
export const SHOVE_EDGE = 0.55;
/** Nobody ahead but someone close at your side (within this angle)? Turn to slap them. */
export const SHOVE_TURN = 2.2;
/** A press during the cooldown is remembered (as long as the cooldown), then fires. */
export const SHOVE_BUFFER_MS = 400;
/** A shove from a standstill: a nudge, about a tile. */
export const SHOVE_POWER = 4.5;
/** Extra shove per unit of closing speed: run in to really send them. */
export const SHOVE_RUN = 1.4;
export const SHOVE_COOLDOWN_MS = 400;
export const SHOVE_ANIM_MS = 260;
export const MEGA_FACTOR = 1.75;
export const MEGA_MS = 9000;

/** Body bump when two penguins run into each other. */
export const BUMP_POWER = 0.9;
export const BUMP_COOLDOWN_MS = 300;

/** A thrown fish (fish power): one throw, a big knock-back, no stun. */
export const FISH_HIT = 10.5;
export const FISH_USES = 1;

/** Snowballs (fish power). */
export const SNOWBALL_USES = 3;
export const SNOWBALL_SPEED = 12;
export const SNOWBALL_RANGE = 10;
export const SNOWBALL_R = 0.22;
export const STUN_MS = 1600;

/**
 * Walking (not shoved) to the edge, a penguin teeters instead of falling
 * straight in. Keep pushing toward the water this long and in you go.
 */
export const TEETER_MS = 450;

/** Falling in, coming back. */
export const FALL_MS = 1200;
export const RESPAWN_MS = 1000;
export const RESPAWN_HEIGHT = 7;
export const INVULN_MS = 1600;

/** Giant snowballs on Snowball Hill. */
export const BALL_R = 0.95;
export const BALL_KICK_SPEED = 3.6;
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
export const SHRINK_START_MS = 75000;
export const SHRINK_END_MS = 130000;
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
