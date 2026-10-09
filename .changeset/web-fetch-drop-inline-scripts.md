---
"@ian-pascoe/pi-web-tools": patch
---

Web Fetch removes inline `<script>`, `<style>`, and `<template>` elements before splitting HTML for Markdown conversion, so a large embedded payload (such as a hydration script) no longer pushes the content around it into the plain-text fallback and drops its links.
