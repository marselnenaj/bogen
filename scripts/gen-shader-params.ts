// Writes packages/server/src/shader-params.json: every shader effect's parameters, with defaults, choices and the
// range its presets use, read from @paper-design/shaders(-react). Run again after updating that package:
//   npx tsx scripts/gen-shader-params.ts
// A test (shader-params.test.ts) fails when the table no longer matches the installed package.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shaderParamTable } from '../packages/server/src/shader-params-gen.ts';

const out = join(import.meta.dirname, '..', 'packages', 'server', 'src', 'shader-params.json');
writeFileSync(out, `${JSON.stringify(await shaderParamTable(), null, 1)}\n`);
console.log(`Wrote ${out}`);
