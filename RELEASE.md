# CollectorsHub POS Release Guide

This desktop app updates through GitHub Releases. A tagged release builds the
Windows installer and publishes the update metadata that installed apps check.

## First-Time Repository Setup

1. Make sure the GitHub repository exists at `Cymunix/CollectorsHub_POS`.
2. Push the local branch and set upstream if Git says `origin/main` is gone:

   ```powershell
   git push -u origin main
   ```

3. Use public GitHub releases for tester updates, or host update files somewhere
   the installed app can access without a secret token. Do not embed a private
   GitHub token in the app.

## Create a Release

For the first tester build, tag the current version after committing release
setup:

```powershell
git tag v0.1.0
git push origin main --follow-tags
```

For later releases, bump the app version:

   ```powershell
   npm version patch
   ```

Then push the commit and tag:

   ```powershell
   git push origin main --follow-tags
   ```

GitHub Actions will build the Windows installer and attach it to the release.
   Share the generated `.exe` installer with testers.

## Update Testers

For later releases, repeat the version bump and tag push. Installed copies check
for updates on startup, download the new version, and offer to restart once the
update is ready.
