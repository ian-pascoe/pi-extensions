---
"@ian-pascoe/pi-secret": minor
---

Add the Env File Secret Provider: grant Secrets from `.env` and `.env.*` files in the project, or files listed in global `secret.providers.dotenv.files`, through `dotenv://<path>#<KEY>` Secret Locators, read again at each use, and save typed Secrets into them as new keys. It is on when Pi starts in a directory with a top-level Env File, or when global settings list files or set `enabled: true`; global `enabled: false` turns it off. The approval dialogs warn when git does not ignore a project Env File. Project settings for one Secret Provider no longer replace global settings for the others.
