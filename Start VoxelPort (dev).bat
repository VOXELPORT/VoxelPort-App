@echo off
rem Dev launcher for the Direct mode copy: runs this folder with the stock electron.exe from node_modules.
rem Smart App Control allows that well-known file, but blocks a freshly built,
rem unsigned VoxelPort.exe because it has no reputation yet.
rem VoxelPort allows one copy at a time: close the normal app first.
set ELECTRON_RUN_AS_NODE=
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
