import {
  AnalysisResult,
  MemoryType,
  CognitiveSubject,
} from "./types.js";

function parseOne(result: any): AnalysisResult {

  return {

    speaker:
      result?.speaker ?? "user",

    subject:
      result?.subject ?? "user",

    memory_type:
      result?.memory_type ?? "fact",

    content:
      result?.content ?? "",

    importance:
      Number(result?.importance ?? 0.5),

    unresolved:
      Boolean(result?.unresolved ?? false),

    valence:
      Number(result?.valence ?? 0),

    arousal:
      Number(result?.arousal ?? 0),

    keywords:
      Array.isArray(result?.keywords)
        ? result.keywords
        : [],

  };

}


export function parseAnalysis(
  data: any
): AnalysisResult[] {

  console.log(
    "ANALYZER DATA:",
    JSON.stringify(data, null, 2)
  );


  const text =
    data?.content
    ??
    data?.choices?.[0]?.message?.content
    ??
    '[]';


  console.log(
    "ANALYZER RAW:",
    text
  );


  let result: any;


  try {

    result =
      JSON.parse(text);

  } catch {

    const fixed =
      text
        .replace(/```json/g, "")
        .replace(/```/g, "")
        .trim();

    result =
      JSON.parse(fixed);

  }


  if (!Array.isArray(result)) {

    result = [result];

  }


  return result
    .map(parseOne)
    .filter(
      (item: AnalysisResult) =>
        item.content.length > 0
    );

}