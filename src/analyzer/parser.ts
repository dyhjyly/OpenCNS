import { AnalysisResult } from "./types.js";

export function parseAnalysis(data: any): AnalysisResult {

   console.log("ANALYZER DATA:", JSON.stringify(data, null, 2));

    const text =
    data?.content
    ??
    data?.choices?.[0]?.message?.content
    ??
    '{}';

    console.log("ANALYZER RAW:", text);
   
    let result;

    try {

        result = JSON.parse(text);

    } catch {

        const fixed = text
            .replace(/```json/g, "")
            .replace(/```/g, "")
            .trim();

        result = JSON.parse(fixed);
    }

    return {

        memory_type:
            result.memory_type ?? "fact",

        importance:
            result.importance ?? 0.5,

        unresolved:
            result.unresolved ?? false,

        valence:
            result.valence ?? 0,

        arousal:
            result.arousal ?? 0,

        keywords:
            result.keywords ?? [],

    };
}
