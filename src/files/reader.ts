import fs from "node:fs/promises";
import path from "node:path";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

export interface ReadFileResult {
  name: string;
  type: string;
  text: string;
}

export async function readUploadedFile(
  name: string,
  type: string,
  data: string,
): Promise<ReadFileResult> {
  const base64 = data.replace(/^data:[^;]+;base64,/, "");
  const buffer = Buffer.from(base64, "base64");

  const ext = path.extname(name).toLowerCase();

  if (ext === ".txt" || ext === ".md") {
    return {
      name,
      type,
      text: buffer.toString("utf-8"),
    };
  }

  if (ext === ".pdf") {
    const parser = new PDFParse({
      data: buffer,
    });

    const result = await parser.getText();

    console.log("[PDF READER]", name, "text length =", result.text?.length);

    await parser.destroy();

    return {
      name,
      type,
      text: result.text,
    };
  }

  if (ext === ".docx") {
    const result = await mammoth.extractRawText({
      buffer,
    });

    return {
      name,
      type,
      text: result.value,
    };
  }

  throw new Error(`暂不支持读取文件类型: ${ext || type}`);
}
