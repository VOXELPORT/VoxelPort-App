# Code signing the installer

**State today:** the installer (`VoxelPort-Setup.exe`) is **not code-signed**. Windows shows "Windows protected your PC" (SmartScreen) once, and on Windows 11 with Smart
App Control switched on it blocks the installer outright. The *update* signature (minisign, `UPDATE_PUBLIC_KEY`) is a different thing: it protects updates and is already
in place.

The download page of the website carries SignPath's required "Code signing policy" panel (free signing for open-source projects by SignPath.io, certificate by the SignPath
Foundation). That panel only becomes true once signing is set up as below; until then the page also says the installer is not signed yet.

## What signing through SignPath needs

SignPath Foundation signs only what a **CI build of the public source** produced, so the installer has to be built by a GitHub Actions workflow rather than on a PC. The steps
that are the owner's (they need the SignPath account and secrets) and the steps that are code:

| Who | Step |
|---|---|
| Owner | Be accepted by the SignPath Foundation for the project (the website panel names the team roles) and create, in SignPath, a project, an artifact configuration for the NSIS installer (`.exe`) and a signing policy |
| Owner | Add the GitHub secrets `SIGNPATH_API_TOKEN` and the organization id / project / policy slugs as repository variables |
| Code | A workflow on a Windows runner: build the installer with `node tools/build-release.mjs --no-update-sign` (to be added: build only), upload it as an artifact, submit it with `signpath/github-action-submit-signing-request`, download the signed installer |
| Code | Sign the **signed** installer for updates (minisign) afterwards: the update signature is over the installer's bytes, so it must be made last. `tools/build-release.mjs` would split into "build" and "update-sign" for this |
| Code | Attach the installer, `latest.json` and checksums to the release, as is done by hand today |

## Why it was not done in this round

It cannot be finished without the SignPath project and its token, and a signing workflow that was never run against a real SignPath project would be a guess. Until then the
honest wording on the site and in the announcement stays: not code-signed yet, and with Smart App Control on the installer is blocked.

## Keep in mind

* The update key (`~/.voxelport-update-signing`) must stay backed up. Losing it means every installed copy has to be reinstalled by hand.
* A signed installer changes nothing for people who update from inside the app: the updater checks the minisign signature, not the Windows one.
