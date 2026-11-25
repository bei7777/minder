use framework "AppKit"
use scripting additions

on run arguments
	set targetPID to item 1 of arguments as integer
	set operation to item 2 of arguments
	if operation is "quit" then
		set target to current application's NSRunningApplication's runningApplicationWithProcessIdentifier:targetPID
		if target is missing value then return
		if not (target's terminate() as boolean) then error "The application declined the quit request."
		return
	end if
	tell application "System Events"
		tell (first application process whose unix id is targetPID)
			set frontmost to true
			if not frontmost then error "The test application is not active."
			if operation is "close-window" then
				click (first button of front window whose subrole is "AXCloseButton")
			else if operation is "command-q" then
				keystroke "q" using command down
			else
				error "Unknown window operation."
			end if
		end tell
	end tell
end run
