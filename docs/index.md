---
layout: home

hero:
  name: probe-web
  text: Flash and debug embedded targets from a browser tab
  tagline: probe-rs compiled to WebAssembly, talking to your debug probe over WebUSB. No install, no server — or the same API against a native probe-rs serve.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Open the flasher
      link: /flash/
      target: _self
    - theme: alt
      text: Open the workbench
      link: /workbench/
      target: _self

features:
  - title: Two transports, one API
    details: probe-rs in a Web Worker over WebUSB (Chromium), or a native probe-rs serve over WebSocket (any browser, and Node). Your code does not change.
    link: /guide/transports
  - title: Flash, RTT, defmt, semihosting
    details: Flash ELF, bin, hex, UF2 and ESP-IDF images with progress and verify. Stream RTT with defmt decoded in the browser, and semihosting output.
    link: /guide/flashing
  - title: A full debugger
    details: Breakpoints, stepping, call stacks, variables, registers, memory and SVD peripherals, over either transport.
    link: /guide/debugging
  - title: Components and DAP
    details: Sixteen framework-agnostic web components, and a Debug Adapter Protocol adapter for Monaco, VS Code for the Web or Theia.
    link: /guide/components
  - title: Bring your own chip
    details: Import a vendor's CMSIS-Pack or .FLM flash algorithm in the browser, so a chip probe-rs does not ship can still be flashed.
    link: /guide/custom-targets
  - title: Runs in CI too
    details: The same SDK drives hardware-in-the-loop tests from Node against probe-rs serve, including embedded-test suites.
    link: /guide/node-and-ci
---
