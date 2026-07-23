from db import fetch_all


def load_tournament_teams():
    """All scraped teams: [{id, pokemon: [{name, item, nature, ability, attacks: [...]}], wins, losses}]"""
    return fetch_all("SELECT id, pokemon, wins, losses FROM tournament_teams")


def load_winning_teams():
    """Teams with a net-positive record — the population used for tournament-prevalence stats."""
    return fetch_all("SELECT id, pokemon, wins, losses FROM tournament_teams WHERE wins > losses")


def load_pokemon_species():
    """Species lookup keyed by lowercased name -> base stats + typing."""
    rows = fetch_all("""
        SELECT name, type1, type2, hp, atk, def, spa, spd, spe
        FROM pokemon
    """)
    return {row["name"].lower(): row for row in rows}


def load_moves():
    """Move lookup keyed by lowercased name -> type/category/power."""
    rows = fetch_all("SELECT name, type, category, power FROM moves")
    return {row["name"].lower(): row for row in rows}


def load_abilities():
    """Ability lookup keyed by lowercased name -> description text."""
    rows = fetch_all("SELECT name, description FROM abilities")
    return {row["name"].lower(): row for row in rows}


def unique_attacks(mon):
    """A mon's attacks, de-duplicated (order preserved). Guards against scraper glitches
    where the same move is listed twice in one team's decklist — a real Pokemon can
    never have a duplicate move, so a repeat is bad data, not a signal."""
    seen = set()
    result = []
    for move in mon.get("attacks") or []:
        if move not in seen:
            seen.add(move)
            result.append(move)
    return result


def species_key(mon):
    """Species-table lookup key for a scraped Pokemon entry.

    Prefer the Showdown `id` field over `name`: `name` is a display string that can
    carry gender symbols the species table doesn't use (e.g. "Basculegion ♀" vs
    the table's "Basculegion-F"), while `id` is already close to the table's naming
    convention ("basculegion-f"). Using `id` raises the species-match rate from
    ~89% to ~92% of tournament_teams pokemon entries.
    """
    return (mon.get("id") or mon.get("name") or "").lower()


def species_identity_key(mon, species):
    """(key, display_name) for a scraped Pokemon entry, preferring its Mega/regional
    identity over its base form — or None if the entry doesn't match any real species
    row at all.

    Mirrors train_synergy.py's own `team_pokemon_identity()` (that file keeps its own
    local copy rather than importing this — see its docstring — this version exists so
    train_moves.py can use the same, already-correct pattern without duplicating it a
    third time). Validity is checked via the BASE `species_key()` against the `pokemon`
    species table, since that's the only reliable existence check available — the table
    has zero "-Mega" rows, so checking membership using the *normalized* name would
    reject every Mega entry outright. Once that base check passes, `normalizedName`
    (set by normalize.js at scrape time, e.g. "Raichu" + Raichunite Y -> "Raichu-Mega-Y")
    is substituted in for the actual identity/bucketing key, so a Mega form's move data
    is tracked separately from its base form's instead of being silently blended
    together under one shared species_key() bucket.
    """
    base_key = species_key(mon)
    if base_key not in species:
        return None
    normalized = (mon.get("normalizedName") or "").strip()
    if normalized:
        return normalized.lower(), normalized
    return base_key, species[base_key]["name"]


if __name__ == "__main__":
    teams = load_tournament_teams()
    print(f"Loaded {len(teams)} tournament teams")

    winning = load_winning_teams()
    print(f"Loaded {len(winning)} winning teams (wins > losses)")

    species = load_pokemon_species()
    print(f"Loaded {len(species)} pokemon species")

    moves = load_moves()
    print(f"Loaded {len(moves)} moves")

    abilities = load_abilities()
    print(f"Loaded {len(abilities)} abilities")

    garchomp = species.get("garchomp")
    print(f"Garchomp row: {garchomp}")
