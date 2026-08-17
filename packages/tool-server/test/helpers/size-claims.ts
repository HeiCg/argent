/**
 * Vocabulary for "this image is at the device's own resolution", in the
 * spellings the screenshot surfaces reach for. `screenshot-diff` captures live
 * input at full resolution only when the device streams it, and writes its diff
 * at whatever size the comparison ran at, so every one of these words is a claim
 * that has to be checked against `captureLiveInput` and `writeDiffArtifacts`
 * rather than a phrase to be pattern-matched.
 */
const CLAIMS_SIZE = /full[- ](?:resolution|res\b|size)|native resolution|unscaled|1:1|100% scale/i;

/**
 * The sentences of `text` that reach for that vocabulary. Pinning the whole
 * collection, rather than the presence of a corrected phrase, is what makes a
 * contradicting *addition* visible: it arrives as an extra element instead of
 * sitting beside the phrase a positive assertion already found.
 *
 * Split on a period followed by whitespace, which leaves decimals ("0.3 by
 * default") intact.
 */
export function sentencesClaimingSize(text: string): string[] {
  return text
    .split(/(?<=\.)\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => CLAIMS_SIZE.test(sentence));
}

/** The same sweep over a rendered summary, which is line- rather than sentence-shaped. */
export function linesClaimingSize(text: string): string[] {
  return text.split("\n").filter((line) => CLAIMS_SIZE.test(line));
}
