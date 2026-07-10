import { handleSaveMemory } from "./save.js";
import { handleSearchMemories } from "./search.js";
import { handleReadMemory } from "./read.js";
import { handleDeleteMemory } from "./delete.js";
import { runLifecycle } from "./lifecycle.js";

import {
  SaveMemorySchema,
  SearchMemoriesSchema,
  ReadMemorySchema,
  DeleteMemorySchema,
} from "./types.js";

import { PerceptionResult } from "../perception/index.js";
const memoryStore: any[] = [];

/**
 * =========================
 * Schema exports
 * =========================
 */
export {
  SaveMemorySchema,
  SearchMemoriesSchema,
  ReadMemorySchema,
  DeleteMemorySchema,
};

/**
 * =========================
 * Handler exports
 * =========================
 */
export {
  handleSaveMemory,
  handleSearchMemories,
  handleReadMemory,
  handleDeleteMemory,
  runLifecycle,
};

/**
 * =========================
 * Perception → Memory Bridge
 * =========================
 */
export async function storePerception(p: PerceptionResult) {
const memory = {
    raw: p.raw,
    intent: p.intent,
    topic: p.topic,
    emotion: p.emotion,
    entities: p.entities,
    timestamp: p.timestamp,

    importance: computeImportanceFromPerception(p),
  };

  memoryStore.push(memory);

  return memory;
}

/**
 * 🧠 simple importance scoring (v1)
 */
function computeImportanceFromPerception(p: PerceptionResult) {
  let score = 0.5;

  if (p.intent === "question") score += 0.2;
  if (p.emotion === "excited") score += 0.1;
  if (p.entities.length > 0) score += 0.1;

  return Math.min(1, score);
}

/**
 * =========================
 * Memory Module API
 * =========================
 */
export const MemoryModule = {
  save: handleSaveMemory,
  search: handleSearchMemories,
  read: handleReadMemory,
  delete: handleDeleteMemory,
  lifecycle: runLifecycle,
  storePerception,

  getAll() {
  return memoryStore;
 },
};