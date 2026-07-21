// Streaming JSONL helpers. Upstream files reach ~160 MB, so nothing here loads a
// whole file into a single string.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * Yield parsed objects from a JSONL file, one line at a time.
 * Blank lines are skipped; a malformed line throws with its line number.
 *
 * @param {string} filePath
 * @returns {AsyncGenerator<object>}
 */
export async function* readJsonl(filePath) {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch (e) {
      throw new Error(`${filePath}:${lineNo}: malformed JSON — ${e.message}`);
    }
  }
}
