# Publish Pi extensions as source TypeScript

Pi extension packages publish their `src` directories and point `pi.extensions` directly to `./src/index.ts`; they do not generate or publish `dist`, `main`, `types`, or `exports` artifacts. Package TypeScript uses NodeNext semantics with explicit `.js` specifiers for local imports, while Pi-provided modules remain wildcard peer dependencies. The previous Rolldown and declaration builds added release complexity without serving Pi's runtime, which loads TypeScript extensions directly.

`@ian-pascoe/pi-utils` is a reusable library rather than a Pi extension. It therefore publishes compiled JavaScript and declarations from `dist` behind a conventional `exports` contract so installed extension packages can load it through Node without relying on Pi's TypeScript extension loader.
