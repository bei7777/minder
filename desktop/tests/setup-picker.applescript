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
			repeat 40 times
				if exists text field 1 of sheet 1 of sheet 1 of front window then exit repeat
				delay 0.1
			end repeat
			set value of text field 1 of sheet 1 of sheet 1 of front window to chosenPath
			key code 124
			keystroke " "
			key code 51
			delay 0.6
			if (value of text field 1 of sheet 1 of sheet 1 of front window as text) does not start with chosenPath then error "The native path field did not accept the requested path."
			key code 36
			delay 0.8
			if not frontmost then error "The application lost keyboard focus."
			if (exists sheet 1 of front window) then key code 36
			repeat 40 times
				if not (exists sheet 1 of front window) then return
				delay 0.1
			end repeat
			error "The native file chooser did not confirm its selection."
		end tell
	end tell
end run
