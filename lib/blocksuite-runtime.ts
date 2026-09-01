// BlockSuite boundary for browser runtime loading. Keep dynamic package
// imports centralized so editor components remain insulated from internals.
export async function loadBlockSuiteRuntime() {
  const [presets, store, schemas, blocks] = await Promise.all([
    import('@blocksuite/presets'),
    import('@blocksuite/store'),
    import('@blocksuite/blocks/schemas'),
    import('@blocksuite/blocks'),
  ])
  return { presets, store, schemas, blocks }
}
