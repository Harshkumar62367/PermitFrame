@echo off
rem Windows shim so DKG_CLI_BIN can point at the remote-CLI wrapper.
node "%~dp0dkg-remote-cli.mjs" %*
