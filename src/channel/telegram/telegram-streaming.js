export async function* chunkText(text, size = 80) {
  for (let i = 0; i < text.length; i += size) {
    yield text.slice(i, i + size);
  }
}
