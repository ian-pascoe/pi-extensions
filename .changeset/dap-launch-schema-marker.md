---
"@ian-pascoe/pi-dap": patch
---

Stop `dap_launch` from sending a TypeBox `~optional` marker in its `launch_arguments` schema. Gemini rejected every request with the tool active ("Unknown name \"~optional\"") when a provider passed the schema through as OpenAPI `parameters`.
