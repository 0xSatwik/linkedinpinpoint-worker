-- D1 Database Schema for LinkedIn Pinpoint Data
-- This table stores the scraped pinpoint data

CREATE TABLE IF NOT EXISTS pinpoint_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number INTEGER NOT NULL UNIQUE,
    date TEXT NOT NULL,
    clues TEXT NOT NULL, -- JSON array of clue strings
    answer TEXT NOT NULL,
    explanation TEXT, -- AI-generated explanation of the answer
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Index for faster searches
CREATE INDEX IF NOT EXISTS idx_number ON pinpoint_data(number);
CREATE INDEX IF NOT EXISTS idx_date ON pinpoint_data(date);
CREATE INDEX IF NOT EXISTS idx_created_at ON pinpoint_data(created_at DESC);
