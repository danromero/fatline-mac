#!/bin/bash
# Put a built Fatline.app in a disk image with the designed Finder window.
# Usage: scripts/make-dmg.sh <Fatline.app> <output.dmg>
# This doesn't sign or notarize the image. release.sh does that afterward.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <Fatline.app> <output.dmg>" >&2
  exit 1
fi
app=$1
dmg=$2
scripts=$(cd "$(dirname "$0")" && pwd)

work=$(mktemp -d)
mount="$work/mount"
cleanup() {
  if mount | grep -q " on $mount "; then diskutil eject "$mount" >/dev/null 2>&1 || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

stage="$work/stage"
mkdir -p "$stage/.background" "$mount"
ditto "$app" "$stage/Fatline.app"
ln -s /Applications "$stage/Applications"
# Finder's saved window. It finds the background by this exact path on a volume named Fatline,
# so scripts/dmg-layout.applescript has to be rerun if either of those changes.
cp "$scripts/dmg.DS_Store" "$stage/.DS_Store"
cp "$scripts/dmg-background.tiff" "$stage/.background/background.tiff"
cp "$app/Contents/Resources/AppIcon.icns" "$stage/.VolumeIcon.icns"

writable="$work/writable.dmg"
hdiutil create -quiet -volname Fatline -srcfolder "$stage" -fs APFS -format UDRW "$writable"

# A volume only shows .VolumeIcon.icns once its root is flagged as having a custom icon.
# diskutil, because hdiutil's attach and detach print deprecation warnings on macOS 27.
diskutil image attach --nobrowse --mountPoint "$mount" "$writable" >/dev/null
xattr -wx com.apple.FinderInfo \
  "0000000000000000040000000000000000000000000000000000000000000000" "$mount"
diskutil eject "$mount" >/dev/null

hdiutil convert -quiet -format ULFO -ov -o "$dmg" "$writable"
