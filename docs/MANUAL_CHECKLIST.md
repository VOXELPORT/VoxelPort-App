# Checks only a person can do

The automated runs (see [TEST_RESULTS.md](TEST_RESULTS.md)) answer every native dialog from a debug-only switch and use stand-ins for Discord, Mojang,
Modrinth and the relays. These are the things they cannot see. Do them on the **release** installer (`VoxelPort-Setup.exe`), on a PC that is not the
development PC if you can, and write the result next to each line.

## Dialogs the person clicks

| Check | Result |
|---|---|
| New server > Choose folder: the Windows folder picker opens, the chosen folder shows in the box, Cancel leaves the old one | |
| Delete a server: the confirmation names the server, Cancel keeps it, Delete moves the folder to the Recycle Bin (look in it) | |
| Settings > Export error report: the Save dialog opens with a `.txt` name, the saved file has no address, token or your user name | |
| Modpack > Choose file: the picker shows `.mrpack` files, a bad file gives a plain message | |
| Import an existing server folder: the picker, then the server appears in the list | |

## Closing and reopening

| Check | Result |
|---|---|
| Close the window while a server runs: it asks the server to stop, waits, and the world is intact on the next start | |
| Start the app a second time while the first is open, then while it is minimised: the second copy ends and the first comes to the front | |
| Restart Windows with the app installed: it starts, signs in again by itself (no new Discord sign-in), shows the same servers | |

## The installer

| Check | Result |
|---|---|
| Run it by hand (not silent): the screens read well, the finish page starts the app | |
| Install to a folder with spaces and non-English letters (for example `C:\Users\Test User\Ünïcode Folder`) | |
| Install on a PC where WebView2 is missing (fresh Windows 10) | |
| Install over a slow connection (WebView2 is downloaded) | |
| Windows "unknown publisher" warning: click **More info > Run anyway**; with Smart App Control on, the installer is blocked as the site says | |
| Uninstall from Settings > Apps: the app goes, your servers and worlds stay | |
| A previous VoxelPort (Electron) on the same PC is left exactly as it was | |

## The real services

| Check | Result |
|---|---|
| Sign in with a real Discord account, once; join the VoxelPort Discord when asked; the app lets you host | |
| Make a server public, join it from another PC or phone with plain Minecraft through the real relay | |
| A Bedrock phone joins a Java server through Geyser, and a Bedrock Dedicated Server through its own address | |
| Real Paper, Fabric and Vanilla jars download and start with the real Java the app installs | |
| Install a plugin and a mod from the Plugins screen; remove them again | |
| Update: with an older installed copy and a newer pre-release published, the banner appears, **Restart & Update** installs it and the app comes back on the new version with its servers | |
| Move over from the previous app with the real **Update to the new VoxelPort** button and with a real Microsoft Store copy | |

## Web control (testers only)

Start the app with `VOXELPORT_WEB_CONTROL=1` (or the `--web-control` argument), sign in as a Supporter+ member, and:

| Check | Result |
|---|---|
| Library shows the Web control card; the screen lets you choose a server and switch it on | |
| Create an invite link, open it on a phone, sign in with Discord there (a member of the VoxelPort Discord) | |
| From the phone: Start, watch the console, Restart, Kick a player, Stop; each shows on the PC under Recent activity | |
| The console on the phone shows no IP address and no part of your Windows user name | |
| Remove the link or the friend: the phone can no longer control the server | |
| Without Supporter+: the screen says it is a Supporter+ perk and no link can be made | |
