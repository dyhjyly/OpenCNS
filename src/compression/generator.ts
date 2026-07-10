export function generateCompressionSummary(
  memories: {
    content: string;
  }[]
) {
  const contents = memories.map(
    (m) => m.content
  );

  return `Compressed memory summary: ${contents.join(
    " | "
  )}`;
}
