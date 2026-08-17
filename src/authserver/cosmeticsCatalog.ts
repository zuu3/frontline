import { ColorPaletteSchema, Cosmetics } from "../core/CosmeticSchemas";
import { z } from "zod/v4";

// Original tiling patterns, not copied from OpenFront's proprietary catalog
// (see LICENSE-ASSETS: premium skins/patterns accessed via API are
// explicitly excluded from the open-source license and are not ours to
// use). Encoded with the same open-source PatternDecoder format
// (src/core/PatternDecoder.ts) but new content: 24x24, scale 2, generated
// by a small script -- textile/heraldic motifs (herringbone, houndstooth,
// argyle, etc.) rather than plain stripes/dots, since a pattern tiles
// across a whole territory shape and a bold woven motif reads much better
// repeated than a flat geometric primitive does.
//
// product: null on every entry -- no real-money purchase, no payment
// backend. priceSoft (tiered by rarity: common 300, uncommon 600, rare
// 1200, epic 2500) is paid in soft currency, earned for free by winning
// games (25/win, see /game/:gameId in AuthServer.ts) and spent via
// /shop/purchase, which grants the matching "pattern:<name>" flare on
// success. See src/client/Cosmetics.ts's
// cosmeticRelationship()/patternRelationship() for how flares/price/product
// combine into owned vs purchasable vs blocked, and note every pattern
// below references at least one colorPalette -- patternRelationship()'s
// colorPalette === null branch never checks price at all, so a
// palette-less priced pattern is silently unreachable in the store grid.
const COLOR_PALETTES: Record<string, z.infer<typeof ColorPaletteSchema>> = {
  crimson: { name: "crimson", primaryColor: "#8b1e1e", secondaryColor: "#e8c4c4" },
  ocean: { name: "ocean", primaryColor: "#1e4d8b", secondaryColor: "#c4dde8" },
  forest: { name: "forest", primaryColor: "#1e6b3a", secondaryColor: "#c9e8c4" },
  sunset: { name: "sunset", primaryColor: "#c9701e", secondaryColor: "#f5dcae" },
  royal: { name: "royal", primaryColor: "#4a1e8b", secondaryColor: "#d8c4e8" },
  monochrome: { name: "monochrome", primaryColor: "#2a2a2a", secondaryColor: "#e0e0e0" },
};
const PALETTE_NAMES = Object.keys(COLOR_PALETTES).map((name) => ({
  name,
  isArchived: false,
}));

const PRICE_BY_RARITY = { common: 300, uncommon: 600, rare: 1200, epic: 2500 } as const;

function pattern(
  name: string,
  rarity: keyof typeof PRICE_BY_RARITY,
  data: string,
) {
  return {
    name,
    product: null,
    rarity,
    priceSoft: PRICE_BY_RARITY[rarity],
    colorPalettes: PALETTE_NAMES,
    pattern: data,
  };
}

// Sorted by rarity tier (common -> uncommon -> rare -> epic) so the catalog
// source matches the intended store ordering.
const PATTERNS: Cosmetics["patterns"] = {
  // -- common (300) --
  // Kept from the original procedural textile batch -- the rest (plain
  // stripes/dots/noise-style ones) were pruned as low quality now that
  // illustrated patterns exist below for comparison.
  trellis: pattern(
    "trellis",
    "common",
    "ALJYwzAM53mePM_zGIZhPM_z53mewzAM53mePM_zGIZhPM_z53mewzAM53mePM_zGIZhPM_z53mewzAM53mePM_zGIZhPM_z53me",
  ),
  herringbone: pattern(
    "herringbone",
    "common",
    "ALJYgYGBQkJCJCQkGBgYGBgYJCQkQkJCgYGBgYGBQkJCJCQkGBgYGBgYJCQkQkJCgYGBgYGBQkJCJCQkGBgYGBgYJCQkQkJCgYGB",
  ),
  houndstooth: pattern(
    "houndstooth",
    "common",
    "ALJYS0tLh4eHHh4eLS0ttLS0eHh44eHh0tLSS0tLh4eHHh4eLS0ttLS0eHh44eHh0tLSS0tLh4eHHh4eLS0ttLS0eHh44eHh0tLS",
  ),
  diamond_rings: pattern(
    "diamond_rings",
    "common",
    "ALJYM8PMmZmZzDwzZmZmM8PMmZmZzDwzZmZmM8PMmZmZzDwzZmZmZmZmzDwzmZmZM8PMZmZmzDwzmZmZM8PMZmZmzDwzmZmZM8PM",
  ),
  camo: pattern(
    "camo",
    "common",
    "ALJYBAAABgAABgAABjgABnwABxwAAYCBAMBHOOBhfPgAPnwAezyAHxyAHwyAHwCAGECA-OCH-ODDMMDDHwDgDwDwDwD0DhwHDAgA",
  ),

  // -- uncommon (600) --
  miners_pick: pattern("miners_pick", "uncommon", "ANBo__8B8P8B4MMHgD8eAP7zAPC_B8D_PwD-_wHw_w-A_38A_P8H4P8_AP__A3j_H8Dz_wEe_x_w8P-Bf_0P_N__4P_1D_5___D_14____n4_x_P___j_P9_7P__j_7__-H__z8"),
  travelers_boot: pattern("travelers_boot", "uncommon", "ALB4P4D_HwD-D3_8D__5D__zD__zD_7zD_zxDwDwD-D5D_j9D_j-D3z_D7z_D97_D-7_D-7_B_b_B_D_A_D_A-D_AcD_AQD_AQD8_gCA_AMAgA8AAHwA__D__4f__x8A_38A"),
  all_seeing: pattern("all_seeing", "uncommon", "AMBg_wP__w_8_w_D_z8M___8_P_z8__DD_8PP_w___P__M__8D_8w__wzwDMPwMw_8AP_AM_8APPAw88DzzDD_MMP8zwADzAA_DA__8P__8_AAAAAAAAAA"),
  rock_on: pattern("rock_on", "uncommon", "ALBwP8D_P8D_P88AP88AP888P888P888P888Pw88Pw88AP8_AP8_PM88PM88_P8__P8_8P8_8P8_8_8_8_8_w_8_w_8_D_8PD_8PPwDAPwDAP__PP__PPwDAPwDA"),

  // -- rare (1200) --
  // Illustrated icon patterns below: converted (alpha/luminance threshold or
  // ordered dithering, see /root/packs/pattern_encode.py on the host) from
  // four CC0 1.0 Universal source packs, license verified on each itch.io
  // page before use:
  //   - "1-Bit Icons" by thkaspar (https://thkaspar.itch.io/1-bit-icons)
  //   - "1-bit Pixel Icons" by Nikoichu (https://nikoichu.itch.io/pixel-icons)
  //   - "Pet Cats Pack" by LuizMelo (https://luizmelo.itch.io/pet-cat-pack)
  // CC0 dedicates the source art to the public domain -- no attribution
  // required, but named here for provenance.
  excalibur: pattern("excalibur", "rare", "AKh0_v9__v-__v_f_v_v_v_3_v_7_v_9_v_-_n___j___p___o___o___of__qf_nJf_pod_26e_87e__7ef_5c__Kf__rd__7ff_7f3_7f9_zf__9f__-f___cB"),
  elixir_flask: pattern("elixir_flask", "rare", "AOBwwPz_P9j-_w-7__9j9___7Pb_v9H7_z_4_f8H__7_In__v4W__5_A3_-_4e__3_D3_2_4-_83_P3_G_7-_w1___-Gv_9_w9__v-Hv_9_w9_9v-Pv_N_z-_xt-__8N3___xvf_f__9_7-___-f5___Hw4"),
  evil_cackle: pattern("evil_cackle", "rare", "ALBYDwDwDwDww__Dw__D8P8P8P8PPP88PP88PDw8PDw8_P8__P8_PAA8PAA8PAA8PAA8_AA__AA_8P8P8P8Pw__Dw__DDwDwDwDw"),
  uh_oh: pattern("uh_oh", "rare", "ALBg_wP8_wP8__D8__D8Pzz8Pzz8Pz_8Pz_8P__wP__wA_zzA_zz8PAD8PAD_P8w_P8w_AM8_AM8_P8__P8_8P8P8P8Pw__Dw__DDwDwDwDw"),

  // -- epic (2500) --
  sly_fox: pattern("sly_fox", "epic", "AKBY_v8x_x-M_wHDH8AAADAAAAwAAMMDwHAAIBwACAcAhAEAYcB_EPgzDP_Pwn938f-7_P8d__-O_3_m_z_y_z_4_z_4"),
  lonely_heart: pattern("lonely_heart", "epic", "ANBYD_wDPwAPwAFgABgAAIBgAAAADwAA8AAAAAYAAAAAAAAAAAAAAAAAAAAAAQAAGAAAgAMAADwAAMAHAAD-AADwHwCA_wMA_H8A4P8PAP__A_z___D_"),
  fluffy_nap: pattern("fluffy_nap", "epic", "AIjp_________________________________________________________d______13_9____f__3____f93V_____3Vd_____9_V3f___________3_d3f3____3______9fFV39____f_X3____39Vd_____19d_f___13V1f____93d______d1f3_____f______f1VH9____________393d____________f9Xd_f___________9_d3f____________9XVd3_____________3V31______93____f1VV_f___________9XdVf3_____f_f__39VVVX9______X___9f3V3V____V1V1____V1VV1f___1VV____V1VVVfX_f3VVVff__1VVVVX9_39dVfX__99VVVVV__9fV1V1_39VVVVV1f__11VV___fXV1V3fX__________________________________________________w8"),
  tabby_trot: pattern("tabby_trot", "epic", "ABjS__________________________________________________________________________________________X_____________________Vf________9f__________9H_f_______19V_f_______1VV________f1X1________RAT8______9fVdX_______9XVfT__39VVVVVff___09ERERExf___1VVVVX1_f__V1VVVVX1____VVVVVX_9__9fRERERNX___9XVVVVd____39VVVVV1f___19VVVV9_____0VERERV____f1VVVfX3____V1VVVVX9____VXVX1f____9fRFREVPX___9XVVdVf____39VRVRV1f___19VVVd9_f___0UEUEVV____V9VfVXX1____VPVHVFX9__9fVX9V1dX__0_kxA9cfPT__1Vd_dVXV___f8RXf3T11f__VX_1V19d_f9fxE_8wMVH__9X_dVffXX1_____9VfVF_9____f_VX__f_____R35AffX_____________________________________________________________________Pw"),

  // -- custom (100) --
  // BSSM (Busan Software Meister High School) logo skins, requested by the
  // server owner (their own school) -- fixed price 100 outside the rarity
  // tiers above, so not routed through pattern()'s PRICE_BY_RARITY lookup.
  // Encoded from the school's own public logo assets (Wikimedia Commons /
  // school YouTube channel), alpha-threshold (no dither) at 48x48/64x64 so
  // the ring/wordmark stay crisp instead of dissolving into dither noise.
  bssm_badge: {
    name: "bssm_badge",
    product: null,
    rarity: "common",
    priceSoft: 100,
    colorPalettes: PALETTE_NAMES,
    pattern:
      "AHC5__8DgP___38AAP7__x8AAPj__wcAAOD__wMAAMD__wAAAAD_fwAAAAD-PwAAAAD8HwAAAAD4HwDgDwD4DwD8PwDwBwD__wDgB8Cf8QPgA-AP8AfAA_AP4A_AAfAP8A-AAfif-R-AAciTATCAAIwDADAAAIwDADAAAA4AwHEAAA4AwHEAAI4jxHEAAI4jxHEAAA4gBHAAAA5gBnAAAB7wD3gAAP7__38AAAYoAGAAAARAACAAAAQBACAAAQAAACCAAfgEYBuAAXAAAA6AA3AAAA7AA2AAEAbAB8D__wPgBwD__wDgDwD__wDwHwAAAAD4HwAAAAD4PwAAAAD8PwAAAAD8PwAAAAD4HwAAAAD4DwAAAADw_wMAAMD__wMAAMD_",
  },
  bssm_wordmark: {
    name: "bssm_wordmark",
    product: null,
    rarity: "common",
    priceSoft: 100,
    colorPalettes: PALETTE_NAMES,
    pattern:
      "APD5_______________________________________________________________________________________________________________________________________________7v___________________qqv-_________________6q7_v________________-qq_7_________________-______________________________f9_93d_8_-q-iq6qq_n_9X9X_VVX9v_gPiKuqqv5__V_V__V__z-qKqq7-r_-f1VVXf31X_2_iAiMqui__n9VFV3_9X__P7oLLrr6v_5__R9f__Vf_b_4Dw766L_-f_0fX__1f_8_-g8--vq__n_dRV_81V39v4gIPvyoqv5_VRV__VVV__-qij_-q6r-__________________________________________________________________________________________________________________________________________________________________________________________________________________________________________8",
  },
};

// Effects: animated recolors (trails/structures/warship/detonations), a
// separate cosmetic category from patterns. Not copied from OpenFront's
// catalog -- same reasoning as the patterns above (LICENSE-ASSETS excludes
// their premium API-delivered content) -- original color palettes/names
// against the same open-source schema (src/core/CosmeticSchemas.ts). No
// image assets involved: every value here is plain color/number data
// consumed directly by the existing shader (WebGLFrameBuilder.ts,
// FxShockwavePass.ts) and store-card preview (EffectPreview.ts) --
// both already fully built and previously unpopulated (this file had no
// `effects` key at all).
function effect<T>(
  name: string,
  effectType: string,
  rarity: keyof typeof PRICE_BY_RARITY,
  attributes: T,
) {
  return {
    name,
    product: null,
    rarity,
    priceSoft: PRICE_BY_RARITY[rarity],
    effectType,
    attributes,
  };
}

const EFFECTS: Cosmetics["effects"] = {
  transportShipTrail: {
    ocean_current: effect("ocean_current", "transportShipTrail", "common", {
      type: "gradient",
      colors: ["#0077b6", "#00b4d8", "#90e0ef"],
      colorSize: 3,
      movementSpeed: 2,
    }),
    toxic_drift: effect("toxic_drift", "transportShipTrail", "common", {
      type: "gradient",
      colors: ["#39ff14", "#0d9d58", "#065f36"],
      colorSize: 3,
      movementSpeed: 2,
    }),
    sunset_wake: effect("sunset_wake", "transportShipTrail", "common", {
      type: "gradient",
      colors: ["#ff6b35", "#f7931e", "#ffd23f"],
      colorSize: 3,
      movementSpeed: 2,
    }),
    molten_wake: effect("molten_wake", "transportShipTrail", "uncommon", {
      type: "gradient",
      colors: ["#ff0000", "#ff8c00", "#ffd700"],
      colorSize: 3,
      movementSpeed: 3,
    }),
    aurora_wake: effect("aurora_wake", "transportShipTrail", "uncommon", {
      type: "gradient",
      colors: ["#00f5d4", "#9b5de5", "#f15bb5"],
      colorSize: 4,
      movementSpeed: 3,
    }),
    royal_wake: effect("royal_wake", "transportShipTrail", "rare", {
      type: "gradient",
      colors: ["#7209b7", "#f72585", "#ffd60a"],
      colorSize: 3,
      movementSpeed: 3,
    }),
    prism_wake: effect("prism_wake", "transportShipTrail", "rare", {
      type: "gradient",
      colors: [
        "#ff0000", "#ff8700", "#ffd300", "#a1ff0a", "#0aefff", "#147df5", "#be0aff",
      ],
      colorSize: 4,
      movementSpeed: 4,
    }),
    solar_flare: effect("solar_flare", "transportShipTrail", "epic", {
      type: "gradient",
      colors: ["#fff700", "#ff9900", "#ff3d00", "#ffffff"],
      colorSize: 3,
      movementSpeed: 5,
    }),
  },
  nukeTrail: {
    contrail: effect("contrail", "nukeTrail", "common", {
      type: "gradient",
      colors: ["#e0e0e0", "#ffffff", "#b0c4de"],
      colorSize: 3,
      movementSpeed: 2,
    }),
    inferno_trail: effect("inferno_trail", "nukeTrail", "uncommon", {
      type: "gradient",
      colors: ["#ff0000", "#ff8c00", "#ffff00"],
      colorSize: 3,
      movementSpeed: 3,
    }),
    void_trail: effect("void_trail", "nukeTrail", "rare", {
      type: "gradient",
      colors: ["#3a0ca3", "#000000", "#4361ee"],
      colorSize: 3,
      movementSpeed: 3,
    }),
    gale_vortex: effect("gale_vortex", "nukeTrail", "rare", {
      type: "spiral",
      colors: ["#00f5d4", "#0aefff", "#9b5de5"],
      radius: 2,
      strands: 4,
      rotationSpeed: 2.5,
    }),
    spectrum_helix: effect("spectrum_helix", "nukeTrail", "epic", {
      type: "spiral",
      colors: [
        "#ff0000", "#ff8700", "#ffd300", "#a1ff0a", "#0aefff", "#147df5", "#be0aff",
      ],
      radius: 2.5,
      strands: 6,
      rotationSpeed: 3,
    }),
  },
  structures: {
    copper_glow: effect("copper_glow", "structures", "common", {
      type: "gradient",
      colors: ["#b87333", "#e8a563", "#ffd9a0"],
      colorSize: 2,
      movementSpeed: 1.5,
    }),
    emerald_circuit: effect("emerald_circuit", "structures", "uncommon", {
      type: "gradient",
      colors: ["#0d9d58", "#39ff14", "#c9e8c4"],
      colorSize: 2,
      movementSpeed: 1.5,
    }),
    royal_enamel: effect("royal_enamel", "structures", "rare", {
      type: "gradient",
      colors: ["#4a1e8b", "#f72585", "#ffd60a"],
      colorSize: 2,
      movementSpeed: 2,
    }),
    obsidian_flux: effect("obsidian_flux", "structures", "epic", {
      type: "transition",
      colors: ["#000000", "#3a0ca3", "#f72585"],
      frequency: 1,
    }),
  },
  warship: {
    steel_wake: effect("steel_wake", "warship", "common", {
      type: "gradient",
      colors: ["#8d99ae", "#edf2f4", "#2b2d42"],
      colorSize: 2,
      movementSpeed: 1.5,
    }),
    crimson_fleet: effect("crimson_fleet", "warship", "uncommon", {
      type: "gradient",
      colors: ["#8b1e1e", "#ff0000", "#ffd700"],
      colorSize: 2,
      movementSpeed: 2,
    }),
    golden_armada: effect("golden_armada", "warship", "rare", {
      type: "gradient",
      colors: ["#ffd700", "#fff8dc", "#b8860b"],
      colorSize: 2,
      movementSpeed: 2,
    }),
    abyssal_hull: effect("abyssal_hull", "warship", "epic", {
      type: "transition",
      colors: ["#03045e", "#0077b6", "#00b4d8"],
      frequency: 1.2,
    }),
  },
  nukeExplosion: {
    atomic_bloom: effect("atomic_bloom", "nukeExplosion", "common", {
      type: "shockwave",
      nukeType: "atom",
      colors: ["#ff6b00", "#ffd23f"],
      size: 4,
      speed: 3,
      thickness: 0.8,
      transitionSpeed: 2,
    }),
    fission_sparkle: effect("fission_sparkle", "nukeExplosion", "uncommon", {
      type: "sparkles",
      nukeType: "atom",
      colors: ["#ffd700", "#ffffff", "#ff8c00"],
      size: 3,
      speed: 2,
      thickness: 0.6,
      transitionSpeed: 2,
      density: 20,
    }),
    hydro_pulse: effect("hydro_pulse", "nukeExplosion", "common", {
      type: "shockwave",
      nukeType: "hydro",
      colors: ["#00b4d8", "#90e0ef"],
      size: 5,
      speed: 3.5,
      thickness: 1,
      transitionSpeed: 2,
    }),
    fusion_flare: effect("fusion_flare", "nukeExplosion", "uncommon", {
      type: "sparkles",
      nukeType: "hydro",
      colors: ["#00f5d4", "#9b5de5", "#ffffff"],
      size: 4,
      speed: 2.5,
      thickness: 0.7,
      transitionSpeed: 2,
      density: 25,
    }),
    mirv_storm: effect("mirv_storm", "nukeExplosion", "common", {
      type: "shockwave",
      nukeType: "mirvWarhead",
      colors: ["#8d99ae", "#ff0000"],
      size: 4,
      speed: 3,
      thickness: 0.9,
      transitionSpeed: 2,
    }),
    warhead_burst: effect("warhead_burst", "nukeExplosion", "uncommon", {
      type: "embers",
      nukeType: "mirvWarhead",
      colors: ["#ff4500", "#ffd700", "#8b0000"],
      size: 3,
      speed: 2,
      thickness: 0.5,
      transitionSpeed: 1.5,
      density: 18,
    }),
  },
} as Cosmetics["effects"];

export const cosmeticsCatalog: Cosmetics = {
  patterns: PATTERNS,
  flags: {},
  colorPalettes: COLOR_PALETTES,
  effects: EFFECTS,
};
