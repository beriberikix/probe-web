import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type DefaultTheme } from 'vitepress';

// The API reference is generated into docs/api by TypeDoc (`npm run docs:api`), along with
// its sidebar. Build the docs through `npm run docs:build`, which runs TypeDoc first.
const apiSidebarFile = fileURLToPath(new URL('../api/typedoc-sidebar.json', import.meta.url));
const apiSidebar: DefaultTheme.SidebarItem[] = existsSync(apiSidebarFile)
  ? JSON.parse(readFileSync(apiSidebarFile, 'utf8'))
  : [];
// The SDK first, then the rest alphabetically.
const apiOrder = ['@probe-web/client', '@probe-web/ui', '@probe-web/dap'];
apiSidebar.sort((a, b) => {
  const rank = (i: DefaultTheme.SidebarItem) => {
    const r = apiOrder.indexOf(i.text ?? '');
    return r === -1 ? apiOrder.length : r;
  };
  return rank(a) - rank(b) || (a.text ?? '').localeCompare(b.text ?? '');
});

// The hosted apps are separate Vite builds deployed next to the docs (scripts/build-site.sh),
// so links to them must leave the VitePress router: `target: '_self'` does that.
const apps: DefaultTheme.NavItemWithLink[] = [
  { text: 'Flasher', link: '/flash/', target: '_self' },
  { text: 'Workbench', link: '/workbench/', target: '_self' },
  { text: 'Inspector', link: '/inspect/', target: '_self' },
  { text: 'Monaco IDE example', link: '/monaco-ide/', target: '_self' },
  { text: 'React example', link: '/react-flash/', target: '_self' },
];

export default defineConfig({
  title: 'probe-web',
  description: 'Flash and debug embedded targets from a browser tab, on top of probe-rs.',
  // Project Pages serve from /<repo>/; scripts/build-site.sh passes it.
  base: process.env.DOCS_BASE ?? '/',
  cleanUrls: true,
  lastUpdated: true,
  // The apps are not VitePress pages, so links to them cannot be checked here.
  ignoreDeadLinks: [/^\/(flash|workbench|inspect|monaco-ide)\//],
  head: [['link', { rel: 'icon', href: `${process.env.DOCS_BASE ?? '/'}favicon.svg`, type: 'image/svg+xml' }]],
  // The local search index covers the whole API reference, which makes for one large chunk.
  vite: { server: { port: 5180 }, build: { chunkSizeWarningLimit: 2000 } },
  themeConfig: {
    logo: '/favicon.svg',
    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '^/guide/' },
      { text: 'Reference', link: '/reference/hardware', activeMatch: '^/reference/' },
      { text: 'API', link: '/api/', activeMatch: '^/api/' },
      { text: 'Apps', items: apps },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'Transports', link: '/guide/transports' },
            { text: 'Architecture', link: '/guide/architecture' },
          ],
        },
        {
          text: 'Using the SDK',
          items: [
            { text: 'Flashing', link: '/guide/flashing' },
            { text: 'RTT and defmt', link: '/guide/rtt-defmt' },
            { text: 'Semihosting', link: '/guide/semihosting' },
            { text: 'Debugging', link: '/guide/debugging' },
            { text: 'Custom targets and packs', link: '/guide/custom-targets' },
            { text: 'Firmware tests', link: '/guide/testing' },
            { text: 'Node and CI', link: '/guide/node-and-ci' },
          ],
        },
        {
          text: 'Building UIs',
          items: [
            { text: 'Web components', link: '/guide/components' },
            { text: 'Using with React', link: '/guide/react' },
            { text: 'IDE integration (DAP)', link: '/guide/ide-integration' },
            { text: 'Firmware files', link: '/guide/artifacts' },
            { text: 'Serial monitor', link: '/guide/serial' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Supported hardware', link: '/reference/hardware' },
            { text: 'Browser support and limitations', link: '/reference/limitations' },
            { text: 'Hosted apps', link: '/reference/apps' },
            { text: 'API reference', link: '/api/' },
          ],
        },
      ],
      '/api/': [{ text: 'API reference', link: '/api/', items: apiSidebar }],
    },
    search: { provider: 'local' },
    outline: [2, 3],
    editLink: {
      pattern: 'https://github.com/beriberikix/probe-web/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/beriberikix/probe-web' }],
    footer: {
      message: 'MIT or Apache-2.0. Built on <a href="https://probe.rs">probe-rs</a>.',
    },
  },
});
