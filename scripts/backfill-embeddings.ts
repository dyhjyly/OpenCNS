import { supabase } from '../src/db.js';
import { getEmbedding } from '../src/embedding.js';

async function main() {
  const { data, error } = await supabase
    .from('memories')
    .select('id, content')
    .is('embedding', null);

  if (error) throw error;

  console.log(`Need rebuild: ${data.length}`);

  for (const memory of data) {
    try {
      const embedding = await getEmbedding(memory.content);

      await supabase
        .from('memories')
        .update({ embedding })
        .eq('id', memory.id);

      console.log(`✓ ${memory.id}`);
    } catch (err) {
      console.error(`✗ ${memory.id}`);
    }
  }

  console.log('Done');
}

main();
