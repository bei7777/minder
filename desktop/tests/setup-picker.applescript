on run arguments
	set targetPID to item 1 of arguments as integer
	set chosenPath to item 2 of arguments
	tell application "System Events"
		tell (first application process whose unix id is targetPID)
			set frontmost to true
			repeat 100 times
				if exists sheet 1 of front window then exit repeat
				delay 0.1
			end repeat
			if not (exists sheet 1 of front window) then error "The system file chooser did not open."
			keystroke "g" using {command down, shift down}
			delay 0.3
			keystroke chosenPath
			delay 0.3
			key code 36
			delay 0.4
			if not frontmost then error "The application lost keyboard focus."
			key code 36
		end tell
	end tell
end run
