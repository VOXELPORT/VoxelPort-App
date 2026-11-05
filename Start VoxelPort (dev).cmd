@echo off
rem Dev launcher: runs this folder with the stock electron.exe from node_modules.
rem Smart App Control allows that well-known file, but blocks a freshly built,
rem unsigned VoxelPort.exe (release\win-unpacked) because it has no reputation yet.
rem VOXELPORT_DEVTOOLS=1 opens the DevTools console automatically (dev runs only;
rem a packaged release ignores it), so you can watch the renderer console and the
rem [VoxelPort] log lines while testing (e.g. the Bedrock make-public restart).
set ELECTRON_RUN_AS_NODE=
set VOXELPORT_DEVTOOLS=1
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
