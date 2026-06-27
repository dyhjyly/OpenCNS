"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeMemory = analyzeMemory;
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const API_KEY = process.env.DEEPSEEK_API_KEY;
async function analyzeMemory(content) {
    try {
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
                        content: `

你是记忆分析器。

分析用户输入并返回JSON。

字段：

memory_type:

- fact
- understanding
- belief

importance:
0~1

unresolved:
true/false

valence:
-1~1

arousal:
0~1

keywords:
最多5个关键词

只允许返回JSON。
不要解释。
`,
                    },
                    {
                        role: 'user',
                        content,
                    },
                ],
            }),
        });
        const data = await response.json();
        const text = data.choices?.[0]?.message?.content ?? '{}';
        const result = JSON.parse(text);
        return {
            memory_type: result.memory_type ?? 'fact',
            importance: result.importance ?? 0.5,
            unresolved: result.unresolved ?? false,
            valence: result.valence ?? 0,
            arousal: result.arousal ?? 0,
            keywords: result.keywords ?? [],
        };
    }
    catch (error) {
        console.error('====================');
        console.error('Memory analysis failed');
        console.error(error);
        console.error('====================');
        throw error;
    }
}
//# sourceMappingURL=analyzer.js.map