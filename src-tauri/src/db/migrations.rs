pub const MIGRATIONS: &[&str] = &[
    r#"
    CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        size INTEGER NOT NULL,
        modified INTEGER NOT NULL,
        file_type TEXT NOT NULL,
        indexed_at INTEGER NOT NULL,
        parse_status TEXT NOT NULL DEFAULT 'ok'
    );
    CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS embeddings (
        chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
        vector BLOB NOT NULL,
        model_version TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS doc_graph (
        file_id_a INTEGER NOT NULL,
        file_id_b INTEGER NOT NULL,
        similarity REAL NOT NULL,
        PRIMARY KEY (file_id_a, file_id_b)
    );
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS index_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS watched_folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
    CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id);
    "#,
];
