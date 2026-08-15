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
// backend. priceSoft (tiered by rarity: common 200, uncommon 450, rare
// 900, epic 2000) is paid in soft currency, earned for free by winning
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

const PRICE_BY_RARITY = { common: 200, uncommon: 450, rare: 900, epic: 2000 } as const;

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

const PATTERNS: Cosmetics["patterns"] = {
  micro_weave: pattern(
    "micro_weave",
    "common",
    "ALJYIiIiERERiIiIREREIiIiERERiIiIREREIiIiERERiIiIREREIiIiERERiIiIREREIiIiERERiIiIREREIiIiERERiIiIRERE",
  ),
  lattice_dots: pattern(
    "lattice_dots",
    "common",
    "ALJYAAAAAAAAPDw8PDw8PDw8PDw8AAAAAAAAAAAAAAAAPDw8PDw8PDw8PDw8AAAAAAAAAAAAAAAAPDw8PDw8PDw8PDw8AAAAAAAA",
  ),
  trellis: pattern(
    "trellis",
    "common",
    "ALJYwzAM53mePM_zGIZhPM_z53mewzAM53mePM_zGIZhPM_z53mewzAM53mePM_zGIZhPM_z53mewzAM53mePM_zGIZhPM_z53me",
  ),
  basket_weave: pattern(
    "basket_weave",
    "common",
    "ALJYPz8_Pz8_MDAwMDAw8_Pz8_PzAwMDAwMDPz8_Pz8_MDAwMDAw8_Pz8_PzAwMDAwMDPz8_Pz8_MDAwMDAw8_Pz8_PzAwMDAwMD",
  ),
  scale_mail: pattern(
    "scale_mail",
    "common",
    "ALJYAAAAjDHG3nvv3nvvjDHGAAAAc845c845c845c845AAAAjDHG3nvv3nvvjDHGAAAAc845c845c845c845AAAAjDHG3nvv3nvv",
  ),
  fish_scale: pattern(
    "fish_scale",
    "common",
    "ALJYHMdxHMdxAAAA4ziO4ziOAAAAHMdxHMdxAAAA4ziO4ziOAAAAHMdxHMdxAAAA4ziO4ziOAAAAHMdxHMdxAAAA4ziO4ziOAAAA",
  ),
  herringbone: pattern(
    "herringbone",
    "uncommon",
    "ALJYgYGBQkJCJCQkGBgYGBgYJCQkQkJCgYGBgYGBQkJCJCQkGBgYGBgYJCQkQkJCgYGBgYGBQkJCJCQkGBgYGBgYJCQkQkJCgYGB",
  ),
  houndstooth: pattern(
    "houndstooth",
    "uncommon",
    "ALJYS0tLh4eHHh4eLS0ttLS0eHh44eHh0tLSS0tLh4eHHh4eLS0ttLS0eHh44eHh0tLSS0tLh4eHHh4eLS0ttLS0eHh44eHh0tLS",
  ),
  honeycomb: pattern(
    "honeycomb",
    "uncommon",
    "ALJY____xsbGbGxsODg4____sbGxGxsbDg4O____xsbGbGxsODg4____sbGxGxsbDg4O____xsbGbGxsODg4____sbGxGxsbDg4O",
  ),
  chevron_bands: pattern(
    "chevron_bands",
    "uncommon",
    "ALJYODg4fHx87u7ux8fHg4ODERERODg4fHx87u7ux8fHg4ODERERODg4fHx87u7ux8fHg4ODERERODg4fHx87u7ux8fHg4ODERER",
  ),
  quilted: pattern(
    "quilted",
    "uncommon",
    "ALJYAAAAAAAACIIgHMdxCIIgAAAAAAAAAAAACIIgHMdxCIIgAAAAAAAAAAAACIIgHMdxCIIgAAAAAAAAAAAACIIgHMdxCIIgAAAA",
  ),
  lightning: pattern(
    "lightning",
    "uncommon",
    "ALJYMzMzERERmZmZiIiIzMzMREREZmZmIiIiMzMzERERmZmZiIiIzMzMREREZmZmIiIiMzMzERERmZmZiIiIzMzMREREZmZmIiIi",
  ),
  argyle: pattern(
    "argyle",
    "rare",
    "ALJYERERoiiKWIM1FEVRDdZgoiiKREREoiiKDdZgFEVRWIM1oiiKERERoiiKWIM1FEVRDdZgoiiKREREoiiKDdZgFEVRWIM1oiiK",
  ),
  sierpinski: pattern(
    "sierpinski",
    "rare",
    "ALJYAAAAqqqqzMzM7u7u8PDw-vr6_Pz8_v7-AP8Aqv-qzP_M7v_u8P_w-v_6_P_8_v_-AAD_qqr_zMz_7u7_8PD_-vr__Pz__v7_",
  ),
  diamond_rings: pattern(
    "diamond_rings",
    "rare",
    "ALJYM8PMmZmZzDwzZmZmM8PMmZmZzDwzZmZmM8PMmZmZzDwzZmZmZmZmzDwzmZmZM8PMZmZmzDwzmZmZM8PMZmZmzDwzmZmZM8PM",
  ),
  radial_dither: pattern(
    "radial_dither",
    "rare",
    "ALJY____u6q639X9qqqqf1X3q6qqX1XVqoCoV1X1KgCqVUXVCgCoV1H1KgCqVUXVigCoV1X1q6KqX1Xdqqqqf3f_q6q6_93_r6rq",
  ),
  shattered: pattern(
    "shattered",
    "rare",
    "ALJYCAgIDg4ODg4ODw8P____4ODg4ODg4ODgCAgIDg4ODg4ODw8P____4ODg4ODg4ODgCAgIDg4ODg4ODw8P____4ODg4ODg4ODg",
  ),
  camo: pattern(
    "camo",
    "epic",
    "ALJYBAAABgAABgAABjgABnwABxwAAYCBAMBHOOBhfPgAPnwAezyAHxyAHwyAHwCAGECA-OCH-ODDMMDDHwDgDwDwDwD0DhwHDAgA",
  ),
};

export const cosmeticsCatalog: Cosmetics = {
  patterns: PATTERNS,
  flags: {},
  colorPalettes: COLOR_PALETTES,
};
