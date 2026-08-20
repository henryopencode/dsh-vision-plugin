# Integrating into the DeepSeek Harness repo (first-class plugin)

The browser plugin in this repository is a standalone build of the same code
that ships inside the DSH repository as
`packages/client/ui-vision-bridge`. To make it a first-class DSH package
(publishable, HMR-friendly, testable), apply these changes in a DSH checkout:

## 1. Add the package

```
packages/client/ui-vision-bridge/
├── package.json          # name: @deepseek-ai/dsh-client-ui-vision-bridge
│                         # dsh.client.platform: web
├── src/index.ts          # node half (empty apply)
├── src/client/index.ts   # browser half (fetch interception + pill)
├── tsconfig.json / tsdown.config.ts / css-modules.d.ts / invariant.ts
└── README.md / README.zh.md
```

## 2. Register it

- `tsconfig.client.json` → add `{ "path": "./packages/client/ui-vision-bridge" }` to references
- `packages/bundle/web-app/package.json` → add
  `"@deepseek-ai/dsh-client-ui-vision-bridge": "workspace:^"` to dependencies
- `packages/bundle/web-app/cordis.patch.yml` → add to the browser roster:

```yaml
    - id: ui-vision-bridge
      name: '@deepseek-ai/dsh-client-ui-vision-bridge'
```

## 3. Build

```bash
pnpm install
cd packages/client/ui-vision-bridge
npx tsc -p tsconfig.json --noEmit
npx tsdown          # → lib/client.js
```

## 4. Server plugin

The same-origin recognition endpoint (`/vision/recognize`, `/vision/attach`,
`/vision/image/<id>`) lives in this repo's `server/vision-server.mjs`. For a
repo-native home, move it to e.g. `packages/vision/vision-server` (a cordis
plugin package) and compose it from `packages/bundle/web-app/cordis.patch.yml`
instead of the user profile patch.

## 5. Restart

Kill the `dsh web` process (the launcher restarts it; sessions persist in
`~/.dsh/sessions`) and refresh the browser. Browser-plugin-only changes only
need a page refresh.
