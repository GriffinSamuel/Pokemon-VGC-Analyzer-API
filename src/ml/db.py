import psycopg2
import psycopg2.extras

# Mirrors src/db/pool.js — hardcoded intentionally, see CLAUDE.md.
DB_CONFIG = {
    "host": "localhost",
    "port": 5432,
    "dbname": "pokemon_vgc",
    "user": "postgres",
    "password": "R@1nb0w!",
}


def get_connection():
    return psycopg2.connect(**DB_CONFIG)


def fetch_all(query, params=None):
    conn = get_connection()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(query, params or ())
            return cur.fetchall()
    finally:
        conn.close()


if __name__ == "__main__":
    rows = fetch_all("SELECT 1 AS ok")
    print(f"Connection OK: {rows}")
