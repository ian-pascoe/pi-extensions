# Language Tools

Language Tools describes the shared vocabulary of built-in language support and
Pi-owned tool installations. Server Definitions, Formatter Definitions, Adapter
Definitions, and Launch Profiles retain their package-local meanings.

## Language

**Language Tool Preset**:
A package-supplied default for using a language tool, with the identity of the tool
and its installation requirements. It is distinct from an Explicit Definition.
_Avoid_: Mason package, installer recipe

**Explicit Definition**:
A Server Definition, Formatter Definition, or Adapter Definition supplied through
user configuration rather than a Language Tool Preset.
_Avoid_: Default, detected tool

**Managed Installation**:
A Pi-owned copy of a language tool and its supporting runtimes or toolchain
components, distinct from installations owned by a project or the user.
_Avoid_: Global installation, project dependency

**External Installation**:
A language tool or runtime owned by the project or user rather than Pi, including
project-local executables and executables discoverable through the user's PATH.
_Avoid_: Managed Installation

**Installer Helper**:
A program responsible for acquiring tools and supporting runtimes for Managed
Installations. It is not the authority for language routing or launch behavior.
_Avoid_: Language Tool Preset, language registry

**Formatter Marker**:
A formatter-specific configuration file or an explicit formatter declaration
inside a project manifest. The existence of a generic manifest alone is not a
Formatter Marker.
_Avoid_: File extension, generic project marker

**Installed-only Mode**:
A policy that permits use of existing installations but excludes automatic
downloads. Explicit Tool Updates are distinct from automatic installation.
_Avoid_: Offline mode, network sandbox

**Tool Update**:
An explicit request to advance an existing Managed Installation to the latest
upstream version for subsequent use, without replacing running tool processes.
_Avoid_: Pi update, project dependency update
