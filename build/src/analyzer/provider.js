"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.callAnalyzer = callAnalyzer;
const dotenv_1 = __importDefault(require("dotenv"));
const prompt_js_1 = require("./prompt.js");
dotenv_1.default.config();
const API_KEY = process.env.DEEPSEEK_API_KEY;
async function callAnalyzer(content) {
    const response = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
            model: 'deepseek-ai/DeepSeek-V3',
            temperature: 0.1,
            messages: [
                {
                    role: 'system',
                    content: prompt_js_1.ANALYZER_PROMPT,
                },
                {
                    role: 'user',
                    content,
                },
            ],
        }),
    });
    return response.json();
}
//# sourceMappingURL=provider.js.map