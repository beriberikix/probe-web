// @ts-check
import { OptionDefaults } from 'typedoc';

// Generates the API reference (docs/api) that the VitePress site links into. Every package
// is documented from its source; `@fires` documents the events a custom element dispatches.
/** @type {Partial<import('typedoc').TypeDocOptions>} */
const config = {
  "name": "probe-web",
  "entryPointStrategy": "packages",
  "entryPoints": [
    "packages/client",
    "packages/ui",
    "packages/dap",
    "packages/devices",
    "packages/serial",
    "packages/artifacts"
  ],
  "packageOptions": {
    "entryPoints": [
      "src/index.ts"
    ],
    "excludePrivate": true,
    "excludeProtected": true,
    "excludeInternal": true,
    "excludeExternals": true,
    "sort": [
      "kind",
      "source-order"
    ]
  },
  "plugin": [
    "./docs/typedoc-plugin-elements.mjs",
    "typedoc-plugin-markdown",
    "typedoc-vitepress-theme"
  ],
  "out": "docs/api",
  "docsRoot": "docs",
  "readme": "none",
  "hidePageHeader": true,
  "excludeScopesInPaths": true,
  "hideBreadcrumbs": false,
  "useCodeBlocks": true,
  "expandObjects": true,
  "parametersFormat": "table",
  "interfacePropertiesFormat": "table",
  "classPropertiesFormat": "table",
  "typeDeclarationFormat": "table",
  "sidebar": {
    "autoConfiguration": true,
    "format": "vitepress",
    "pretty": true,
    "collapsed": true
  },
  "sourceLinkTemplate": "https://github.com/beriberikix/probe-web/blob/main/{path}#L{line}",
  "gitRevision": "main",
  "treatWarningsAsErrors": true
};
config.packageOptions = { ...config.packageOptions, blockTags: [...OptionDefaults.blockTags, '@fires'] };

export default config;
