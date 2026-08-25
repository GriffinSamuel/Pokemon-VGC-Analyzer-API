const { Dex } = require('@pkmn/dex');
const pool = require('../db/pool');
const logger = require('./logger');

const MANUAL_MAP = {
  'basculegion-f':   'Basculegion-F',
  'basculegion-m':   'Basculegion',
  'indeedee-f':      'Indeedee-F',
  'indeedee-m':      'Indeedee',
  'meowstic-f':      'Meowstic-F',
  'meowstic-m':      'Meowstic',
  'oinkologne-f':    'Oinkologne-F',
  'oinkologne-m':    'Oinkologne',
  'floette-eternal': 'Floette-Eternal',
};

// Every Mega Stone in Champions mapped to the correct normalized name
const MEGA_ITEM_MAP = {
  // Reg M-A - Standard Gen 6/7 Megas
  'venusaurite':     'Venusaur-Mega',
  'charizardite x':  'Charizard-Mega-X',
  'charizardite y':  'Charizard-Mega-Y',
  'blastoisinite':   'Blastoise-Mega',
  'beedrillite':     'Beedrill-Mega',
  'pidgeotite':      'Pidgeot-Mega',
  'alakazite':       'Alakazam-Mega',
  'slowbronite':     'Slowbro-Mega',
  'gengarite':       'Gengar-Mega',
  'kangaskhanite':   'Kangaskhan-Mega',
  'pinsirite':       'Pinsir-Mega',
  'gyaradosite':     'Gyarados-Mega',
  'aerodactylite':   'Aerodactyl-Mega',
  'ampharosite':     'Ampharos-Mega',
  'steelixite':      'Steelix-Mega',
  'scizorite':       'Scizor-Mega',
  'heracronite':     'Heracross-Mega',
  'houndoominite':   'Houndoom-Mega',
  'tyranitarite':    'Tyranitar-Mega',
  'gardevoirite':    'Gardevoir-Mega',
  'sablenite':       'Sableye-Mega',
  'aggronite':       'Aggron-Mega',
  'medichamite':     'Medicham-Mega',
  'manectite':       'Manectric-Mega',
  'sharpedonite':    'Sharpedo-Mega',
  'cameruptite':     'Camerupt-Mega',
  'altarianite':     'Altaria-Mega',
  'salamencite':     'Salamence-Mega',
  'metagrossite':    'Metagross-Mega',
  'latiasite':       'Latias-Mega',
  'latiosite':       'Latios-Mega',
  'garchompite':     'Garchomp-Mega',
  'lucarionite':     'Lucario-Mega',
  'abomasite':       'Abomasnow-Mega',
  'audinite':        'Audino-Mega',
  'galladite':       'Gallade-Mega',
  'banettite':       'Banette-Mega',
  'absolite':        'Absol-Mega',
  'glalitite':       'Glalie-Mega',
  'lopunnite':       'Lopunny-Mega',
  'diancite':        'Diancie-Mega',
  'mewtwonite x':    'Mewtwo-Mega-X',
  'mewtwonite y':    'Mewtwo-Mega-Y',

  // Reg M-A - Champions exclusive (Legends Z-A transfers)
  'dragoninite':     'Dragonite-Mega',
  'greninjite':      'Greninja-Mega',
  'chesnaughtite':   'Chesnaught-Mega',
  'delphoxite':      'Delphox-Mega',
  'emboarite':       'Emboar-Mega',
  'feraligite':      'Feraligatr-Mega',
  'meganiumite':     'Meganium-Mega',
  'floettite':       'Floette-Eternal-Mega',

  // Reg M-B - New Megas (June 17 2026 update)
  'swampertite':     'Swampert-Mega',
  'sceptilite':      'Sceptile-Mega',
  'blazikenite':     'Blaziken-Mega',
  'mawilite':        'Mawile-Mega',
  // FIX 1 (round 3): the prior round's fix REPLACED 'staraptite' with
  // 'staraptornite' on the mistaken assumption that "Staraptornite" was the
  // one real spelling — verified live this round that both are genuinely real,
  // but overwhelmingly lopsided (210 real occurrences of "Staraptite" vs. just
  // 1 of "Staraptornite"). That prior substitution was itself a regression
  // (unmapped 210 real rows it had previously covered) — caught by this round's
  // own startup audit (`auditMegaItemMappings()`) flagging "Staraptite" as
  // unmapped on the very first run. Both kept, mapping to the same form.
  'staraptite':      'Staraptor-Mega',
  'staraptornite':   'Staraptor-Mega',
  'scolipite':       'Scolipede-Mega',
  'scraftinite':     'Scrafty-Mega',
  'eelektrossite':   'Eelektross-Mega',
  'pyroarite':       'Pyroar-Mega',
  'malamarite':      'Malamar-Mega',
  'barbaracite':     'Barbaracle-Mega',
  'dragalgite':      'Dragalge-Mega',
  'falinksite':      'Falinks-Mega',
  'raichunite x':    'Raichu-Mega-X',
  'raichunite y':    'Raichu-Mega-Y',

  // FIX 3: added — verified against real scraped item strings in tournament_teams
  // (grepped every distinct `-ite`/`-nite` item across the full table and cross-
  // checked against this map's own keys; see CLAUDE.md for the full method).
  // These 13 previously had NO entry at all, so normalizePokemonName() silently
  // fell through to @pkmn/dex's `Dex.species.get()` for the bare species id
  // (e.g. "excadrill"), which resolves fine but drops the Mega form entirely —
  // identical failure mode to the raichuite/beedrilite/staraptite typos above,
  // just an omission instead of a misspelling. `Starminite`/`Drampanite` are
  // included for completeness/consistency even though `Starmie`/`Drampa` have
  // NO base-form row in the `pokemon` table at all (a separate, deeper seeding
  // gap this fix does not attempt to close — see CLAUDE.md).
  'excadrite':       'Excadrill-Mega',
  'scovillainite':   'Scovillain-Mega',
  'froslassite':     'Froslass-Mega',
  'clefablite':      'Clefable-Mega',
  'starminite':      'Starmie-Mega',
  'glimmoranite':    'Glimmora-Mega',
  'golurkite':       'Golurk-Mega',
  'drampanite':      'Drampa-Mega',
  'skarmorite':      'Skarmory-Mega',
  'victreebelite':   'Victreebel-Mega',
  'crabominite':     'Crabominable-Mega',
  'chandelurite':    'Chandelure-Mega',
  'hawluchanite':    'Hawlucha-Mega',
};

function normalizePokemonName(id, item) {
  if (!id) return null;

  const lower = id.toLowerCase();
  const itemLower = (item || '').toLowerCase();

  // Check if the held item reveals a Mega form
  if (itemLower && MEGA_ITEM_MAP[itemLower]) return MEGA_ITEM_MAP[itemLower];

  // Check manual map for gender variants etc
  if (MANUAL_MAP[lower]) return MANUAL_MAP[lower];

  // Try @pkmn/dex for canonical name
  const species = Dex.species.get(lower);
  if (species?.exists) return species.name;

  // Fall back to title-casing the id
  return id
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('-');
}

/**
 * A move name as scraped, corrected to its canonical display form. Same
 * ID-vs-display confusion as the toID/LOWER() bug that hollowed out
 * pokemon_moves, different place: one Limitless tournament's decklist data
 * arrived with `attacks` as dex move IDs ("trickroom") instead of display
 * names ("Trick Room") — Limitless's structured API is passed straight
 * through with no move-name processing at all, unlike species names, which
 * normalizePokemonName already corrects.
 *
 * Dex.moves.get() normalises its input via toID() before lookup, so this is
 * a no-op for an already-correct display name and a real fix for an ID-style
 * string. A genuine typo ("Solat Beam") the dex doesn't recognise either is
 * returned unchanged — there is no safe way to guess what it meant, so it is
 * left for a human to see and fix, not silently "corrected" into something
 * that might be wrong.
 */
function normalizeMoveName(name) {
  if (!name) return name;
  const move = Dex.moves.get(name);
  return move?.exists ? move.name : name;
}

function normalizeTeam(pokemonArray) {
  if (!Array.isArray(pokemonArray)) return [];
  return pokemonArray.map(p => ({
    ...p,
    normalizedName: normalizePokemonName(p.id || p.name, p.item),
    attacks: Array.isArray(p.attacks) ? p.attacks.map(normalizeMoveName) : p.attacks,
  }));
}

// FIX 1 STEP 1: startup-time regression check — pulls every distinct item
// string ever scraped into tournament_teams that ENDS in "ite" (Mega Stones'
// real naming convention; verified live against this project's actual data,
// not just Game Freak's real-item convention, since several of this format's
// homebrew Champions-exclusive stones follow the same "-ite" pattern), then
// cross-references each against MEGA_ITEM_MAP. This is exactly how the real
// Raichunite X/Y, Beedrillite, and Staraptornite mapping bugs were originally
// found (by hand, once) — this makes that same check run automatically on every
// server start so a future scrape introducing a new, unmapped Mega item (or a
// scraper-format change that alters an existing item string) is caught
// immediately as a startup log line instead of silently falling back to a base
// form for however long it takes someone to notice by hand again.
async function auditMegaItemMappings() {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT elem->>'item' AS item
       FROM tournament_teams, jsonb_array_elements(pokemon) elem
       WHERE elem->>'item' ILIKE '%ite'`
    );
    const mappedKeys = new Set(Object.keys(MEGA_ITEM_MAP));
    const unmapped = rows
      .map((r) => r.item)
      .filter(Boolean)
      .filter((item) => !mappedKeys.has(item.toLowerCase()));

    if (unmapped.length > 0) {
      logger.error('Mega item mapping audit found unmapped items', {
        unmapped_items: unmapped,
        note: 'Every one of these will silently fall back to its base-form name via Dex.species.get() until MEGA_ITEM_MAP is updated — see normalize.js',
      });
    } else {
      logger.info('Mega item mapping audit: all real scraped -ite items are mapped', { checked: rows.length });
    }
    return unmapped;
  } catch (err) {
    logger.error('Mega item mapping audit failed to run', { message: err.message });
    return [];
  }
}

module.exports = { normalizePokemonName, normalizeMoveName, normalizeTeam, auditMegaItemMappings, MEGA_ITEM_MAP };