// MIRRORFALL — simulation rule constants.
// Single source of truth for every number the game rules depend on.
// Pure data: no DOM, no time, no randomness.

export const GRID_W = 30;
export const GRID_H = 17;
export const TILE_PX = 32;
export const CELLS = GRID_W * GRID_H;

export const TICK_HZ = 60;
export const LOOP_TICKS = 1800;          // 30 s per loop
export const MAX_GHOSTS = 4;
export const MAX_RUNNERS = MAX_GHOSTS + 1;

// Sub-units: positions are integers, 1 tile = 24 SU.
export const SU = 24;
export const HALF_SU = 12;
export const RUNNER_SPEED = 3;           // SU per tick → 8 ticks per tile
export const GUARD_SPEED = 2;            // SU per tick → 12 ticks per tile
export const PLATFORM_SPEED = 3;         // SU per tick → 8 ticks per tile
export const MOVE_TICKS = SU / RUNNER_SPEED;

// Input bit mask (5 bits per tick).
export const IN_U = 1, IN_D = 2, IN_L = 4, IN_R = 8, IN_A = 16;
export const IN_DIRS = IN_U | IN_D | IN_L | IN_R;
export const INPUT_BITS = 5;

// Cardinal directions, index order matches the input bit order.
export const DIR_U = 0, DIR_D = 1, DIR_L = 2, DIR_R = 3;
export const DX4 = [0, 0, -1, 1];
export const DY4 = [-1, 1, 0, 0];
export const DIR_BITS = [IN_U, IN_D, IN_L, IN_R];
export const DIR_NAMES = ['U', 'D', 'L', 'R'];

// Detection.
export const ALARM_TICKS = 24;           // 0.4 s continuously seen → alarm
export const SUSP_DECAY = 4;             // per unseen tick
export const GUARD_RANGE_SU = 6 * SU;    // 6 tiles
export const GUARD_COS2_K = 671;         // cos²(35°)·1000 → 70° cone
export const CAMERA_RANGE_SU = 7 * SU;
export const CAMERA_COS2_K = 821;        // cos²(25°)·1000 → 50° cone
export const LOS_STEP_SU = 6;            // line-of-sight sampling step

// Coins / noise.
export const MAX_COINS_CARRIED = 3;
export const COIN_THROW_TILES = 4;
export const COIN_FLIGHT_TICKS = 16;
export const COIN_SLOTS = 4;
export const COIN_LANDED_TICKS = 180;
export const NOISE_RADIUS = 9;           // path distance in tiles
export const GUARD_LOOK_TICKS = 120;     // investigation look-around
export const GUARD_LOOK_TURN = 30;

// Duo vault.
export const VAULT_HOLD_TICKS = 30;

// Tile types (static map).
export const T_FLOOR = 0;
export const T_WALL = 1;
export const T_CHASM = 2;
export const T_DOOR = 3;
export const T_VAULT = 4;

// Static object kinds stored per cell (objAt grid).
export const O_NONE = 0;
export const O_SPAWN = 1;
export const O_EXIT = 2;
export const O_LOOT = 3;
export const O_COIN = 4;
export const O_PLATE = 5;
export const O_SWITCH = 6;
export const O_TERMINAL = 7;

// World status.
export const ST_RUNNING = 0;
export const ST_WON = 1;
export const ST_CAUGHT = 2;     // live runner failed → alarm
export const ST_PARADOX = 3;    // a ghost failed or diverged
export const ST_TIMEOUT = 4;    // loop ran out (live run becomes a ghost)

// Failure reasons.
export const FAIL_NONE = 0;
export const FAIL_GUARD = 1;
export const FAIL_CAMERA = 2;
export const FAIL_LASER = 3;
export const FAIL_FELL = 4;
export const FAIL_DIVERGED = 5;

// Guard modes.
export const GM_PATROL = 0;
export const GM_INVESTIGATE = 1;
export const GM_LOOK = 2;
export const GM_RETURN = 3;

// Event codes (emitted per step for audio/visual feedback, never hashed).
export const EV_DOOR_OPEN = 1;
export const EV_DOOR_CLOSE = 2;
export const EV_PLATE_ON = 3;
export const EV_PLATE_OFF = 4;
export const EV_SWITCH = 5;
export const EV_COIN_PICK = 6;
export const EV_COIN_THROW = 7;
export const EV_COIN_LAND = 8;
export const EV_GUARD_HEAR = 9;
export const EV_LOOT_PICK = 10;
export const EV_VAULT_OPEN = 11;
export const EV_CAUGHT = 12;
export const EV_PARADOX = 13;
export const EV_WIN = 14;
export const EV_STEP = 15;
export const EV_LASER_ON = 16;
export const EV_PLATFORM_GO = 17;
export const EV_TERMINAL = 18;
export const EV_SPOTTED = 19;   // suspicion started rising on a runner
export const EV_BUMP = 20;

// Entity limits (keep the state small and the editor honest).
export const LIMITS = {
  guards: 6, cameras: 4, lasers: 10, doors: 24, switches: 8, plates: 16,
  coins: 8, platforms: 4, terminals: 2, channels: 8,
};
