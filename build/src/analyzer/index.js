"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeMemory = analyzeMemory;
const provider_js_1 = require("./provider.js");
const parser_js_1 = require("./parser.js");
async function analyzeMemory(content) {
    const data = await (0, provider_js_1.callAnalyzer)(content);
    return (0, parser_js_1.parseAnalysis)(data);
}
//# sourceMappingURL=index.js.map