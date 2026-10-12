-- ============================================
-- MCP Memory Server - Supabase Schema
-- ============================================

-- 1. Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Create memories table
CREATE TABLE IF NOT EXISTS memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  embedding VECTOR(1024),
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Create vector similarity search index
CREATE INDEX IF NOT EXISTS memories_embedding_idx ON memories
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- 4. Create updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- 5. Apply trigger to memories table
DROP TRIGGER IF EXISTS update_memories_updated_at ON memories;
CREATE TRIGGER update_memories_updated_at
    BEFORE UPDATE ON memories
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 6. Create search function for pgvector similarity search
CREATE OR REPLACE FUNCTION search_memories(
  query_embedding VECTOR(1024),
  match_limit INT DEFAULT 5
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  metadata JSONB,
  similarity FLOAT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    memories.id,
    memories.content,
    memories.metadata,
    1 - (memories.embedding <=> query_embedding) AS similarity,
    memories.created_at,
    memories.updated_at
  FROM memories
  WHERE memories.embedding IS NOT NULL
  ORDER BY memories.embedding <=> query_embedding
  LIMIT match_limit;
END;
$$;

-- ============================================
-- Conversation Context
-- ============================================

-- 7. Rolling Summary
CREATE TABLE IF NOT EXISTS conversation_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL UNIQUE,
  summary TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. Recent Chat
CREATE TABLE IF NOT EXISTS recent_chat (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL,
  sequence BIGINT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. Recent Chat indexes
CREATE INDEX IF NOT EXISTS recent_chat_session_sequence_idx
ON recent_chat (session_id, sequence DESC);

CREATE INDEX IF NOT EXISTS recent_chat_session_created_idx
ON recent_chat (session_id, created_at DESC);

-- 10. Rolling Summary updated_at trigger
DROP TRIGGER IF EXISTS update_conversation_summaries_updated_at
ON conversation_summaries;

CREATE TRIGGER update_conversation_summaries_updated_at
    BEFORE UPDATE ON conversation_summaries
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- Conversation Context v2
-- Daily Summary + Period Summary
-- ============================================

-- 11. Daily Summary
CREATE TABLE IF NOT EXISTS daily_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  session_id UUID NOT NULL,

  summary_date DATE NOT NULL,

  summary TEXT NOT NULL DEFAULT '',

  summarized_through TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW(),

  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (session_id, summary_date)
);

-- 12. Daily Summary indexes
CREATE INDEX IF NOT EXISTS daily_summaries_session_date_idx
ON daily_summaries (session_id, summary_date DESC);

CREATE INDEX IF NOT EXISTS daily_summaries_session_through_idx
ON daily_summaries (session_id, summarized_through DESC);


-- 13. Period Summary
CREATE TABLE IF NOT EXISTS period_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  session_id UUID NOT NULL,

  period_start DATE NOT NULL,

  period_end DATE NOT NULL,

  summary TEXT NOT NULL DEFAULT '',

  source_through TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW(),

  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (session_id, period_start, period_end)
);

-- 14. Period Summary indexes
CREATE INDEX IF NOT EXISTS period_summaries_session_period_idx
ON period_summaries (
  session_id,
  period_end DESC
);

CREATE INDEX IF NOT EXISTS period_summaries_session_through_idx
ON period_summaries (
  session_id,
  source_through DESC
);


-- 15. Daily Summary updated_at trigger
DROP TRIGGER IF EXISTS update_daily_summaries_updated_at
ON daily_summaries;

CREATE TRIGGER update_daily_summaries_updated_at
    BEFORE UPDATE ON daily_summaries
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();


-- 16. Period Summary updated_at trigger
DROP TRIGGER IF EXISTS update_period_summaries_updated_at
ON period_summaries;

CREATE TRIGGER update_period_summaries_updated_at
    BEFORE UPDATE ON period_summaries
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
