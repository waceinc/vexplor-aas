import { rolldown } from 'rolldown';
const build = await rolldown({ input: 'packages/edge/dist/bin.js', platform: 'node', external: (id) => id.startsWith('node:'), logLevel: 'warn', treeshake: true });
const { output } = await build.write({ file: process.argv[2], format: 'cjs', inlineDynamicImports: true });
console.log(output.map((o) => `${o.fileName} ${o.code?.length ?? o.source?.length}`).join('\n'));
