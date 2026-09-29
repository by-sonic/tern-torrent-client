; Remove the per-user file/protocol registrations Tern's "make default" button wrote.
!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Tern.Torrent"
  DeleteRegKey HKCU "Software\Classes\Tern.Magnet"
  DeleteRegValue HKCU "Software\Classes\.torrent\OpenWithProgids" "Tern.Torrent"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Tern"
  DeleteRegKey HKCU "Software\Tern"
!macroend
