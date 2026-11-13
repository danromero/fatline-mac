-- Has Finder save the disk image's window, which becomes scripts/dmg.DS_Store.
-- Only needed when the window's size, its icons, or the background's path change.
-- Mount a writable image named Fatline that has Fatline.app, Applications, and
-- .background/background.tiff, run this with osascript, then copy .DS_Store off the volume.
-- Keep that image at /Users/Shared/Fatline.dmg. Finder saves the image's path in the layout,
-- and the layout ships publicly, so the path shouldn't have a username in it.
tell application "Finder"
	open disk "Fatline"
	delay 1
	if name of Finder window 1 is not "Fatline" then error "The Fatline window didn't open in front."
	-- Keep this out of a "tell disk" block, where "Finder window 1" would mean a window of the disk.
	-- Going through the disk's container window instead timed out setting the view.
	tell Finder window 1
		set toolbar visible to false
		set statusbar visible to false
		set bounds to {240, 180, 900, 612}
	end tell
	tell icon view options of Finder window 1
		set arrangement to not arranged
		set icon size to 160
		set text size to 13
		set shows item info to false
		set shows icon preview to true
	end tell
	-- Also outside that block, or "disk" is read as belonging to the view options.
	set background picture of icon view options of Finder window 1 to file ".background:background.tiff" of disk "Fatline"
	set position of item "Fatline.app" of disk "Fatline" to {170, 170}
	set position of item "Applications" of disk "Fatline" to {480, 170}
	update disk "Fatline" without registering applications
	delay 1
	close Finder window 1
	delay 2
	open disk "Fatline"
	delay 2
	close Finder window 1
end tell
