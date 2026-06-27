export async function getEmbedding(text: string): Promise<number[]> {
  const response = await fetch(
    'http://127.0.0.1:11434/api/embeddings',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'nomic-embed-text',
        prompt: text,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Ollama embedding error: ${response.status} ${errorText}`
    );
  }

  const data = (await response.json()) as any;

  return data.embedding;
}
