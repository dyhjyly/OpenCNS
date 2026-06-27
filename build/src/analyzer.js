"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeMemory = analyzeMemory;
async function analyzeMemory(content) {
    const lower = content.toLowerCase();
    let memory_type = 'fact';
    let importance = 0.5;
    let unresolved = false;
    // TYPE DETECTION
    if (lower.includes('should') ||
        lower.includes('want') ||
        lower.includes('plan')) {
        memory_type = 'goal';
        importance += 0.5;
    }
    if (lower.includes('like') ||
        lower.includes('prefer') ||
        lower.includes('favorite')) {
        memory_type = 'preference';
        importance += 0.3;
    }
    if (lower.includes('error') ||
        lower.includes('failed') ||
        lower.includes('bug')) {
        memory_type = 'error';
        importance += 0.4;
    }
    if (lower.includes('not sure') ||
        lower.includes('todo') ||
        lower.includes('later')) {
        unresolved = true;
    }
    // clamp importance
    importance = Math.max(0, Math.min(1, importance));
    return {
        memory_type,
        importance,
        unresolved,
    };
}
//# sourceMappingURL=analyzer.js.map