// BlockSuite boundary for browser-only custom-element registration. Keeping the
// dynamic imports here prevents components from depending on package effects.
export async function ensureBlockSuiteEffects() {
  const [{ effects: blocks }, { effects: presets }] = await Promise.all([
    import('@blocksuite/blocks/effects'),
    import('@blocksuite/presets/effects'),
  ])
  blocks()
  presets()
}
